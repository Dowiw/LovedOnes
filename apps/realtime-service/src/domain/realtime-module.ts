import { createHash } from 'node:crypto';
import {
  GroupMemberLocationRow,
  GroupMembershipPrivacyInfo,
  GroupTrailQueryOptions,
  RespondLocationRequestDbResult,
} from '@loved-ones/db';
import {
  applyPrivacyFuzzing,
  BoundingBox,
  ChatMessage,
  CreateGroupPlaceSchema,
  CreateLocationRequestSchema,
  GroupPlace,
  GroupRole,
  haversineMeters,
  JwtUserPayload,
  LocationBatchSchema,
  LocationBroadcast,
  LocationPoint,
  LocationRequestItem,
  LocationSnapshotQuerySchema,
  normalizeOverlandToPoints,
  normalizeOwnTracksToPoints,
  parseBoundingBox,
  PlaceTransitionEvent,
  PrivacyMode,
  RespondLocationRequestSchema,
  SendMessageSchema,
  TrailQuerySchema,
} from '@loved-ones/shared';
export { haversineMeters };
import { DomainError } from '@loved-ones/shared/auth';

export interface RealtimeStore {
  isGroupMember(userId: string, groupId: string): Promise<boolean>;
  getUserProfile?(userId: string): Promise<{
    username: string;
    avatarUrl: string | null;
    haloColor?: string | null;
    fuzzCircleColor?: string | null;
  } | null>;
  listUserGroupIds(userId: string): Promise<string[]>;
  insertLocationBatch(userId: string, points: LocationPoint[]): Promise<number>;
  listMembershipsForUser(
    userId: string,
    now?: Date,
  ): Promise<Array<{ groupId: string; role: GroupRole; privacy: PrivacyMode }>>;
  getGroupMembershipPrivacyInfo(
    userId: string,
    groupId: string,
    now?: Date,
  ): Promise<GroupMembershipPrivacyInfo | null>;
  getLatestUserLocation(userId: string): Promise<LocationPoint | null>;
  getLatestGroupLocations(groupId: string, now?: Date): Promise<GroupMemberLocationRow[]>;
  getGroupTrails(options: GroupTrailQueryOptions): Promise<GroupMemberLocationRow[]>;
  getGroupMessages(groupId: string, limit?: number): Promise<ChatMessage[]>;
  insertChatMessage(
    groupId: string,
    senderId: string,
    senderUsername: string,
    content: string,
  ): Promise<ChatMessage>;
  createLocationRequest(input: {
    groupId: string;
    requesterId: string;
    targetUserId: string;
    suggestedDurationMinutes: number;
    expiresAt: Date;
    message?: string;
    now?: Date;
  }): Promise<LocationRequestItem>;
  listLocationRequestsForUser(
    groupId: string,
    userId: string,
    now?: Date,
  ): Promise<LocationRequestItem[]>;
  respondToLocationRequest(input: {
    groupId: string;
    requestId: string;
    responderUserId: string;
    action: 'accept' | 'decline';
    durationMinutes?: number;
    now?: Date;
  }): Promise<RespondLocationRequestDbResult>;
  createGroupPlace(input: {
    groupId: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    createdBy: string;
  }): Promise<GroupPlace>;
  listGroupPlaces(groupId: string): Promise<GroupPlace[]>;
  deleteGroupPlace(groupId: string, placeId: string): Promise<boolean>;
  listRecentPlaceTransitions(groupId: string, limit?: number): Promise<PlaceTransitionEvent[]>;
  evaluatePlaceTransitions(input: {
    groupId: string;
    userId: string;
    username: string;
    latitude: number;
    longitude: number;
    recordedAt: string;
  }): Promise<PlaceTransitionEvent[]>;
}

export interface RealtimeBroadcaster {
  broadcastLocation(groupId: string, update: LocationBroadcast): void;
  broadcastChatMessage(groupId: string, message: ChatMessage): void;
  broadcastLocationRequest(
    requesterId: string,
    targetUserId: string,
    request: LocationRequestItem,
  ): void;
  broadcastLocationRequestResponse(
    requesterId: string,
    targetUserId: string,
    request: LocationRequestItem,
  ): void;
  broadcastPlaceTransition(groupId: string, event: PlaceTransitionEvent): void;
  broadcastPlacesUpdated(groupId: string, places: GroupPlace[]): void;
}

