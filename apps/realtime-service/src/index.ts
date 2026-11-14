import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import { createAdapter } from '@socket.io/redis-adapter';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { Server as SocketIOServer, Socket } from 'socket.io';
import {
  createPool,
  getLatestGroupLocations,
  insertLocationBatch,
  runMigrations,
} from '@loved-ones/db';
import {
  applyPrivacyFuzzing,
  ChatMessage,
  GroupRole,
  JwtUserPayload,
  JwtUserPayloadSchema,
  LocationBatchSchema,
  LocationBroadcast,
  LocationPoint,
  PrivacyMode,
  SendMessageSchema,
} from '@loved-ones/shared';
import {
  createServiceLogger,
  LOGS_RING_KEY,
  LOGS_STREAM_CHANNEL,
  ServiceLoggerHandle,
} from '@loved-ones/shared/logger';
import { recordUserTelemetry, trackUserSocket } from '@loved-ones/shared/telemetry';

export interface RealtimeServiceOptions {
  databaseUrl?: string;
  redisUrl?: string;
  jwtSecret?: string;
  logDir?: string;
  disableFileLog?: boolean;
  disableRedisLog?: boolean;
}

interface AuthenticatedRequest extends FastifyRequest {
  authUser?: JwtUserPayload;
  perfStartMs?: number;
}

