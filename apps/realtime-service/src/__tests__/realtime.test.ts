import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { io as ioClient, Socket } from 'socket.io-client';
import { createAuthAdminServer } from '@loved-ones/auth-admin-service';
import { createRealtimeServer } from '../index.js';

const BASE_PG_URL = 'postgresql://postgres:postgres@localhost:5432';
const TEST_DB_NAME = 'lovedones_test_realtime';
const TEST_DB_URL = `${BASE_PG_URL}/${TEST_DB_NAME}`;
const TEST_REDIS_URL = 'redis://localhost:6379/2';

async function recreateTestDatabase(dbName: string): Promise<void> {
  const adminPool = new pg.Pool({ connectionString: `${BASE_PG_URL}/postgres` });
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await adminPool.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await adminPool.end();
  }
}

describe('@loved-ones/realtime-service integration', () => {
  let authApp: FastifyInstance;
  let realtimeApp: FastifyInstance;
  let realtimeUrl: string;
  let logDir: string;

  beforeAll(async () => {
    await recreateTestDatabase(TEST_DB_NAME);
    const flushRedis = new Redis(TEST_REDIS_URL);
    await flushRedis.flushdb();
    await flushRedis.quit();

    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovedones-realtime-logs-'));

    const authServer = await createAuthAdminServer({
      databaseUrl: TEST_DB_URL,
      redisUrl: TEST_REDIS_URL,
      logDir,
      disableFileLog: true,
    });
    authApp = authServer.app;

    const rtServer = await createRealtimeServer({
      databaseUrl: TEST_DB_URL,
      redisUrl: TEST_REDIS_URL,
      logDir,
      disableFileLog: true,
    });
    realtimeApp = rtServer.app;
    await realtimeApp.listen({ port: 0, host: '127.0.0.1' });
    const addr = realtimeApp.server.address();
    if (typeof addr === 'object' && addr) {
      realtimeUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    await realtimeApp.close();
    await authApp.close();
    fs.rmSync(logDir, { recursive: true, force: true });
    const adminPool = new pg.Pool({ connectionString: `${BASE_PG_URL}/postgres` });
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB_NAME],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.end();
  });

  it('ingests GPS batches, enforces EXACT/FUZZED/GHOST privacy, and broadcasts group chat', async () => {
    // Setup 2 users in 1 group
    const adminReg = await authApp.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'rt-admin@lovedones.test',
        username: 'Alice',
        password: 'Password1234',
      },
    });
    const alice = adminReg.json();

    const grpRes = await authApp.inject({
      method: 'POST',
      url: '/api/auth/groups',
      headers: { Authorization: `Bearer ${alice.accessToken}` },
      payload: { name: 'Road Trip' },
    });
    const group = grpRes.json();

    const invRes = await authApp.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { Authorization: `Bearer ${alice.accessToken}` },
      payload: { groupId: group.id, assignedRole: 'MEMBER', maxUses: 1, expiresInHours: 1 },
    });
    const invite = invRes.json();

    const bobReg = await authApp.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'rt-bob@lovedones.test',
        username: 'Bob',
        password: 'Password1234',
        inviteToken: invite.inviteToken,
      },
    });
    const bob = bobReg.json();

    const connectSocket = (token: string): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const s = ioClient(realtimeUrl, {
          auth: { token },
          transports: ['websocket'],
        });
        s.on('connect', () => resolve(s));
        s.on('connect_error', reject);
      });

    const aliceSocket = await connectSocket(alice.accessToken);
    const bobSocket = await connectSocket(bob.accessToken);

    try {
      // 1. EXACT location broadcast
      const exactPromise = new Promise<Record<string, unknown>>((resolve) => {
        aliceSocket.once('location:update', resolve);
      });

      const batchAck = await new Promise<{ ok: boolean; inserted?: number }>((resolve) => {
        bobSocket.emit(
          'location:batch',
          {
            points: [
              {
                latitude: 48.8566,
                longitude: 2.3522,
                batteryLevel: 76,
                speed: 3.2,
                recordedAt: new Date().toISOString(),
              },
            ],
          },
          resolve,
        );
      });
      expect(batchAck.ok).toBe(true);
      expect(batchAck.inserted).toBe(1);

      const exactBroadcast = await exactPromise;
      expect(exactBroadcast.username).toBe('Bob');
      expect(exactBroadcast.isFuzzed).toBe(false);
      expect(exactBroadcast.latitude).toBeCloseTo(48.8566, 4);

      // 2. Switch Bob to FUZZED privacy and send another ping
      await authApp.inject({
        method: 'PATCH',
        url: `/api/auth/groups/${group.id}/privacy`,
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: { privacy: 'FUZZED' },
      });

      const fuzzedPromise = new Promise<Record<string, unknown>>((resolve) => {
        aliceSocket.once('location:update', resolve);
      });

      await new Promise((resolve) => {
        bobSocket.emit(
          'location:batch',
          {
            points: [
              {
                latitude: 48.8566,
                longitude: 2.3522,
                batteryLevel: 75,
                recordedAt: new Date().toISOString(),
              },
            ],
          },
          resolve,
        );
      });

      const fuzzedBroadcast = await fuzzedPromise;
      expect(fuzzedBroadcast.isFuzzed).toBe(true);
      expect(fuzzedBroadcast.privacyMode).toBe('FUZZED');
      expect(Math.abs(Number(fuzzedBroadcast.latitude) - 48.8566)).toBeLessThan(0.02);

      // 3. Switch Bob to GHOST -> snapshot excludes Bob & no socket broadcast fires
      await authApp.inject({
        method: 'PATCH',
        url: `/api/auth/groups/${group.id}/privacy`,
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: { privacy: 'GHOST' },
      });

      let ghostBroadcastReceived = false;
      const ghostHandler = () => {
        ghostBroadcastReceived = true;
      };
      aliceSocket.on('location:update', ghostHandler);

      await new Promise((resolve) => {
        bobSocket.emit(
          'location:batch',
          {
            points: [
              {
                latitude: 48.8566,
                longitude: 2.3522,
                recordedAt: new Date().toISOString(),
              },
            ],
          },
          resolve,
        );
      });
      await new Promise((r) => setTimeout(r, 80));
      aliceSocket.off('location:update', ghostHandler);
      expect(ghostBroadcastReceived).toBe(false);

      const snapshotRes = await realtimeApp.inject({
        method: 'GET',
        url: `/api/realtime/groups/${group.id}/locations`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(snapshotRes.statusCode).toBe(200);
      expect(snapshotRes.json().locations).toHaveLength(0);

      // 4. Group chat over Socket.io + REST retrieval
      const chatPromise = new Promise<Record<string, unknown>>((resolve) => {
        bobSocket.once('chat:message', resolve);
      });

      const chatAck = await new Promise<{ ok: boolean }>((resolve) => {
        aliceSocket.emit(
          'chat:send',
          { groupId: group.id, content: 'Arrived in Paris!' },
          resolve,
        );
      });
      expect(chatAck.ok).toBe(true);

      const receivedChat = await chatPromise;
      expect(receivedChat.content).toBe('Arrived in Paris!');
      expect(receivedChat.senderUsername).toBe('Alice');

      const msgRes = await realtimeApp.inject({
        method: 'GET',
        url: `/api/realtime/groups/${group.id}/messages`,
        headers: { Authorization: `Bearer ${bob.accessToken}` },
      });
      expect(msgRes.statusCode).toBe(200);
      expect(msgRes.json().messages).toHaveLength(1);
      expect(msgRes.json().messages[0].content).toBe('Arrived in Paris!');

      // 5. ETag/304 conditional snapshot polling, ?since= filtering, and PostGIS bounding-box /trails
      await authApp.inject({
        method: 'PATCH',
        url: `/api/auth/groups/${group.id}/privacy`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
        payload: { privacy: 'EXACT' },
      });
      await authApp.inject({
        method: 'PATCH',
        url: `/api/auth/groups/${group.id}/privacy`,
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: { privacy: 'FUZZED' },
      });

      const trailT1 = '2026-11-19T08:00:00.000Z';
      const trailT2 = '2026-11-19T09:00:00.000Z';
      await realtimeApp.inject({
        method: 'POST',
        url: '/api/realtime/locations',
        headers: { Authorization: `Bearer ${alice.accessToken}` },
        payload: {
          points: [
            { latitude: 52.52, longitude: 13.405, recordedAt: trailT1 }, // Berlin
            { latitude: 48.1351, longitude: 11.582, recordedAt: trailT2 }, // Munich
          ],
        },
      });
      await realtimeApp.inject({
        method: 'POST',
        url: '/api/realtime/locations',
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: {
          points: [{ latitude: 52.515, longitude: 13.415, recordedAt: '2026-11-19T08:30:00.000Z' }],
        },
      });

      const snapInitial = await realtimeApp.inject({
        method: 'GET',
        url: `/api/realtime/groups/${group.id}/locations`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(snapInitial.statusCode).toBe(200);
      const etag = snapInitial.headers.etag as string;
      expect(etag).toBeTruthy();

      // Re-poll with matching ETag returns 304 Not Modified
      const snapCached = await realtimeApp.inject({
        method: 'GET',
        url: `/api/realtime/groups/${group.id}/locations`,
        headers: {
          Authorization: `Bearer ${alice.accessToken}`,
          'If-None-Match': etag,
        },
      });
      expect(snapCached.statusCode).toBe(304);

      // Polling after Alice toggles privacy to GHOST returns 200 with rotated ETag
      await authApp.inject({
        method: 'PATCH',
        url: `/api/auth/groups/${group.id}/privacy`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
        payload: { privacy: 'GHOST' },
      });
      const snapAfterPrivacy = await realtimeApp.inject({
        method: 'GET',
        url: `/api/realtime/groups/${group.id}/locations`,
        headers: {
          Authorization: `Bearer ${alice.accessToken}`,
          'If-None-Match': etag,
        },
      });
      expect(snapAfterPrivacy.statusCode).toBe(200);
      expect(snapAfterPrivacy.headers.etag).not.toBe(etag);
      expect(snapAfterPrivacy.json().locations.every((l: { userId: string }) => l.userId !== alice.user.id)).toBe(true);

      // Restore Alice to EXACT and query PostGIS bounding-box trail over Berlin
      await authApp.inject({
        method: 'PATCH',
        url: `/api/auth/groups/${group.id}/privacy`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
        payload: { privacy: 'EXACT' },
      });
      const trailsRes = await realtimeApp.inject({
        method: 'GET',
        url: `/api/realtime/groups/${group.id}/trails?from=2026-11-19T07:00:00.000Z&to=2026-11-19T10:00:00.000Z&bbox=13.0,52.3,13.8,52.7`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(trailsRes.statusCode).toBe(200);
      const trails = trailsRes.json().trails as Array<{
        userId: string;
        latitude: number;
        longitude: number;
        isFuzzed: boolean;
        privacyMode: string;
      }>;
      // Munich point is filtered by PostGIS ST_MakeEnvelope; Alice (EXACT) & Bob (FUZZED) Berlin fixes remain
      expect(trails).toHaveLength(2);
      const aliceTrail = trails.find((t) => t.userId === alice.user.id)!;
      const bobTrail = trails.find((t) => t.userId === bob.user.id)!;
      expect(aliceTrail.isFuzzed).toBe(false);
      expect(aliceTrail.latitude).toBeCloseTo(52.52, 4);
      expect(bobTrail.isFuzzed).toBe(true);
      expect(bobTrail.privacyMode).toBe('FUZZED');

      // 6. Expiring check-in request (REST + Socket.io) and geofenced group place ST_DWithin transitions
      await authApp.inject({
        method: 'PATCH',
        url: `/api/auth/groups/${group.id}/privacy`,
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: { privacy: 'GHOST' },
      });

      const incomingReqPromise = new Promise<Record<string, unknown>>((resolve) => {
        bobSocket.once('checkin:request', resolve);
      });
      const createReqRes = await realtimeApp.inject({
        method: 'POST',
        url: `/api/realtime/groups/${group.id}/location-requests`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
        payload: {
          targetUserId: bob.user.id,
          suggestedDurationMinutes: 15,
          expiresInMinutes: 10,
          message: 'Quick check-in?',
        },
      });
      expect(createReqRes.statusCode).toBe(201);
      const createdCheckinId = createReqRes.json().request.id as string;
      const incomingReq = await incomingReqPromise;
      expect(incomingReq.id).toBe(createdCheckinId);

      // Bob accepts check-in -> Socket.io delivers response + EXACT override pin
      const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
        aliceSocket.once('checkin:response', resolve);
      });
      const acceptRes = await realtimeApp.inject({
        method: 'POST',
        url: `/api/realtime/groups/${group.id}/location-requests/${createdCheckinId}/respond`,
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: { action: 'accept' },
      });
      expect(acceptRes.statusCode).toBe(200);
      expect(acceptRes.json().privacyOverrideUntil).toBeTruthy();
      expect((await responsePromise).status).toBe('accepted');

      // Non-admin Bob cannot create group place; Admin Alice creates 'Studio' (200 m radius)
      const forbiddenPlaceRes = await realtimeApp.inject({
        method: 'POST',
        url: `/api/realtime/groups/${group.id}/places`,
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: { name: 'Studio', latitude: 52.5, longitude: 13.4, radiusMeters: 200 },
      });
      expect(forbiddenPlaceRes.statusCode).toBe(403);

      const createPlaceRes = await realtimeApp.inject({
        method: 'POST',
        url: `/api/realtime/groups/${group.id}/places`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
        payload: { name: 'Studio', latitude: 52.5, longitude: 13.4, radiusMeters: 200 },
      });
      expect(createPlaceRes.statusCode).toBe(201);
      const studioId = createPlaceRes.json().place.id as string;

      // Bob (now under active EXACT override!) enters 'Studio' -> place:transition ('enter') broadcasts live
      const transitionPromise = new Promise<Record<string, unknown>>((resolve) => {
        aliceSocket.once('place:transition', resolve);
      });
      const bobAtStudio = await realtimeApp.inject({
        method: 'POST',
        url: '/api/realtime/locations',
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: {
          points: [{ latitude: 52.5003, longitude: 13.4, recordedAt: '2026-11-19T12:01:00.000Z' }],
        },
      });
      expect(bobAtStudio.statusCode).toBe(200);
      const enterEvent = await transitionPromise;
      expect(enterEvent.placeName).toBe('Studio');
      expect(enterEvent.transition).toBe('enter');

      const placesListRes = await realtimeApp.inject({
        method: 'GET',
        url: `/api/realtime/groups/${group.id}/places`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(placesListRes.statusCode).toBe(200);
      expect(placesListRes.json().places).toHaveLength(1);
      expect(placesListRes.json().recentTransitions[0].transition).toBe('enter');

      await realtimeApp.inject({
        method: 'DELETE',
        url: `/api/realtime/groups/${group.id}/places/${studioId}`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });

      // 7. Verify telemetry reflects active sockets and GPS/chat events
      await new Promise((r) => setTimeout(r, 50));
      const telemetryRes = await authApp.inject({
        method: 'GET',
        url: '/api/admin/telemetry',
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(telemetryRes.statusCode).toBe(200);
      const telemetry = telemetryRes.json();
      expect(telemetry.totalActiveSockets).toBeGreaterThanOrEqual(2);
      const bobStats = telemetry.users.find((u: { userId: string }) => u.userId === bob.user.id);
      // Bob sent 5 pings, but pings 2 & 3 repeated (48.8566, 2.3522) and coalesced via stationary detection
      expect(bobStats.locationPoints).toBe(3);
      expect(bobStats.eventsCount).toBeGreaterThanOrEqual(5);

      // 8. Verify recent audit logs capture chat, place creation/deletion, check-in, and geofence transitions with full context
      const logsRes = await authApp.inject({
        method: 'GET',
        url: '/api/admin/logs/recent',
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(logsRes.statusCode).toBe(200);
      const parsedLogs = (logsRes.json().logs as string[]).map((line) =>
        JSON.parse(line) as Record<string, unknown>,
      );
      const chatLog = parsedLogs.find((l) => l.action === 'chat.message_sent');
      expect(chatLog?.username).toBe('Alice');
      expect(chatLog?.groupName).toBe('Road Trip');
      expect(String(chatLog?.msg)).toContain('sent message to group "Road Trip"');

      const placeCreatedLog = parsedLogs.find((l) => l.action === 'place.created');
      expect(placeCreatedLog?.placeName).toBe('Studio');
      expect(placeCreatedLog?.groupName).toBe('Road Trip');
      expect(String(placeCreatedLog?.msg)).toContain('Alice created place "Studio" in group "Road Trip"');

      const transitionLog = parsedLogs.find((l) => l.action === 'place.transition');
      expect(transitionLog?.username).toBe('Bob');
      expect(transitionLog?.placeName).toBe('Studio');
      expect(transitionLog?.transition).toBe('enter');
      expect(String(transitionLog?.msg)).toContain('Bob entered place "Studio" in group "Road Trip"');

      const placeDeletedLog = parsedLogs.find((l) => l.action === 'place.deleted');
      expect(placeDeletedLog?.placeName).toBe('Studio');
      expect(String(placeDeletedLog?.msg)).toContain('Alice deleted place "Studio" from group "Road Trip"');

      // 9. Option A FIFO auto-trim quota enforcement + persistent admin notice until dismissed
      const setQuotaRes = await authApp.inject({
        method: 'PATCH',
        url: '/api/admin/resource-limits',
        headers: { Authorization: `Bearer ${alice.accessToken}` },
        payload: { perUserMaxPoints: 1, autoTrimOnQuota: true },
      });
      expect(setQuotaRes.statusCode).toBe(200);

      const extraPingRes = await realtimeApp.inject({
        method: 'POST',
        url: '/api/realtime/locations',
        headers: { Authorization: `Bearer ${bob.accessToken}` },
        payload: {
          points: [
            { latitude: 52.521, longitude: 13.406, recordedAt: '2026-11-19T12:15:00.000Z' },
          ],
        },
      });
      expect(extraPingRes.statusCode).toBe(200);

      const telWithNoticeRes = await authApp.inject({
        method: 'GET',
        url: '/api/admin/telemetry',
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(telWithNoticeRes.statusCode).toBe(200);
      const notices = telWithNoticeRes.json().notices as Array<{
        id: string;
        kind: string;
        userId: string;
        deletedPoints: number;
        rangeStart: string;
        rangeEnd: string;
        message: string;
      }>;
      const bobNotice = notices.find((n) => n.kind === 'quota_trim' && n.userId === bob.user.id);
      expect(bobNotice).toBeDefined();
      expect(bobNotice!.deletedPoints).toBeGreaterThanOrEqual(3);
      expect(bobNotice!.rangeStart).toBeTruthy();
      expect(bobNotice!.rangeEnd).toBeTruthy();
      expect(bobNotice!.message).toContain('Bob');

      // Dismiss notice via X button endpoint
      const dismissRes = await authApp.inject({
        method: 'DELETE',
        url: `/api/admin/notices/${bobNotice!.id}`,
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(dismissRes.statusCode).toBe(200);

      const telAfterDismiss = await authApp.inject({
        method: 'GET',
        url: '/api/admin/telemetry',
        headers: { Authorization: `Bearer ${alice.accessToken}` },
      });
      expect(telAfterDismiss.json().notices).toHaveLength(0);
    } finally {
      aliceSocket.disconnect();
      bobSocket.disconnect();
    }
  });
});