const DEFAULT_MAX_ACCURACY_METERS = 1000;
const DEFAULT_MAX_JUMP_SPEED_MPS = 350;
const DEFAULT_MIN_JUMP_DISTANCE_METERS = 5000;

export interface CoordinateFilterOptions {
  maxAccuracyMeters?: number;
  maxJumpSpeedMps?: number;
  minJumpDistanceMeters?: number;
}

/**
 * Returns true when coordinates fall on or immediately around Null Island (0, 0),
 * which GPS chips commonly emit before acquiring a valid satellite lock.
 */
export function isNullIsland(latitude: number, longitude: number): boolean {
  return Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001;
}

/**
 * Drops Null Island (0, 0) glitches, coarse fixes exceeding maxAccuracyMeters,
 * and impossible intra-batch velocity teleports, returning surviving points
 * ordered chronologically so callers can safely take the last element as latest.
 */
export function filterAnomalousLocationPoints<
  T extends { latitude: number; longitude: number; accuracy?: number | null; recordedAt: string },
>(points: readonly T[], options: CoordinateFilterOptions = {}): T[] {
  const maxAccuracyMeters = options.maxAccuracyMeters ?? DEFAULT_MAX_ACCURACY_METERS;
  const maxJumpSpeedMps = options.maxJumpSpeedMps ?? DEFAULT_MAX_JUMP_SPEED_MPS;
  const minJumpDistanceMeters = options.minJumpDistanceMeters ?? DEFAULT_MIN_JUMP_DISTANCE_METERS;

  const sortedCandidates = points
    .filter((pt) => {
      if (isNullIsland(pt.latitude, pt.longitude)) return false;
      if (
        typeof pt.accuracy === 'number' &&
        Number.isFinite(pt.accuracy) &&
        pt.accuracy > maxAccuracyMeters
      ) {
        return false;
      }
      return true;
    })
    .map((pt, index) => ({ pt, index, ts: Date.parse(pt.recordedAt) }))
    .sort((a, b) => {
      if (Number.isFinite(a.ts) && Number.isFinite(b.ts) && a.ts !== b.ts) {
        return a.ts - b.ts;
      }
      return a.index - b.index;
    });

  const accepted: T[] = [];
  let lastAccepted: { pt: T; ts: number } | null = null;

  for (const item of sortedCandidates) {
    if (lastAccepted && Number.isFinite(lastAccepted.ts) && Number.isFinite(item.ts)) {
      const dtSeconds = Math.max(0, (item.ts - lastAccepted.ts) / 1000);
      const distanceMeters = haversineMeters(
        lastAccepted.pt.latitude,
        lastAccepted.pt.longitude,
        item.pt.latitude,
        item.pt.longitude,
      );
      const maxAllowedDistance = Math.max(minJumpDistanceMeters, maxJumpSpeedMps * dtSeconds);
      if (distanceMeters > maxAllowedDistance) {
        continue;
      }
    }
    accepted.push(item.pt);
    lastAccepted = { pt: item.pt, ts: item.ts };
  }

  return accepted;
}

const FUZZED_BBOX_PAD_DEG = 0.015;

export interface GroupLocationSnapshot {
  locations: LocationBroadcast[];
  etag: string;
  lastModified: string | null;
}

/**
 * Checks whether an HTTP If-None-Match header value matches the current entity tag.
 */