export async function createRealtimeServer(options: RealtimeServiceOptions = {}): Promise<{
  app: FastifyInstance;
  io: SocketIOServer;
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
  const logDir = options.logDir ?? process.env.LOG_DIR ?? path.resolve(process.cwd(), 'logs');

  const pool = createPool(databaseUrl);
  await runMigrations(pool);

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const pubClient = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const subClient = pubClient.duplicate();
  const logSubClient = new Redis(redisUrl, { maxRetriesPerRequest: 3 });

  const loggerHandle = await createServiceLogger('realtime-service', {
    logDir,
    redisUrl,
    disableFile: options.disableFileLog,
    disableRedis: options.disableRedisLog,
  });

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(fastifyJwt, {
    secret: jwtSecret,
  });

  const io = new SocketIOServer(app.server, {
    cors: {
      origin: true,
      credentials: true,
    },
    adapter: createAdapter(pubClient, subClient),
  });

  logSubClient.on('message', (_channel, message) => {
    io.to('admin:logs').emit('logs:line', message);
  });
  await logSubClient.subscribe(LOGS_STREAM_CHANNEL);

  async function requireAuth(request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
    try {
      const decoded = await request.jwtVerify<JwtUserPayload>();
      request.authUser = JwtUserPayloadSchema.parse(decoded);
    } catch {
      await reply.code(401).send({ error: 'Unauthorized' });
    }
  }

  async function isGroupMember(userId: string, groupId: string): Promise<boolean> {
    const res = await pool.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM group_memberships WHERE user_id = $1 AND group_id = $2) AS exists',
      [userId, groupId],
    );
    return Boolean(res.rows[0]?.exists);
  }

  async function processAndBroadcastLocations(
    user: JwtUserPayload,
    points: LocationPoint[],
  ): Promise<number> {
    const inserted = await insertLocationBatch(pool, user.id, points);
    const latest = points[points.length - 1];
    if (!latest) return inserted;

    const memberships = await pool.query<{
      group_id: string;
      role: GroupRole;
      privacy: PrivacyMode;
    }>(
      'SELECT group_id, role, privacy FROM group_memberships WHERE user_id = $1',
      [user.id],
    );

    for (const m of memberships.rows) {
      if (m.role === 'SPECTATOR') continue;

      const fuzzed = applyPrivacyFuzzing(latest.latitude, latest.longitude, m.privacy, user.id);
      if (!fuzzed.visible) continue;

      const broadcast: LocationBroadcast = {
        userId: user.id,
        username: user.username,
        groupId: m.group_id,
        latitude: fuzzed.latitude,
        longitude: fuzzed.longitude,
        altitude: latest.altitude ?? null,
        speed: latest.speed ?? null,
        batteryLevel: latest.batteryLevel ?? null,
        recordedAt: latest.recordedAt,
        privacyMode: m.privacy,
        isFuzzed: fuzzed.isFuzzed,
      };
      io.to(`group:${m.group_id}`).emit('location:update', broadcast);
    }

    return inserted;
  }

  async function persistAndBroadcastChat(
    user: JwtUserPayload,
    groupId: string,
    content: string,
  ): Promise<ChatMessage> {
    const inserted = await pool.query<{
      id: string;
      group_id: string;
      sender_id: string;
      content: string;
      created_at: Date;
    }>(
      `INSERT INTO messages (group_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, group_id, sender_id, content, created_at`,
      [groupId, user.id, content],
    );
    const row = inserted.rows[0];
    const message: ChatMessage = {
      id: row.id,
      groupId: row.group_id,
      senderId: row.sender_id,
      senderUsername: user.username,
      content: row.content,
      createdAt: row.created_at.toISOString(),
    };
    io.to(`group:${groupId}`).emit('chat:message', message);
    return message;
  }

  // REST telemetry hook
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
    return { status: 'ok', service: 'realtime-service' };
  });

  app.post(
    '/api/realtime/locations',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const startMs = performance.now();
      const parsed = LocationBatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid location batch', details: parsed.error.flatten() });
      }
      const user = request.authUser!;
      const inserted = await processAndBroadcastLocations(user, parsed.data.points);
      const elapsedMs = Math.max(0, performance.now() - startMs);
      await recordUserTelemetry(redis, user.id, elapsedMs, parsed.data.points.length);

      loggerHandle.logger.info({ userId: user.id, points: inserted }, 'ingested location batch via REST');
      return { inserted };
    },
  );

  app.get(
    '/api/realtime/groups/:groupId/locations',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const { groupId } = request.params as { groupId: string };
      const user = request.authUser!;
      if (!(await isGroupMember(user.id, groupId))) {
        return reply.code(403).send({ error: 'Not a member of this group' });
      }

      const rows = await getLatestGroupLocations(pool, groupId);
      const locations: LocationBroadcast[] = [];
      for (const row of rows) {
        const fuzzed = applyPrivacyFuzzing(row.latitude, row.longitude, row.privacy, row.userId);
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
      return { locations };
    },
  );

  app.get(
    '/api/realtime/groups/:groupId/messages',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const { groupId } = request.params as { groupId: string };
      const user = request.authUser!;
      if (!(await isGroupMember(user.id, groupId))) {
        return reply.code(403).send({ error: 'Not a member of this group' });
      }

      const res = await pool.query<{
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
         LIMIT 100`,
        [groupId],
      );

      const messages: ChatMessage[] = res.rows.reverse().map((r) => ({
        id: r.id,
        groupId: r.group_id,
        senderId: r.sender_id,
        senderUsername: r.sender_username,
        content: r.content,
        createdAt: r.created_at.toISOString(),
      }));
      return { messages };
    },
  );

  app.post(
    '/api/realtime/groups/:groupId/messages',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const { groupId } = request.params as { groupId: string };
      const body = (request.body ?? {}) as { content?: string };
      const parsed = SendMessageSchema.safeParse({ groupId, content: body.content });
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid message payload' });
      }
      const user = request.authUser!;
      if (!(await isGroupMember(user.id, groupId))) {
        return reply.code(403).send({ error: 'Not a member of this group' });
      }

      const message = await persistAndBroadcastChat(user, groupId, parsed.data.content);
      loggerHandle.logger.info({ userId: user.id, groupId }, 'chat message sent via REST');
      return reply.code(201).send({ message });
    },
  );

  // ---- Socket.io Auth & Handlers ----

  io.use(async (socket: Socket, next) => {
    try {
      const authToken =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.headers.authorization?.startsWith('Bearer ')
          ? socket.handshake.headers.authorization.slice(7)
          : undefined);
      if (!authToken) {
        next(new Error('Unauthorized'));
        return;
      }
      const decoded = app.jwt.verify<JwtUserPayload>(authToken);
      const user = JwtUserPayloadSchema.parse(decoded);
      socket.data.user = user;

      const groupsRes = await pool.query<{ group_id: string }>(
        'SELECT group_id FROM group_memberships WHERE user_id = $1',
        [user.id],
      );
      socket.data.groupIds = groupsRes.rows.map((r) => r.group_id);
      await trackUserSocket(redis, user.id, socket.id, 'connect');
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as JwtUserPayload;
    const groupIds = (socket.data.groupIds as string[] | undefined) ?? [];

    for (const gid of groupIds) {
      void socket.join(`group:${gid}`);
    }

    if (user.role === 'HOST_ADMIN') {
      void socket.join('admin:logs');
      void redis.lrange(LOGS_RING_KEY, 0, 99).then((recent) => {
        socket.emit('logs:init', recent.reverse());
      });
    }

    loggerHandle.logger.info({ userId: user.id, socketId: socket.id }, 'socket connected');

    socket.on('group:join', async (groupId: string, ack?: (res: { ok: boolean }) => void) => {
      try {
        if (typeof groupId === 'string' && (await isGroupMember(user.id, groupId))) {
          await socket.join(`group:${groupId}`);
          ack?.({ ok: true });
        } else {
          ack?.({ ok: false });
        }
      } catch {
        ack?.({ ok: false });
      }
    });

    socket.on(
      'location:batch',
      async (
        payload: unknown,
        ack?: (res: { ok: boolean; inserted?: number; error?: string }) => void,
      ) => {
        const startMs = performance.now();
        try {
          const parsed = LocationBatchSchema.safeParse(payload);
          if (!parsed.success) {
            ack?.({ ok: false, error: 'Invalid location batch' });
            return;
          }
          const inserted = await processAndBroadcastLocations(user, parsed.data.points);
          const elapsedMs = Math.max(0, performance.now() - startMs);
          await recordUserTelemetry(redis, user.id, elapsedMs, parsed.data.points.length);
          loggerHandle.logger.info(
            { userId: user.id, points: inserted },
            'ingested location batch via socket',
          );
          ack?.({ ok: true, inserted });
        } catch (err) {
          ack?.({ ok: false, error: err instanceof Error ? err.message : 'Failed to ingest' });
        }
      },
    );

    socket.on(
      'chat:send',
      async (
        payload: unknown,
        ack?: (res: { ok: boolean; message?: ChatMessage; error?: string }) => void,
      ) => {
        const startMs = performance.now();
        try {
          const parsed = SendMessageSchema.safeParse(payload);
          if (!parsed.success) {
            ack?.({ ok: false, error: 'Invalid chat message' });
            return;
          }
          if (!(await isGroupMember(user.id, parsed.data.groupId))) {
            ack?.({ ok: false, error: 'Not a group member' });
            return;
          }
          const message = await persistAndBroadcastChat(
            user,
            parsed.data.groupId,
            parsed.data.content,
          );
          const elapsedMs = Math.max(0, performance.now() - startMs);
          await recordUserTelemetry(redis, user.id, elapsedMs, 1);
          loggerHandle.logger.info(
            { userId: user.id, groupId: parsed.data.groupId },
            'chat message sent via socket',
          );
          ack?.({ ok: true, message });
        } catch (err) {
          ack?.({ ok: false, error: err instanceof Error ? err.message : 'Failed to send' });
        }
      },
    );

    socket.on('disconnect', () => {
      void trackUserSocket(redis, user.id, socket.id, 'disconnect').catch(() => {});
      loggerHandle.logger.info({ userId: user.id, socketId: socket.id }, 'socket disconnected');
    });
  });

  app.addHook('onClose', async () => {
    io.disconnectSockets(true);
    await loggerHandle.close();
    await logSubClient.unsubscribe().catch(() => {});
    logSubClient.disconnect();
    pubClient.disconnect();
    subClient.disconnect();
    await redis.quit().catch(() => redis.disconnect());
    await pool.end();
  });

  return { app, io, pool, redis, loggerHandle };
}

async function main() {
  const port = Number.parseInt(process.env.PORT ?? process.env.REALTIME_PORT ?? '4002', 10);
  const { app, loggerHandle } = await createRealtimeServer();
  await app.listen({ port, host: '0.0.0.0' });
  loggerHandle.logger.info({ port }, 'realtime-service listening');
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error('realtime-service fatal error:', err);
    process.exit(1);
  });
}
