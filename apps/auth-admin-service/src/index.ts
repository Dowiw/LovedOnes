import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import argon2 from 'argon2';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { SignJWT, jwtVerify } from 'jose';
import pg from 'pg';
import { createPool, getDatabaseTelemetry, runMigrations } from '@loved-ones/db';
import {
  CreateGroupSchema,
  CreateInviteSchema,
  GroupRole,
  JoinInviteSchema,
  JwtUserPayload,
  JwtUserPayloadSchema,
  LoginSchema,
  normalizePrivacyMode,
  PrivacyMode,
  QrInvitePayloadSchema,
  RefreshSchema,
  RegisterSchema,
  SystemRole,
  SystemTelemetry,
  UpdateMemberRoleSchema,
  UpdatePrivacySchema,
} from '@loved-ones/shared';
import {
  createServiceLogger,
  LOGS_RING_KEY,
  LOGS_STREAM_CHANNEL,
  ServiceLoggerHandle,
} from '@loved-ones/shared/logger';
import {
  getUserTelemetryFromRedis,
  recordUserTelemetry,
  SESSION_USER_PREFIX,
} from '@loved-ones/shared/telemetry';

export interface AuthAdminOptions {
  databaseUrl?: string;
  redisUrl?: string;
  jwtSecret?: string;
  jwtRefreshSecret?: string;
  logDir?: string;
  maxLogStorageMb?: number;
  publicServerUrl?: string;
  disableFileLog?: boolean;
  disableRedisLog?: boolean;
}

interface AuthenticatedRequest extends FastifyRequest {
  authUser?: JwtUserPayload;
  perfStartMs?: number;
}

interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  role: SystemRole;
  created_at: Date;
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

