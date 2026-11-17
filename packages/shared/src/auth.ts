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

export interface TokenServiceOptions {
  jwtSecret: string;
  jwtRefreshSecret?: string;
  accessExpiresIn?: string;
  refreshExpiresIn?: string;
}

export interface TokenService {
  issueTokenPair(account: TokenAccountClaims): Promise<TokenPair>;
  verifyAccessToken(token: string): Promise<JwtUserPayload>;
  verifyRefreshToken(token: string): Promise<JwtUserPayload>;
}

/**
 * Unifies access and refresh JWT signing/verification on `jose` with strict
 * `type` checks (`access` vs `refresh`).
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
    expectedType: 'access' | 'refresh',
  ): Promise<JwtUserPayload> {
    const { payload } = await jwtVerify(token, secretBytes, { algorithms: ['HS256'] });
    const parsed = JwtUserPayloadSchema.parse(payload);
    if (parsed.type !== expectedType) {
      throw new Error(`Invalid token type: expected ${expectedType}`);
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

    verifyAccessToken(token: string): Promise<JwtUserPayload> {
      return verifyWithSecret(token, accessSecretBytes, 'access');
    },

    verifyRefreshToken(token: string): Promise<JwtUserPayload> {
      if (!refreshSecretBytes) {
        throw new Error('jwtRefreshSecret is required to verify refresh tokens');
      }
      return verifyWithSecret(token, refreshSecretBytes, 'refresh');
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

export interface AuthenticatedRequest extends FastifyRequest {
  authUser?: JwtUserPayload;
  perfStartMs?: number;
  telemetryEventWeight?: number;
  skipTelemetry?: boolean;
}

export interface AttachAuthTelemetryOptions {
  verifyAccessToken: (token: string) => Promise<JwtUserPayload>;
  recordTelemetry: (userId: string, elapsedMs: number, eventWeight: number) => Promise<void>;
}

export interface FastifyAuthAdapter {
  requireAuth: (request: AuthenticatedRequest, reply: FastifyReply) => Promise<void>;
  requireHostAdmin: (request: AuthenticatedRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Shared Fastify auth + single-counted per-request telemetry adapter.
 * Routes can set `request.telemetryEventWeight` (e.g. batch point count) or
 * `request.skipTelemetry = true` without double-counting in `onResponse`.
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

  return { requireAuth, requireHostAdmin };
}
