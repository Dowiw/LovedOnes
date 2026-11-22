import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import { createAdapter } from '@socket.io/redis-adapter';
import Fastify, { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { Server as SocketIOServer, Socket } from 'socket.io';
import {
  createPool,
  enforceLocationQuotas,
  resolveAuditContext,
  runMigrations,
} from '@loved-ones/db';
import {
  AccountRemovedEventSchema,
  JwtUserPayload,
  MemberPrivacyUpdatedSchema,
  MemberProfileUpdatedSchema,
} from '@loved-ones/shared';
import {
  attachAuthAndTelemetry,
  AuthenticatedRequest,
  createEventThrottle,
  createFastifyCorsDelegator,
  createRateLimiter,
  createTokenService,
  DomainError,
  extractBearerToken,
  isOriginAllowed,
  registerGracefulShutdown,
} from '@loved-ones/shared/auth';
import {
  createServiceLogger,
  LOGS_RING_KEY,
  LOGS_STREAM_CHANNEL,
  ServiceLoggerHandle,
} from '@loved-ones/shared/logger';
import {
  loadResourceLimitsSettings,
  recordAdminNotice,
  recordUserTelemetry,
  REMOVED_USER_PREFIX,
  startServiceHeartbeat,
  TRACKER_JTI_USER_PREFIX,
  trackUserSocket,
  USER_ACCOUNT_REMOVED_CHANNEL,
  USER_PRIVACY_UPDATED_CHANNEL,
  USER_PROFILE_UPDATED_CHANNEL,
} from '@loved-ones/shared/telemetry';
import type { ResourceLimitsSettings } from '@loved-ones/shared';
import {
  PostgresRealtimeStore,
  SocketIoBroadcaster,
} from './adapters/postgres-socketio-adapters.js';
import { PostgresShareLinkStore } from './adapters/postgres-share-links-adapter.js';
import {
  PostgresPushSubscriptionStore,
  WebPushTransport,
} from './adapters/web-push-adapter.js';
import { PushNotificationsModule } from './domain/push-notifications-module.js';
import { ShareLinksModule } from './domain/share-links-module.js';
import { matchesIfNoneMatch, RealtimeModule } from './domain/realtime-module.js';

export interface RealtimeServiceOptions {
  databaseUrl?: string;
  redisUrl?: string;
  jwtSecret?: string;
  logDir?: string;
  disableFileLog?: boolean;
  disableRedisLog?: boolean;
  trustCloudflareHeaders?: boolean;
  rateLimit?: {
    disabled?: boolean;
    windowMs?: number;
    publicShareReadMax?: number;
    publicSharePingMax?: number;
  };
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

  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(cors, () =>
    createFastifyCorsDelegator({
      publicServerUrl: process.env.PUBLIC_SERVER_URL,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match', 'If-Modified-Since'],
      exposedHeaders: ['ETag', 'Last-Modified'],
    }),
  );

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
    verifyUserActive: async (userId) => !(await redis.get(`${REMOVED_USER_PREFIX}${userId}`)),
    recordTelemetry: (userId, elapsedMs, weight) =>
      recordUserTelemetry(redis, userId, elapsedMs, weight),
  });

  const io = new SocketIOServer(app.server, {
    cors: {
      origin: true,
      credentials: true,
    },
    allowRequest: (req, callback) => {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const rawHost = req.headers['x-forwarded-host'] ?? req.headers.host;
      const reqHost = (Array.isArray(rawHost) ? rawHost[0] : rawHost)?.split(',')[0]?.trim();
      const allowed = isOriginAllowed(origin, reqHost, {
        publicServerUrl: process.env.PUBLIC_SERVER_URL,
      });
      callback(null, allowed);
    },
    adapter: createAdapter(pubClient, subClient),
  });

  const pushNotifications = new PushNotificationsModule({
    store: new PostgresPushSubscriptionStore(pool),
    transport: new WebPushTransport(),
  });

  const shareLinks = new ShareLinksModule({
    store: new PostgresShareLinkStore(pool),
    publicServerUrl: process.env.PUBLIC_SERVER_URL ?? '',
  });

  const resolveRequestOrigin = (request: {
    headers: Record<string, string | string[] | undefined>;
  }): string | undefined => {
    const originHeader = request.headers.origin;
    if (typeof originHeader === 'string' && originHeader && originHeader !== 'null') {
      return originHeader;
    }
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    if (typeof host === 'string' && host.trim()) {
      const proto = request.headers['x-forwarded-proto'];
      const scheme = typeof proto === 'string' && proto.trim() ? proto.split(',')[0].trim() : 'http';
      return `${scheme}://${host.split(',')[0].trim()}`;
    }
    return undefined;
  };

  let cachedLimits: { value: ResourceLimitsSettings; fetchedAt: number } | null = null;
  let lastGlobalTrimAt = 0;

  const getCachedResourceLimits = async (): Promise<ResourceLimitsSettings> => {
    const nowMs = Date.now();
    if (cachedLimits && nowMs - cachedLimits.fetchedAt < 5000) {
      return cachedLimits.value;
    }
    const value = await loadResourceLimitsSettings(redis);
    cachedLimits = { value, fetchedAt: nowMs };
    return value;
  };

  const realtime = new RealtimeModule({
    store: new PostgresRealtimeStore(pool),
    broadcaster: new SocketIoBroadcaster(io),
    onLocationIngested: async (userId) => {
      const limits = await getCachedResourceLimits();
      if (!limits.autoTrimOnQuota) return;
      const perUserMaxPoints = limits.perUserMaxPoints;
      const perUserMaxLocationBytes = Math.round(limits.perUserMaxLocationMb * 1024 * 1024);
      const maxDatabaseBytes = Math.round(limits.maxDatabaseMb * 1024 * 1024);
      if (perUserMaxPoints <= 0 && perUserMaxLocationBytes <= 0 && maxDatabaseBytes <= 0) {
        return;
      }

      const nowMs = Date.now();
      const allowGlobalTrim = nowMs - lastGlobalTrimAt >= 60_000;
      const { trims, globalTrimmed } = await enforceLocationQuotas(pool, {
        userId,
        perUserMaxPoints,
        perUserMaxLocationBytes,
        maxDatabaseBytes,
        allowGlobalTrim,
      });
      if (globalTrimmed) {
        lastGlobalTrimAt = nowMs;
      }

      for (const trim of trims) {
        const notice = await recordAdminNotice(redis, {
          kind: 'quota_trim',
          userId: trim.userId,
          username: trim.username,
          deletedPoints: trim.deletedPoints,
          rangeStart: trim.rangeStart,
          rangeEnd: trim.rangeEnd,
          scope: trim.scope,
        }).catch(() => null);
        loggerHandle.logger.warn(
          {
            action: 'location.quota_trimmed',
            userId: trim.userId,
            username: trim.username,
            deletedPoints: trim.deletedPoints,
            rangeStart: trim.rangeStart,
            rangeEnd: trim.rangeEnd,
            scope: trim.scope,
            noticeId: notice?.id ?? null,
          },
          notice?.message ??
            `Auto-trimmed ${trim.deletedPoints} location point(s) for ${trim.username ?? trim.userId} (${trim.rangeStart}..${trim.rangeEnd})`,
        );
      }
    },
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
          void pushNotifications.notifyPlaceTransition(evt, groupName).catch(() => {});
        })
        .catch(() => {});
    },
  });

  logSubClient.on('message', (channel, message) => {
    if (channel === LOGS_STREAM_CHANNEL) {
      io.to('admin:logs').emit('logs:line', message);
      return;
    }
    if (channel === USER_ACCOUNT_REMOVED_CHANNEL) {
      try {
        const parsed = AccountRemovedEventSchema.parse(JSON.parse(message));
        const room = `user:${parsed.userId}`;
        io.to(room).emit('account:removed', parsed);
        setTimeout(() => {
          io.in(room).disconnectSockets(true);
        }, 180);
      } catch {
        // Ignore malformed account removal pub/sub payloads
      }
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
      return;
    }
    if (channel === USER_PRIVACY_UPDATED_CHANNEL) {
      try {
        const parsed = MemberPrivacyUpdatedSchema.parse(JSON.parse(message));
        io.to([`user:${parsed.userId}`, `group:${parsed.groupId}`]).emit('member:privacy:updated', parsed);
        void realtime.handleMemberPrivacyUpdated(parsed.userId, parsed.groupId).catch(() => {});
      } catch {
        // Ignore malformed privacy update pub/sub payloads
      }
    }
  });
  await logSubClient.subscribe(
    LOGS_STREAM_CHANNEL,
    USER_PROFILE_UPDATED_CHANNEL,
    USER_PRIVACY_UPDATED_CHANNEL,
    USER_ACCOUNT_REMOVED_CHANNEL,
  );

  // ---- REST Routes ----

  app.get('/health', async (_request, reply) => {
    let pgOk = false;
    let redisOk = false;
    try {
      await pool.query('SELECT 1');
      pgOk = true;
    } catch {
      pgOk = false;
    }
    try {
      redisOk = (await redis.ping()) === 'PONG';
    } catch {
      redisOk = false;
    }
    const status = pgOk && redisOk ? 'ok' : 'degraded';
    return reply.code(pgOk && redisOk ? 200 : 503).send({
      status,
      service: 'realtime-service',
      postgres: pgOk ? 'ok' : 'error',
      redis: redisOk ? 'ok' : 'error',
    });
  });

  app.get(
    '/api/realtime/push/vapid-public-key',
    { preHandler: [requireAuth] },
    async () => {
      const publicKey = await pushNotifications.getPublicKey();
      return { publicKey };
    },
  );

  app.post(
    '/api/realtime/push/subscribe',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const userAgent =
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null;
      const result = await pushNotifications.subscribe(user.id, request.body, userAgent);
      const endpointRaw = (request.body as { endpoint?: unknown } | undefined)?.endpoint;
      let endpointHost: string | undefined;
      if (typeof endpointRaw === 'string') {
        try {
          endpointHost = new URL(endpointRaw).host;
        } catch {
          endpointHost = undefined;
        }
      }
      loggerHandle.logger.info(
        {
          action: 'push.subscribed',
          userId: user.id,
          username: user.username,
          email: user.email,
          endpointHost,
        },
        `${user.username} enabled Web Push notifications${endpointHost ? ` (${endpointHost})` : ''}`,
      );
      return result;
    },
  );

  app.delete(
    '/api/realtime/push/subscribe',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const result = await pushNotifications.unsubscribe(user.id, request.body);
      loggerHandle.logger.info(
        {
          action: 'push.unsubscribed',
          userId: user.id,
          username: user.username,
          email: user.email,
          unsubscribed: result.unsubscribed,
        },
        `${user.username} disabled Web Push notifications`,
      );
      return result;
    },
  );

  app.post(
    '/api/realtime/push/test',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const result = await pushNotifications.sendTestNotification(user.id, user.username);
      loggerHandle.logger.info(
        {
          action: 'push.test_sent',
          userId: user.id,
          username: user.username,
          email: user.email,
          sent: result.sent,
          failed: result.failed,
        },
        `${user.username} triggered a test Web Push alert (sent=${result.sent}, failed=${result.failed})`,
      );
      return result;
    },
  );

  app.get(
    '/api/realtime/share-links',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const links = await shareLinks.listShareLinks(
        request.authUser!,
        resolveRequestOrigin(request),
      );
      return { links };
    },
  );

  app.post(
    '/api/realtime/share-links',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const user = request.authUser!;
      const link = await shareLinks.createShareLink(
        user,
        request.body,
        resolveRequestOrigin(request),
      );
      loggerHandle.logger.info(
        {
          action: 'share_link.created',
          userId: user.id,
          username: user.username,
          groupId: link.groupId,
          allowGuestSharing: link.allowGuestSharing,
          expiresAt: link.expiresAt,
        },
        `${user.username} created temporary guest share link (${link.allowGuestSharing ? 'mutual' : 'view-only'})`,
      );
      return reply.code(201).send({ link });
    },
  );

  app.delete(
    '/api/realtime/share-links/:token',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const { token } = request.params as { token: string };
      const res = await shareLinks.revokeShareLink(user, token);
      loggerHandle.logger.info(
        { action: 'share_link.revoked', userId: user.id, username: user.username },
        `${user.username} revoked temporary guest share link`,
      );
      return res;
    },
  );

  const rateLimitDisabled =
    options.rateLimit?.disabled ?? process.env.RATE_LIMIT_ENABLED === 'false';
  const publicShareWindowMs =
    options.rateLimit?.windowMs ??
    (Number.parseInt(process.env.RATE_LIMIT_SHARE_WINDOW_MS ?? '', 10) || 60 * 1000);
  const publicShareReadMax =
    options.rateLimit?.publicShareReadMax ??
    (Number.parseInt(process.env.RATE_LIMIT_SHARE_READ_MAX ?? '', 10) || 60);
  const publicSharePingMax =
    options.rateLimit?.publicSharePingMax ??
    (Number.parseInt(process.env.RATE_LIMIT_SHARE_PING_MAX ?? '', 10) || 30);
  const trustCloudflareHeaders =
    options.trustCloudflareHeaders ??
    process.env.TRUST_CLOUDFLARE_HEADERS?.trim().toLowerCase() === 'true';

  const publicShareReadRateLimit = createRateLimiter({
    prefix: 'share-read',
    max: publicShareReadMax,
    windowMs: publicShareWindowMs,
    redis,
    disabled: rateLimitDisabled,
    trustCloudflareHeaders,
  });
  const publicSharePingRateLimit = createRateLimiter({
    prefix: 'share-ping',
    max: publicSharePingMax,
    windowMs: publicShareWindowMs,
    redis,
    disabled: rateLimitDisabled,
    trustCloudflareHeaders,
  });

  app.get(
    '/api/realtime/public/share/:token',
    { preHandler: [publicShareReadRateLimit] },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      reply.header('Cache-Control', 'no-store');
      return shareLinks.getPublicShareSnapshot(token);
    },
  );

  app.post(
    '/api/realtime/public/share/:token/ping',
    { preHandler: [publicSharePingRateLimit] },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      reply.header('Cache-Control', 'no-store');
      const result = await shareLinks.upsertGuestPing(token, request.body);
      const guestName =
        typeof (request.body as { displayName?: unknown } | undefined)?.displayName === 'string'
          ? (request.body as { displayName: string }).displayName.trim()
          : 'Guest';
      loggerHandle.logger.info(
        {
          action: 'share_link.guest_ping',
          guestId: result.guestId,
          guestName,
          creatorUserId: result.snapshot.creator.userId,
          creatorUsername: result.snapshot.creator.username,
          activeGuests: result.snapshot.guests.length,
        },
        `Guest "${guestName}" updated live location on ${result.snapshot.creator.username}'s share link (${result.snapshot.guests.length} active guest(s))`,
      );
      return result;
    },
  );

  app.delete(
    '/api/realtime/public/share/:token/ping',
    { preHandler: [publicSharePingRateLimit] },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      reply.header('Cache-Control', 'no-store');
      const result = await shareLinks.stopGuestPing(token, request.body);
      const guestId =
        typeof (request.body as { guestId?: unknown } | undefined)?.guestId === 'string'
          ? (request.body as { guestId: string }).guestId
          : undefined;
      loggerHandle.logger.info(
        {
          action: 'share_link.guest_stopped',
          guestId,
          stopped: result.stopped,
          creatorUserId: result.snapshot.creator.userId,
          creatorUsername: result.snapshot.creator.username,
          activeGuests: result.snapshot.guests.length,
        },
        `Guest stopped sharing location on ${result.snapshot.creator.username}'s share link (${result.snapshot.guests.length} active guest(s) remaining)`,
      );
      return result;
    },
  );

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
      void pushNotifications.notifyChatMessage(message, groupName).catch(() => {});
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
      void pushNotifications.notifyCheckInRequest(created, groupName).catch(() => {});
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
      void pushNotifications.notifyCheckInResponse(res.request, groupName).catch(() => {});
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

  app.get(
    '/api/realtime/places',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const q = (request.query ?? {}) as { groupId?: string };
      return realtime.listAccessiblePlaces(
        request.authUser!,
        typeof q.groupId === 'string' && q.groupId ? q.groupId : undefined,
      );
    },
  );

  app.post(
    '/api/realtime/places',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const user = request.authUser!;
      const place = await realtime.createPlace(user, request.body);
      const groupName = place.groupId ? await resolveGroupName(place.groupId) : 'Private';
      loggerHandle.logger.info(
        {
          action: place.isPrivate ? 'place.private_created' : 'place.created',
          userId: user.id,
          username: user.username,
          email: user.email,
          groupId: place.groupId,
          groupName,
          isPrivate: place.isPrivate,
          placeId: place.id,
          placeName: place.name,
          latitude: place.latitude,
          longitude: place.longitude,
          radiusMeters: place.radiusMeters,
        },
        `${user.username} created ${place.isPrivate ? 'private ' : ''}place "${place.name}"`,
      );
      return reply.code(201).send({ place });
    },
  );

  app.delete(
    '/api/realtime/places/:placeId',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const user = request.authUser!;
      const { placeId } = request.params as { placeId: string };
      const before = await resolveAuditContext(pool, { userId: user.id, placeId });
      await realtime.deletePlace(user, placeId);
      const actorName = before.actorUsername ?? user.username;
      const placeName = before.placeName ?? placeId;
      loggerHandle.logger.info(
        {
          action: 'place.deleted',
          userId: user.id,
          username: actorName,
          email: user.email,
          placeId,
          placeName,
        },
        `${actorName} deleted place "${placeName}"`,
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
      const removedFlag = await redis.get(`${REMOVED_USER_PREFIX}${user.id}`);
      if (removedFlag) {
        next(new Error('ACCOUNT_REMOVED'));
        return;
      }
      socket.data.user = user;
      socket.data.groupIds = await realtime.resolveAuthorizedGroupIds(user.id);
      await trackUserSocket(redis, user.id, socket.id, 'connect');
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  const socketJoinThrottle = createEventThrottle({
    max: 30,
    windowMs: 60_000,
    disabled: rateLimitDisabled,
  });
  const socketLocationThrottle = createEventThrottle({
    max: 60,
    windowMs: 60_000,
    disabled: rateLimitDisabled,
  });
  const socketChatThrottle = createEventThrottle({
    max: 30,
    windowMs: 60_000,
    disabled: rateLimitDisabled,
  });
  const socketCheckInThrottle = createEventThrottle({
    max: 20,
    windowMs: 60_000,
    disabled: rateLimitDisabled,
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as JwtUserPayload;
    const groupIds = (socket.data.groupIds as string[] | undefined) ?? [];

    const checkSocketRate = (
      eventName: string,
      throttle: ReturnType<typeof createEventThrottle>,
      ack?: (res: { ok: boolean; error?: string }) => void,
    ): boolean => {
      const result = throttle.consume(socket.id);
      if (result.allowed) return true;
      loggerHandle.logger.warn(
        {
          action: 'socket.rate_limited',
          event: eventName,
          userId: user.id,
          username: user.username,
          socketId: socket.id,
          retryAfterMs: result.retryAfterMs,
        },
        `${user.username} hit Socket.io rate limit on ${eventName}`,
      );
      ack?.({ ok: false, error: 'Too many requests. Please slow down.' });
      return false;
    };

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

    socket.on('group:join', async (groupId: string, ack?: (res: { ok: boolean; error?: string }) => void) => {
      if (!checkSocketRate('group:join', socketJoinThrottle, ack)) return;
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
        if (!checkSocketRate('location:batch', socketLocationThrottle, ack)) return;
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
        if (!checkSocketRate('chat:send', socketChatThrottle, ack)) return;
        const startMs = performance.now();
        try {
          const message = await realtime.sendChatMessage(user, payload);
          const elapsedMs = Math.max(0, performance.now() - startMs);
          await recordUserTelemetry(redis, user.id, elapsedMs, 1);
          const groupName = await resolveGroupName(message.groupId);
          const preview = truncatePreview(message.content);
          void pushNotifications.notifyChatMessage(message, groupName).catch(() => {});
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
        if (!checkSocketRate('checkin:request', socketCheckInThrottle, ack)) return;
        try {
          const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
          const created = await realtime.createCheckInRequest(user, groupId, payload);
          const groupName = await resolveGroupName(groupId);
          void pushNotifications.notifyCheckInRequest(created, groupName).catch(() => {});
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
        if (!checkSocketRate('checkin:respond', socketCheckInThrottle, ack)) return;
        try {
          const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
          const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
          const res = await realtime.respondToCheckInRequest(user, groupId, requestId, payload);
          const groupName = await resolveGroupName(groupId);
          void pushNotifications.notifyCheckInResponse(res.request, groupName).catch(() => {});
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
      socketJoinThrottle.clearKey(socket.id);
      socketLocationThrottle.clearKey(socket.id);
      socketChatThrottle.clearKey(socket.id);
      socketCheckInThrottle.clearKey(socket.id);
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

  const heartbeat = startServiceHeartbeat({
    service: 'realtime-service',
    redis,
    mounts: [{ mountLabel: 'logs', path: logDir }],
  });

  app.addHook('onClose', async () => {
    io.disconnectSockets(true);
    await heartbeat.stop();
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
  registerGracefulShutdown(app, loggerHandle.logger, 'realtime-service');
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
