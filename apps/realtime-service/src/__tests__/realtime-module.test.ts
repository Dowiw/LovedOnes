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
      for (const point of points) {
        storedPoints.push({ userId, point });
      }
      return points.length;
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
  return { mod, locationBroadcasts, chatBroadcasts };
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
});
