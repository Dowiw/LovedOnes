import pg from 'pg';
import { Server as SocketIOServer } from 'socket.io';
import {
  createGroupPlaceRecord,
  createLocationRequestRecord,
  deleteGroupPlaceRecord,
  deletePlaceById,
  evaluateAndRecordPlaceTransitions,
  findPlaceById,
  getGroupMembershipPrivacyInfo,
  getGroupTrails,
  getLatestGroupLocations,
  getLatestUserLocation,
  getUserPublicProfile,
  GroupTrailQueryOptions,
  insertLocationBatch,
  listAccessiblePlaces,
  listEffectiveMembershipsForUser,
  listGroupPlaces,
  listLocationRequestsForUser,
  listPrivatePlaces,
  listRecentPlaceTransitions,
  respondToLocationRequestRecord,
} from '@loved-ones/db';
import {
  ChatMessage,
  GroupPlace,
  LocationBroadcast,
  LocationPoint,
  LocationRequestItem,
  PlaceTransitionEvent,
} from '@loved-ones/shared';
import { RealtimeBroadcaster, RealtimeStore } from '../domain/realtime-module.js';

export class PostgresRealtimeStore implements RealtimeStore {
  constructor(private readonly pool: pg.Pool) {}

  async isGroupMember(userId: string, groupId: string): Promise<boolean> {
    const res = await this.pool.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM group_memberships WHERE user_id = $1 AND group_id = $2) AS exists',
      [userId, groupId],
    );
    return Boolean(res.rows[0]?.exists);
  }

  getUserProfile(userId: string): Promise<{ username: string; avatarUrl: string | null } | null> {
    return getUserPublicProfile(this.pool, userId);
  }

  async listUserGroupIds(userId: string): Promise<string[]> {
    const res = await this.pool.query<{ group_id: string }>(
      'SELECT group_id FROM group_memberships WHERE user_id = $1',
      [userId],
    );
    return res.rows.map((r) => r.group_id);
  }

  insertLocationBatch(userId: string, points: LocationPoint[]): Promise<number> {
    return insertLocationBatch(this.pool, userId, points);
  }

  listMembershipsForUser(userId: string, now?: Date) {
    return listEffectiveMembershipsForUser(this.pool, userId, now);
  }

  getGroupMembershipPrivacyInfo(userId: string, groupId: string, now?: Date) {
    return getGroupMembershipPrivacyInfo(this.pool, userId, groupId, now);
  }

  getLatestUserLocation(userId: string) {
    return getLatestUserLocation(this.pool, userId);
  }

  getLatestGroupLocations(groupId: string, now?: Date) {
    return getLatestGroupLocations(this.pool, groupId, now);
  }

  getGroupTrails(options: GroupTrailQueryOptions) {
    return getGroupTrails(this.pool, options);
  }

  createLocationRequest(input: {
    groupId: string;
    requesterId: string;
    targetUserId: string;
    suggestedDurationMinutes: number;
    expiresAt: Date;
    message?: string;
    now?: Date;
  }) {
    return createLocationRequestRecord(this.pool, input);
  }

  listLocationRequestsForUser(groupId: string, userId: string, now?: Date) {
    return listLocationRequestsForUser(this.pool, groupId, userId, now);
  }

  respondToLocationRequest(input: {
    groupId: string;
    requestId: string;
    responderUserId: string;
    action: 'accept' | 'decline';
    durationMinutes?: number;
    now?: Date;
  }) {
    return respondToLocationRequestRecord(this.pool, input);
  }

  createGroupPlace(input: {
    groupId: string | null;
    isPrivate?: boolean;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    createdBy: string;
  }) {
    return createGroupPlaceRecord(this.pool, input);
  }

  listGroupPlaces(groupId: string) {
    return listGroupPlaces(this.pool, groupId);
  }

  listPrivatePlaces(userId: string) {
    return listPrivatePlaces(this.pool, userId);
  }

  listAccessiblePlaces(userId: string, groupId?: string) {
    return listAccessiblePlaces(this.pool, userId, groupId);
  }

  findPlaceById(placeId: string) {
    return findPlaceById(this.pool, placeId);
  }

  deletePlaceById(placeId: string) {
    return deletePlaceById(this.pool, placeId);
  }

  deleteGroupPlace(groupId: string, placeId: string) {
    return deleteGroupPlaceRecord(this.pool, groupId, placeId);
  }

  listRecentPlaceTransitions(groupId: string, limit = 50) {
    return listRecentPlaceTransitions(this.pool, groupId, limit);
  }

  evaluatePlaceTransitions(input: {
    groupId: string;
    userId: string;
    username: string;
    latitude: number;
    longitude: number;
    recordedAt: string;
  }) {
    return evaluateAndRecordPlaceTransitions(this.pool, input);
  }

  async getGroupMessages(groupId: string, limit = 100): Promise<ChatMessage[]> {
    const res = await this.pool.query<{
      id: string;
      group_id: string;
      sender_id: string;
      sender_username: string;
      sender_avatar_url: string | null;
      content: string;
      created_at: Date;
    }>(
      `SELECT m.id, m.group_id, m.sender_id, u.username AS sender_username,
              u.avatar_url AS sender_avatar_url, m.content, m.created_at
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.group_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [groupId, limit],
    );

    return res.rows.reverse().map((r) => ({
      id: r.id,
      groupId: r.group_id,
      senderId: r.sender_id,
      senderUsername: r.sender_username,
      senderAvatarUrl: r.sender_avatar_url ?? null,
      content: r.content,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async insertChatMessage(
    groupId: string,
    senderId: string,
    senderUsername: string,
    content: string,
  ): Promise<ChatMessage> {
    const [res, profile] = await Promise.all([
      this.pool.query<{
        id: string;
        group_id: string;
        sender_id: string;
        content: string;
        created_at: Date;
      }>(
        `INSERT INTO messages (group_id, sender_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, group_id, sender_id, content, created_at`,
        [groupId, senderId, content],
      ),
      getUserPublicProfile(this.pool, senderId),
    ]);
    const row = res.rows[0];
    return {
      id: row.id,
      groupId: row.group_id,
      senderId: row.sender_id,
      senderUsername: profile?.username ?? senderUsername,
      senderAvatarUrl: profile?.avatarUrl ?? null,
      content: row.content,
      createdAt: row.created_at.toISOString(),
    };
  }
}

export class SocketIoBroadcaster implements RealtimeBroadcaster {
  constructor(private readonly io: SocketIOServer) {}

  broadcastLocation(groupId: string, update: LocationBroadcast): void {
    this.io.to(`group:${groupId}`).emit('location:update', update);
  }

  broadcastLocationRemoved(groupId: string, userId: string): void {
    this.io.to(`group:${groupId}`).emit('location:removed', { groupId, userId });
  }

  broadcastChatMessage(groupId: string, message: ChatMessage): void {
    this.io.to(`group:${groupId}`).emit('chat:message', message);
  }

  broadcastLocationRequest(
    requesterId: string,
    targetUserId: string,
    request: LocationRequestItem,
  ): void {
    this.io.to([`user:${requesterId}`, `user:${targetUserId}`]).emit('checkin:request', request);
  }

  broadcastLocationRequestResponse(
    requesterId: string,
    targetUserId: string,
    request: LocationRequestItem,
  ): void {
    this.io.to([`user:${requesterId}`, `user:${targetUserId}`]).emit('checkin:response', request);
  }

  broadcastPlaceTransition(groupId: string, event: PlaceTransitionEvent): void {
    this.io.to(`group:${groupId}`).emit('place:transition', event);
  }

  broadcastPlacesUpdated(groupId: string, places: GroupPlace[]): void {
    this.io.to(`group:${groupId}`).emit('place:updated', { groupId, places });
  }

  broadcastPrivatePlacesUpdated(userId: string, places: GroupPlace[]): void {
    this.io.to(`user:${userId}`).emit('place:private:updated', { places });
  }
}
