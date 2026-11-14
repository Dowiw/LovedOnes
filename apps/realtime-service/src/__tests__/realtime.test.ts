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

      // 5. Verify telemetry reflects active sockets and GPS/chat events
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
      expect(bobStats.locationPoints).toBe(3);
      expect(bobStats.eventsCount).toBeGreaterThanOrEqual(3);
    } finally {
      aliceSocket.disconnect();
      bobSocket.disconnect();
    }
  });
});
