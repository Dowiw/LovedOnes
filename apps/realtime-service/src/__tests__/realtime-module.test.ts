import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { GroupMemberLocationRow } from '@loved-ones/db';
import {
  ChatMessage,
  GroupRole,
  JwtUserPayload,
  LocationBroadcast,
  LocationPoint,
  PrivacyMode,
} from '@loved-ones/shared';
import {
  attachAuthAndTelemetry,
  AuthenticatedRequest,
  createTokenService,
} from '@loved-ones/shared/auth';
import {
  filterAnomalousLocationPoints,
  isNullIsland,
  RealtimeBroadcaster,
  RealtimeModule,
  RealtimeStore,
} from '../domain/realtime-module.js';

const GROUP_EXACT = '11111111-1111-4111-8111-111111111111';
const GROUP_FUZZED = '22222222-2222-4222-8222-222222222222';
const GROUP_GHOST = '33333333-3333-4333-8333-333333333333';
const GROUP_SPECTATOR = '44444444-4444-4444-8444-444444444444';

const alice: JwtUserPayload = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'alice@example.com',
  username: 'Alice',
  role: 'USER',
  type: 'access',
};

const outsider: JwtUserPayload = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'outsider@example.com',
  username: 'Outsider',
  role: 'USER',
  type: 'access',
};

function createInMemoryRealtimeHarness() {
  const storedPoints: Array<{ userId: string; point: LocationPoint }> = [];
  const storedMessages: ChatMessage[] = [];
  const memberships: Array<{ userId: string; groupId: string; role: GroupRole; privacy: PrivacyMode }> = [
    { userId: alice.id, groupId: GROUP_EXACT, role: 'MEMBER', privacy: 'EXACT' },
    { userId: alice.id, groupId: GROUP_FUZZED, role: 'MEMBER', privacy: 'FUZZED' },
    { userId: alice.id, groupId: GROUP_GHOST, role: 'MEMBER', privacy: 'GHOST' },
    { userId: alice.id, groupId: GROUP_SPECTATOR, role: 'SPECTATOR', privacy: 'EXACT' },
  ];

  const locationBroadcasts: LocationBroadcast[] = [];
  const chatBroadcasts: ChatMessage[] = [];

  const store: RealtimeStore = {
    async isGroupMember(userId, groupId) {
      return memberships.some((m) => m.userId === userId && m.groupId === groupId);
    },
    async listUserGroupIds(userId) {
      return memberships.filter((m) => m.userId === userId).map((m) => m.groupId);
    },
    async insertLocationBatch(userId, points) {
      let inserted = 0;
      for (const point of points) {
        const epochMs = new Date(point.recordedAt).getTime();
        const exists = storedPoints.some(
          (p) => p.userId === userId && new Date(p.point.recordedAt).getTime() === epochMs,
        );
        if (!exists) {
          storedPoints.push({ userId, point });
          inserted += 1;
        }
      }
      return inserted;
    },
    async listMembershipsForUser(userId) {
      return memberships
        .filter((m) => m.userId === userId)
        .map(({ groupId, role, privacy }) => ({ groupId, role, privacy }));
    },
    async getLatestGroupLocations(groupId): Promise<GroupMemberLocationRow[]> {
      const latest = storedPoints[storedPoints.length - 1];
      if (!latest) return [];
      const member = memberships.find(
        (m) => m.groupId === groupId && m.userId === latest.userId && m.role !== 'SPECTATOR',
      );
      if (!member) return [];
      return [
        {
          userId: alice.id,
          username: alice.username,
          role: member.role,
          privacy: member.privacy,
          latitude: latest.point.latitude,
          longitude: latest.point.longitude,
          altitude: latest.point.altitude ?? null,
          speed: latest.point.speed ?? null,
          batteryLevel: latest.point.batteryLevel ?? null,
          recordedAt: latest.point.recordedAt,
        },
      ];
    },
    async getGroupMessages(groupId) {
      return storedMessages.filter((m) => m.groupId === groupId);
    },
    async insertChatMessage(groupId, senderId, senderUsername, content) {
      const msg: ChatMessage = {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        groupId,
        senderId,
        senderUsername,
        content,
        createdAt: '2026-11-17T12:00:00.000Z',
      };
      storedMessages.push(msg);
      return msg;
    },
  };

  const broadcaster: RealtimeBroadcaster = {
    broadcastLocation(_groupId, update) {
      locationBroadcasts.push(update);
    },
    broadcastChatMessage(_groupId, message) {
      chatBroadcasts.push(message);
    },
  };

  const mod = new RealtimeModule({ store, broadcaster });
  return { mod, locationBroadcasts, chatBroadcasts, storedPoints };
}

