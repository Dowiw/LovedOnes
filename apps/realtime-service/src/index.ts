import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import { createAdapter } from '@socket.io/redis-adapter';
import Fastify, { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createPool, resolveAuditContext, runMigrations } from '@loved-ones/db';
import { JwtUserPayload, MemberProfileUpdatedSchema } from '@loved-ones/shared';
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
  USER_PROFILE_UPDATED_CHANNEL,
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

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DomainError) {
      const authReq = request as AuthenticatedRequest;
      loggerHandle.logger.warn(
        {
          action: 'request.rejected',
          statusCode: err.statusCode,
          method: request.method,
          url: request.url,
          userId: authReq.authUser?.id,
          username: authReq.authUser?.username,
          email: authReq.authUser?.email,
          error: err.message,
        },
        `${authReq.authUser?.username ?? request.ip} ${request.method} ${request.url} rejected (${err.statusCode}): ${err.message}`,
      );
      return reply
        .code(err.statusCode)
        .send(err.details ? { error: err.message, details: err.details } : { error: err.message });
    }
    loggerHandle.logger.error({ err, method: request.method, url: request.url }, 'unhandled realtime error');
    return reply.code(500).send({ error: 'Internal server error' });
  });

  const groupNameCache = new Map<string, string>();
  const resolveGroupName = async (groupId: string): Promise<string> => {
    const cached = groupNameCache.get(groupId);
    if (cached) return cached;
    const ctx = await resolveAuditContext(pool, { groupId });
    if (ctx.groupName) {
      groupNameCache.set(groupId, ctx.groupName);
      return ctx.groupName;
    }
    return groupId;
  };
  const truncatePreview = (text: string, max = 140): string =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

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
    onPlaceTransition: (evt) => {
      void resolveGroupName(evt.groupId)
        .then((groupName) => {
          loggerHandle.logger.info(
            {
              action: 'place.transition',
              userId: evt.userId,
              username: evt.username,
              groupId: evt.groupId,
              groupName,
              placeId: evt.placeId,
              placeName: evt.placeName,
              transition: evt.transition,
              recordedAt: evt.recordedAt,
            },
            `${evt.username} ${evt.transition === 'enter' ? 'entered' : 'exited'} place "${evt.placeName}" in group "${groupName}"`,
          );
        })
        .catch(() => {});
    },
  });

  logSubClient.on('message', (channel, message) => {
    if (channel === LOGS_STREAM_CHANNEL) {
      io.to('admin:logs').emit('logs:line', message);
      return;
    }
    if (channel === USER_PROFILE_UPDATED_CHANNEL) {
      try {
        const parsed = MemberProfileUpdatedSchema.parse(JSON.parse(message));
        for (const gid of parsed.groupIds) {
          io.to(`group:${gid}`).emit('member:profile:updated', {
            userId: parsed.userId,
            username: parsed.username,
            avatarUrl: parsed.avatarUrl,
            haloColor: parsed.haloColor ?? null,
            fuzzCircleColor: parsed.fuzzCircleColor ?? null,
          });
        }
      } catch {
        // Ignore malformed profile update pub/sub payloads
      }
    }
  });
  await logSubClient.subscribe(LOGS_STREAM_CHANNEL, USER_PROFILE_UPDATED_CHANNEL);

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
      loggerHandle.logger.info(
        {
          action: 'location.ingested_rest',
          userId: user.id,
          username: user.username,
          email: user.email,
          points: inserted,
        },
        `${user.username} (${user.email}) shared ${inserted} location point(s) via REST`,
      );
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
      loggerHandle.logger.info(
        {
          action: 'location.ingested_owntracks',
          userId: user.id,
          username: user.username,
          email: user.email,
          points: inserted,
        },
        `${user.username} (${user.email}) shared ${inserted} location point(s) via OwnTracks`,
      );
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
      loggerHandle.logger.info(
        {
          action: 'location.ingested_overland',
          userId: user.id,
          username: user.username,
          email: user.email,
          points: inserted,
        },
        `${user.username} (${user.email}) shared ${inserted} location point(s) via Overland`,
      );
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
      const user = request.authUser!;
      const { groupId } = request.params as { groupId: string };
      const body = (request.body ?? {}) as { content?: string };
      const message = await realtime.sendChatMessage(user, {
        groupId,
        content: body.content,
      });
      const groupName = await resolveGroupName(groupId);
      const preview = truncatePreview(message.content);
      loggerHandle.logger.info(
        {
          action: 'chat.message_sent',
          channel: 'rest',
          userId: user.id,
          username: message.senderUsername,
          email: user.email,
          groupId,
          groupName,
          messageId: message.id,
          messagePreview: preview,
        },
        `${message.senderUsername} sent message to group "${groupName}": "${preview}"`,
      );
      return reply.code(201).send({ message });
    },
  );

  app.get(
    '/api/realtime/groups/:groupId/location-requests',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const { groupId } = request.params as { groupId: string };
      return realtime.listCheckInRequests(request.authUser!, groupId);
    },
  );

  app.post(
    '/api/realtime/groups/:groupId/location-requests',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const user = request.authUser!;
      const { groupId } = request.params as { groupId: string };
      const created = await realtime.createCheckInRequest(
        user,
        groupId,
        request.body,
      );
      const groupName = await resolveGroupName(groupId);
      loggerHandle.logger.info(
        {
          action: 'checkin.requested',
          channel: 'rest',
          requestId: created.id,
          userId: user.id,
          username: created.requesterUsername,
          targetUserId: created.targetUserId,
          targetUsername: created.targetUsername,
          groupId,
          groupName,
          durationMinutes: created.suggestedDurationMinutes,
          note: created.message,
        },
        `${created.requesterUsername} requested check-in from ${created.targetUsername} in group "${groupName}" (${created.suggestedDurationMinutes} min${
          created.message ? `, note: "${truncatePreview(created.message, 80)}"` : ''
        })`,
      );
      return reply.code(201).send({ request: created });
    },
  );

  app.post(
    '/api/realtime/groups/:groupId/location-requests/:requestId/respond',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const { groupId, requestId } = request.params as { groupId: string; requestId: string };
      const res = await realtime.respondToCheckInRequest(
        user,
        groupId,
        requestId,
        request.body,
      );
      const groupName = await resolveGroupName(groupId);
      loggerHandle.logger.info(
        {
          action: 'checkin.responded',
          channel: 'rest',
          requestId: res.request.id,
          status: res.request.status,
          userId: user.id,
          username: res.request.targetUsername,
          requesterId: res.request.requesterId,
          requesterUsername: res.request.requesterUsername,
          groupId,
          groupName,
          privacyOverrideUntil: res.privacyOverrideUntil,
        },
        `${res.request.targetUsername} ${res.request.status} check-in request from ${res.request.requesterUsername} in group "${groupName}"${
          res.privacyOverrideUntil ? ` (EXACT override until ${res.privacyOverrideUntil})` : ''
        }`,
      );
      return res;
    },
  );

  app.get(
    '/api/realtime/groups/:groupId/places',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const { groupId } = request.params as { groupId: string };
      return realtime.listGroupPlaces(request.authUser!, groupId);
    },
  );

  app.post(
    '/api/realtime/groups/:groupId/places',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const user = request.authUser!;
      const { groupId } = request.params as { groupId: string };
      const place = await realtime.createGroupPlace(user, groupId, request.body);
      const groupName = await resolveGroupName(groupId);
      loggerHandle.logger.info(
        {
          action: 'place.created',
          userId: user.id,
          username: user.username,
          email: user.email,
          groupId,
          groupName,
          placeId: place.id,
          placeName: place.name,
          latitude: place.latitude,
          longitude: place.longitude,
          radiusMeters: place.radiusMeters,
        },
        `${user.username} created place "${place.name}" in group "${groupName}" (${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}, radius ${place.radiusMeters}m)`,
      );
      return reply.code(201).send({ place });
    },
  );

  app.delete(
    '/api/realtime/groups/:groupId/places/:placeId',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const { groupId, placeId } = request.params as { groupId: string; placeId: string };
      const before = await resolveAuditContext(pool, { userId: user.id, groupId, placeId });
      await realtime.deleteGroupPlace(user, groupId, placeId);
      const actorName = before.actorUsername ?? user.username;
      const groupName = before.groupName ?? groupId;
      const placeName = before.placeName ?? placeId;
      loggerHandle.logger.info(
        {
          action: 'place.deleted',
          userId: user.id,
          username: actorName,
          email: user.email,
          groupId,
          groupName,
          placeId,
          placeName,
        },
        `${actorName} deleted place "${placeName}" from group "${groupName}"`,
      );
      return { ok: true };
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

    void socket.join(`user:${user.id}`);
    for (const gid of groupIds) {
      void socket.join(`group:${gid}`);
    }

    if (user.role === 'HOST_ADMIN') {
      void socket.join('admin:logs');
      void redis.lrange(LOGS_RING_KEY, 0, 99).then((recent) => {
        socket.emit('logs:init', recent.reverse());
      });
    }

    loggerHandle.logger.info(
      {
        action: 'socket.connected',
        userId: user.id,
        username: user.username,
        email: user.email,
        socketId: socket.id,
        groupCount: groupIds.length,
      },
      `${user.username} (${user.email}) connected live socket`,
    );

    socket.on('group:join', async (groupId: string, ack?: (res: { ok: boolean }) => void) => {
      try {
        if (typeof groupId === 'string' && (await realtime.canJoinGroupRoom(user.id, groupId))) {
          await socket.join(`group:${groupId}`);
          const groupName = await resolveGroupName(groupId);
          loggerHandle.logger.info(
            {
              action: 'socket.group_joined',
              userId: user.id,
              username: user.username,
              groupId,
              groupName,
              socketId: socket.id,
            },
            `${user.username} joined live room for group "${groupName}"`,
          );
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
            {
              action: 'location.ingested_socket',
              userId: user.id,
              username: user.username,
              email: user.email,
              points: inserted,
            },
            `${user.username} (${user.email}) shared ${inserted} location point(s) via Socket`,
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
          const groupName = await resolveGroupName(message.groupId);
          const preview = truncatePreview(message.content);
          loggerHandle.logger.info(
            {
              action: 'chat.message_sent',
              channel: 'socket',
              userId: user.id,
              username: message.senderUsername,
              email: user.email,
              groupId: message.groupId,
              groupName,
              messageId: message.id,
              messagePreview: preview,
            },
            `${message.senderUsername} sent message to group "${groupName}": "${preview}"`,
          );
          ack?.({ ok: true, message });
        } catch (err) {
          ack?.({ ok: false, error: err instanceof Error ? err.message : 'Failed to send' });
        }
      },
    );

    socket.on(
      'checkin:request',
      async (
        payload: { groupId?: string } & Record<string, unknown>,
        ack?: (res: { ok: boolean; request?: unknown; error?: string }) => void,
      ) => {
        try {
          const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
          const created = await realtime.createCheckInRequest(user, groupId, payload);
          const groupName = await resolveGroupName(groupId);
          loggerHandle.logger.info(
            {
              action: 'checkin.requested',
              channel: 'socket',
              requestId: created.id,
              userId: user.id,
              username: created.requesterUsername,
              targetUserId: created.targetUserId,
              targetUsername: created.targetUsername,
              groupId,
              groupName,
              durationMinutes: created.suggestedDurationMinutes,
              note: created.message,
            },
            `${created.requesterUsername} requested check-in from ${created.targetUsername} in group "${groupName}" (${created.suggestedDurationMinutes} min${
              created.message ? `, note: "${truncatePreview(created.message, 80)}"` : ''
            })`,
          );
          ack?.({ ok: true, request: created });
        } catch (err) {
          ack?.({ ok: false, error: err instanceof Error ? err.message : 'Failed to request check-in' });
        }
      },
    );

    socket.on(
      'checkin:respond',
      async (
        payload: { groupId?: string; requestId?: string } & Record<string, unknown>,
        ack?: (res: { ok: boolean; request?: unknown; privacyOverrideUntil?: string | null; error?: string }) => void,
      ) => {
        try {
          const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
          const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
          const res = await realtime.respondToCheckInRequest(user, groupId, requestId, payload);
          const groupName = await resolveGroupName(groupId);
          loggerHandle.logger.info(
            {
              action: 'checkin.responded',
              channel: 'socket',
              requestId: res.request.id,
              status: res.request.status,
              userId: user.id,
              username: res.request.targetUsername,
              requesterId: res.request.requesterId,
              requesterUsername: res.request.requesterUsername,
              groupId,
              groupName,
              privacyOverrideUntil: res.privacyOverrideUntil,
            },
            `${res.request.targetUsername} ${res.request.status} check-in request from ${res.request.requesterUsername} in group "${groupName}"${
              res.privacyOverrideUntil ? ` (EXACT override until ${res.privacyOverrideUntil})` : ''
            }`,
          );
          ack?.({ ok: true, ...res });
        } catch (err) {
          ack?.({ ok: false, error: err instanceof Error ? err.message : 'Failed to respond' });
        }
      },
    );

    socket.on('disconnect', () => {
      void trackUserSocket(redis, user.id, socket.id, 'disconnect').catch(() => {});
      loggerHandle.logger.info(
        {
          action: 'socket.disconnected',
          userId: user.id,
          username: user.username,
          email: user.email,
          socketId: socket.id,
        },
        `${user.username} (${user.email}) disconnected live socket`,
      );
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