export function matchesIfNoneMatch(
  headerValue: string | string[] | undefined,
  etag: string,
): boolean {
  if (!headerValue) return false;
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  const normalizeTag = (tag: string) => tag.trim().replace(/^W\//i, '');
  const target = normalizeTag(etag);
  return raw
    .split(',')
    .map(normalizeTag)
    .some((candidate) => candidate === '*' || candidate === target);
}

function toPrivacySafeBroadcast(
  groupId: string,
  row: GroupMemberLocationRow,
): LocationBroadcast | null {
  if (row.role === 'SPECTATOR') return null;
  const recordedAtMs = new Date(row.recordedAt).getTime();
  const fuzzed = applyPrivacyFuzzing(
    row.latitude,
    row.longitude,
    row.privacy,
    row.userId,
    recordedAtMs,
  );
  if (!fuzzed.visible) return null;

  return {
    userId: row.userId,
    username: row.username,
    avatarUrl: row.avatarUrl ?? null,
    haloColor: row.haloColor ?? null,
    fuzzCircleColor: row.fuzzCircleColor ?? null,
    groupId,
    latitude: fuzzed.latitude,
    longitude: fuzzed.longitude,
    altitude: row.altitude,
    speed: row.speed,
    batteryLevel: row.batteryLevel,
    recordedAt: row.recordedAt,
    privacyMode: row.privacy,
    isFuzzed: fuzzed.isFuzzed,
  };
}

function padBoundingBox(bbox: BoundingBox): BoundingBox {
  return {
    minLon: Math.max(-180, bbox.minLon - FUZZED_BBOX_PAD_DEG),
    minLat: Math.max(-90, bbox.minLat - FUZZED_BBOX_PAD_DEG),
    maxLon: Math.min(180, bbox.maxLon + FUZZED_BBOX_PAD_DEG),
    maxLat: Math.min(90, bbox.maxLat + FUZZED_BBOX_PAD_DEG),
  };
}

function isInsideBoundingBox(lat: number, lon: number, bbox: BoundingBox): boolean {
  return lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;
}

export interface RealtimeModuleOptions extends CoordinateFilterOptions {
  store: RealtimeStore;
  broadcaster: RealtimeBroadcaster;
  now?: () => number;
  onPlaceTransition?: (event: PlaceTransitionEvent) => void;
}

/**
 * Deep domain module owning location batch ingestion, coordinate anomaly hygiene,
 * deterministic recordedAt-anchored privacy fuzzing, group location snapshots,
 * expiring check-in requests, geofenced group places, and group chat.
 */
export class RealtimeModule {
  private readonly store: RealtimeStore;
  private readonly broadcaster: RealtimeBroadcaster;
  private readonly filterOptions: CoordinateFilterOptions;
  private readonly now: () => number;
  private readonly onPlaceTransition?: (event: PlaceTransitionEvent) => void;

  constructor(options: RealtimeModuleOptions) {
    this.store = options.store;
    this.broadcaster = options.broadcaster;
    this.filterOptions = {
      maxAccuracyMeters: options.maxAccuracyMeters,
      maxJumpSpeedMps: options.maxJumpSpeedMps,
      minJumpDistanceMeters: options.minJumpDistanceMeters,
    };
    this.now = options.now ?? (() => Date.now());
    this.onPlaceTransition = options.onPlaceTransition;
  }

  private async requireMembership(
    userId: string,
    groupId: string,
  ): Promise<GroupMembershipPrivacyInfo> {
    const info = await this.store.getGroupMembershipPrivacyInfo(
      userId,
      groupId,
      new Date(this.now()),
    );
    if (!info) {
      throw new DomainError(403, 'Not a member of this group');
    }
    return info;
  }

  async ingestLocationBatch(user: JwtUserPayload, rawInput: unknown): Promise<number> {
    const parsed = LocationBatchSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid location batch', parsed.error.flatten());
    }
    const points = filterAnomalousLocationPoints(parsed.data.points, this.filterOptions);
    if (points.length === 0) {
      return 0;
    }
    const inserted = await this.store.insertLocationBatch(user.id, points);
    const latest = points[points.length - 1];
    if (!latest || inserted === 0) return inserted;

    const recordedAtMs = new Date(latest.recordedAt).getTime();
    const [memberships, profile] = await Promise.all([
      this.store.listMembershipsForUser(user.id, new Date(this.now())),
      this.store.getUserProfile?.(user.id).catch(() => null) ?? Promise.resolve(null),
    ]);
    const displayName = profile?.username ?? user.username;
    const avatarUrl = profile?.avatarUrl ?? null;
    const haloColor = profile?.haloColor ?? null;
    const fuzzCircleColor = profile?.fuzzCircleColor ?? null;

    for (const m of memberships) {
      if (m.role === 'SPECTATOR') continue;

      if (m.privacy === 'EXACT') {
        for (const pt of points) {
          const placeEvents = await this.store.evaluatePlaceTransitions({
            groupId: m.groupId,
            userId: user.id,
            username: displayName,
            latitude: pt.latitude,
            longitude: pt.longitude,
            recordedAt: pt.recordedAt,
          });
          for (const evt of placeEvents) {
            this.broadcaster.broadcastPlaceTransition(m.groupId, evt);
            this.onPlaceTransition?.(evt);
          }
        }
      }

      const fuzzed = applyPrivacyFuzzing(
        latest.latitude,
        latest.longitude,
        m.privacy,
        user.id,
        recordedAtMs,
      );
      if (!fuzzed.visible) continue;

      const broadcast: LocationBroadcast = {
        userId: user.id,
        username: displayName,
        avatarUrl,
        haloColor,
        fuzzCircleColor,
        groupId: m.groupId,
        latitude: fuzzed.latitude,
        longitude: fuzzed.longitude,
        altitude: latest.altitude ?? null,
        speed: latest.speed ?? null,
        batteryLevel: latest.batteryLevel ?? null,
        recordedAt: latest.recordedAt,
        privacyMode: m.privacy,
        isFuzzed: fuzzed.isFuzzed,
      };
      this.broadcaster.broadcastLocation(m.groupId, broadcast);
    }

    return inserted;
  }

  async ingestOwnTracks(
    user: JwtUserPayload,
    rawInput: unknown,
    nowMs = Date.now(),
  ): Promise<{ inserted: number; response: [] }> {
    let points: LocationPoint[];
    try {
      points = normalizeOwnTracksToPoints(rawInput, nowMs);
    } catch (err) {
      throw new DomainError(
        400,
        'Invalid OwnTracks payload',
        err instanceof Error ? err.message : undefined,
      );
    }
    if (points.length === 0) {
      return { inserted: 0, response: [] };
    }
    const inserted = await this.ingestLocationBatch(user, { points });
    return { inserted, response: [] };
  }

  async ingestOverland(
    user: JwtUserPayload,
    rawInput: unknown,
    nowMs = Date.now(),
  ): Promise<{ inserted: number; result: 'ok' }> {
    let points: LocationPoint[];
    try {
      points = normalizeOverlandToPoints(rawInput, nowMs);
    } catch (err) {
      throw new DomainError(
        400,
        'Invalid Overland payload',
        err instanceof Error ? err.message : undefined,
      );
    }
    if (points.length === 0) {
      return { inserted: 0, result: 'ok' };
    }
    const inserted = await this.ingestLocationBatch(user, { points });
    return { inserted, result: 'ok' };
  }

  async getGroupLocationsSnapshot(
    user: JwtUserPayload,
    groupId: string,
    rawQuery: unknown = {},
  ): Promise<GroupLocationSnapshot> {
    const parsed = LocationSnapshotQuerySchema.safeParse(rawQuery ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid location snapshot query', parsed.error.flatten());
    }
    if (!(await this.store.isGroupMember(user.id, groupId))) {
      throw new DomainError(403, 'Not a member of this group');
    }

    const rows = await this.store.getLatestGroupLocations(groupId, new Date(this.now()));
    const visibleAll = rows
      .map((row) => toPrivacySafeBroadcast(groupId, row))
      .filter((loc): loc is LocationBroadcast => loc !== null)
      .sort((a, b) => a.userId.localeCompare(b.userId));

    const sinceMs = parsed.data.since ? Date.parse(parsed.data.since) : null;
    const locations =
      sinceMs !== null
        ? visibleAll.filter((loc) => Date.parse(loc.recordedAt) > sinceMs)
        : visibleAll;

    const hash = createHash('sha256')
      .update(JSON.stringify({ since: parsed.data.since ?? null, locations }))
      .digest('hex')
      .slice(0, 24);

    let maxMs = 0;
    for (const loc of locations) {
      const ts = Date.parse(loc.recordedAt);
      if (Number.isFinite(ts) && ts > maxMs) maxMs = ts;
    }

    return {
      locations,
      etag: `"${hash}"`,
      lastModified: maxMs > 0 ? new Date(maxMs).toUTCString() : null,
    };
  }

  async getGroupLocations(user: JwtUserPayload, groupId: string): Promise<LocationBroadcast[]> {
    const snapshot = await this.getGroupLocationsSnapshot(user, groupId);
    return snapshot.locations;
  }

  async getGroupTrails(
    user: JwtUserPayload,
    groupId: string,
    rawQuery: unknown = {},
  ): Promise<LocationBroadcast[]> {
    const parsed = TrailQuerySchema.safeParse(rawQuery ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid trail query', parsed.error.flatten());
    }
    if (!(await this.store.isGroupMember(user.id, groupId))) {
      throw new DomainError(403, 'Not a member of this group');
    }

    const toDate = parsed.data.to ? new Date(parsed.data.to) : new Date();
    const fromDate = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(toDate.getTime() - 24 * 60 * 60 * 1000);
    if (fromDate > toDate) {
      return [];
    }

    const requestedBbox = parsed.data.bbox ? (parseBoundingBox(parsed.data.bbox) ?? undefined) : undefined;
    const rows = await this.store.getGroupTrails({
      groupId,
      from: fromDate,
      to: toDate,
      // Pad the spatial query margin so FUZZED grid centers remain evaluated post-fuzz
      bbox: requestedBbox ? padBoundingBox(requestedBbox) : undefined,
      userId: parsed.data.userId,
      limit: Math.min(parsed.data.limit * 2, 10000),
      now: new Date(this.now()),
    });

    const filtered: LocationBroadcast[] = [];
    for (const row of rows) {
      const safe = toPrivacySafeBroadcast(groupId, row);
      if (!safe) continue;
      if (requestedBbox && !isInsideBoundingBox(safe.latitude, safe.longitude, requestedBbox)) {
        continue;
      }
      filtered.push(safe);
      if (filtered.length >= parsed.data.limit) break;
    }
    return filtered;
  }

  async getGroupMessages(user: JwtUserPayload, groupId: string): Promise<ChatMessage[]> {
    if (!(await this.store.isGroupMember(user.id, groupId))) {
      throw new DomainError(403, 'Not a member of this group');
    }
    return this.store.getGroupMessages(groupId, 100);
  }

  async sendChatMessage(user: JwtUserPayload, rawInput: unknown): Promise<ChatMessage> {
    const parsed = SendMessageSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid chat message', parsed.error.flatten());
    }
    const { groupId, content } = parsed.data;

    if (!(await this.store.isGroupMember(user.id, groupId))) {
      throw new DomainError(403, 'Not a member of this group');
    }

    const profile = (await this.store.getUserProfile?.(user.id).catch(() => null)) ?? null;
    const message = await this.store.insertChatMessage(
      groupId,
      user.id,
      profile?.username ?? user.username,
      content,
    );
    this.broadcaster.broadcastChatMessage(groupId, message);
    return message;
  }

  resolveAuthorizedGroupIds(userId: string): Promise<string[]> {
    return this.store.listUserGroupIds(userId);
  }

  canJoinGroupRoom(userId: string, groupId: string): Promise<boolean> {
    return this.store.isGroupMember(userId, groupId);
  }

  async createCheckInRequest(
    user: JwtUserPayload,
    groupId: string,
    rawInput: unknown,
  ): Promise<LocationRequestItem> {
    const parsed = CreateLocationRequestSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid check-in request payload', parsed.error.flatten());
    }
    const requesterMembership = await this.requireMembership(user.id, groupId);
    if (requesterMembership.role === 'SPECTATOR') {
      throw new DomainError(403, 'Spectators cannot request location check-ins');
    }
    if (parsed.data.targetUserId === user.id) {
      throw new DomainError(400, 'Cannot request a location check-in from yourself');
    }
    if (!(await this.store.isGroupMember(parsed.data.targetUserId, groupId))) {
      throw new DomainError(404, 'Target member does not belong to this group');
    }

    const nowDate = new Date(this.now());
    const expiresAt = new Date(nowDate.getTime() + parsed.data.expiresInMinutes * 60_000);
    const created = await this.store.createLocationRequest({
      groupId,
      requesterId: user.id,
      targetUserId: parsed.data.targetUserId,
      suggestedDurationMinutes: parsed.data.suggestedDurationMinutes,
      expiresAt,
      message: parsed.data.message,
      now: nowDate,
    });
    this.broadcaster.broadcastLocationRequest(user.id, parsed.data.targetUserId, created);
    return created;
  }

  async listCheckInRequests(
    user: JwtUserPayload,
    groupId: string,
  ): Promise<{ requests: LocationRequestItem[]; myPrivacyOverrideUntil: string | null }> {
    const membership = await this.requireMembership(user.id, groupId);
    const requests = await this.store.listLocationRequestsForUser(
      groupId,
      user.id,
      new Date(this.now()),
    );
    return {
      requests,
      myPrivacyOverrideUntil: membership.privacyOverrideUntil,
    };
  }

  async respondToCheckInRequest(
    user: JwtUserPayload,
    groupId: string,
    requestId: string,
    rawInput: unknown,
  ): Promise<{ request: LocationRequestItem; privacyOverrideUntil: string | null }> {
    const parsed = RespondLocationRequestSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid check-in response payload', parsed.error.flatten());
    }
    const membership = await this.requireMembership(user.id, groupId);

    const nowDate = new Date(this.now());
    const result = await this.store.respondToLocationRequest({
      groupId,
      requestId,
      responderUserId: user.id,
      action: parsed.data.action,
      durationMinutes: parsed.data.durationMinutes,
      now: nowDate,
    });

    if (result.kind === 'not_found') {
      throw new DomainError(404, 'Check-in request not found');
    }
    if (result.kind === 'forbidden') {
      throw new DomainError(403, 'Only the requested member can respond');
    }
    if (result.kind === 'expired') {
      throw new DomainError(410, 'Check-in request has expired');
    }
    if (result.kind === 'already_responded') {
      throw new DomainError(409, `Check-in request was already ${result.status}`);
    }

    this.broadcaster.broadcastLocationRequestResponse(
      result.request.requesterId,
      result.request.targetUserId,
      result.request,
    );

    if (parsed.data.action === 'accept' && membership.role !== 'SPECTATOR') {
      const [latest, profile] = await Promise.all([
        this.store.getLatestUserLocation(user.id),
        this.store.getUserProfile?.(user.id).catch(() => null) ?? Promise.resolve(null),
      ]);
      if (latest) {
        this.broadcaster.broadcastLocation(groupId, {
          userId: user.id,
          username: profile?.username ?? user.username,
          avatarUrl: profile?.avatarUrl ?? null,
          haloColor: profile?.haloColor ?? null,
          fuzzCircleColor: profile?.fuzzCircleColor ?? null,
          groupId,
          latitude: latest.latitude,
          longitude: latest.longitude,
          altitude: latest.altitude ?? null,
          speed: latest.speed ?? null,
          batteryLevel: latest.batteryLevel ?? null,
          recordedAt: latest.recordedAt,
          privacyMode: 'EXACT',
          isFuzzed: false,
        });
      }
    }

    return {
      request: result.request,
      privacyOverrideUntil: result.privacyOverrideUntil,
    };
  }

  async listGroupPlaces(
    user: JwtUserPayload,
    groupId: string,
  ): Promise<{ places: GroupPlace[]; recentTransitions: PlaceTransitionEvent[] }> {
    await this.requireMembership(user.id, groupId);
    const [places, recentTransitions] = await Promise.all([
      this.store.listGroupPlaces(groupId),
      this.store.listRecentPlaceTransitions(groupId, 30),
    ]);
    return { places, recentTransitions };
  }

  async createGroupPlace(
    user: JwtUserPayload,
    groupId: string,
    rawInput: unknown,
  ): Promise<GroupPlace> {
    const parsed = CreateGroupPlaceSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid group place payload', parsed.error.flatten());
    }
    const membership = await this.requireMembership(user.id, groupId);
    if (membership.role !== 'ADMIN') {
      throw new DomainError(403, 'Group admin role required to manage places');
    }
    const place = await this.store.createGroupPlace({
      groupId,
      name: parsed.data.name,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      radiusMeters: parsed.data.radiusMeters,
      createdBy: user.id,
    });
    const allPlaces = await this.store.listGroupPlaces(groupId);
    this.broadcaster.broadcastPlacesUpdated(groupId, allPlaces);
    return place;
  }

  async deleteGroupPlace(user: JwtUserPayload, groupId: string, placeId: string): Promise<void> {
    const membership = await this.requireMembership(user.id, groupId);
    if (membership.role !== 'ADMIN') {
      throw new DomainError(403, 'Group admin role required to manage places');
    }
    const deleted = await this.store.deleteGroupPlace(groupId, placeId);
    if (!deleted) {
      throw new DomainError(404, 'Group place not found');
    }
    const allPlaces = await this.store.listGroupPlaces(groupId);
    this.broadcaster.broadcastPlacesUpdated(groupId, allPlaces);
  }
}
