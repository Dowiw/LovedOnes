import { GroupMemberLocationRow } from '@loved-ones/db';
import {
  applyPrivacyFuzzing,
  ChatMessage,
  GroupRole,
  JwtUserPayload,
  LocationBatchSchema,
  LocationBroadcast,
  LocationPoint,
  normalizeOverlandToPoints,
  normalizeOwnTracksToPoints,
  PrivacyMode,
  SendMessageSchema,
} from '@loved-ones/shared';
import { DomainError } from '@loved-ones/shared/auth';

export interface RealtimeStore {
  isGroupMember(userId: string, groupId: string): Promise<boolean>;
  listUserGroupIds(userId: string): Promise<string[]>;
  insertLocationBatch(userId: string, points: LocationPoint[]): Promise<number>;
  listMembershipsForUser(
    userId: string,
  ): Promise<Array<{ groupId: string; role: GroupRole; privacy: PrivacyMode }>>;
  getLatestGroupLocations(groupId: string): Promise<GroupMemberLocationRow[]>;
  getGroupMessages(groupId: string, limit?: number): Promise<ChatMessage[]>;
  insertChatMessage(
    groupId: string,
    senderId: string,
    senderUsername: string,
    content: string,
  ): Promise<ChatMessage>;
}

export interface RealtimeBroadcaster {
  broadcastLocation(groupId: string, update: LocationBroadcast): void;
  broadcastChatMessage(groupId: string, message: ChatMessage): void;
}

const DEFAULT_MAX_ACCURACY_METERS = 1000;
const DEFAULT_MAX_JUMP_SPEED_MPS = 350;
const DEFAULT_MIN_JUMP_DISTANCE_METERS = 5000;
const EARTH_RADIUS_METERS = 6_371_000;

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
 * Great-circle surface distance in meters between two WGS84 coordinates.
 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

export interface RealtimeModuleOptions extends CoordinateFilterOptions {
  store: RealtimeStore;
  broadcaster: RealtimeBroadcaster;
}

/**
 * Deep domain module owning location batch ingestion, coordinate anomaly hygiene,
 * deterministic recordedAt-anchored privacy fuzzing, group location snapshots, and
 * group chat persistence/broadcasting.
 */
export class RealtimeModule {
  private readonly store: RealtimeStore;
  private readonly broadcaster: RealtimeBroadcaster;
  private readonly filterOptions: CoordinateFilterOptions;

  constructor(options: RealtimeModuleOptions) {
    this.store = options.store;
    this.broadcaster = options.broadcaster;
    this.filterOptions = {
      maxAccuracyMeters: options.maxAccuracyMeters,
      maxJumpSpeedMps: options.maxJumpSpeedMps,
      minJumpDistanceMeters: options.minJumpDistanceMeters,
    };
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
    const memberships = await this.store.listMembershipsForUser(user.id);

    for (const m of memberships) {
      if (m.role === 'SPECTATOR') continue;

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
        username: user.username,
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

  async getGroupLocations(user: JwtUserPayload, groupId: string): Promise<LocationBroadcast[]> {
    if (!(await this.store.isGroupMember(user.id, groupId))) {
      throw new DomainError(403, 'Not a member of this group');
    }

    const rows = await this.store.getLatestGroupLocations(groupId);
    const locations: LocationBroadcast[] = [];
    for (const row of rows) {
      const recordedAtMs = new Date(row.recordedAt).getTime();
      const fuzzed = applyPrivacyFuzzing(
        row.latitude,
        row.longitude,
        row.privacy,
        row.userId,
        recordedAtMs,
      );
      if (!fuzzed.visible) continue;

      locations.push({
        userId: row.userId,
        username: row.username,
        groupId,
        latitude: fuzzed.latitude,
        longitude: fuzzed.longitude,
        altitude: row.altitude,
        speed: row.speed,
        batteryLevel: row.batteryLevel,
        recordedAt: row.recordedAt,
        privacyMode: row.privacy,
        isFuzzed: fuzzed.isFuzzed,
      });
    }
    return locations;
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

    const message = await this.store.insertChatMessage(groupId, user.id, user.username, content);
    this.broadcaster.broadcastChatMessage(groupId, message);
    return message;
  }

  resolveAuthorizedGroupIds(userId: string): Promise<string[]> {
    return this.store.listUserGroupIds(userId);
  }

  canJoinGroupRoom(userId: string, groupId: string): Promise<boolean> {
    return this.store.isGroupMember(userId, groupId);
  }
}
