import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createPool, runMigrations } from '@loved-ones/db';
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
import { recordUserTelemetry } from '@loved-ones/shared/telemetry';
import {
  PostgresAuthGroupStore,
  PostgresRedisTelemetryStore,
  RedisSessionStore,
} from './adapters/postgres-redis-adapters.js';
import { AuthGroupModule } from './domain/auth-group-module.js';
import { TelemetryQueryModule } from './domain/telemetry-query-module.js';

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

  const loggerHandle = await createServiceLogger('auth-admin-service', {
    logDir,
    redisUrl,
    disableFile: options.disableFileLog,
    disableRedis: options.disableRedisLog,
  });

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  redis.on('error', (err) => {
    loggerHandle.logger.error({ err }, 'auth-admin redis client error');
  });

  const tokenService = createTokenService({ jwtSecret, jwtRefreshSecret });
  const authGroup = new AuthGroupModule({
    store: new PostgresAuthGroupStore(pool),
    sessionStore: new RedisSessionStore(redis),
    tokenService,
    publicServerUrl,
  });
  const telemetryQuery = new TelemetryQueryModule({
    store: new PostgresRedisTelemetryStore(pool, redis, logDir),
    logDir,
    maxLogStorageMb,
  });

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof DomainError) {
      return reply
        .code(err.statusCode)
        .send(err.details ? { error: err.message, details: err.details } : { error: err.message });
    }
    loggerHandle.logger.error({ err }, 'unhandled auth-admin error');
    return reply.code(500).send({ error: 'Internal server error' });
  });

  const { requireAuth, requireHostAdmin } = attachAuthAndTelemetry(app, {
    verifyAccessToken: (token) => tokenService.verifyAccessToken(token),
    recordTelemetry: (userId, elapsedMs, weight) =>
      recordUserTelemetry(redis, userId, elapsedMs, weight),
  });

  async function requireAdmin(request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);
    if (reply.sent) return;
    await authGroup.assertAdmin(request.authUser!);
  }

  app.get('/health', async () => {
    return { status: 'ok', service: 'auth-admin-service' };
  });

  // ---- Auth & Onboarding Endpoints ----

  app.post('/api/auth/register', async (request: AuthenticatedRequest, reply) => {
    request.skipTelemetry = true;
    const result = await authGroup.register(request.body);
    loggerHandle.logger.info(
      { userId: result.user.id, role: result.user.role, invited: Boolean(result.joinedGroup) },
      'user registered',
    );
    return reply.code(201).send(result);
  });

  app.post('/api/auth/login', async (request: AuthenticatedRequest) => {
    request.skipTelemetry = true;
    const result = await authGroup.login(request.body);
    loggerHandle.logger.info({ userId: result.user.id }, 'user logged in');
    return result;
  });

  app.post('/api/auth/refresh', async (request: AuthenticatedRequest) => {
    request.skipTelemetry = true;
    const { tokens } = await authGroup.refresh(request.body);
    return tokens;
  });

  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request: AuthenticatedRequest) => {
    return authGroup.getMe(request.authUser!.id);
  });

  app.get('/api/auth/invites/:token', async (request) => {
    const { token } = request.params as { token: string };
    return authGroup.previewInvite(token);
  });

  app.post('/api/auth/join', { preHandler: [requireAuth] }, async (request: AuthenticatedRequest) => {
    const result = await authGroup.joinByInvite(request.authUser!.id, request.body);
    loggerHandle.logger.info(
      {
        userId: request.authUser!.id,
        groupId: result.groupId,
        role: result.role,
        alreadyMember: result.alreadyMember,
      },
      'user joined group via invite',
    );
    return result;
  });

  // ---- Group & RBAC Endpoints ----

  app.get('/api/auth/groups', { preHandler: [requireAuth] }, async (request: AuthenticatedRequest) => {
    return authGroup.listGroups(request.authUser!.id);
  });

  app.post(
    '/api/auth/groups',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const created = await authGroup.createGroup(request.authUser!.id, request.body);
      loggerHandle.logger.info(
        { userId: request.authUser!.id, groupId: created.id, name: created.name },
        'group created',
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/api/auth/groups/:groupId/privacy',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const { groupId } = request.params as { groupId: string };
      const updated = await authGroup.updatePrivacy(request.authUser!.id, groupId, request.body);
      loggerHandle.logger.info(
        { userId: request.authUser!.id, groupId, privacy: updated.privacy },
        'privacy mode updated',
      );
      return updated;
    },
  );

  app.patch(
    '/api/auth/groups/:groupId/members/:userId',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const { groupId, userId } = request.params as { groupId: string; userId: string };
      return authGroup.updateMemberRole(request.authUser!, groupId, userId, request.body);
    },
  );

  // ---- Admin & Telemetry Endpoints ----

  app.post(
    '/api/admin/invites',
    { preHandler: [requireAdmin] },
    async (request: AuthenticatedRequest, reply) => {
      const invite = await authGroup.createInvite(
        request.authUser!,
        request.body,
        request.headers.origin,
      );
      loggerHandle.logger.info(
        {
          userId: request.authUser!.id,
          groupName: invite.groupName,
          assignedRole: invite.assignedRole,
          maxUses: invite.maxUses,
        },
        'admin created invite token',
      );
      return reply.code(201).send(invite);
    },
  );

  app.get('/api/admin/invites', { preHandler: [requireAdmin] }, async (request: AuthenticatedRequest) => {
    return authGroup.listInvites(request.authUser!);
  });

  app.get('/api/admin/telemetry', { preHandler: [requireHostAdmin] }, async () => {
    return telemetryQuery.getSystemTelemetry();
  });

  app.get('/api/admin/logs/recent', { preHandler: [requireHostAdmin] }, async () => {
    return telemetryQuery.getRecentLogs(200);
  });

  app.get('/api/admin/logs/stream', { websocket: true }, async (socket, request) => {
    const query = request.query as { token?: string };
    const rawToken = query.token ?? extractBearerToken(request.headers.authorization);

    if (!rawToken) {
      socket.close(1008, 'Missing token');
      return;
    }

    try {
      const decoded = await tokenService.verifyAccessToken(rawToken);
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

    const subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
    });
    subscriber.on('error', (err) => {
      loggerHandle.logger.error({ err }, 'log stream subscriber error');
    });
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

/**
 * main for auth server for the admin
 */
async function main() {
  const port = Number.parseInt(process.env.PORT ?? process.env.AUTH_ADMIN_PORT ?? '4001', 10);
  const { app, loggerHandle } = await createAuthAdminServer();
  await app.listen({ port, host: '0.0.0.0' }); // listen to local and port
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
