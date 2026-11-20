import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createPool, resolveAuditContext, runMigrations } from '@loved-ones/db';
import {
  DEFAULT_APP_VERSION,
  evaluateClientVersion,
  MOBILE_DEFAULT_DOWNLOAD_URL,
} from '@loved-ones/shared';
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
import { SmtpEmailSender } from './adapters/smtp-mailer.js';
import { AuthGroupModule, EmailSender } from './domain/auth-group-module.js';
import {
  MapRegionsModule,
  MapRegionsModuleOptions,
} from './domain/map-regions-module.js';
import {
  SystemUpdateDriver,
  SystemUpdateModule,
} from './domain/system-update-module.js';
import { TelemetryQueryModule } from './domain/telemetry-query-module.js';

export interface AuthAdminOptions {
  databaseUrl?: string;
  redisUrl?: string;
  jwtSecret?: string;
  jwtRefreshSecret?: string;
  logDir?: string;
  maxLogStorageMb?: number;
  publicServerUrl?: string;
  emailSender?: EmailSender;
  mapRegions?: MapRegionsModuleOptions;
  systemUpdater?: {
    driver?: SystemUpdateDriver;
    updaterUrl?: string;
    allowRemoteUpdate?: boolean;
  };
  appVersion?: {
    serverVersion?: string;
    latestMobileVersion?: string;
    minSupportedVersion?: string;
    downloadUrl?: string;
    releaseNotes?: string | null;
  };
  disableFileLog?: boolean;
  disableRedisLog?: boolean;
}

