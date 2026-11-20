import fs from 'node:fs';
import path from 'node:path';
import { Redis } from 'ioredis';
import pg from 'pg';
import { getDatabaseTelemetry } from '@loved-ones/db';
import { GroupRole, PrivacyMode, SystemRole } from '@loved-ones/shared';
import { LOGS_RING_KEY } from '@loved-ones/shared/logger';
import {
  getUserTelemetryFromRedis,
  SESSION_USER_PREFIX,
  TRACKER_JTI_USER_PREFIX,
  USER_PROFILE_UPDATED_CHANNEL,
} from '@loved-ones/shared/telemetry';
import {
  AccountRecord,
  AuthGroupStore,
  AuthGroupTxStore,
  GroupMemberEntry,
  GroupSummaryRecord,
  GroupWithMembers,
  InviteRecord,
  MembershipSummaryRecord,
  PublicAccountRecord,
  SessionStore,
} from '../domain/auth-group-module.js';
import { TelemetryQueryStore } from '../domain/telemetry-query-module.js';

interface PgUserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  role: SystemRole;
  avatar_url: string | null;
  created_at: Date;
}

interface PgInviteRow {
  token: string;
  group_id: string;
  group_name: string;
  assigned_role: GroupRole;
  max_uses: number;
  uses: number;
  expires_at: Date;
}

const REGISTRATION_ADVISORY_LOCK_KEY = 948271;

function mapPublicAccount(row: Omit<PgUserRow, 'password_hash'>): PublicAccountRecord {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    avatarUrl: row.avatar_url ?? null,
    createdAt: row.created_at,
  };
}

function mapAccount(row: PgUserRow): AccountRecord {
  return {
    ...mapPublicAccount(row),
    passwordHash: row.password_hash,
  };
}

function mapInvite(row: PgInviteRow): InviteRecord {
  return {
    token: row.token,
    groupId: row.group_id,
    groupName: row.group_name,
    assignedRole: row.assigned_role,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
  };
}

function createTxStore(client: pg.PoolClient): AuthGroupTxStore {
  return {
    async findAccountByEmail(email: string): Promise<AccountRecord | null> {
      const res = await client.query<PgUserRow>(
        'SELECT id, email, username, password_hash, role, avatar_url, created_at FROM users WHERE LOWER(email) = LOWER($1)',
        [email],
      );
      return res.rows[0] ? mapAccount(res.rows[0]) : null;
    },

    async countAccounts(): Promise<number> {
      const res = await client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users');
      return res.rows[0]?.cnt ?? 0;
    },

    async insertAccount(input): Promise<PublicAccountRecord> {
      const res = await client.query<Omit<PgUserRow, 'password_hash'>>(
        `INSERT INTO users (email, username, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, username, role, avatar_url, created_at`,
        [input.email, input.username, input.passwordHash, input.role],
      );
      return mapPublicAccount(res.rows[0]);
    },

    async findInviteForUpdate(token: string): Promise<InviteRecord | null> {
      const res = await client.query<PgInviteRow>(
        `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
                gi.max_uses, gi.uses, gi.expires_at
         FROM group_invites gi
         JOIN groups g ON g.id = gi.group_id
         WHERE gi.token = $1
         FOR UPDATE OF gi`,
        [token],
      );
      return res.rows[0] ? mapInvite(res.rows[0]) : null;
    },

    async findMembership(userId: string, groupId: string) {
      const res = await client.query<{ role: GroupRole; privacy: PrivacyMode }>(
        'SELECT role, privacy FROM group_memberships WHERE user_id = $1 AND group_id = $2',
        [userId, groupId],
      );
      return res.rows[0] ?? null;
    },

    async insertMembership(input): Promise<void> {
      await client.query(
        `INSERT INTO group_memberships (user_id, group_id, role, privacy)
         VALUES ($1, $2, $3, $4)`,
        [input.userId, input.groupId, input.role, input.privacy],
      );
    },

    async incrementInviteUses(token: string): Promise<void> {
      await client.query('UPDATE group_invites SET uses = uses + 1 WHERE token = $1', [token]);
    },

    async insertGroup(name: string, createdBy: string): Promise<GroupSummaryRecord> {
      const res = await client.query<{ id: string; name: string; created_at: Date }>(
        'INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at',
        [name, createdBy],
      );
      return {
        id: res.rows[0].id,
        name: res.rows[0].name,
        createdAt: res.rows[0].created_at,
      };
    },
  };
}

