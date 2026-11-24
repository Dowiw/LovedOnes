import argon2 from 'argon2';
import pg from 'pg';
import {
  CreateRegistrationRequestSchema,
  GroupRole,
  OnboardingHandshakeResponse,
  OnboardingHandshakeSchema,
  REGISTRATION_REQUEST_TTL_MS,
  RegistrationRequestItem,
  RegistrationRequestStatus,
} from '@loved-ones/shared';
import { DomainError } from '@loved-ones/shared/auth';

const REGISTRATION_REQUEST_ADVISORY_LOCK = 948272;

interface PgRegistrationRequestRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  avatar_url: string | null;
  halo_color: string | null;
  fuzz_circle_color: string | null;
  invite_token: string | null;
  group_name: string | null;
  requester_ip: string;
  status: RegistrationRequestStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

interface PgInvitePreviewRow {
  token: string;
  group_id: string;
  group_name: string;
  assigned_role: GroupRole;
  max_uses: number;
  uses: number;
  expires_at: Date;
}

function mapRegistrationRequest(row: PgRegistrationRequestRow): RegistrationRequestItem {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_url ?? null,
    haloColor: row.halo_color ?? null,
    fuzzCircleColor: row.fuzz_circle_color ?? null,
    inviteToken: row.invite_token ?? null,
    groupName: row.group_name ?? null,
    requesterIp: row.requester_ip,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
  };
}

/**
 * Normalizes a request IP (handling reverse-proxy X-Forwarded-For / IPv6-mapped IPv4).
 */
export function normalizeRequesterIp(rawIp: string | string[] | undefined, fallbackIp: string): string {
  const first = Array.isArray(rawIp) ? rawIp[0] : rawIp;
  const candidate = (first?.split(',')[0] ?? fallbackIp ?? 'unknown').trim();
  if (!candidate) return 'unknown';
  return candidate.replace(/^::ffff:/i, '').slice(0, 128);
}

export class RegistrationRequestModule {
  private readonly pool: pg.Pool;
  private readonly ttlMs: number;

  constructor(pool: pg.Pool, options?: { ttlMs?: number }) {
    this.pool = pool;
    this.ttlMs = options?.ttlMs ?? REGISTRATION_REQUEST_TTL_MS;
  }

  async expireStaleRequests(client?: pg.PoolClient): Promise<void> {
    const runner = client ?? this.pool;
    await runner.query(
      `UPDATE registration_requests
       SET status = 'EXPIRED'
       WHERE status = 'PENDING' AND expires_at <= NOW()`,
    );
  }

  async handshake(
    rawBody: unknown,
    requesterIp: string,
  ): Promise<OnboardingHandshakeResponse> {
    const parsed = OnboardingHandshakeSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid onboarding handshake payload', parsed.error.flatten());
    }

    await this.expireStaleRequests();

