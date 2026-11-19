import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import { createAdapter } from '@socket.io/redis-adapter';
import Fastify, { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createPool, runMigrations } from '@loved-ones/db';
import { JwtUserPayload } from '@loved-ones/shared';
import {
  attachAuthAndTelemetry,
  AuthenticatedRequest,
  createTokenService,
  DomainError,
  extractBearerToken,
} from '@loved-ones/shared/auth';
import {
  createServiceLogger,
  LOGS_RING_KEY,
  LOGS_STREAM_CHANNEL,
  ServiceLoggerHandle,
} from '@loved-ones/shared/logger';
import {
  recordUserTelemetry,
  TRACKER_JTI_USER_PREFIX,
  trackUserSocket,
} from '@loved-ones/shared/telemetry';
import {
  PostgresRealtimeStore,
  SocketIoBroadcaster,
} from './adapters/postgres-socketio-adapters.js';
import { matchesIfNoneMatch, RealtimeModule } from './domain/realtime-module.js';

export interface RealtimeServiceOptions {
  databaseUrl?: string;
  redisUrl?: string;
  jwtSecret?: string;
  logDir?: string;
  disableFileLog?: boolean;
  disableRedisLog?: boolean;
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

  const loggerHandle = await createServiceLogger('realtime-service', {
    logDir,
    redisUrl,
    disableFile: options.disableFileLog,
    disableRedis: options.disableRedisLog,
  });

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const pubClient = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const subClient = pubClient.duplicate({ enableReadyCheck: false });
  const logSubClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
  });

  for (const [name, client] of [
    ['redis', redis],
    ['pubClient', pubClient],
    ['subClient', subClient],
    ['logSubClient', logSubClient],
  ] as const) {
    client.on('error', (err) => {
      loggerHandle.logger.error({ err, client: name }, 'redis client error');
    });
  }

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match', 'If-Modified-Since'],
    exposedHeaders: ['ETag', 'Last-Modified'],
  });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof DomainError) {
      return reply
        .code(err.statusCode)
        .send(err.details ? { error: err.message, details: err.details } : { error: err.message });
    }
    loggerHandle.logger.error({ err }, 'unhandled realtime error');
    return reply.code(500).send({ error: 'Internal server error' });
  });

  const tokenService = createTokenService({ jwtSecret });
  const { requireAuth, requireIngestionAuth } = attachAuthAndTelemetry(app, {
    verifyAccessToken: (token) => tokenService.verifyAccessToken(token),
    verifyIngestionToken: (token) => tokenService.verifyIngestionToken(token),
    verifyTrackerJti: async (userId, jti) => {
      const activeJti = await redis.get(`${TRACKER_JTI_USER_PREFIX}${userId}`);
      return activeJti === jti;
    },
    recordTelemetry: (userId, elapsedMs, weight) =>
      recordUserTelemetry(redis, userId, elapsedMs, weight),
  });

  const io = new SocketIOServer(app.server, {
    cors: {
      origin: true,
      credentials: true,
    },
    adapter: createAdapter(pubClient, subClient),
  });

  const realtime = new RealtimeModule({
    store: new PostgresRealtimeStore(pool),
    broadcaster: new SocketIoBroadcaster(io),
  });

  logSubClient.on('message', (_channel, message) => {
    io.to('admin:logs').emit('logs:line', message);
  });
  await logSubClient.subscribe(LOGS_STREAM_CHANNEL);

  // ---- REST Routes ----

  app.get('/health', async () => {
    return { status: 'ok', service: 'realtime-service' };
  });

  app.post(
    '/api/realtime/locations',
    { preHandler: [requireIngestionAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const body = request.body as { points?: unknown[] } | undefined;
      const inserted = await realtime.ingestLocationBatch(user, body);
      request.telemetryEventWeight = Math.max(1, inserted);
      loggerHandle.logger.info({ userId: user.id, points: inserted }, 'ingested location batch via REST');
      return { inserted };
    },
  );

  app.post(
    '/api/realtime/owntracks',
    { preHandler: [requireIngestionAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const { inserted, response } = await realtime.ingestOwnTracks(user, request.body);
      request.telemetryEventWeight = Math.max(1, inserted);
      loggerHandle.logger.info({ userId: user.id, points: inserted }, 'ingested OwnTracks payload');
      return response;
    },
  );

  app.post(
    '/api/realtime/overland',
    { preHandler: [requireIngestionAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const { inserted, result } = await realtime.ingestOverland(user, request.body);
      request.telemetryEventWeight = Math.max(1, inserted);
      loggerHandle.logger.info({ userId: user.id, points: inserted }, 'ingested Overland payload');
      return { result, inserted };
    },
  );

  app.get(
    '/api/realtime/groups/:groupId/locations',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const { groupId } = request.params as { groupId: string };
      const snapshot = await realtime.getGroupLocationsSnapshot(
        request.authUser!,
        groupId,
        request.query,
      );
      reply.header('ETag', snapshot.etag);
      reply.header('Cache-Control', 'private, no-cache');
      if (snapshot.lastModified) {
        reply.header('Last-Modified', snapshot.lastModified);
      }
      if (matchesIfNoneMatch(request.headers['if-none-match'], snapshot.etag)) {
        return reply.code(304).send();
      }
      return { locations: snapshot.locations };
    },
  );

  app.get(
    '/api/realtime/groups/:groupId/trails',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const { groupId } = request.params as { groupId: string };
      const trails = await realtime.getGroupTrails(
        request.authUser!,
        groupId,
        request.query,
      );
      return { trails };
    },
  );

  app.get(
    '/api/realtime/groups/:groupId/messages',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const { groupId } = request.params as { groupId: string };
      const messages = await realtime.getGroupMessages(request.authUser!, groupId);
      return { messages };
    },
  );

  app.post(
    '/api/realtime/groups/:groupId/messages',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const { groupId } = request.params as { groupId: string };
      const body = (request.body ?? {}) as { content?: string };
      const message = await realtime.sendChatMessage(request.authUser!, {
        groupId,
        content: body.content,
      });
      loggerHandle.logger.info({ userId: request.authUser!.id, groupId }, 'chat message sent via REST');
      return reply.code(201).send({ message });
    },
  );

  // ---- Socket.io Auth & Handlers ----

  io.use(async (socket: Socket, next) => {
    try {
      const authToken =
        (socket.handshake.auth?.token as string | undefined) ??
        extractBearerToken(socket.handshake.headers.authorization);
      if (!authToken) {
        next(new Error('Unauthorized'));
        return;
      }
      const user = await tokenService.verifyAccessToken(authToken);
      socket.data.user = user;
      socket.data.groupIds = await realtime.resolveAuthorizedGroupIds(user.id);
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
        if (typeof groupId === 'string' && (await realtime.canJoinGroupRoom(user.id, groupId))) {
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
          const inserted = await realtime.ingestLocationBatch(user, payload);
          const elapsedMs = Math.max(0, performance.now() - startMs);
          if (inserted > 0) {
            await recordUserTelemetry(redis, user.id, elapsedMs, inserted);
          }
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
        ack?: (res: { ok: boolean; message?: unknown; error?: string }) => void,
      ) => {
        const startMs = performance.now();
        try {
          const message = await realtime.sendChatMessage(user, payload);
          const elapsedMs = Math.max(0, performance.now() - startMs);
          await recordUserTelemetry(redis, user.id, elapsedMs, 1);
          loggerHandle.logger.info(
            { userId: user.id, groupId: message.groupId },
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
