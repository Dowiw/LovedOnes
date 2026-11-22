import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { JwtUserPayload, JwtUserPayloadSchema, SystemRole } from './schemas.js';

export class DomainError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface TokenAccountClaims {
  id: string;
  email: string;
  username: string;
  role: SystemRole;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface IssuedTrackerToken {
  token: string;
  jti: string;
  expiresInDays: number;
  expiresAt: string;
}

export interface TokenServiceOptions {
  jwtSecret: string;
  jwtRefreshSecret?: string;
  accessExpiresIn?: string;
  refreshExpiresIn?: string;
}

export interface TokenService {
  issueTokenPair(account: TokenAccountClaims): Promise<TokenPair>;
  issueTrackerToken(
    account: TokenAccountClaims,
    options: { jti: string; expiresInDays: number; nowMs?: number },
  ): Promise<IssuedTrackerToken>;
  verifyAccessToken(token: string): Promise<JwtUserPayload>;
  verifyIngestionToken(token: string): Promise<JwtUserPayload>;
  verifyRefreshToken(token: string): Promise<JwtUserPayload>;
}

/**
 * Unifies access, refresh, and scoped tracker JWT signing/verification on `jose`
 * with strict `type` checks (`access`, `refresh`, `tracker`).
 */
export function createTokenService(options: TokenServiceOptions): TokenService {
  const accessSecretBytes = new TextEncoder().encode(options.jwtSecret);
  const refreshSecretBytes = options.jwtRefreshSecret
    ? new TextEncoder().encode(options.jwtRefreshSecret)
    : null;
  const accessExpiresIn = options.accessExpiresIn ?? '1d';
  const refreshExpiresIn = options.refreshExpiresIn ?? '7d';

  async function verifyWithSecret(
    token: string,
    secretBytes: Uint8Array,
    expectedTypes: Array<'access' | 'refresh' | 'tracker'>,
  ): Promise<JwtUserPayload> {
    const { payload } = await jwtVerify(token, secretBytes, { algorithms: ['HS256'] });
    const parsed = JwtUserPayloadSchema.parse(payload);
    if (!parsed.type || !expectedTypes.includes(parsed.type)) {
      throw new Error(`Invalid token type: expected ${expectedTypes.join(' or ')}`);
    }
    if (parsed.type === 'tracker' && (!parsed.jti || parsed.jti.trim().length === 0)) {
      throw new Error('Tracker token requires jti');
    }
    return parsed;
  }

  return {
    async issueTokenPair(account: TokenAccountClaims): Promise<TokenPair> {
      if (!refreshSecretBytes) {
        throw new Error('jwtRefreshSecret is required to issue token pairs');
      }
      const baseClaims = {
        id: account.id,
        email: account.email,
        username: account.username,
        role: account.role,
      };

      const accessToken = await new SignJWT({ ...baseClaims, type: 'access' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(accessExpiresIn)
        .sign(accessSecretBytes);

      const refreshToken = await new SignJWT({ ...baseClaims, type: 'refresh' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(refreshExpiresIn)
        .sign(refreshSecretBytes);

      return { accessToken, refreshToken };
    },

    async issueTrackerToken(
      account: TokenAccountClaims,
      trackerOpts: { jti: string; expiresInDays: number; nowMs?: number },
    ): Promise<IssuedTrackerToken> {
      const nowMs = trackerOpts.nowMs ?? Date.now();
      const expiresAt = new Date(nowMs + trackerOpts.expiresInDays * 24 * 60 * 60 * 1000);
      const token = await new SignJWT({
        id: account.id,
        email: account.email,
        username: account.username,
        role: account.role,
        type: 'tracker',
        jti: trackerOpts.jti,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${trackerOpts.expiresInDays}d`)
        .sign(accessSecretBytes);

      return {
        token,
        jti: trackerOpts.jti,
        expiresInDays: trackerOpts.expiresInDays,
        expiresAt: expiresAt.toISOString(),
      };
    },

    verifyAccessToken(token: string): Promise<JwtUserPayload> {
      return verifyWithSecret(token, accessSecretBytes, ['access']);
    },

    verifyIngestionToken(token: string): Promise<JwtUserPayload> {
      return verifyWithSecret(token, accessSecretBytes, ['access', 'tracker']);
    },

    verifyRefreshToken(token: string): Promise<JwtUserPayload> {
      if (!refreshSecretBytes) {
        throw new Error('jwtRefreshSecret is required to verify refresh tokens');
      }
      return verifyWithSecret(token, refreshSecretBytes, ['refresh']);
    },
  };
}

export function extractBearerToken(authorizationHeader?: string): string | null {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authorizationHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Extracts a JWT token from:
 * 1. `Authorization: Bearer <token>` (Overland / REST default)
 * 2. `Authorization: Basic base64(username:token)` (OwnTracks HTTP mode default)
 * 3. `?token=<token>` query string parameter
 */
export function extractIngestionToken(
  authorizationHeader?: string,
  queryToken?: string,
): string | null {
  const bearer = extractBearerToken(authorizationHeader);
  if (bearer) return bearer;

  if (authorizationHeader && authorizationHeader.startsWith('Basic ')) {
    try {
      const b64 = authorizationHeader.slice(6).trim();
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const userPart = decoded.slice(0, colonIdx).trim();
        const passPart = decoded.slice(colonIdx + 1).trim();
        const candidate = passPart.length > 0 ? passPart : userPart;
        if (candidate.length > 0) return candidate;
      } else if (decoded.trim().length > 0) {
        return decoded.trim();
      }
    } catch {
      // Ignore malformed base64
    }
  }

  if (typeof queryToken === 'string' && queryToken.trim().length > 0) {
    return queryToken.trim();
  }

  return null;
}

export interface AuthenticatedRequest extends FastifyRequest {
  authUser?: JwtUserPayload;
  perfStartMs?: number;
  telemetryEventWeight?: number;
  skipTelemetry?: boolean;
}

export interface AttachAuthTelemetryOptions {
  verifyAccessToken: (token: string) => Promise<JwtUserPayload>;
  verifyIngestionToken?: (token: string) => Promise<JwtUserPayload>;
  verifyTrackerJti?: (userId: string, jti: string) => Promise<boolean>;
  verifyUserActive?: (userId: string) => Promise<boolean>;
  recordTelemetry: (userId: string, elapsedMs: number, eventWeight: number) => Promise<void>;
}

export interface FastifyAuthAdapter {
  requireAuth: (request: AuthenticatedRequest, reply: FastifyReply) => Promise<void>;
  requireIngestionAuth: (request: AuthenticatedRequest, reply: FastifyReply) => Promise<void>;
  requireHostAdmin: (request: AuthenticatedRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Shared Fastify auth + single-counted per-request telemetry adapter.
 * - `requireAuth`: strictly requires `type === 'access'`
 * - `requireIngestionAuth`: accepts `type === 'access'` or active `type === 'tracker'`
 *   via Bearer, HTTP Basic Auth, or `?token=` query parameter.
 */
export function attachAuthAndTelemetry(
  app: FastifyInstance,
  options: AttachAuthTelemetryOptions,
): FastifyAuthAdapter {
  app.addHook('onRequest', async (request: AuthenticatedRequest) => {
    request.perfStartMs = performance.now();
  });

  app.addHook('onResponse', async (request: AuthenticatedRequest) => {
    if (request.skipTelemetry || !request.authUser?.id || request.perfStartMs === undefined) {
      return;
    }
    const elapsedMs = Math.max(0, performance.now() - request.perfStartMs);
    const weight = request.telemetryEventWeight ?? 1;
    if (weight <= 0) return;
    void options.recordTelemetry(request.authUser.id, elapsedMs, weight).catch(() => {});
  });

  async function requireAuth(
    request: AuthenticatedRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    try {
      const decoded = await options.verifyAccessToken(token);
      if (options.verifyUserActive) {
        const active = await options.verifyUserActive(decoded.id);
        if (!active) {
          await reply.code(401).send({
            error: 'Your account was removed from this server.',
            code: 'ACCOUNT_REMOVED',
          });
          return;
        }
      }
      request.authUser = decoded;
    } catch {
      await reply.code(401).send({ error: 'Unauthorized' });
    }
  }

  async function requireIngestionAuth(
    request: AuthenticatedRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const query = request.query as { token?: string } | undefined;
    const token = extractIngestionToken(request.headers.authorization, query?.token);
    if (!token) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    try {
      const verifyFn = options.verifyIngestionToken ?? options.verifyAccessToken;
      const decoded = await verifyFn(token);
      if (decoded.type === 'tracker') {
        if (!decoded.jti) {
          await reply.code(401).send({ error: 'Unauthorized' });
          return;
        }
        if (options.verifyTrackerJti) {
          const active = await options.verifyTrackerJti(decoded.id, decoded.jti);
          if (!active) {
            await reply.code(401).send({ error: 'Tracker token revoked or rotated' });
            return;
          }
        }
      }
      if (options.verifyUserActive) {
        const active = await options.verifyUserActive(decoded.id);
        if (!active) {
          await reply.code(401).send({
            error: 'Your account was removed from this server.',
            code: 'ACCOUNT_REMOVED',
          });
          return;
        }
      }
      request.authUser = decoded;
    } catch {
      await reply.code(401).send({ error: 'Unauthorized' });
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

  return { requireAuth, requireIngestionAuth, requireHostAdmin };
}

type HeaderValue = string | string[] | undefined;

function firstHeaderValue(raw: HeaderValue): string {
  const first = Array.isArray(raw) ? raw[0] : raw;
  return (first?.split(',')[0] ?? '').trim();
}

/**
 * Resolves the real client IP across reverse-proxy headers (`X-Forwarded-For`, `X-Real-IP`),
 * and optionally Cloudflare headers (`CF-Connecting-IP`, `True-Client-IP`) only when
 * `trustCloudflareHeaders` (or `TRUST_CLOUDFLARE_HEADERS=true`) is explicitly enabled.
 */
export function resolveClientIp(
  headers: Record<string, HeaderValue> | undefined,
  fallbackIp = 'unknown',
  options?: { trustCloudflareHeaders?: boolean },
): string {
  const trustCf =
    options?.trustCloudflareHeaders ??
    process.env.TRUST_CLOUDFLARE_HEADERS?.trim().toLowerCase() === 'true';
  const cfCandidate = trustCf
    ? firstHeaderValue(headers?.['cf-connecting-ip']) ||
      firstHeaderValue(headers?.['true-client-ip'])
    : '';
  const candidate =
    cfCandidate ||
    firstHeaderValue(headers?.['x-forwarded-for']) ||
    firstHeaderValue(headers?.['x-real-ip']) ||
    fallbackIp.trim() ||
    'unknown';
  return candidate.replace(/^::ffff:/i, '').slice(0, 128) || 'unknown';
}

export interface CorsPolicyOptions {
  nodeEnv?: string;
  publicServerUrl?: string;
  allowedOriginsRaw?: string;
}

function parseOriginString(raw?: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw.trim()).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Evaluates whether a browser `Origin` should receive credentialed CORS headers.
 */
export function isOriginAllowed(
  origin: string | undefined,
  requestHost: string | undefined,
  options: CorsPolicyOptions = {},
): boolean {
  if (!origin) return true;
  const nodeEnv = (options.nodeEnv ?? process.env.NODE_ENV ?? 'development').trim().toLowerCase();
  const rawAllowed = (options.allowedOriginsRaw ?? process.env.CORS_ALLOWED_ORIGINS ?? '').trim();
  if (rawAllowed === '*' || nodeEnv !== 'production') {
    return true;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  const normalizedOrigin = parsedOrigin.origin.toLowerCase();

  if (requestHost && parsedOrigin.host.toLowerCase() === requestHost.trim().toLowerCase()) {
    return true;
  }

  const allowedSet = new Set<string>();
  const publicOrigin = parseOriginString(options.publicServerUrl ?? process.env.PUBLIC_SERVER_URL);
  if (publicOrigin) {
    allowedSet.add(publicOrigin);
  }
  for (const part of rawAllowed.split(',')) {
    const parsed = parseOriginString(part);
    if (parsed) allowedSet.add(parsed);
  }

  if (allowedSet.has(normalizedOrigin)) {
    return true;
  }

  const publicIsLocal =
    !publicOrigin ||
    publicOrigin.includes('localhost') ||
    publicOrigin.includes('127.0.0.1');
  if (
    publicIsLocal &&
    (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1')
  ) {
    return true;
  }

  return false;
}

export function createFastifyCorsDelegator(
  options: CorsPolicyOptions & {
    credentials?: boolean;
    methods?: string[];
    allowedHeaders?: string[];
    exposedHeaders?: string[];
  } = {},
) {
  return (
    req: FastifyRequest,
    cb: (
      err: Error | null,
      corsOpts: {
        origin: boolean;
        credentials?: boolean;
        methods?: string[];
        allowedHeaders?: string[];
        exposedHeaders?: string[];
      },
    ) => void,
  ): void => {
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const rawHost = req.headers['x-forwarded-host'] ?? req.headers.host;
    const reqHost = firstHeaderValue(rawHost);
    const allowed = isOriginAllowed(originHeader, reqHost || undefined, options);
    cb(null, {
      origin: allowed,
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
      ...(options.methods ? { methods: options.methods } : {}),
      ...(options.allowedHeaders ? { allowedHeaders: options.allowedHeaders } : {}),
      ...(options.exposedHeaders ? { exposedHeaders: options.exposedHeaders } : {}),
    });
  };
}

export interface RateLimitRedisClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  pttl(key: string): Promise<number>;
}

export interface RateLimiterOptions {
  prefix: string;
  max: number;
  windowMs: number;
  redis?: RateLimitRedisClient | null;
  disabled?: boolean;
  trustCloudflareHeaders?: boolean;
  keyResolver?: (request: FastifyRequest) => string;
}

/**
 * Fixed-window IP/key rate limiter backed by Redis with automatic in-memory fallback.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

  async function consume(key: string): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const namespacedKey = `ratelimit:${options.prefix}:${key}`;

    if (options.redis) {
      try {
        const count = await options.redis.incr(namespacedKey);
        let ttlMs = -1;
        if (count === 1) {
          await options.redis.pexpire(namespacedKey, options.windowMs);
          ttlMs = options.windowMs;
        } else {
          ttlMs = await options.redis.pttl(namespacedKey);
          if (ttlMs <= 0) {
            await options.redis.pexpire(namespacedKey, options.windowMs);
            ttlMs = options.windowMs;
          }
        }
        return { count, resetAt: now + ttlMs };
      } catch {
        // Fall through to in-memory limiter when Redis is unavailable
      }
    }

    if (memoryBuckets.size > 5000) {
      for (const [k, entry] of memoryBuckets.entries()) {
        if (entry.resetAt <= now) memoryBuckets.delete(k);
      }
    }

    const existing = memoryBuckets.get(namespacedKey);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + options.windowMs };
      memoryBuckets.set(namespacedKey, fresh);
      return fresh;
    }
    existing.count += 1;
    return existing;
  }

  return async function rateLimitPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (options.disabled) return;
    const key = options.keyResolver
      ? options.keyResolver(request)
      : resolveClientIp(request.headers as Record<string, HeaderValue>, request.ip, {
          trustCloudflareHeaders: options.trustCloudflareHeaders,
        });
    const { count, resetAt } = await consume(key);
    const remaining = Math.max(0, options.max - count);
    const resetSec = Math.ceil(Math.max(1000, resetAt - Date.now()) / 1000);

    reply.header('X-RateLimit-Limit', String(options.max));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(resetSec));

    if (count > options.max) {
      reply.header('Retry-After', String(resetSec));
      await reply.code(429).send({
        error: 'Too many requests. Please wait before trying again.',
        retryAfterSeconds: resetSec,
      });
    }
  };
}

/**
 * Registers SIGTERM/SIGINT handlers to cleanly close Fastify, drain active connections,
 * and flush logs/pools before process exit.
 */
export function registerGracefulShutdown(
  app: FastifyInstance,
  logger: { info: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void },
  serviceName: string,
  timeoutMs = 10_000,
): () => void {
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, service: serviceName }, `${serviceName} shutting down gracefully`);
    const forceTimer = setTimeout(() => {
      logger.error({ signal, service: serviceName }, `${serviceName} forced exit after shutdown timeout`);
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();

    void app
      .close()
      .then(() => {
        clearTimeout(forceTimer);
        process.exit(0);
      })
      .catch((err) => {
        clearTimeout(forceTimer);
        logger.error({ err, signal, service: serviceName }, `${serviceName} error during shutdown`);
        process.exit(1);
      });
  };

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);
  return () => {
    process.off('SIGTERM', handleSignal);
    process.off('SIGINT', handleSignal);
  };
}