function readJsonVersionFile(candidates: string[], extractor: (parsed: unknown) => unknown): string | null {
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const val = extractor(JSON.parse(raw));
      if (typeof val === 'string' && val.trim().length > 0) {
        return val.trim();
      }
    } catch {
      // ignore missing path
    }
  }
  return null;
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

  const emailSender = options.emailSender ?? new SmtpEmailSender();
  const tokenService = createTokenService({ jwtSecret, jwtRefreshSecret });
  const authGroup = new AuthGroupModule({
    store: new PostgresAuthGroupStore(pool),
    sessionStore: new RedisSessionStore(redis),
    tokenService,
    emailSender,
    publicServerUrl,
  });
  const telemetryQuery = new TelemetryQueryModule({
    store: new PostgresRedisTelemetryStore(pool, redis, logDir),
    logDir,
    maxLogStorageMb,
  });
  const mapRegions = new MapRegionsModule({
    ...(options.mapRegions ?? {}),
    onLog: (level, msg, meta) => {
      loggerHandle.logger[level](meta ?? {}, msg);
    },
  });
  const systemUpdater = new SystemUpdateModule({
    driver: options.systemUpdater?.driver,
    updaterUrl: options.systemUpdater?.updaterUrl ?? process.env.SYSTEM_UPDATER_URL,
    jwtSecret,
    stateFilePath: path.join(logDir, 'system-update.json'),
    allowRemoteUpdate:
      options.systemUpdater?.allowRemoteUpdate ??
      process.env.ALLOW_REMOTE_SYSTEM_UPDATE !== 'false',
  });

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(fastifyWebsocket);

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
    loggerHandle.logger.error({ err, method: request.method, url: request.url }, 'unhandled auth-admin error');
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

  const resolvedServerVersion =
    options.appVersion?.serverVersion ??
    (process.env.APP_VERSION || undefined) ??
    readJsonVersionFile(
      [
        path.resolve(process.cwd(), 'package.json'),
        path.resolve(process.cwd(), '../../package.json'),
      ],
      (p) => (p as { version?: string })?.version,
    ) ??
    DEFAULT_APP_VERSION;

  const resolvedLatestMobileVersion =
    options.appVersion?.latestMobileVersion ??
    (process.env.LATEST_MOBILE_VERSION || undefined) ??
    readJsonVersionFile(
      [
        path.resolve(process.cwd(), 'apps/mobile-app/app.json'),
        path.resolve(process.cwd(), '../../apps/mobile-app/app.json'),
      ],
      (p) => (p as { expo?: { version?: string } })?.expo?.version,
    ) ??
    resolvedServerVersion;

  const resolvedMinSupportedVersion =
    options.appVersion?.minSupportedVersion ??
    (process.env.MIN_SUPPORTED_APP_VERSION || undefined) ??
    DEFAULT_APP_VERSION;

  const resolvedDownloadUrl =
    options.appVersion?.downloadUrl ??
    (process.env.MOBILE_DOWNLOAD_URL || undefined) ??
    MOBILE_DEFAULT_DOWNLOAD_URL;

  const resolvedReleaseNotes =
    options.appVersion?.releaseNotes ??
    (process.env.MOBILE_RELEASE_NOTES || null);

  app.get('/api/auth/app-version', async (request) => {
    const query = (request.query ?? {}) as { version?: string; platform?: string };
    const headerVersion =
      typeof request.headers['x-app-version'] === 'string'
        ? request.headers['x-app-version']
        : undefined;
    return evaluateClientVersion({
      clientVersion: query.version ?? headerVersion ?? null,
      platform: query.platform ?? null,
      serverVersion: resolvedServerVersion,
      latestMobileVersion: resolvedLatestMobileVersion,
      minSupportedVersion: resolvedMinSupportedVersion,
      downloadUrl: resolvedDownloadUrl,
      releaseNotes: resolvedReleaseNotes,
    });
  });

  // ---- Auth & Onboarding Endpoints ----

  app.post('/api/auth/register', async (request: AuthenticatedRequest, reply) => {
    request.skipTelemetry = true;
    const result = await authGroup.register(request.body);
    loggerHandle.logger.info(
      {
        action: 'auth.register',
        userId: result.user.id,
        username: result.user.username,
        email: result.user.email,
        role: result.user.role,
        groupId: result.joinedGroup?.groupId,
        groupName: result.joinedGroup?.groupName,
        assignedRole: result.joinedGroup?.role,
      },
      `${result.user.username} (${result.user.email}) registered as ${result.user.role}${
        result.joinedGroup
          ? ` and joined group "${result.joinedGroup.groupName}" as ${result.joinedGroup.role}`
          : ''
      }`,
    );
    return reply.code(201).send(result);
  });

  app.post('/api/auth/login', async (request: AuthenticatedRequest) => {
    request.skipTelemetry = true;
    const result = await authGroup.login(request.body);
    loggerHandle.logger.info(
      {
        action: 'auth.login',
        userId: result.user.id,
        username: result.user.username,
        email: result.user.email,
        role: result.user.role,
      },
      `${result.user.username} (${result.user.email}) signed in`,
    );
    return result;
  });

  app.post('/api/auth/refresh', async (request: AuthenticatedRequest) => {
    request.skipTelemetry = true;
    const { tokens, userId } = await authGroup.refresh(request.body);
    const ctx = await resolveAuditContext(pool, { userId });
    loggerHandle.logger.info(
      {
        action: 'auth.refresh',
        userId,
        username: ctx.actorUsername,
        email: ctx.actorEmail,
      },
      `${ctx.actorUsername ?? userId} refreshed access session`,
    );
    return tokens;
  });

  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request: AuthenticatedRequest) => {
    return authGroup.getMe(request.authUser!.id);
  });

  app.patch('/api/auth/me', { preHandler: [requireAuth] }, async (request: AuthenticatedRequest) => {
    const actor = request.authUser!;
    const rawBody = (request.body ?? {}) as Record<string, unknown>;
    const changedFields = ['username', 'email', 'avatarUrl', 'haloColor', 'fuzzCircleColor'].filter(
      (k) => rawBody[k] !== undefined,
    );
    const result = await authGroup.updateProfile(actor.id, request.body);
    loggerHandle.logger.info(
      {
        action: 'account.profile_update',
        userId: actor.id,
        previousUsername: actor.username,
        username: result.user.username,
        previousEmail: actor.email,
        email: result.user.email,
        changedFields,
      },
      `${result.user.username} (${result.user.email}) updated profile (${changedFields.join(', ') || 'details'})`,
    );
    return result;
  });

  app.post('/api/auth/password', { preHandler: [requireAuth] }, async (request: AuthenticatedRequest) => {
    const actor = request.authUser!;
    const result = await authGroup.changePassword(actor.id, request.body);
    loggerHandle.logger.info(
      {
        action: 'account.password_change',
        userId: actor.id,
        username: actor.username,
        email: actor.email,
      },
      `${actor.username} (${actor.email}) changed account password`,
    );
    return result;
  });

  app.post(
    '/api/auth/recovery-email/send-code',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const recoveryEmail =
        typeof (request.body as { recoveryEmail?: unknown } | undefined)?.recoveryEmail === 'string'
          ? (request.body as { recoveryEmail: string }).recoveryEmail.trim().toLowerCase()
          : undefined;
      const result = await authGroup.sendRecoveryVerificationCode(actor.id, request.body);
      loggerHandle.logger.info(
        {
          action: 'account.recovery_email_code_sent',
          userId: actor.id,
          username: actor.username,
          recoveryEmail,
        },
        `${actor.username} sent recovery verification code to ${recoveryEmail ?? 'recovery email'}`,
      );
      return result;
    },
  );

  app.post(
    '/api/auth/recovery-email/verify',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const result = await authGroup.verifyRecoveryEmail(actor.id, request.body);
      loggerHandle.logger.info(
        {
          action: 'account.recovery_email_verified',
          userId: actor.id,
          username: actor.username,
          recoveryEmail: result.user.recoveryEmail,
        },
        `${actor.username} verified backup recovery email ${result.user.recoveryEmail ?? ''}`.trim(),
      );
      return result;
    },
  );

  app.delete(
    '/api/auth/recovery-email',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const result = await authGroup.clearRecoveryEmail(actor.id);
      loggerHandle.logger.info(
        {
          action: 'account.recovery_email_cleared',
          userId: actor.id,
          username: actor.username,
          email: actor.email,
        },
        `${actor.username} removed their backup recovery email`,
      );
      return result;
    },
  );

  app.post('/api/auth/forgot-password/request', async (request: AuthenticatedRequest) => {
    request.skipTelemetry = true;
    const email =
      typeof (request.body as { email?: unknown } | undefined)?.email === 'string'
        ? (request.body as { email: string }).email.trim().toLowerCase()
        : undefined;
    const result = await authGroup.requestPasswordReset(request.body);
    loggerHandle.logger.info(
      { action: 'auth.forgot_password_requested', email },
      `Password reset code requested for ${email ?? 'account'}`,
    );
    return result;
  });

  app.post('/api/auth/forgot-password/reset', async (request: AuthenticatedRequest) => {
    request.skipTelemetry = true;
    const email =
      typeof (request.body as { email?: unknown } | undefined)?.email === 'string'
        ? (request.body as { email: string }).email.trim().toLowerCase()
        : undefined;
    const result = await authGroup.resetPasswordWithCode(request.body);
    loggerHandle.logger.info(
      { action: 'auth.forgot_password_completed', email },
      `Password reset completed via verified recovery email (${email ?? 'unknown'})`,
    );
    return result;
  });

  app.get(
    '/api/auth/tracker-token',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      return authGroup.getTrackerTokenStatus(request.authUser!.id);
    },
  );

  app.post(
    '/api/auth/tracker-token',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const actor = request.authUser!;
      const created = await authGroup.createTrackerToken(
        actor,
        request.body,
        request.headers.origin,
      );
      loggerHandle.logger.info(
        {
          action: 'tracker.token_created',
          userId: actor.id,
          username: actor.username,
          email: actor.email,
          expiresInDays: created.expiresInDays,
        },
        `${actor.username} generated an HTTP tracker token (${created.expiresInDays}d TTL)`,
      );
      return reply.code(201).send(created);
    },
  );

  app.delete(
    '/api/auth/tracker-token',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const res = await authGroup.revokeTrackerToken(actor.id);
      loggerHandle.logger.info(
        {
          action: 'tracker.token_revoked',
          userId: actor.id,
          username: actor.username,
          email: actor.email,
        },
        `${actor.username} revoked their HTTP tracker token`,
      );
      return res;
    },
  );

  app.get('/api/auth/invites/:token', async (request) => {
    const { token } = request.params as { token: string };
    return authGroup.previewInvite(token);
  });

  app.post('/api/auth/join', { preHandler: [requireAuth] }, async (request: AuthenticatedRequest) => {
    const actor = request.authUser!;
    const result = await authGroup.joinByInvite(actor.id, request.body);
    loggerHandle.logger.info(
      {
        action: 'group.joined_via_invite',
        userId: actor.id,
        username: actor.username,
        email: actor.email,
        groupId: result.groupId,
        groupName: result.groupName,
        role: result.role,
        alreadyMember: result.alreadyMember,
      },
      `${actor.username} joined group "${result.groupName}" as ${result.role}${
        result.alreadyMember ? ' (already a member)' : ''
      }`,
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
      const actor = request.authUser!;
      const created = await authGroup.createGroup(actor.id, request.body);
      loggerHandle.logger.info(
        {
          action: 'group.created',
          userId: actor.id,
          username: actor.username,
          email: actor.email,
          groupId: created.id,
          groupName: created.name,
        },
        `${actor.username} created group "${created.name}"`,
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/api/auth/groups/:groupId/privacy',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const { groupId } = request.params as { groupId: string };
      const before = await resolveAuditContext(pool, { userId: actor.id, groupId });
      const updated = await authGroup.updatePrivacy(actor.id, groupId, request.body);
      const actorName = before.actorUsername ?? actor.username;
      const groupName = before.groupName ?? groupId;
      const prevPrivacy = before.membershipPrivacy;
      loggerHandle.logger.info(
        {
          action: 'group.privacy_updated',
          userId: actor.id,
          username: actorName,
          email: before.actorEmail ?? actor.email,
          groupId,
          groupName,
          previousPrivacy: prevPrivacy,
          privacy: updated.privacy,
        },
        `${actorName} switched privacy in group "${groupName}"${
          prevPrivacy ? ` from ${prevPrivacy}` : ''
        } to ${updated.privacy}`,
      );
      return updated;
    },
  );

  app.patch(
    '/api/auth/groups/:groupId/members/:userId',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const { groupId, userId } = request.params as { groupId: string; userId: string };
      const before = await resolveAuditContext(pool, {
        userId: actor.id,
        targetUserId: userId,
        groupId,
      });
      const updated = await authGroup.updateMemberRole(actor, groupId, userId, request.body);
      const actorName = before.actorUsername ?? actor.username;
      const targetName = before.targetUsername ?? userId;
      const groupName = before.groupName ?? groupId;
      loggerHandle.logger.info(
        {
          action: 'group.member_role_updated',
          userId: actor.id,
          username: actorName,
          targetUserId: userId,
          targetUsername: targetName,
          groupId,
          groupName,
          previousRole: before.membershipRole,
          role: updated.role,
        },
        `${actorName} updated ${targetName}'s role in group "${groupName}"${
          before.membershipRole ? ` from ${before.membershipRole}` : ''
        } to ${updated.role}`,
      );
      return updated;
    },
  );

  // ---- Admin & Telemetry Endpoints ----

  app.post(
    '/api/admin/invites',
    { preHandler: [requireAdmin] },
    async (request: AuthenticatedRequest, reply) => {
      const actor = request.authUser!;
      const invite = await authGroup.createInvite(
        actor,
        request.body,
        request.headers.origin,
      );
      loggerHandle.logger.info(
        {
          action: 'invite.created',
          userId: actor.id,
          username: actor.username,
          groupName: invite.groupName,
          assignedRole: invite.assignedRole,
          maxUses: invite.maxUses,
          expiresAt: invite.expiresAt,
        },
        `${actor.username} created QR invite for group "${invite.groupName}" (role ${invite.assignedRole}, maxUses ${invite.maxUses})`,
      );
      return reply.code(201).send(invite);
    },
  );

  app.get('/api/admin/invites', { preHandler: [requireAdmin] }, async (request: AuthenticatedRequest) => {
    return authGroup.listInvites(request.authUser!);
  });

  app.delete(
    '/api/admin/invites/:token',
    { preHandler: [requireAdmin] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const { token } = request.params as { token: string };
      const res = await authGroup.deleteInvite(actor, token);
      loggerHandle.logger.info(
        {
          action: 'invite.deleted',
          userId: actor.id,
          username: actor.username,
          token,
        },
        `${actor.username} deleted invite token ${token}`,
      );
      return res;
    },
  );

  app.get('/api/admin/telemetry', { preHandler: [requireHostAdmin] }, async () => {
    return telemetryQuery.getSystemTelemetry();
  });

  app.get('/api/admin/logs/recent', { preHandler: [requireHostAdmin] }, async () => {
    return telemetryQuery.getRecentLogs(200);
  });

  app.get(
    '/api/admin/system/update',
    { preHandler: [requireHostAdmin] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const query = (request.query ?? {}) as { refresh?: string };
      const refresh = query.refresh === '1' || query.refresh === 'true';
      const status = await systemUpdater.getStatus(refresh);
      if (refresh) {
        loggerHandle.logger.info(
          {
            action: 'system.update_checked',
            userId: actor.id,
            username: actor.username,
            commitsBehind: status.commitsBehind,
            updateAvailable: status.updateAvailable,
          },
          `${actor.username} checked for system updates (${status.commitsBehind} commit(s) behind)`,
        );
      }
      return status;
    },
  );

  app.post(
    '/api/admin/system/update',
    { preHandler: [requireHostAdmin] },
    async (request: AuthenticatedRequest, reply) => {
      const actor = request.authUser!;
      const result = await systemUpdater.triggerUpdate(request.body);
      loggerHandle.logger.info(
        {
          action: 'system.update_started',
          userId: actor.id,
          username: actor.username,
          phase: result.status.phase,
          targetCommit: result.status.targetCommit,
        },
        `${actor.username} triggered a remote system update (${result.status.phase})`,
      );
      return reply.code(result.statusCode).send(result.status);
    },
  );

  // ---- Dynamic Map Region Coverage & PMTiles Download Endpoints ----

  app.get('/api/maps/regions', async () => {
    const regions = await mapRegions.listRegions();
    return {
      regions,
      jobs: mapRegions.listJobs(),
      allowMemberDownloads: mapRegions.allowMemberDownloads,
    };
  });

  app.get('/api/maps/jobs', { preHandler: [requireAuth] }, async () => {
    return { jobs: mapRegions.listJobs() };
  });

  app.get('/api/maps/jobs/:jobId', { preHandler: [requireAuth] }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    return { job: mapRegions.getJob(jobId) };
  });

  app.post(
    '/api/maps/download',
    { preHandler: [requireAuth] },
    async (request: AuthenticatedRequest, reply) => {
      const actor = request.authUser!;
      const body = (request.body ?? {}) as { latitude?: number; longitude?: number };
      const result = await mapRegions.requestCityDownload(
        { id: actor.id, role: actor.role },
        request.body,
      );
      if (result.alreadyCovered) {
        loggerHandle.logger.info(
          {
            action: 'map.download_skipped_covered',
            userId: actor.id,
            username: actor.username,
            latitude: body.latitude,
            longitude: body.longitude,
            regionId: result.region?.id,
            regionName: result.region?.displayName ?? result.region?.name,
          },
          `${actor.username} checked map coverage at (${body.latitude}, ${body.longitude}) — already covered by ${result.region?.displayName ?? result.region?.name ?? 'region'}`,
        );
        return reply.code(200).send(result);
      }
      loggerHandle.logger.info(
        {
          action: 'map.download_requested',
          userId: actor.id,
          username: actor.username,
          jobId: result.job?.id,
          cityName: result.job?.displayName ?? result.job?.cityName,
          bbox: result.job?.bbox,
        },
        `${actor.username} requested server PMTiles download for "${result.job?.displayName ?? result.job?.cityName ?? 'city'}"`,
      );
      return reply.code(202).send(result);
    },
  );

  app.delete(
    '/api/maps/regions/:regionId',
    { preHandler: [requireHostAdmin] },
    async (request: AuthenticatedRequest) => {
      const actor = request.authUser!;
      const { regionId } = request.params as { regionId: string };
      const res = await mapRegions.deleteRegion(regionId);
      loggerHandle.logger.info(
        {
          action: 'map.region_deleted',
          userId: actor.id,
          username: actor.username,
          regionId,
        },
        `${actor.username} deleted downloaded map region "${regionId}"`,
      );
      return res;
    },
  );

  app.get('/api/maps/tiles/:z/:x/:y', async (request, reply) => {
    const params = request.params as { z: string; x: string; y: string };
    const z = Number.parseInt(params.z, 10);
    const x = Number.parseInt(params.x, 10);
    const y = Number.parseInt(params.y.replace(/\.(pbf|mvt)$/i, ''), 10);
    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return reply.code(400).send({ error: 'Invalid tile coordinates' });
    }
    const tile = await mapRegions.getCompositeTile(z, x, y);
    if (!tile) {
      reply.header('Cache-Control', 'public, max-age=300');
      return reply.code(204).send();
    }
    reply.header('Content-Type', 'application/x-protobuf');
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(Buffer.from(tile));
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
    await mapRegions.close();
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
