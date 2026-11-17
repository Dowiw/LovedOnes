import pg from 'pg';
import { Server as SocketIOServer } from 'socket.io';
import { getLatestGroupLocations, insertLocationBatch } from '@loved-ones/db';
import {
  ChatMessage,
  GroupRole,
  LocationBroadcast,
  LocationPoint,
  PrivacyMode,
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

  async listMembershipsForUser(
    userId: string,
  ): Promise<Array<{ groupId: string; role: GroupRole; privacy: PrivacyMode }>> {
    const res = await this.pool.query<{
      group_id: string;
      role: GroupRole;
      privacy: PrivacyMode;
    }>('SELECT group_id, role, privacy FROM group_memberships WHERE user_id = $1', [userId]);

    return res.rows.map((r) => ({
      groupId: r.group_id,
      role: r.role,
      privacy: r.privacy,
    }));
  }

  getLatestGroupLocations(groupId: string) {
    return getLatestGroupLocations(this.pool, groupId);
  }

  async getGroupMessages(groupId: string, limit = 100): Promise<ChatMessage[]> {
    const res = await this.pool.query<{
      id: string;
      group_id: string;
      sender_id: string;
      sender_username: string;
      content: string;
      created_at: Date;
    }>(
      `SELECT m.id, m.group_id, m.sender_id, u.username AS sender_username, m.content, m.created_at
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
    const res = await this.pool.query<{
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
    );
    const row = res.rows[0];
    return {
      id: row.id,
      groupId: row.group_id,
      senderId: row.sender_id,
      senderUsername,
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

  broadcastChatMessage(groupId: string, message: ChatMessage): void {
    this.io.to(`group:${groupId}`).emit('chat:message', message);
  }
}