    const activeRes = await this.pool.query<PgRegistrationRequestRow>(
      `SELECT *
       FROM registration_requests
       WHERE requester_ip = $1 AND status = 'PENDING' AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [requesterIp],
    );
    const activeRequest = activeRes.rows[0] ? mapRegistrationRequest(activeRes.rows[0]) : null;

    let invite: OnboardingHandshakeResponse['invite'] = null;
    if (parsed.data.inviteToken) {
      const invRes = await this.pool.query<PgInvitePreviewRow>(
        `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
                gi.max_uses, gi.uses, gi.expires_at
         FROM group_invites gi
         JOIN groups g ON g.id = gi.group_id
         WHERE gi.token = $1`,
        [parsed.data.inviteToken],
      );
      const row = invRes.rows[0];
      if (!row) {
        throw new DomainError(404, 'Invite token not found on this server');
      }
      if (row.expires_at.getTime() <= Date.now()) {
        throw new DomainError(410, 'This invite link has expired');
      }
      if (row.uses >= row.max_uses) {
        throw new DomainError(410, 'This invite link has already reached its max uses');
      }
      invite = {
        groupId: row.group_id,
        groupName: row.group_name,
        assignedRole: row.assigned_role,
      };
    }

    return {
      ok: true,
      serverName: 'LovedOnes',
      requesterIp,
      alreadyPinged: Boolean(activeRequest),
      activeRequest,
      invite,
    };
  }

  async createRequest(
    rawBody: unknown,
    requesterIp: string,
  ): Promise<{ request: RegistrationRequestItem }> {
    const parsed = CreateRegistrationRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new DomainError(400, 'Please fill in all required account details cleanly.', parsed.error.flatten());
    }

    const input = parsed.data;
    const normalizedEmail = input.email.trim().toLowerCase();
    const passwordHash = await argon2.hash(input.password);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [REGISTRATION_REQUEST_ADVISORY_LOCK]);
      await this.expireStaleRequests(client);

      const existingIpRes = await client.query<PgRegistrationRequestRow>(
        `SELECT *
         FROM registration_requests
         WHERE requester_ip = $1 AND status = 'PENDING' AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1`,
        [requesterIp],
      );
      if (existingIpRes.rows[0]) {
        throw new DomainError(
          409,
          'An account request from this device is already pending admin approval.',
          { activeRequest: mapRegistrationRequest(existingIpRes.rows[0]) },
        );
      }

      const existingUserRes = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [normalizedEmail],
      );
      if (existingUserRes.rows[0]) {
        throw new DomainError(409, 'An account with this email already exists on this server.');
      }

      const normalizedUsername = input.username.trim();
      const existingUsernameRes = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
        [normalizedUsername],
      );
      if (existingUsernameRes.rows[0]) {
        throw new DomainError(409, 'That username is already taken on this server.');
      }

      const existingEmailReq = await client.query<{ id: string }>(
        `SELECT id
         FROM registration_requests
         WHERE LOWER(email) = LOWER($1) AND status = 'PENDING' AND expires_at > NOW()
         LIMIT 1`,
        [normalizedEmail],
      );
      if (existingEmailReq.rows[0]) {
        throw new DomainError(
          409,
          'A registration request for this email is already awaiting admin approval.',
        );
      }

      const existingUsernameReq = await client.query<{ id: string }>(
        `SELECT id
         FROM registration_requests
         WHERE LOWER(username) = LOWER($1) AND status = 'PENDING' AND expires_at > NOW()
         LIMIT 1`,
        [normalizedUsername],
      );
      if (existingUsernameReq.rows[0]) {
        throw new DomainError(
          409,
          'A registration request for that username is already awaiting admin approval.',
        );
      }

      let groupName: string | null = null;
      let validInviteToken: string | null = null;
      if (input.inviteToken) {
        const invRes = await client.query<PgInvitePreviewRow>(
          `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
                  gi.max_uses, gi.uses, gi.expires_at
           FROM group_invites gi
           JOIN groups g ON g.id = gi.group_id
           WHERE gi.token = $1`,
          [input.inviteToken],
        );
        const inv = invRes.rows[0];
        if (!inv) {
          throw new DomainError(404, 'Invite token not found on this server');
        }
        if (inv.expires_at.getTime() <= Date.now()) {
          throw new DomainError(410, 'Invite token has expired');
        }
        if (inv.uses >= inv.max_uses) {
          throw new DomainError(410, 'Invite token has reached maximum uses');
        }
        groupName = inv.group_name;
        validInviteToken = inv.token;
      }

      const insertedRes = await client.query<PgRegistrationRequestRow>(
        `INSERT INTO registration_requests (
           email, username, password_hash, avatar_url, halo_color, fuzz_circle_color,
           invite_token, group_name, requester_ip, status, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10)
         RETURNING *`,
        [
          normalizedEmail,
          input.username.trim(),
          passwordHash,
          input.avatarUrl ?? null,
          input.haloColor ?? null,
          input.fuzzCircleColor ?? null,
          validInviteToken,
          groupName,
          requesterIp,
          expiresAt,
        ],
      );

      await client.query('COMMIT');
      return { request: mapRegistrationRequest(insertedRes.rows[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getStatus(
    options: { requestId?: string; requesterIp: string },
  ): Promise<{ request: RegistrationRequestItem | null }> {
    await this.expireStaleRequests();

    if (options.requestId) {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(options.requestId)) {
        throw new DomainError(400, 'Invalid request id');
      }
      const res = await this.pool.query<PgRegistrationRequestRow>(
        `SELECT * FROM registration_requests WHERE id = $1 LIMIT 1`,
        [options.requestId],
      );
      return { request: res.rows[0] ? mapRegistrationRequest(res.rows[0]) : null };
    }

    const res = await this.pool.query<PgRegistrationRequestRow>(
      `SELECT *
       FROM registration_requests
       WHERE requester_ip = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [options.requesterIp],
    );
    return { request: res.rows[0] ? mapRegistrationRequest(res.rows[0]) : null };
  }

  async listForAdmin(): Promise<{ requests: RegistrationRequestItem[] }> {
    await this.expireStaleRequests();
    const res = await this.pool.query<PgRegistrationRequestRow>(
      `SELECT *
       FROM registration_requests
       ORDER BY
         CASE WHEN status = 'PENDING' THEN 0 ELSE 1 END ASC,
         created_at DESC
       LIMIT 100`,
    );
    return { requests: res.rows.map(mapRegistrationRequest) };
  }

  async approveRequest(
    requestId: string,
    adminUserId: string,
  ): Promise<{
    request: RegistrationRequestItem;
    user: { id: string; email: string; username: string };
    joinedGroup: { groupId: string; groupName: string; role: GroupRole } | null;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.expireStaleRequests(client);

      const reqRes = await client.query<PgRegistrationRequestRow>(
        `SELECT * FROM registration_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      const row = reqRes.rows[0];
      if (!row) {
        throw new DomainError(404, 'Registration request not found');
      }
      if (row.status !== 'PENDING') {
        throw new DomainError(409, `Registration request is already ${row.status.toLowerCase()}`);
      }
      if (row.expires_at.getTime() <= Date.now()) {
        await client.query(
          `UPDATE registration_requests SET status = 'EXPIRED' WHERE id = $1`,
          [requestId],
        );
        await client.query('COMMIT');
        throw new DomainError(410, 'Registration request has expired');
      }

      const existingUser = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [row.email],
      );
      if (existingUser.rows[0]) {
        throw new DomainError(409, 'An account with this email already exists');
      }

      const existingUsername = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
        [row.username],
      );
      if (existingUsername.rows[0]) {
        throw new DomainError(409, 'An account with this username already exists');
      }

      const createdUserRes = await client.query<{
        id: string;
        email: string;
        username: string;
      }>(
        `INSERT INTO users (email, username, password_hash, role, avatar_url, halo_color, fuzz_circle_color)
         VALUES ($1, $2, $3, 'USER', $4, $5, $6)
         RETURNING id, email, username`,
        [
          row.email,
          row.username,
          row.password_hash,
          row.avatar_url,
          row.halo_color,
          row.fuzz_circle_color,
        ],
      );
      const createdUser = createdUserRes.rows[0];

      let joinedGroup: { groupId: string; groupName: string; role: GroupRole } | null = null;
      if (row.invite_token) {
        const invRes = await client.query<PgInvitePreviewRow>(
          `SELECT gi.token, gi.group_id, g.name AS group_name, gi.assigned_role,
                  gi.max_uses, gi.uses, gi.expires_at
           FROM group_invites gi
           JOIN groups g ON g.id = gi.group_id
           WHERE gi.token = $1
           FOR UPDATE OF gi`,
          [row.invite_token],
        );
        const inv = invRes.rows[0];
        if (inv && inv.expires_at.getTime() > Date.now() && inv.uses < inv.max_uses) {
          await client.query(
            `INSERT INTO group_memberships (user_id, group_id, role, privacy)
             VALUES ($1, $2, $3, 'EXACT')
             ON CONFLICT (user_id, group_id) DO NOTHING`,
            [createdUser.id, inv.group_id, inv.assigned_role],
          );
          await client.query(
            `UPDATE group_invites SET uses = uses + 1 WHERE token = $1`,
            [inv.token],
          );
          joinedGroup = {
            groupId: inv.group_id,
            groupName: inv.group_name,
            role: inv.assigned_role,
          };
        }
      }

      const updatedReqRes = await client.query<PgRegistrationRequestRow>(
        `UPDATE registration_requests
         SET status = 'APPROVED', reviewed_by = $2, reviewed_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [requestId, adminUserId],
      );

      await client.query('COMMIT');
      return {
        request: mapRegistrationRequest(updatedReqRes.rows[0]),
        user: createdUser,
        joinedGroup,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async denyRequest(
    requestId: string,
    adminUserId: string,
  ): Promise<{ request: RegistrationRequestItem }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.expireStaleRequests(client);

      const reqRes = await client.query<PgRegistrationRequestRow>(
        `SELECT * FROM registration_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      const row = reqRes.rows[0];
      if (!row) {
        throw new DomainError(404, 'Registration request not found');
      }
      if (row.status !== 'PENDING') {
        throw new DomainError(409, `Registration request is already ${row.status.toLowerCase()}`);
      }

      const updatedReqRes = await client.query<PgRegistrationRequestRow>(
        `UPDATE registration_requests
         SET status = 'DENIED', reviewed_by = $2, reviewed_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [requestId, adminUserId],
      );
      await client.query('COMMIT');
      return { request: mapRegistrationRequest(updatedReqRes.rows[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