export class PostgresAuthGroupStore implements AuthGroupStore {
  constructor(private readonly pool: pg.Pool) {}

  async withTransaction<T>(
    fn: (tx: AuthGroupTxStore) => Promise<T>,
    options?: { registrationLock?: boolean },
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (options?.registrationLock) {
        await client.query(`SELECT pg_advisory_xact_lock(${REGISTRATION_ADVISORY_LOCK_KEY})`);
      }
      const result = await fn(createTxStore(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findAccountByEmail(email: string): Promise<AccountRecord | null> {
    const res = await this.pool.query<PgUserRow>(
      `SELECT id, email, username, password_hash, role, avatar_url, created_at
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    return res.rows[0] ? mapAccount(res.rows[0]) : null;
  }

  async findAccountById(id: string): Promise<PublicAccountRecord | null> {
    const res = await this.pool.query<Omit<PgUserRow, 'password_hash'>>(
      'SELECT id, email, username, role, avatar_url, created_at FROM users WHERE id = $1',
      [id],
    );
    return res.rows[0] ? mapPublicAccount(res.rows[0]) : null;
  }

  async findAccountWithPasswordById(id: string): Promise<AccountRecord | null> {
    const res = await this.pool.query<PgUserRow>(
      'SELECT id, email, username, password_hash, role, avatar_url, created_at FROM users WHERE id = $1',
      [id],
    );
    return res.rows[0] ? mapAccount(res.rows[0]) : null;
  }

  async updateAccountProfile(
    userId: string,
    patch: { email?: string; username?: string; avatarUrl?: string | null },
  ): Promise<
    { status: 'ok'; account: PublicAccountRecord } | { status: 'email_conflict' } | { status: 'not_found' }
  > {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.username !== undefined) {
      params.push(patch.username);
      sets.push(`username = $${params.length}`);
    }
    if (patch.email !== undefined) {
      params.push(patch.email);
      sets.push(`email = $${params.length}`);
    }
    if (patch.avatarUrl !== undefined) {
      params.push(patch.avatarUrl);
      sets.push(`avatar_url = $${params.length}`);
    }

    if (sets.length === 0) {
      const current = await this.findAccountById(userId);
      return current ? { status: 'ok', account: current } : { status: 'not_found' };
    }

    if (patch.email !== undefined) {
      const dup = await this.pool.query<{ id: string }>(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1',
        [patch.email, userId],
      );
      if (dup.rows.length > 0) {
        return { status: 'email_conflict' };
      }
    }

    params.push(userId);
    try {
      const res = await this.pool.query<Omit<PgUserRow, 'password_hash'>>(
        `UPDATE users SET ${sets.join(', ')}
         WHERE id = $${params.length}
         RETURNING id, email, username, role, avatar_url, created_at`,
        params,
      );
      const row = res.rows[0];
      return row ? { status: 'ok', account: mapPublicAccount(row) } : { status: 'not_found' };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return { status: 'email_conflict' };
      }
      throw err;
    }
  }

  async updateAccountPassword(userId: string, passwordHash: string): Promise<boolean> {
    const res = await this.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      userId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async listAccountMemberships(userId: string): Promise<MembershipSummaryRecord[]> {
    const res = await this.pool.query<{
      group_id: string;
      name: string;
      role: GroupRole;
      privacy: PrivacyMode;
      joined_at: Date;
    }>(
      `SELECT g.id AS group_id, g.name, gm.role, gm.privacy, gm.joined_at
       FROM group_memberships gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = $1
       ORDER BY gm.joined_at ASC`,
      [userId],
    );
    return res.rows.map((r) => ({
      groupId: r.group_id,
      name: r.name,
      role: r.role,
      privacy: r.privacy,
      joinedAt: r.joined_at,
    }));
  }

  async listGroupsWithMembers(userId: string): Promise<GroupWithMembers[]> {
    const groupsRes = await this.pool.query<{
      id: string;
      name: string;
      created_at: Date;
      my_role: GroupRole;
      my_privacy: PrivacyMode;
    }>(
      `SELECT g.id, g.name, g.created_at, gm.role AS my_role, gm.privacy AS my_privacy
       FROM group_memberships gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = $1
       ORDER BY g.created_at ASC`,
      [userId],
    );

    const groupIds = groupsRes.rows.map((g) => g.id);
    const membersByGroup = new Map<string, GroupMemberEntry[]>();

    if (groupIds.length > 0) {
      const membersRes = await this.pool.query<{
        group_id: string;
        user_id: string;
        username: string;
        avatar_url: string | null;
        role: GroupRole;
        privacy: PrivacyMode;
        joined_at: Date;
      }>(
        `SELECT gm.group_id, gm.user_id, u.username, u.avatar_url, gm.role, gm.privacy, gm.joined_at
         FROM group_memberships gm
         JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = ANY($1::uuid[])
         ORDER BY gm.joined_at ASC`,
        [groupIds],
      );

      for (const row of membersRes.rows) {
        const list = membersByGroup.get(row.group_id) ?? [];
        list.push({
          userId: row.user_id,
          username: row.username,
          avatarUrl: row.avatar_url ?? null,
          role: row.role,
          privacy: row.privacy,
          joinedAt: row.joined_at.toISOString(),
        });
        membersByGroup.set(row.group_id, list);
      }
    }

    return groupsRes.rows.map((g) => ({
      id: g.id,
      name: g.name,
      createdAt: g.created_at.toISOString(),
      myRole: g.my_role,
      myPrivacy: g.my_privacy,
      members: membersByGroup.get(g.id) ?? [],
    }));
  }

  async findInviteByToken(token: string): Promise<InviteRecord | null> {
    const res = await this.pool.query<PgInviteRow>(
      `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
              gi.max_uses, gi.uses, gi.expires_at
       FROM group_invites gi
       JOIN groups g ON g.id = gi.group_id
       WHERE gi.token = $1`,
      [token],
    );
    return res.rows[0] ? mapInvite(res.rows[0]) : null;
  }

  async findGroupById(groupId: string): Promise<{ id: string; name: string } | null> {
    const res = await this.pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM groups WHERE id = $1',
      [groupId],
    );
    return res.rows[0] ?? null;
  }

  async findMembership(userId: string, groupId: string) {
    const res = await this.pool.query<{ role: GroupRole; privacy: PrivacyMode }>(
      'SELECT role, privacy FROM group_memberships WHERE user_id = $1 AND group_id = $2',
      [userId, groupId],
    );
    return res.rows[0] ?? null;
  }

  async hasAnyAdminMembership(userId: string): Promise<boolean> {
    const res = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM group_memberships
         WHERE user_id = $1 AND role = 'ADMIN'
       ) AS exists`,
      [userId],
    );
    return Boolean(res.rows[0]?.exists);
  }

  async updateMembershipPrivacy(
    userId: string,
    groupId: string,
    privacy: PrivacyMode,
  ): Promise<PrivacyMode | null> {
    const res = await this.pool.query<{ privacy: PrivacyMode }>(
      `UPDATE group_memberships
       SET privacy = $1
       WHERE user_id = $2 AND group_id = $3
       RETURNING privacy`,
      [privacy, userId, groupId],
    );
    return res.rows[0]?.privacy ?? null;
  }

  async updateMembershipRole(
    userId: string,
    groupId: string,
    role: GroupRole,
  ): Promise<{ userId: string; role: GroupRole } | null> {
    const res = await this.pool.query<{ user_id: string; role: GroupRole }>(
      `UPDATE group_memberships
       SET role = $1
       WHERE user_id = $2 AND group_id = $3
       RETURNING user_id, role`,
      [role, userId, groupId],
    );
    return res.rows[0] ? { userId: res.rows[0].user_id, role: res.rows[0].role } : null;
  }

  async insertInvite(input: {
    token: string;
    groupId: string;
    assignedRole: GroupRole;
    createdBy: string;
    maxUses: number;
    expiresAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO group_invites (token, group_id, assigned_role, created_by, max_uses, uses, expires_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6)`,
      [
        input.token,
        input.groupId,
        input.assignedRole,
        input.createdBy,
        input.maxUses,
        input.expiresAt,
      ],
    );
  }

  async listInvites(caller: { userId: string; systemRole: SystemRole }): Promise<InviteRecord[]> {
    const isHostAdmin = caller.systemRole === 'HOST_ADMIN';
    const query = isHostAdmin
      ? `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
                gi.max_uses, gi.uses, gi.expires_at
         FROM group_invites gi
         JOIN groups g ON g.id = gi.group_id
         ORDER BY gi.expires_at DESC`
      : `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
                gi.max_uses, gi.uses, gi.expires_at
         FROM group_invites gi
         JOIN groups g ON g.id = gi.group_id
         JOIN group_memberships gm ON gm.group_id = gi.group_id
         WHERE gm.user_id = $1 AND gm.role = 'ADMIN'
         ORDER BY gi.expires_at DESC`;

    const res = await this.pool.query<PgInviteRow>(query, isHostAdmin ? [] : [caller.userId]);
    return res.rows.map(mapInvite);
  }
}

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async saveSession(account: {
    id: string;
    email: string;
    username: string;
    role: SystemRole;
  }): Promise<void> {
    await this.redis.set(
      `${SESSION_USER_PREFIX}${account.id}`,
      JSON.stringify({
        userId: account.id,
        email: account.email,
        username: account.username,
        role: account.role,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      60 * 60 * 24 * 7,
    );
  }

  async saveTrackerTokenJti(userId: string, jti: string, expiresInDays: number): Promise<void> {
    await this.redis.set(
      `${TRACKER_JTI_USER_PREFIX}${userId}`,
      jti,
      'EX',
      Math.max(60, Math.round(expiresInDays * 24 * 60 * 60)),
    );
  }

  async revokeTrackerTokenJti(userId: string): Promise<void> {
    await this.redis.del(`${TRACKER_JTI_USER_PREFIX}${userId}`);
  }

  async getTrackerTokenStatus(userId: string): Promise<{ active: boolean; ttlSeconds: number }> {
    const key = `${TRACKER_JTI_USER_PREFIX}${userId}`;
    const [val, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
    return {
      active: Boolean(val) && ttl > 0,
      ttlSeconds: ttl > 0 ? ttl : 0,
    };
  }

  async publishProfileUpdated(event: {
    userId: string;
    username: string;
    avatarUrl: string | null;
    groupIds: string[];
  }): Promise<void> {
    await this.redis.publish(USER_PROFILE_UPDATED_CHANNEL, JSON.stringify(event));
  }
}

async function computeDirectorySizeBytes(dirPath: string): Promise<number> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        const stat = await fs.promises.stat(full);
        total += stat.size;
      } else if (entry.isDirectory()) {
        total += await computeDirectorySizeBytes(full);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export class PostgresRedisTelemetryStore implements TelemetryQueryStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly logDir: string,
  ) {}

  computeLogStorageBytes(): Promise<number> {
    return computeDirectorySizeBytes(this.logDir);
  }

  getDatabaseTelemetry() {
    return getDatabaseTelemetry(this.pool);
  }

  getUserTelemetry(userId: string) {
    return getUserTelemetryFromRedis(this.redis, userId);
  }

  getRecentLogLines(limit: number): Promise<string[]> {
    return this.redis.lrange(LOGS_RING_KEY, 0, Math.max(0, limit - 1));
  }
}