describe('RealtimeModule domain interface', () => {
  it('enforces EXACT/FUZZED/GHOST/SPECTATOR rules and anchors FUZZED grid to recordedAt across wall-clock drift', async () => {
    const { mod, locationBroadcasts } = createInMemoryRealtimeHarness();
    const recordedAt = '2026-11-17T10:09:59.000Z';

    const inserted = await mod.ingestLocationBatch(alice, {
      points: [{ latitude: 48.8566, longitude: 2.3522, recordedAt }],
    });
    expect(inserted).toBe(1);

    // Only EXACT and FUZZED should broadcast (GHOST and SPECTATOR are suppressed)
    expect(locationBroadcasts.map((b) => b.groupId)).toEqual([GROUP_EXACT, GROUP_FUZZED]);

    const fuzzedBroadcast = locationBroadcasts.find((b) => b.groupId === GROUP_FUZZED)!;
    expect(fuzzedBroadcast.isFuzzed).toBe(true);

    // Advance wall clock far past the 10-minute boundary; snapshot must still match live broadcast
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-17T15:45:00.000Z'));
      const snapshot = await mod.getGroupLocations(alice, GROUP_FUZZED);
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].latitude).toBe(fuzzedBroadcast.latitude);
      expect(snapshot[0].longitude).toBe(fuzzedBroadcast.longitude);
    } finally {
      vi.useRealTimers();
    }

    // GHOST and SPECTATOR snapshots return empty
    expect(await mod.getGroupLocations(alice, GROUP_GHOST)).toHaveLength(0);
    expect(await mod.getGroupLocations(alice, GROUP_SPECTATOR)).toHaveLength(0);

    // Retrying the exact same batch is idempotent and does not emit duplicate broadcasts
    const retryInserted = await mod.ingestLocationBatch(alice, {
      points: [{ latitude: 48.8566, longitude: 2.3522, recordedAt }],
    });
    expect(retryInserted).toBe(0);
    expect(locationBroadcasts).toHaveLength(2);
  });

  it('rejects non-members with 403 and validates payloads', async () => {
    const { mod } = createInMemoryRealtimeHarness();

    await expect(mod.getGroupLocations(outsider, GROUP_EXACT)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(mod.getGroupMessages(outsider, GROUP_EXACT)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      mod.sendChatMessage(outsider, { groupId: GROUP_EXACT, content: 'hi' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(mod.ingestLocationBatch(alice, { points: [] })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await mod.canJoinGroupRoom(outsider.id, GROUP_EXACT)).toBe(false);
    expect(await mod.canJoinGroupRoom(alice.id, GROUP_EXACT)).toBe(true);
  });

  it('records single-counted telemetry weights via shared Fastify auth/telemetry adapter', async () => {
    const tokenService = createTokenService({
      jwtSecret: 'test-access-secret-minimum-32-chars!!',
      jwtRefreshSecret: 'test-refresh-secret-minimum-32-chars!',
    });
    const pair = await tokenService.issueTokenPair(alice);
    const recorded: Array<{ userId: string; weight: number }> = [];

    const app = Fastify({ logger: false });
    const { requireAuth } = attachAuthAndTelemetry(app, {
      verifyAccessToken: (token) => tokenService.verifyAccessToken(token),
      async recordTelemetry(userId, _elapsedMs, weight) {
        recorded.push({ userId, weight });
      },
    });

    app.post('/unauthenticated', async (request: AuthenticatedRequest) => {
      request.skipTelemetry = true;
      return { ok: true };
    });

    app.post(
      '/locations',
      { preHandler: [requireAuth] },
      async (request: AuthenticatedRequest) => {
        request.telemetryEventWeight = 3;
        return { inserted: 3 };
      },
    );

    await app.inject({ method: 'POST', url: '/unauthenticated' });
    const locRes = await app.inject({
      method: 'POST',
      url: '/locations',
      headers: { Authorization: `Bearer ${pair.accessToken}` },
    });
    expect(locRes.statusCode).toBe(200);
    // Rejects refresh token on Bearer route
    const badTokenRes = await app.inject({
      method: 'POST',
      url: '/locations',
      headers: { Authorization: `Bearer ${pair.refreshToken}` },
    });
    expect(badTokenRes.statusCode).toBe(401);

    // Exactly 1 telemetry call with weight=3 (never double-counted)
    expect(recorded).toEqual([{ userId: alice.id, weight: 3 }]);
    await app.close();
  });

  it('ingests OwnTracks and Overland payloads and enforces scoped tracker token JTI revocation', async () => {
    const { mod, locationBroadcasts } = createInMemoryRealtimeHarness();

    // 1. OwnTracks location ping returns [] and broadcasts
    const otResult = await mod.ingestOwnTracks(alice, {
      _type: 'location',
      lat: 52.52,
      lon: 13.405,
      tst: 1_700_000_100,
      vel: 18,
      batt: 90,
    });
    expect(otResult).toEqual({ inserted: 1, response: [] });
    expect(locationBroadcasts).toHaveLength(2); // EXACT + FUZZED groups

    // Non-location OwnTracks event returns [] with 0 inserts
    const lwtResult = await mod.ingestOwnTracks(alice, { _type: 'lwt', tst: 1_700_000_200 });
    expect(lwtResult).toEqual({ inserted: 0, response: [] });

    // 2. Overland GeoJSON batch returns { result: 'ok', inserted: 1 }
    const overlandResult = await mod.ingestOverland(alice, {
      locations: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [13.41, 52.53] },
          properties: { timestamp: '2026-11-18T21:00:00Z', battery_level: 0.65, speed: 3.1 },
        },
      ],
    });
    expect(overlandResult).toEqual({ inserted: 1, result: 'ok' });

    // 3. Scoped tracker token works on requireIngestionAuth (via Basic Auth / ?token=)
    //    but is blocked on requireAuth and blocked when JTI is revoked/rotated
    const tokenService = createTokenService({
      jwtSecret: 'test-access-secret-minimum-32-chars!!',
      jwtRefreshSecret: 'test-refresh-secret-minimum-32-chars!',
    });
    let activeJti: string | null = 'jti-active-1';
    const tracker = await tokenService.issueTrackerToken(alice, {
      jti: activeJti,
      expiresInDays: 30,
    });

    const app = Fastify({ logger: false });
    const { requireAuth, requireIngestionAuth } = attachAuthAndTelemetry(app, {
      verifyAccessToken: (t) => tokenService.verifyAccessToken(t),
      verifyIngestionToken: (t) => tokenService.verifyIngestionToken(t),
      verifyTrackerJti: async (_userId, jti) => activeJti === jti,
      async recordTelemetry() {},
    });

    app.post('/api/realtime/owntracks', { preHandler: [requireIngestionAuth] }, async () => []);
    app.get('/api/realtime/groups/messages', { preHandler: [requireAuth] }, async () => ({
      messages: [],
    }));

    // OwnTracks HTTP Basic Auth with tracker token succeeds on /owntracks
    const basicAuth = `Basic ${Buffer.from(`alice:${tracker.token}`, 'utf8').toString('base64')}`;
    const otHttpRes = await app.inject({
      method: 'POST',
      url: '/api/realtime/owntracks',
      headers: { Authorization: basicAuth },
    });
    expect(otHttpRes.statusCode).toBe(200);
    expect(otHttpRes.json()).toEqual([]);

    // Same tracker token is rejected on non-ingestion requireAuth route
    const chatHttpRes = await app.inject({
      method: 'GET',
      url: '/api/realtime/groups/messages',
      headers: { Authorization: `Bearer ${tracker.token}` },
    });
    expect(chatHttpRes.statusCode).toBe(401);

    // Revoking JTI blocks subsequent tracker requests
    activeJti = null;
    const revokedRes = await app.inject({
      method: 'POST',
      url: `/api/realtime/owntracks?token=${encodeURIComponent(tracker.token)}`,
    });
    expect(revokedRes.statusCode).toBe(401);
    await app.close();
  });

  it('filters Null Island (0, 0), coarse accuracy (> 1000m), and impossible intra-batch velocity jumps', async () => {
    expect(isNullIsland(0, 0)).toBe(true);
    expect(isNullIsland(0.00005, -0.00005)).toBe(true);
    expect(isNullIsland(0, 13.4)).toBe(false);
    expect(isNullIsland(52.52, 0)).toBe(false);

    const { mod, locationBroadcasts, storedPoints } = createInMemoryRealtimeHarness();

    // 1. All-invalid batch (Null Island + coarse accuracy) drops cleanly without throwing or broadcasting
    const allBadInserted = await mod.ingestLocationBatch(alice, {
      points: [
        { latitude: 0, longitude: 0, accuracy: 5, recordedAt: '2026-11-18T22:00:00.000Z' },
        {
          latitude: 52.52,
          longitude: 13.405,
          accuracy: 1500,
          recordedAt: '2026-11-18T22:00:05.000Z',
        },
      ],
    });
    expect(allBadInserted).toBe(0);
    expect(storedPoints).toHaveLength(0);
    expect(locationBroadcasts).toHaveLength(0);

    // 2. Mixed batch drops Null Island + >1000m + teleport jump (Berlin -> Munich in 10s),
    //    while keeping valid Berlin fixes (including exact 1000m boundary) and broadcasting the latest valid point
    const mixedInput = [
      {
        latitude: 0.00002,
        longitude: -0.00002,
        accuracy: 10,
        recordedAt: '2026-11-18T22:01:00.000Z',
      },
      {
        latitude: 52.52,
        longitude: 13.405,
        accuracy: 1000,
        recordedAt: '2026-11-18T22:01:05.000Z',
      },
      {
        latitude: 48.1351, // Munich (~504 km jump in 10s -> impossible)
        longitude: 11.582,
        accuracy: 12,
        recordedAt: '2026-11-18T22:01:15.000Z',
      },
      {
        latitude: 52.5205,
        longitude: 13.406,
        accuracy: 2500, // Too coarse -> dropped
        recordedAt: '2026-11-18T22:01:20.000Z',
      },
      {
        latitude: 52.521,
        longitude: 13.407,
        accuracy: 15,
        recordedAt: '2026-11-18T22:01:25.000Z',
      },
    ];

    const filtered = filterAnomalousLocationPoints(mixedInput);
    expect(filtered.map((p) => p.latitude)).toEqual([52.52, 52.521]);

    const mixedInserted = await mod.ingestLocationBatch(alice, { points: mixedInput });
    expect(mixedInserted).toBe(2);
    expect(storedPoints.map((s) => s.point.latitude)).toEqual([52.52, 52.521]);
    expect(locationBroadcasts).toHaveLength(2); // EXACT + FUZZED groups for latest valid point
    expect(locationBroadcasts[0]?.latitude).toBe(52.521);
    expect(locationBroadcasts[0]?.longitude).toBe(13.407);

    // 3. Configurable accuracy threshold respects custom maxAccuracyMeters
    expect(
      filterAnomalousLocationPoints(
        [{ latitude: 52.52, longitude: 13.405, accuracy: 100, recordedAt: '2026-11-18T22:02:00.000Z' }],
        { maxAccuracyMeters: 50 },
      ),
    ).toHaveLength(0);

    // 4. Valid long-distance travel over sufficient elapsed time (Berlin -> Munich over 4 hours) is preserved
    const validTrip = filterAnomalousLocationPoints([
      {
        latitude: 52.52,
        longitude: 13.405,
        accuracy: 10,
        recordedAt: '2026-11-18T10:00:00.000Z',
      },
      {
        latitude: 48.1351,
        longitude: 11.582,
        accuracy: 10,
        recordedAt: '2026-11-18T14:00:00.000Z',
      },
    ]);
    expect(validTrip).toHaveLength(2);

    // 5. OwnTracks and Overland ingestion also apply coordinate hygiene filtering
    locationBroadcasts.length = 0;
    const otBad = await mod.ingestOwnTracks(alice, {
      _type: 'location',
      lat: 0,
      lon: 0,
      acc: 10,
      tst: 1_700_000_500,
    });
    expect(otBad).toEqual({ inserted: 0, response: [] });

    const overlandBad = await mod.ingestOverland(alice, {
      locations: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [13.405, 52.52] },
          properties: {
            timestamp: '2026-11-18T22:05:00Z',
            horizontal_accuracy: 1201,
          },
        },
      ],
    });
    expect(overlandBad).toEqual({ inserted: 0, result: 'ok' });
    expect(locationBroadcasts).toHaveLength(0);
  });
});
