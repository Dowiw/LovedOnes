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
      request.authUser = await options.verifyAccessToken(token);
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