export async function createAuthAdminServer(options: AuthAdminOptions = {}): Promise<{
  app: FastifyInstance;
  pool: pg.Pool;
  redis: Redis;
  loggerHandle: ServiceLoggerHandle;
}> {
  const databaseUrl =
    options.databaseUrl ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/lovedones';
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const jwtSecret =
    options.jwtSecret ?? process.env.JWT_SECRET ?? 'dev-jwt-secret-key-minimum-32-characters-long';
  const jwtRefreshSecret =
    options.jwtRefreshSecret ??
    process.env.JWT_REFRESH_SECRET ??
    'dev-jwt-refresh-secret-key-min-32-chars';
  const logDir = options.logDir ?? process.env.LOG_DIR ?? path.resolve(process.cwd(), 'logs');
  const maxLogStorageMb =
    options.maxLogStorageMb ??
    (Number.parseFloat(process.env.MAX_LOG_STORAGE_MB ?? '500') || 500);
  const publicServerUrl =
    options.publicServerUrl ?? process.env.PUBLIC_SERVER_URL ?? 'http://localhost:8080';

  const pool = createPool(databaseUrl);
  await runMigrations(pool);

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const loggerHandle = await createServiceLogger('auth-admin-service', {
    logDir,
    redisUrl,
    disableFile: options.disableFileLog,
    disableRedis: options.disableRedisLog,
  });

  const refreshSecretBytes = new TextEncoder().encode(jwtRefreshSecret);

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(fastifyJwt, {
    secret: jwtSecret,
  });
  await app.register(fastifyWebsocket);

  async function issueTokenPair(user: {
    id: string;
    email: string;
    username: string;
    role: SystemRole;
  }): Promise<{ accessToken: string; refreshToken: string }> {
    const payload: JwtUserPayload = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      type: 'access',
    };
    const accessToken = app.jwt.sign(payload, { expiresIn: '1d' });
    const refreshToken = await new SignJWT({
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      type: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(refreshSecretBytes);

    await redis.set(
      `${SESSION_USER_PREFIX}${user.id}`,
      JSON.stringify({
        userId: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        updatedAt: new Date().toISOString(),
      }),
      'EX',
      60 * 60 * 24 * 7,
    );

    return { accessToken, refreshToken };
  }

  async function requireAuth(request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
    try {
      const decoded = await request.jwtVerify<JwtUserPayload>();
      const parsed = JwtUserPayloadSchema.parse(decoded);
      request.authUser = parsed;
    } catch {
      await reply.code(401).send({ error: 'Unauthorized' });
    }
  }

  async function requireAdmin(request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!request.authUser) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    if (request.authUser.role === 'HOST_ADMIN') {
      return;
    }
    const adminMembership = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM group_memberships
         WHERE user_id = $1 AND role = 'ADMIN'
       ) AS exists`,
      [request.authUser.id],
    );
    if (!adminMembership.rows[0]?.exists) {
      await reply.code(403).send({ error: 'Admin privileges required' });
    }
  }

  async function requireHostAdmin(
    request: AuthenticatedRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.authUser?.role !== 'HOST_ADMIN') {
      await reply.code(403).send({ error: 'HOST_ADMIN privileges required' });
    }
  }

  // Per-user CPU & event telemetry middleware
  app.addHook('onRequest', async (request: AuthenticatedRequest) => {
    request.perfStartMs = performance.now();
  });

  app.addHook('onResponse', async (request: AuthenticatedRequest) => {
    if (request.authUser?.id && request.perfStartMs !== undefined) {
      const elapsedMs = Math.max(0, performance.now() - request.perfStartMs);
      void recordUserTelemetry(redis, request.authUser.id, elapsedMs, 1).catch(() => {});
    }
  });

  app.get('/health', async () => {
    return { status: 'ok', service: 'auth-admin-service' };
  });

  // ---- Auth Endpoints ----

  app.post('/api/auth/register', async (request: AuthenticatedRequest, reply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { email, username, password, inviteToken } = parsed.data;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    const client = await pool.connect();
    let createdUser: Omit<UserRow, 'password_hash'>;
    let joinedGroup: { groupId: string; groupName: string; role: GroupRole } | null = null;

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(948271)');

      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
        [email],
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'Email already registered' });
      }

      const countRes = await client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users');
      const assignedSystemRole: SystemRole =
        (countRes.rows[0]?.cnt ?? 0) === 0 ? 'HOST_ADMIN' : 'USER';

      const userRes = await client.query<Omit<UserRow, 'password_hash'>>(
        `INSERT INTO users (email, username, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, username, role, created_at`,
        [email.toLowerCase(), username, passwordHash, assignedSystemRole],
      );
      createdUser = userRes.rows[0];

      if (inviteToken) {
        const invRes = await client.query<{
          token: string;
          group_id: string;
          group_name: string;
          assigned_role: GroupRole;
          max_uses: number;
          uses: number;
          expires_at: Date;
        }>(
          `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
                  gi.max_uses, gi.uses, gi.expires_at
           FROM group_invites gi
           JOIN groups g ON g.id = gi.group_id
           WHERE gi.token = $1
           FOR UPDATE OF gi`,
          [inviteToken],
        );

        const inv = invRes.rows[0];
        if (!inv || inv.uses >= inv.max_uses || inv.expires_at.getTime() <= Date.now()) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Invalid or expired invite token' });
        }

        await client.query(
          `INSERT INTO group_memberships (user_id, group_id, role, privacy)
           VALUES ($1, $2, $3, 'EXACT')`,
          [createdUser.id, inv.group_id, inv.assigned_role],
        );
        await client.query('UPDATE group_invites SET uses = uses + 1 WHERE token = $1', [
          inviteToken,
        ]);
        joinedGroup = {
          groupId: inv.group_id,
          groupName: inv.group_name,
          role: inv.assigned_role,
        };
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const tokens = await issueTokenPair(createdUser);
    request.authUser = {
      id: createdUser.id,
      email: createdUser.email,
      username: createdUser.username,
      role: createdUser.role,
    };

    loggerHandle.logger.info(
      { userId: createdUser.id, role: createdUser.role, invited: Boolean(inviteToken) },
      'user registered',
    );

    return reply.code(201).send({
      ...tokens,
      user: {
        id: createdUser.id,
        email: createdUser.email,
        username: createdUser.username,
        role: createdUser.role,
        createdAt: createdUser.created_at.toISOString(),
      },
      joinedGroup,
    });
  });

  app.post('/api/auth/login', async (request: AuthenticatedRequest, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const res = await pool.query<UserRow>(
      `SELECT id, email, username, password_hash, role, created_at
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    const user = res.rows[0];
    if (!user) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }
    const valid = await argon2.verify(user.password_hash, password);
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const tokens = await issueTokenPair(user);
    request.authUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };

    loggerHandle.logger.info({ userId: user.id }, 'user logged in');

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        createdAt: user.created_at.toISOString(),
      },
    };
  });

  app.post('/api/auth/refresh', async (request: AuthenticatedRequest, reply) => {
    const parsed = RefreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid refresh token payload' });
    }
    try {
      const { payload } = await jwtVerify(parsed.data.refreshToken, refreshSecretBytes);
      const userId = String(payload.id ?? '');
      const userRes = await pool.query<Omit<UserRow, 'password_hash'>>(
        'SELECT id, email, username, role, created_at FROM users WHERE id = $1',
        [userId],
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(401).send({ error: 'User not found' });
      }
      const tokens = await issueTokenPair(user);
      request.authUser = {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      };
      return tokens;
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired refresh token' });
    }
  });

  app.get(
    '/api/auth/me',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const userId = request.authUser!.id;
      const [userRes, groupsRes] = await Promise.all([
        pool.query<Omit<UserRow, 'password_hash'>>(
          'SELECT id, email, username, role, created_at FROM users WHERE id = $1',
          [userId],
        ),
        pool.query<{
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
        ),
      ]);

      const u = userRes.rows[0];
      return {
        user: {
          id: u.id,
          email: u.email,
          username: u.username,
          role: u.role,
          createdAt: u.created_at.toISOString(),
        },
        groups: groupsRes.rows.map((g) => ({
          groupId: g.group_id,
          name: g.name,
          role: g.role,
          privacy: g.privacy,
          joinedAt: g.joined_at.toISOString(),
        })),
      };
    },
  );

  app.get('/api/auth/invites/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const res = await pool.query<{
      token: string;
      group_id: string;
      group_name: string;
      assigned_role: GroupRole;
      max_uses: number;
      uses: number;
      expires_at: Date;
    }>(
      `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
              gi.max_uses, gi.uses, gi.expires_at
       FROM group_invites gi
       JOIN groups g ON g.id = gi.group_id
       WHERE gi.token = $1`,
      [token],
    );
    const inv = res.rows[0];
    if (!inv) {
      return reply.code(404).send({ error: 'Invite not found' });
    }
    const valid = inv.uses < inv.max_uses && inv.expires_at.getTime() > Date.now();
    return {
      token: inv.token,
      groupId: inv.group_id,
      groupName: inv.group_name,
      assignedRole: inv.assigned_role,
      maxUses: inv.max_uses,
      uses: inv.uses,
      expiresAt: inv.expires_at.toISOString(),
      valid,
    };
  });

  app.post(
    '/api/auth/join',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const parsed = JoinInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid invite payload' });
      }
      const userId = request.authUser!.id;
      const { inviteToken } = parsed.data;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const invRes = await client.query<{
          token: string;
          group_id: string;
          group_name: string;
          assigned_role: GroupRole;
          max_uses: number;
          uses: number;
          expires_at: Date;
        }>(
          `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
                  gi.max_uses, gi.uses, gi.expires_at
           FROM group_invites gi
           JOIN groups g ON g.id = gi.group_id
           WHERE gi.token = $1
           FOR UPDATE OF gi`,
          [inviteToken],
        );
        const inv = invRes.rows[0];
        if (!inv || inv.uses >= inv.max_uses || inv.expires_at.getTime() <= Date.now()) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Invalid or expired invite token' });
        }

        await client.query(
          `INSERT INTO group_memberships (user_id, group_id, role, privacy)
           VALUES ($1, $2, $3, 'EXACT')
           ON CONFLICT (user_id, group_id)
           DO UPDATE SET role = EXCLUDED.role`,
          [userId, inv.group_id, inv.assigned_role],
        );
        await client.query('UPDATE group_invites SET uses = uses + 1 WHERE token = $1', [
          inviteToken,
        ]);
        await client.query('COMMIT');

        loggerHandle.logger.info(
          { userId, groupId: inv.group_id, role: inv.assigned_role },
          'user joined group via invite',
        );

        return {
          groupId: inv.group_id,
          groupName: inv.group_name,
          role: inv.assigned_role,
          privacy: 'EXACT' as PrivacyMode,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // ---- Group & RBAC Endpoints ----

  app.get(
    '/api/auth/groups',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const userId = request.authUser!.id;
      const groupsRes = await pool.query<{
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
      const membersByGroup = new Map<
        string,
        Array<{
          userId: string;
          username: string;
          role: GroupRole;
          privacy: PrivacyMode;
          joinedAt: string;
        }>
      >();

      if (groupIds.length > 0) {
        const membersRes = await pool.query<{
          group_id: string;
          user_id: string;
          username: string;
          role: GroupRole;
          privacy: PrivacyMode;
          joined_at: Date;
        }>(
          `SELECT gm.group_id, gm.user_id, u.username, gm.role, gm.privacy, gm.joined_at
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
            role: row.role,
            privacy: row.privacy,
            joinedAt: row.joined_at.toISOString(),
          });
          membersByGroup.set(row.group_id, list);
        }
      }

      return {
        groups: groupsRes.rows.map((g) => ({
          id: g.id,
          name: g.name,
          createdAt: g.created_at.toISOString(),
          myRole: g.my_role,
          myPrivacy: g.my_privacy,
          members: membersByGroup.get(g.id) ?? [],
        })),
      };
    },
  );

  app.post(
    '/api/auth/groups',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const parsed = CreateGroupSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid group payload' });
      }
      const userId = request.authUser!.id;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const grpRes = await client.query<{ id: string; name: string; created_at: Date }>(
          'INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at',
          [parsed.data.name, userId],
        );
        const group = grpRes.rows[0];
        await client.query(
          `INSERT INTO group_memberships (user_id, group_id, role, privacy)
           VALUES ($1, $2, 'ADMIN', 'EXACT')`,
          [userId, group.id],
        );
        await client.query('COMMIT');

        loggerHandle.logger.info({ userId, groupId: group.id, name: group.name }, 'group created');

        return reply.code(201).send({
          id: group.id,
          name: group.name,
          createdAt: group.created_at.toISOString(),
          myRole: 'ADMIN' as GroupRole,
          myPrivacy: 'EXACT' as PrivacyMode,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );

  app.patch(
    '/api/auth/groups/:groupId/privacy',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const { groupId } = request.params as { groupId: string };
      const parsed = UpdatePrivacySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid privacy mode' });
      }
      const normalized = normalizePrivacyMode(parsed.data.privacy);
      const userId = request.authUser!.id;

      const updated = await pool.query<{ privacy: PrivacyMode }>(
        `UPDATE group_memberships
         SET privacy = $1
         WHERE user_id = $2 AND group_id = $3
         RETURNING privacy`,
        [normalized, userId, groupId],
      );
      if (updated.rows.length === 0) {
        return reply.code(404).send({ error: 'Membership not found' });
      }
      loggerHandle.logger.info({ userId, groupId, privacy: normalized }, 'privacy mode updated');
      return { groupId, privacy: updated.rows[0].privacy };
    },
  );

  app.patch(
    '/api/auth/groups/:groupId/members/:userId',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const { groupId, userId: targetUserId } = request.params as {
        groupId: string;
        userId: string;
      };
      const parsed = UpdateMemberRoleSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid role payload' });
      }

      if (request.authUser!.role !== 'HOST_ADMIN') {
        const callerMembership = await pool.query<{ role: GroupRole }>(
          'SELECT role FROM group_memberships WHERE user_id = $1 AND group_id = $2',
          [request.authUser!.id, groupId],
        );
        if (callerMembership.rows[0]?.role !== 'ADMIN') {
          return reply.code(403).send({ error: 'Group ADMIN role required' });
        }
      }

      const updated = await pool.query<{ user_id: string; role: GroupRole }>(
        `UPDATE group_memberships
         SET role = $1
         WHERE user_id = $2 AND group_id = $3
         RETURNING user_id, role`,
        [parsed.data.role, targetUserId, groupId],
      );
      if (updated.rows.length === 0) {
        return reply.code(404).send({ error: 'Target membership not found' });
      }
      return {
        groupId,
        userId: updated.rows[0].user_id,
        role: updated.rows[0].role,
      };
    },
  );

  // ---- Admin Endpoints ----

  app.post(
    '/api/admin/invites',
    { preHandler: [requireAdmin] },
    async (request: AuthenticatedRequest, reply) => {
      const parsed = CreateInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid invite payload', details: parsed.error.flatten() });
      }
      const { groupId, assignedRole, maxUses, expiresInHours } = parsed.data;
      const userId = request.authUser!.id;

      const groupRes = await pool.query<{ id: string; name: string }>(
        'SELECT id, name FROM groups WHERE id = $1',
        [groupId],
      );
      const group = groupRes.rows[0];
      if (!group) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      if (request.authUser!.role !== 'HOST_ADMIN') {
        const membership = await pool.query<{ role: GroupRole }>(
          'SELECT role FROM group_memberships WHERE user_id = $1 AND group_id = $2',
          [userId, groupId],
        );
        if (membership.rows[0]?.role !== 'ADMIN') {
          return reply.code(403).send({ error: 'Must be group ADMIN or HOST_ADMIN' });
        }
      }

      const inviteToken = `inv_${crypto.randomBytes(12).toString('hex')}`;
      const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

      await pool.query(
        `INSERT INTO group_invites (token, group_id, assigned_role, created_by, max_uses, uses, expires_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6)`,
        [inviteToken, groupId, assignedRole, userId, maxUses, expiresAt],
      );

      const headerOrigin = request.headers.origin;
      const serverUrl =
        headerOrigin && headerOrigin !== 'null' ? headerOrigin : publicServerUrl;

      const qrPayload = QrInvitePayloadSchema.parse({
        v: 1,
        serverUrl,
        inviteToken,
        groupName: group.name,
      });

      loggerHandle.logger.info(
        { userId, groupId, assignedRole, maxUses },
        'admin created invite token',
      );

      return reply.code(201).send({
        ...qrPayload,
        joinUrl: `${serverUrl.replace(/\/$/, '')}/join?token=${inviteToken}`,
        assignedRole,
        maxUses,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  app.get(
    '/api/admin/invites',
    { preHandler: [requireAdmin] },
    async (request: AuthenticatedRequest) => {
      const userId = request.authUser!.id;
      const isHostAdmin = request.authUser!.role === 'HOST_ADMIN';
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

      const res = await pool.query<{
        token: string;
        group_id: string;
        group_name: string;
        assigned_role: GroupRole;
        max_uses: number;
        uses: number;
        expires_at: Date;
      }>(query, isHostAdmin ? [] : [userId]);

      return {
        invites: res.rows.map((r) => ({
          token: r.token,
          groupId: r.group_id,
          groupName: r.group_name,
          assignedRole: r.assigned_role,
          maxUses: r.max_uses,
          uses: r.uses,
          expiresAt: r.expires_at.toISOString(),
        })),
      };
    },
  );

  app.get(
    '/api/admin/telemetry',
    { preHandler: [requireHostAdmin] },
    async (): Promise<SystemTelemetry> => {
      const [logStorageBytes, dbTelemetry] = await Promise.all([
        computeDirectorySizeBytes(logDir),
        getDatabaseTelemetry(pool),
      ]);

      const maxLogStorageBytes = Math.round(maxLogStorageMb * 1024 * 1024);
      const logStoragePercent =
        maxLogStorageBytes > 0
          ? Number(((logStorageBytes / maxLogStorageBytes) * 100).toFixed(2))
          : 0;

      const userTelemetries = await Promise.all(
        dbTelemetry.users.map(async (u) => {
          const redisStats = await getUserTelemetryFromRedis(redis, u.userId);
          return {
            userId: u.userId,
            username: u.username,
            email: u.email,
            role: u.role,
            locationBytes: u.locationBytes,
            locationPoints: u.locationPoints,
            ...redisStats,
          };
        }),
      );

      userTelemetries.sort((a, b) => {
        if (b.cpuMsPerMin !== a.cpuMsPerMin) return b.cpuMsPerMin - a.cpuMsPerMin;
        return b.eventsCount - a.eventsCount;
      });

      const totalLocationPoints = userTelemetries.reduce((acc, u) => acc + u.locationPoints, 0);
      const totalActiveSockets = userTelemetries.reduce((acc, u) => acc + u.activeSockets, 0);

      return {
        timestamp: new Date().toISOString(),
        logDir,
        logStorageBytes,
        maxLogStorageBytes,
        logStoragePercent,
        logStorageAlert: logStoragePercent >= 80,
        databaseBytes: dbTelemetry.databaseBytes,
        totalLocationPoints,
        totalActiveSockets,
        users: userTelemetries,
      };
    },
  );

  app.get(
    '/api/admin/logs/recent',
    { preHandler: [requireHostAdmin] },
    async () => {
      const lines = await redis.lrange(LOGS_RING_KEY, 0, 199);
      return { logs: lines.reverse() };
    },
  );

  app.get('/api/admin/logs/stream', { websocket: true }, async (socket, request) => {
    const query = request.query as { token?: string };
    const authHeader = request.headers.authorization;
    const rawToken =
      query.token ?? (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);

    if (!rawToken) {
      socket.close(1008, 'Missing token');
      return;
    }

    try {
      const decoded = app.jwt.verify<JwtUserPayload>(rawToken);
      if (decoded.role !== 'HOST_ADMIN') {
        socket.close(1008, 'Forbidden');
        return;
      }
    } catch {
      socket.close(1008, 'Unauthorized');
      return;
    }

    const recent = await redis.lrange(LOGS_RING_KEY, 0, 99);
    for (const entry of recent.reverse()) {
      socket.send(entry);
    }

    const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    subscriber.on('message', (_channel, message) => {
      if (socket.readyState === 1) {
        socket.send(message);
      }
    });
    await subscriber.subscribe(LOGS_STREAM_CHANNEL);

    socket.on('close', () => {
      void subscriber.quit().catch(() => subscriber.disconnect());
    });
  });

  app.addHook('onClose', async () => {
    await loggerHandle.close();
    await redis.quit().catch(() => redis.disconnect());
    await pool.end();
  });

  return { app, pool, redis, loggerHandle };
}

async function main() {
  const port = Number.parseInt(process.env.PORT ?? process.env.AUTH_ADMIN_PORT ?? '4001', 10);
  const { app, loggerHandle } = await createAuthAdminServer();
  await app.listen({ port, host: '0.0.0.0' });
  loggerHandle.logger.info({ port }, 'auth-admin-service listening');
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error('auth-admin-service fatal error:', err);
    process.exit(1);
  });
}
