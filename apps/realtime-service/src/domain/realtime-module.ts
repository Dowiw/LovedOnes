import { GroupMemberLocationRow } from '@loved-ones/db';
import {
  applyPrivacyFuzzing,
  ChatMessage,
  GroupRole,
  JwtUserPayload,
  LocationBatchSchema,
  LocationBroadcast,
  LocationPoint,
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

export interface RealtimeModuleOptions {
  store: RealtimeStore;
  broadcaster: RealtimeBroadcaster;
}

/**
 * Deep domain module owning location batch ingestion, deterministic recordedAt-anchored
 * privacy fuzzing, group location snapshots, and group chat persistence/broadcasting.
 */
export class RealtimeModule {
  private readonly store: RealtimeStore;
  private readonly broadcaster: RealtimeBroadcaster;

  constructor(options: RealtimeModuleOptions) {
    this.store = options.store;
    this.broadcaster = options.broadcaster;
  }

  async ingestLocationBatch(user: JwtUserPayload, rawInput: unknown): Promise<number> {
    const parsed = LocationBatchSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid location batch', parsed.error.flatten());
    }
    const points = parsed.data.points;
    const inserted = await this.store.insertLocationBatch(user.id, points);
    const latest = points[points.length - 1];
    if (!latest) return inserted;

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
