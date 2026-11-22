import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { GroupMemberLocationRow } from '@loved-ones/db';
import {
  ChatMessage,
  GroupPlace,
  GroupRole,
  JwtUserPayload,
  LocationBroadcast,
  LocationPoint,
  LocationRequestItem,
  MemberPresenceUpdate,
  PlaceTransitionEvent,
  PrivacyMode,
  UserPresenceRecord,
} from '@loved-ones/shared';
import {
  attachAuthAndTelemetry,
  AuthenticatedRequest,
  createTokenService,
} from '@loved-ones/shared/auth';
import {
  filterAnomalousLocationPoints,
  haversineMeters,
  isNullIsland,
  matchesIfNoneMatch,
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
  let currentNowMs = Date.parse('2026-11-19T12:00:00.000Z');
  const storedPoints: Array<{ userId: string; point: LocationPoint }> = [];
  const storedMessages: ChatMessage[] = [];
  const storedRequests: LocationRequestItem[] = [];
  const storedPlaces: GroupPlace[] = [];
  const placeInsideState = new Map<string, boolean>();
  const storedPlaceTransitions: PlaceTransitionEvent[] = [];
  const presenceByUser = new Map<string, UserPresenceRecord>();

  const memberships: Array<{
    userId: string;
    username: string;
    groupId: string;
    role: GroupRole;
    privacy: PrivacyMode;
    privacyOverrideUntil?: Date | null;
  }> = [
    { userId: alice.id, username: alice.username, groupId: GROUP_EXACT, role: 'MEMBER', privacy: 'EXACT' },
    { userId: alice.id, username: alice.username, groupId: GROUP_FUZZED, role: 'MEMBER', privacy: 'FUZZED' },
    { userId: alice.id, username: alice.username, groupId: GROUP_GHOST, role: 'MEMBER', privacy: 'GHOST' },
    { userId: alice.id, username: alice.username, groupId: GROUP_SPECTATOR, role: 'SPECTATOR', privacy: 'EXACT' },
  ];

  const effectivePrivacy = (
    m: { privacy: PrivacyMode; privacyOverrideUntil?: Date | null },
    now: Date,
  ): PrivacyMode =>
    m.privacyOverrideUntil && m.privacyOverrideUntil > now ? 'EXACT' : m.privacy;

  const locationBroadcasts: LocationBroadcast[] = [];
  const locationRemovals: Array<{ groupId: string; userId: string }> = [];
  const presenceBroadcasts: MemberPresenceUpdate[] = [];
  const chatBroadcasts: ChatMessage[] = [];
  const checkinRequestBroadcasts: LocationRequestItem[] = [];
  const checkinResponseBroadcasts: LocationRequestItem[] = [];
  const placeTransitionBroadcasts: PlaceTransitionEvent[] = [];
  const privatePlacesUpdates: GroupPlace[][] = [];

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
    async listMembershipsForUser(userId, now = new Date(currentNowMs)) {
      return memberships
        .filter((m) => m.userId === userId)
        .map((m) => ({
          groupId: m.groupId,
          role: m.role,
          privacy: effectivePrivacy(m, now),
        }));
    },
    async getGroupMembershipPrivacyInfo(userId, groupId, now = new Date(currentNowMs)) {
      const m = memberships.find((x) => x.userId === userId && x.groupId === groupId);
      if (!m) return null;
      const activeUntil =
        m.privacyOverrideUntil && m.privacyOverrideUntil > now
          ? m.privacyOverrideUntil.toISOString()
          : null;
      return {
        role: m.role,
        privacy: m.privacy,
        effectivePrivacy: effectivePrivacy(m, now),
        privacyOverrideUntil: activeUntil,
      };
    },
    async getLatestUserLocation(userId) {
      const userPts = storedPoints.filter((p) => p.userId === userId);
      return userPts[userPts.length - 1]?.point ?? null;
    },
    async getLatestGroupLocations(groupId, now = new Date(currentNowMs)): Promise<GroupMemberLocationRow[]> {
      const rows: GroupMemberLocationRow[] = [];
      for (const member of memberships.filter((m) => m.groupId === groupId && m.role !== 'SPECTATOR')) {
        const memberPts = storedPoints.filter((p) => p.userId === member.userId);
        const latest = memberPts[memberPts.length - 1];
        if (!latest) continue;
        rows.push({
          userId: member.userId,
          username: member.username,
          role: member.role,
          privacy: effectivePrivacy(member, now),
          latitude: latest.point.latitude,
          longitude: latest.point.longitude,
          altitude: latest.point.altitude ?? null,
          speed: latest.point.speed ?? null,
          batteryLevel: latest.point.batteryLevel ?? null,
          recordedAt: latest.point.recordedAt,
        });
      }
      return rows;
    },
    async getGroupTrails(options) {
      const now = options.now ?? new Date(currentNowMs);
      const fromMs = options.from.getTime();
      const toMs = options.to.getTime();
      const rows: GroupMemberLocationRow[] = [];
      for (const entry of storedPoints) {
        const member = memberships.find(
          (m) =>
            m.groupId === options.groupId &&
            m.userId === entry.userId &&
            m.role !== 'SPECTATOR' &&
            effectivePrivacy(m, now) !== 'GHOST',
        );
        if (!member) continue;
        if (options.userId && entry.userId !== options.userId) continue;
        const ts = Date.parse(entry.point.recordedAt);
        if (ts < fromMs || ts > toMs) continue;
        if (
          options.bbox &&
          (entry.point.longitude < options.bbox.minLon ||
            entry.point.longitude > options.bbox.maxLon ||
            entry.point.latitude < options.bbox.minLat ||
            entry.point.latitude > options.bbox.maxLat)
        ) {
          continue;
        }
        rows.push({
          userId: entry.userId,
          username: member.username,
          role: member.role,
          privacy: effectivePrivacy(member, now),
          latitude: entry.point.latitude,
          longitude: entry.point.longitude,
          altitude: entry.point.altitude ?? null,
          speed: entry.point.speed ?? null,
          batteryLevel: entry.point.batteryLevel ?? null,
          recordedAt: entry.point.recordedAt,
        });
      }
      rows.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
      return rows.slice(0, options.limit ?? 1000);
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
    async createLocationRequest(input) {
      const reqMember = memberships.find(
        (m) => m.userId === input.requesterId && m.groupId === input.groupId,
      );
      const tgtMember = memberships.find(
        (m) => m.userId === input.targetUserId && m.groupId === input.groupId,
      );
      const item: LocationRequestItem = {
        id: `dddddddd-dddd-4ddd-8ddd-${String(storedRequests.length + 1).padStart(12, '0')}`,
        groupId: input.groupId,
        requesterId: input.requesterId,
        requesterUsername: reqMember?.username ?? 'Requester',
        targetUserId: input.targetUserId,
        targetUsername: tgtMember?.username ?? 'Target',
        status: 'pending',
        suggestedDurationMinutes: input.suggestedDurationMinutes,
        message: input.message ?? null,
        expiresAt: input.expiresAt.toISOString(),
        respondedAt: null,
        createdAt: (input.now ?? new Date(currentNowMs)).toISOString(),
      };
      storedRequests.push(item);
      return item;
    },
    async listLocationRequestsForUser(groupId, userId, now = new Date(currentNowMs)) {
      for (const req of storedRequests) {
        if (req.groupId === groupId && req.status === 'pending' && Date.parse(req.expiresAt) <= now.getTime()) {
          req.status = 'expired';
        }
      }
      return storedRequests.filter(
        (r) => r.groupId === groupId && (r.requesterId === userId || r.targetUserId === userId),
      );
    },
    async respondToLocationRequest(input) {
      const now = input.now ?? new Date(currentNowMs);
      const item = storedRequests.find((r) => r.id === input.requestId && r.groupId === input.groupId);
      if (!item) return { kind: 'not_found' };
      if (item.targetUserId !== input.responderUserId) return { kind: 'forbidden' };
      if (item.status === 'expired' || (item.status === 'pending' && Date.parse(item.expiresAt) <= now.getTime())) {
        item.status = 'expired';
        return { kind: 'expired' };
      }
      if (item.status !== 'pending') return { kind: 'already_responded', status: item.status };

      item.status = input.action === 'accept' ? 'accepted' : 'declined';
      item.respondedAt = now.toISOString();
      let privacyOverrideUntil: string | null = null;
      if (input.action === 'accept') {
        const dur = input.durationMinutes ?? item.suggestedDurationMinutes;
        const until = new Date(now.getTime() + dur * 60_000);
        const member = memberships.find(
          (m) => m.userId === input.responderUserId && m.groupId === input.groupId,
        );
        if (member) {
          member.privacyOverrideUntil =
            member.privacyOverrideUntil && member.privacyOverrideUntil > until
              ? member.privacyOverrideUntil
              : until;
          privacyOverrideUntil = member.privacyOverrideUntil.toISOString();
        }
      }
      return { kind: 'ok', request: { ...item }, privacyOverrideUntil };
    },
    async createGroupPlace(input) {
      const place: GroupPlace = {
        id: `eeeeeeee-eeee-4eee-8eee-${String(storedPlaces.length + 1).padStart(12, '0')}`,
        groupId: input.groupId,
        isPrivate: Boolean(input.isPrivate || !input.groupId),
        name: input.name,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters: input.radiusMeters,
        createdBy: input.createdBy,
        createdAt: new Date(currentNowMs).toISOString(),
      };
      storedPlaces.push(place);
      return place;
    },
    async listGroupPlaces(groupId) {
      return storedPlaces.filter((p) => p.groupId === groupId && !p.isPrivate);
    },
    async listPrivatePlaces(userId) {
      return storedPlaces.filter((p) => p.isPrivate && p.createdBy === userId);
    },
    async listAccessiblePlaces(userId, groupId) {
      return storedPlaces.filter(
        (p) =>
          (p.isPrivate && p.createdBy === userId) ||
          (!p.isPrivate && (groupId ? p.groupId === groupId : true)),
      );
    },
    async findPlaceById(placeId) {
      return storedPlaces.find((p) => p.id === placeId) ?? null;
    },
    async deletePlaceById(placeId) {
      const idx = storedPlaces.findIndex((p) => p.id === placeId);
      if (idx === -1) return false;
      storedPlaces.splice(idx, 1);
      return true;
    },
    async deleteGroupPlace(groupId, placeId) {
      const idx = storedPlaces.findIndex((p) => p.groupId === groupId && p.id === placeId);
      if (idx === -1) return false;
      storedPlaces.splice(idx, 1);
      return true;
    },
    async listRecentPlaceTransitions(groupId, limit = 50) {
      return storedPlaceTransitions.filter((e) => e.groupId === groupId).slice(0, limit);
    },
    async evaluatePlaceTransitions(input) {
      const events: PlaceTransitionEvent[] = [];
      for (const place of storedPlaces.filter((p) => p.groupId === input.groupId)) {
        const dist = haversineMeters(place.latitude, place.longitude, input.latitude, input.longitude);
        const isInsideNow = dist <= place.radiusMeters;
        const key = `${place.id}:${input.userId}`;
        const prev = placeInsideState.get(key);
        if (prev === undefined && !isInsideNow) {
          placeInsideState.set(key, false);
          continue;
        }
        const wasInside = prev ?? false;
        if (wasInside === isInsideNow) continue;
        placeInsideState.set(key, isInsideNow);
        const evt: PlaceTransitionEvent = {
          groupId: input.groupId,
          placeId: place.id,
          placeName: place.name,
          userId: input.userId,
          username: input.username,
          transition: isInsideNow ? 'enter' : 'exit',
          recordedAt: input.recordedAt,
        };
        storedPlaceTransitions.unshift(evt);
        events.push(evt);
      }
      return events;
    },
    async getUserPresence(userId) {
      return presenceByUser.get(userId) ?? null;
    },
    async setUserPresence(userId, record) {
      presenceByUser.set(userId, record);
    },
    async getUsersPresence(userIds) {
      const map = new Map<string, UserPresenceRecord>();
      for (const id of userIds) {
        const rec = presenceByUser.get(id);
        if (rec) map.set(id, rec);
      }
      return map;
    },
  };

  const broadcaster: RealtimeBroadcaster = {
    broadcastLocation(_groupId, update) {
      locationBroadcasts.push(update);
    },
    broadcastLocationRemoved(groupId, userId) {
      locationRemovals.push({ groupId, userId });
    },
    broadcastPresenceUpdate(_groupId, update) {
      presenceBroadcasts.push(update);
    },
    broadcastChatMessage(_groupId, message) {
      chatBroadcasts.push(message);
    },
    broadcastLocationRequest(_requesterId, _targetUserId, request) {
      checkinRequestBroadcasts.push(request);
    },
    broadcastLocationRequestResponse(_requesterId, _targetUserId, request) {
      checkinResponseBroadcasts.push(request);
    },
    broadcastPlaceTransition(_groupId, event) {
      placeTransitionBroadcasts.push(event);
    },
    broadcastPlacesUpdated() {},
    broadcastPrivatePlacesUpdated(_userId, places) {
      privatePlacesUpdates.push(places);
    },
  };

  const mod = new RealtimeModule({ store, broadcaster, now: () => currentNowMs });
  return {
    mod,
    store,
    broadcaster,
    locationBroadcasts,
    locationRemovals,
    presenceBroadcasts,
    chatBroadcasts,
    checkinRequestBroadcasts,
    checkinResponseBroadcasts,
    placeTransitionBroadcasts,
    privatePlacesUpdates,
    storedPoints,
    memberships,
    setNowMs: (ms: number) => {
      currentNowMs = ms;
    },
  };
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

  it('computes deterministic ETag/since snapshots and privacy-safe bounding-box trails', async () => {
    const { mod, memberships } = createInMemoryRealtimeHarness();
    const t1 = '2026-11-19T10:00:00.000Z';
    const t2 = '2026-11-19T11:00:00.000Z';
    const t3 = '2026-11-19T12:00:00.000Z';

    await mod.ingestLocationBatch(alice, {
      points: [
        { latitude: 52.52, longitude: 13.405, recordedAt: t1 },
        { latitude: 52.525, longitude: 13.41, recordedAt: t2 },
      ],
    });
    // Later spaced Munich fix outside Berlin bbox
    await mod.ingestLocationBatch(alice, {
      points: [{ latitude: 48.1351, longitude: 11.582, recordedAt: t3 }],
    });

    // 1. ETag matching & changes across since / privacy mutations
    const snap1 = await mod.getGroupLocationsSnapshot(alice, GROUP_EXACT);
    const snap2 = await mod.getGroupLocationsSnapshot(alice, GROUP_EXACT);
    expect(snap1.etag).toBe(snap2.etag);
    expect(snap1.lastModified).toBe(new Date(t3).toUTCString());
    expect(matchesIfNoneMatch(snap1.etag, snap1.etag)).toBe(true);
    expect(matchesIfNoneMatch(`W/${snap1.etag}`, snap1.etag)).toBe(true);
    expect(matchesIfNoneMatch('"other", *', snap1.etag)).toBe(true);
    expect(matchesIfNoneMatch('"other"', snap1.etag)).toBe(false);

    // ?since=t3 excludes t3 (requires strictly newer recordedAt)
    const emptySince = await mod.getGroupLocationsSnapshot(alice, GROUP_EXACT, { since: t3 });
    expect(emptySince.locations).toHaveLength(0);
    expect(emptySince.etag).not.toBe(snap1.etag);

    // Switching privacy on GROUP_EXACT changes ETag immediately
    const exactMembership = memberships.find((m) => m.groupId === GROUP_EXACT)!;
    exactMembership.privacy = 'FUZZED';
    const fuzzedSnap = await mod.getGroupLocationsSnapshot(alice, GROUP_EXACT);
    expect(fuzzedSnap.etag).not.toBe(snap1.etag);
    expect(fuzzedSnap.locations[0]?.isFuzzed).toBe(true);
    exactMembership.privacy = 'EXACT';

    // 2. Bounding-box + time-window trail filtering & privacy rules
    const berlinTrail = await mod.getGroupTrails(alice, GROUP_EXACT, {
      from: '2026-11-19T09:00:00.000Z',
      to: '2026-11-19T13:00:00.000Z',
      bbox: '13.0,52.3,13.8,52.7',
    });
    expect(berlinTrail.map((p) => p.recordedAt)).toEqual([t1, t2]);
    expect(berlinTrail.every((p) => p.privacyMode === 'EXACT' && !p.isFuzzed)).toBe(true);

    const fuzzedTrail = await mod.getGroupTrails(alice, GROUP_FUZZED, {
      from: '2026-11-19T09:00:00.000Z',
      to: '2026-11-19T13:00:00.000Z',
      bbox: '13.0,52.3,13.8,52.7',
    });
    expect(fuzzedTrail).toHaveLength(2);
    expect(fuzzedTrail.every((p) => p.isFuzzed && p.privacyMode === 'FUZZED')).toBe(true);

    // GHOST and SPECTATOR groups never return trail coordinates
    expect(
      await mod.getGroupTrails(alice, GROUP_GHOST, {
        from: '2026-11-19T09:00:00.000Z',
        to: '2026-11-19T13:00:00.000Z',
      }),
    ).toHaveLength(0);
    expect(
      await mod.getGroupTrails(alice, GROUP_SPECTATOR, {
        from: '2026-11-19T09:00:00.000Z',
        to: '2026-11-19T13:00:00.000Z',
      }),
    ).toHaveLength(0);

    // Validation & access control checks
    await expect(mod.getGroupLocationsSnapshot(alice, GROUP_EXACT, { since: 'bad' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(mod.getGroupTrails(alice, GROUP_EXACT, { bbox: '10,20' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(mod.getGroupTrails(outsider, GROUP_EXACT, {})).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('supports expiring check-in overrides and privacy-restricted geofenced place alerts', async () => {
    const harness = createInMemoryRealtimeHarness();
    const {
      mod,
      memberships,
      locationBroadcasts,
      checkinRequestBroadcasts,
      checkinResponseBroadcasts,
      placeTransitionBroadcasts,
      setNowMs,
    } = harness;

    // Make outsider (Bob) an ADMIN of GROUP_EXACT and Alice a GHOST member of GROUP_EXACT
    const aliceExact = memberships.find((m) => m.groupId === GROUP_EXACT)!;
    aliceExact.privacy = 'GHOST';
    memberships.push({
      userId: outsider.id,
      username: outsider.username,
      groupId: GROUP_EXACT,
      role: 'ADMIN',
      privacy: 'EXACT',
    });

    // Alice records an offline GPS point while GHOST
    await mod.ingestLocationBatch(alice, {
      points: [
        {
          latitude: 52.52,
          longitude: 13.405,
          recordedAt: '2026-11-19T12:00:00.000Z',
        },
      ],
    });
    expect(locationBroadcasts).toHaveLength(1); // Only GROUP_FUZZED (GROUP_EXACT is GHOST)

    // Non-admin Alice cannot create geofenced places
    await expect(
      mod.createGroupPlace(alice, GROUP_EXACT, {
        name: 'Home',
        latitude: 52.52,
        longitude: 13.405,
        radiusMeters: 200,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Admin Bob creates 'Home' around (52.52, 13.405)
    const home = await mod.createGroupPlace(outsider, GROUP_EXACT, {
      name: 'Home',
      latitude: 52.52,
      longitude: 13.405,
      radiusMeters: 200,
    });

    // FUZZED group also gets a place, to confirm FUZZED mode never emits place transitions
    memberships.find((m) => m.groupId === GROUP_FUZZED)!.role = 'ADMIN';
    await mod.createGroupPlace(alice, GROUP_FUZZED, {
      name: 'Fuzzed Place',
      latitude: 52.52,
      longitude: 13.405,
      radiusMeters: 200,
    });

    // Bob requests check-in from Alice for 15 minutes
    const req = await mod.createCheckInRequest(outsider, GROUP_EXACT, {
      targetUserId: alice.id,
      suggestedDurationMinutes: 15,
      expiresInMinutes: 10,
      message: 'Home safely?',
    });
    expect(checkinRequestBroadcasts).toHaveLength(1);

    // Non-target Bob cannot respond
    await expect(
      mod.respondToCheckInRequest(outsider, GROUP_EXACT, req.id, { action: 'accept' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Alice accepts -> broadcast response + immediate EXACT pin broadcast to GROUP_EXACT
    locationBroadcasts.length = 0;
    const accepted = await mod.respondToCheckInRequest(alice, GROUP_EXACT, req.id, {
      action: 'accept',
    });
    expect(accepted.privacyOverrideUntil).toBeTruthy();
    expect(checkinResponseBroadcasts).toHaveLength(1);
    expect(locationBroadcasts).toHaveLength(1);
    expect(locationBroadcasts[0]?.privacyMode).toBe('EXACT');
    expect(locationBroadcasts[0]?.isFuzzed).toBe(false);

    // While EXACT override active (+5m), Alice enters then exits Home -> transitions fire ONLY for GROUP_EXACT (never GROUP_FUZZED)
    setNowMs(Date.parse('2026-11-19T12:05:00.000Z'));
    await mod.ingestLocationBatch(alice, {
      points: [
        { latitude: 52.5202, longitude: 13.405, recordedAt: '2026-11-19T12:05:00.000Z' },
        { latitude: 52.53, longitude: 13.405, recordedAt: '2026-11-19T12:06:00.000Z' },
      ],
    });
    expect(placeTransitionBroadcasts.map((e) => `${e.groupId}:${e.transition}`)).toEqual([
      `${GROUP_EXACT}:enter`,
      `${GROUP_EXACT}:exit`,
    ]);

    // After override expires (+20m), Alice reverts automatically to GHOST and triggers no place alerts
    setNowMs(Date.parse('2026-11-19T12:20:00.000Z'));
    placeTransitionBroadcasts.length = 0;
    locationBroadcasts.length = 0;
    await mod.ingestLocationBatch(alice, {
      points: [{ latitude: 52.5202, longitude: 13.405, recordedAt: '2026-11-19T12:20:00.000Z' }],
    });
    expect(locationBroadcasts.map((l) => l.groupId)).toEqual([GROUP_FUZZED]);
    expect(placeTransitionBroadcasts).toHaveLength(0);

    // Cleanup place
    await mod.deleteGroupPlace(outsider, GROUP_EXACT, home.id);
    expect((await mod.listGroupPlaces(outsider, GROUP_EXACT)).places).toHaveLength(0);
  });

  it('includes latest profile avatarUrl and updated username on live location broadcasts', async () => {
    const harness = createInMemoryRealtimeHarness();
    harness.store.getUserProfile = async () => ({
      username: 'Alice New',
      avatarUrl: 'https://cdn.example.com/alice.png',
    });

    await harness.mod.ingestLocationBatch(alice, {
      points: [{ latitude: 52.52, longitude: 13.405, recordedAt: '2026-11-19T12:00:00.000Z' }],
    });

    expect(harness.locationBroadcasts.length).toBeGreaterThan(0);
    expect(harness.locationBroadcasts[0]?.username).toBe('Alice New');
    expect(harness.locationBroadcasts[0]?.avatarUrl).toBe('https://cdn.example.com/alice.png');
  });

  it('supports private places per user and shared group places cleanly', async () => {
    const harness = createInMemoryRealtimeHarness();
    harness.memberships.push({
      userId: outsider.id,
      username: outsider.username,
      groupId: GROUP_EXACT,
      role: 'MEMBER',
      privacy: 'EXACT',
    });
    const priv = await harness.mod.createPlace(alice, {
      name: 'Secret Bakery',
      latitude: 52.51,
      longitude: 13.41,
      radiusMeters: 120,
      isPrivate: true,
    });
    expect(priv.isPrivate).toBe(true);
    expect(priv.groupId).toBeNull();
    expect(harness.privatePlacesUpdates).toHaveLength(1);

    const alicePlaces = await harness.mod.listAccessiblePlaces(alice, GROUP_EXACT);
    expect(alicePlaces.places.some((p) => p.id === priv.id)).toBe(true);

    const bobPlaces = await harness.mod.listAccessiblePlaces(outsider, GROUP_EXACT);
    expect(bobPlaces.places.some((p) => p.id === priv.id)).toBe(false);

    await expect(harness.mod.deletePlace(outsider, priv.id)).rejects.toMatchObject({
      statusCode: 403,
    });

    await harness.mod.deletePlace(alice, priv.id);
    const aliceAfter = await harness.mod.listAccessiblePlaces(alice, GROUP_EXACT);
    expect(aliceAfter.places.some((p) => p.id === priv.id)).toBe(false);
  });

  it('immediately removes pin when switching to GHOST and re-broadcasts on switch back', async () => {
    const harness = createInMemoryRealtimeHarness();
    await harness.mod.ingestLocationBatch(alice, {
      points: [{ latitude: 52.52, longitude: 13.405, recordedAt: '2026-11-21T12:00:00.000Z' }],
    });
    harness.locationBroadcasts.length = 0;

    const exactMembership = harness.memberships.find((m) => m.groupId === GROUP_EXACT)!;
    exactMembership.privacy = 'GHOST';
    await harness.mod.handleMemberPrivacyUpdated(alice.id, GROUP_EXACT);
    expect(harness.locationRemovals).toEqual([{ groupId: GROUP_EXACT, userId: alice.id }]);

    exactMembership.privacy = 'FUZZED';
    await harness.mod.handleMemberPrivacyUpdated(alice.id, GROUP_EXACT);
    expect(harness.locationBroadcasts).toHaveLength(1);
    expect(harness.locationBroadcasts[0]?.privacyMode).toBe('FUZZED');
    expect(harness.locationBroadcasts[0]?.isFuzzed).toBe(true);
  });

  it('coalesces stationary pings (< 20m) into Redis presence and broadcasts privacy-filtered heartbeats', async () => {
    const harness = createInMemoryRealtimeHarness();
    const t0 = Date.parse('2026-11-22T15:06:00.000Z');
    harness.setNowMs(t0);

    // 1. Initial fix is persisted normally and marks presence active
    const firstInserted = await harness.mod.ingestLocationBatch(alice, {
      points: [
        {
          latitude: 52.52417,
          longitude: 13.51754,
          batteryLevel: 20,
          recordedAt: '2026-11-22T15:06:00.000Z',
        },
      ],
    });
    expect(firstInserted).toBe(1);
    expect(harness.storedPoints).toHaveLength(1);
    expect(harness.locationBroadcasts).toHaveLength(2); // EXACT + FUZZED (GHOST/SPECTATOR suppressed)
    expect(harness.locationBroadcasts[0]?.trackingState).toBe('active');
    expect(harness.locationBroadcasts[0]?.lastHeartbeatAt).toBe('2026-11-22T15:06:00.000Z');

    // 2. Stationary ping 5 minutes later (< 20m moved) skips DB insert, refreshes presence as idle,
    //    updates batteryLevel, and broadcasts presence:update ONLY to EXACT and FUZZED
    harness.setNowMs(t0 + 5 * 60_000);
    const stationaryInserted = await harness.mod.ingestLocationBatch(alice, {
      points: [
        {
          latitude: 52.52419,
          longitude: 13.51756,
          batteryLevel: 16,
          recordedAt: '2026-11-22T15:11:00.000Z',
        },
      ],
    });
    expect(stationaryInserted).toBe(0);
    expect(harness.storedPoints).toHaveLength(1); // No DB bloat!
    expect(harness.locationBroadcasts).toHaveLength(2); // No redundant location:update
    expect(harness.presenceBroadcasts.map((p) => p.groupId)).toEqual([GROUP_EXACT, GROUP_FUZZED]);
    expect(harness.presenceBroadcasts[0]?.trackingState).toBe('idle');
    expect(harness.presenceBroadcasts[0]?.batteryLevel).toBe(16);

    // 3. Snapshot preserves recordedAt (15:06) while exposing fresh lastHeartbeatAt (15:11) & battery (16)
    const snap = await harness.mod.getGroupLocations(alice, GROUP_EXACT);
    expect(snap).toHaveLength(1);
    expect(snap[0]?.recordedAt).toBe('2026-11-22T15:06:00.000Z');
    expect(snap[0]?.lastHeartbeatAt).toBe('2026-11-22T15:11:00.000Z');
    expect(snap[0]?.trackingState).toBe('idle');
    expect(snap[0]?.batteryLevel).toBe(16);

    // 4. Explicit watchdog / pause heartbeat updates trackingState without touching location_history
    harness.presenceBroadcasts.length = 0;
    harness.setNowMs(t0 + 10 * 60_000);
    const hb = await harness.mod.recordHeartbeat(alice, {
      trackingState: 'paused',
      batteryLevel: 15,
    });
    expect(hb.trackingState).toBe('paused');
    expect(harness.presenceBroadcasts.map((p) => p.groupId)).toEqual([GROUP_EXACT, GROUP_FUZZED]);
    expect(harness.presenceBroadcasts[0]?.trackingState).toBe('paused');
    expect(harness.presenceBroadcasts[0]?.batteryLevel).toBe(15);
  });

  it('invokes onLocationIngested hook only when new points are inserted', async () => {
    const harness = createInMemoryRealtimeHarness();
    const calls: Array<{ userId: string; inserted: number }> = [];
    const mod = new RealtimeModule({
      store: harness.store,
      broadcaster: harness.broadcaster,
      onLocationIngested: async (userId, inserted) => {
        calls.push({ userId, inserted });
      },
    });

    const first = await mod.ingestLocationBatch(alice, {
      points: [{ latitude: 52.52, longitude: 13.405, recordedAt: '2026-11-21T12:00:00.000Z' }],
    });
    expect(first).toBe(1);
    expect(calls).toEqual([{ userId: alice.id, inserted: 1 }]);

    // Duplicate timestamp inserts 0 -> hook not re-triggered
    const dup = await mod.ingestLocationBatch(alice, {
      points: [{ latitude: 52.52, longitude: 13.405, recordedAt: '2026-11-21T12:00:00.000Z' }],
    });
    expect(dup).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('drops transient coarse lateral Wi-Fi/cell bounces while preserving genuine street turns and stripping FUZZED accuracy/heading', async () => {
    const filtered = filterAnomalousLocationPoints([
      {
        latitude: 52.51,
        longitude: 13.52,
        accuracy: 12,
        recordedAt: '2026-11-22T12:00:00.000Z',
      },
      {
        // Sudden 180m coarse lateral jump south into a supermarket in 15s, then back to main road
        latitude: 52.5083,
        longitude: 13.521,
        accuracy: 110,
        recordedAt: '2026-11-22T12:00:15.000Z',
      },
      {
        latitude: 52.51,
        longitude: 13.522,
        accuracy: 10,
        recordedAt: '2026-11-22T12:00:30.000Z',
      },
    ]);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((p) => p.longitude)).toEqual([13.52, 13.522]);

    // Real 90-degree turn stays intact
    const corner = filterAnomalousLocationPoints([
      {
        latitude: 52.51,
        longitude: 13.52,
        accuracy: 15,
        recordedAt: '2026-11-22T12:01:00.000Z',
      },
      {
        latitude: 52.51,
        longitude: 13.522,
        accuracy: 15,
        recordedAt: '2026-11-22T12:01:15.000Z',
      },
      {
        latitude: 52.512,
        longitude: 13.522,
        accuracy: 15,
        recordedAt: '2026-11-22T12:01:30.000Z',
      },
    ]);
    expect(corner).toHaveLength(3);

    const harness = createInMemoryRealtimeHarness();
    await harness.mod.ingestLocationBatch(alice, {
      points: [
        {
          latitude: 52.52,
          longitude: 13.405,
          accuracy: 9,
          heading: 92,
          recordedAt: '2026-11-22T12:05:00.000Z',
        },
      ],
    });
    const exactPin = harness.locationBroadcasts.find((b) => b.groupId === GROUP_EXACT);
    const fuzzedPin = harness.locationBroadcasts.find((b) => b.groupId === GROUP_FUZZED);
    expect(exactPin?.accuracy).toBe(9);
    expect(exactPin?.heading).toBe(92);
    expect(fuzzedPin?.accuracy).toBeNull();
    expect(fuzzedPin?.heading).toBeNull();
  });
});
