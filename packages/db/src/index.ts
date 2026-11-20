import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type {
  BoundingBox,
  GroupPlace,
  GroupRole,
  LocationPoint,
  LocationRequestItem,
  LocationRequestStatus,
  PlaceTransitionEvent,
  PlaceTransitionType,
  PrivacyMode,
  SystemRole,
} from '@loved-ones/shared';
import * as schema from './schema.js';

export * from './schema.js';

const { Pool } = pg;

export type Database = NodePgDatabase<typeof schema>;

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return new Pool({ connectionString });
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../migrations/0001_init.sql'),
    path.resolve(currentDir, '../../migrations/0001_init.sql'),
  ];
  const migrationFile = candidates.find((candidate) => fs.existsSync(candidate));
  if (!migrationFile) {
    throw new Error(`Migration SQL file not found. Checked: ${candidates.join(', ')}`);
  }
  const sql = fs.readFileSync(migrationFile, 'utf8');
  await pool.query(sql);
}

/**
 * Deduplicates incoming points by normalized epoch millisecond so intra-batch
 * duplicate timestamps (including equivalent ISO offset representations) do not
 * collide during bulk UNNEST inserts.
 */
export function deduplicateLocationPoints(points: LocationPoint[]): LocationPoint[] {
  if (points.length <= 1) return points;
  const seenEpochMs = new Set<number>();
  const unique: LocationPoint[] = [];

  for (const pt of points) {
    const epochMs = new Date(pt.recordedAt).getTime();
    if (Number.isNaN(epochMs) || seenEpochMs.has(epochMs)) {
      continue;
    }
    seenEpochMs.add(epochMs);
    unique.push(pt);
  }
  return unique;
}

export async function insertLocationBatch(
  pool: pg.Pool,
  userId: string,
  points: LocationPoint[],
): Promise<number> {
  const uniquePoints = deduplicateLocationPoints(points);
  if (uniquePoints.length === 0) return 0;

  const longitudes: number[] = [];
  const latitudes: number[] = [];
  const altitudes: Array<number | null> = [];
  const speeds: Array<number | null> = [];
  const batteryLevels: Array<number | null> = [];
  const recordedAts: string[] = [];

  for (const pt of uniquePoints) {
    longitudes.push(pt.longitude);
    latitudes.push(pt.latitude);
    altitudes.push(pt.altitude ?? null);
    speeds.push(pt.speed ?? null);
    batteryLevels.push(pt.batteryLevel ?? null);
    recordedAts.push(pt.recordedAt);
  }

  const result = await pool.query(
    `INSERT INTO location_history (user_id, coords, altitude, speed, battery_level, recorded_at)
     SELECT
       $1::uuid,
       ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326)::geography,
       u.alt,
       u.spd,
       u.batt,
       u.rec_at
     FROM UNNEST(
       $2::double precision[],
       $3::double precision[],
       $4::double precision[],
       $5::double precision[],
       $6::smallint[],
       $7::timestamptz[]
     ) AS u(lon, lat, alt, spd, batt, rec_at)
     ON CONFLICT (user_id, recorded_at) DO NOTHING`,
    [userId, longitudes, latitudes, altitudes, speeds, batteryLevels, recordedAts],
  );

  return result.rowCount ?? 0;
}

export interface GroupMemberLocationRow {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  role: GroupRole;
  privacy: PrivacyMode;
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  batteryLevel: number | null;
  recordedAt: string;
}

interface RawGroupLocationRow {
  user_id: string;
  username: string;
  avatar_url?: string | null;
  role: GroupRole;
  privacy: PrivacyMode;
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  battery_level: number | null;
  recorded_at: Date;
}

function mapGroupLocationRow(row: RawGroupLocationRow): GroupMemberLocationRow {
  return {
    userId: row.user_id,
    username: row.username,
    avatarUrl: row.avatar_url ?? null,
    role: row.role,
    privacy: row.privacy,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    altitude: row.altitude,
    speed: row.speed,
    batteryLevel: row.battery_level,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function effectivePrivacySql(nowParamIdx: number): string {
  return `CASE WHEN gm.privacy_override_until IS NOT NULL AND gm.privacy_override_until > $${nowParamIdx}::timestamptz THEN 'EXACT'::privacy_mode ELSE gm.privacy END`;
}

export async function getUserPublicProfile(
  pool: pg.Pool,
  userId: string,
): Promise<{ username: string; avatarUrl: string | null } | null> {
  const res = await pool.query<{ username: string; avatar_url: string | null }>(
    'SELECT username, avatar_url FROM users WHERE id = $1',
    [userId],
  );
  const row = res.rows[0];
  return row ? { username: row.username, avatarUrl: row.avatar_url ?? null } : null;
}

export async function getLatestGroupLocations(
  pool: pg.Pool,
  groupId: string,
  now: Date = new Date(),
): Promise<GroupMemberLocationRow[]> {
  const result = await pool.query<RawGroupLocationRow>(
    `SELECT DISTINCT ON (gm.user_id)
       gm.user_id,
       u.username,
       u.avatar_url,
       gm.role,
       ${effectivePrivacySql(2)} AS privacy,
       ST_Y(lh.coords::geometry) AS latitude,
       ST_X(lh.coords::geometry) AS longitude,
       lh.altitude,
       lh.speed,
       lh.battery_level,
       lh.recorded_at
     FROM group_memberships gm
     JOIN users u ON u.id = gm.user_id
     JOIN location_history lh ON lh.user_id = gm.user_id
     WHERE gm.group_id = $1
       AND gm.role <> 'SPECTATOR'
     ORDER BY gm.user_id, lh.recorded_at DESC`,
    [groupId, now],
  );

  return result.rows.map(mapGroupLocationRow);
}

export interface GroupTrailQueryOptions {
  groupId: string;
  from: Date;
  to: Date;
  bbox?: BoundingBox;
  userId?: string;
  limit?: number;
  now?: Date;
}

/**
 * Fetches ordered historical location points for non-GHOST, non-SPECTATOR members
 * of a Group, optionally filtered by time window, member Account, and a PostGIS
 * ST_MakeEnvelope spatial bounding box using idx_location_gist.
 */
export async function getGroupTrails(
  pool: pg.Pool,
  options: GroupTrailQueryOptions,
): Promise<GroupMemberLocationRow[]> {
  const now = options.now ?? new Date();
  const params: unknown[] = [options.groupId, options.from, options.to, now];
  const privacyExpr = effectivePrivacySql(4);
  const conditions = [
    `gm.group_id = $1`,
    `gm.role <> 'SPECTATOR'`,
    `(${privacyExpr}) <> 'GHOST'`,
    `lh.recorded_at >= $2`,
    `lh.recorded_at <= $3`,
  ];

  if (options.userId) {
    params.push(options.userId);
    conditions.push(`gm.user_id = $${params.length}`);
  }

  if (options.bbox) {
    const idx = params.length + 1;
    params.push(options.bbox.minLon, options.bbox.minLat, options.bbox.maxLon, options.bbox.maxLat);
    const isRegionalSpan =
      options.bbox.maxLon - options.bbox.minLon < 180 &&
      options.bbox.maxLat - options.bbox.minLat < 180;
    if (isRegionalSpan) {
      conditions.push(
        `lh.coords && ST_MakeEnvelope($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, 4326)::geography`,
        `ST_Intersects(lh.coords, ST_MakeEnvelope($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, 4326)::geography)`,
      );
    } else {
      conditions.push(
        `ST_Intersects(lh.coords::geometry, ST_MakeEnvelope($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, 4326))`,
      );
    }
  }

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 1000)), 10000);
  params.push(limit);

  const result = await pool.query<RawGroupLocationRow>(
    `SELECT
       gm.user_id,
       u.username,
       u.avatar_url,
       gm.role,
       ${privacyExpr} AS privacy,
       ST_Y(lh.coords::geometry) AS latitude,
       ST_X(lh.coords::geometry) AS longitude,
       lh.altitude,
       lh.speed,
       lh.battery_level,
       lh.recorded_at
     FROM group_memberships gm
     JOIN users u ON u.id = gm.user_id
     JOIN location_history lh ON lh.user_id = gm.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY lh.recorded_at ASC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(mapGroupLocationRow);
}

export interface UserDbFootprintRow {
  userId: string;
  username: string;
  email: string;
  role: SystemRole;
  locationBytes: number;
  locationPoints: number;
}

export interface DatabaseTelemetryResult {
  databaseBytes: number;
  users: UserDbFootprintRow[];
}

export async function getDatabaseTelemetry(pool: pg.Pool): Promise<DatabaseTelemetryResult> {
  const [sizeRes, userRes] = await Promise.all([
    pool.query<{ db_size: string }>('SELECT pg_database_size(current_database())::text AS db_size'),
    pool.query<{
      id: string;
      username: string;
      email: string;
      role: SystemRole;
      location_bytes: string;
      location_points: string;
    }>(
      `SELECT u.id, u.username, u.email, u.role,
         COALESCE(SUM(pg_column_size(lh.*)), 0)::text AS location_bytes,
         COUNT(lh.id)::text AS location_points
       FROM users u
       LEFT JOIN location_history lh ON lh.user_id = u.id
       GROUP BY u.id, u.username, u.email, u.role`,
    ),
  ]);

  const databaseBytes = Number.parseInt(sizeRes.rows[0]?.db_size ?? '0', 10) || 0;
  return {
    databaseBytes,
    users: userRes.rows.map((row) => ({
      userId: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      locationBytes: Number.parseInt(row.location_bytes, 10) || 0,
      locationPoints: Number.parseInt(row.location_points, 10) || 0,
    })),
  };
}

// ---- Expiring Location Check-In Requests & Group Places ----

export interface GroupMembershipPrivacyInfo {
  role: GroupRole;
  privacy: PrivacyMode;
  effectivePrivacy: PrivacyMode;
  privacyOverrideUntil: string | null;
}

export async function listEffectiveMembershipsForUser(
  pool: pg.Pool,
  userId: string,
  now: Date = new Date(),
): Promise<Array<{ groupId: string; role: GroupRole; privacy: PrivacyMode }>> {
  const res = await pool.query<{ group_id: string; role: GroupRole; privacy: PrivacyMode }>(
    `SELECT gm.group_id, gm.role, ${effectivePrivacySql(2)} AS privacy
     FROM group_memberships gm
     WHERE gm.user_id = $1`,
    [userId, now],
  );
  return res.rows.map((r) => ({
    groupId: r.group_id,
    role: r.role,
    privacy: r.privacy,
  }));
}

export async function getGroupMembershipPrivacyInfo(
  pool: pg.Pool,
  userId: string,
  groupId: string,
  now: Date = new Date(),
): Promise<GroupMembershipPrivacyInfo | null> {
  const res = await pool.query<{
    role: GroupRole;
    privacy: PrivacyMode;
    effective_privacy: PrivacyMode;
    privacy_override_until: Date | null;
  }>(
    `SELECT gm.role, gm.privacy, ${effectivePrivacySql(3)} AS effective_privacy, gm.privacy_override_until
     FROM group_memberships gm
     WHERE gm.user_id = $1 AND gm.group_id = $2`,
    [userId, groupId, now],
  );
  const row = res.rows[0];
  if (!row) return null;
  const activeUntil =
    row.privacy_override_until && row.privacy_override_until > now
      ? row.privacy_override_until.toISOString()
      : null;
  return {
    role: row.role,
    privacy: row.privacy,
    effectivePrivacy: row.effective_privacy,
    privacyOverrideUntil: activeUntil,
  };
}

export async function getLatestUserLocation(
  pool: pg.Pool,
  userId: string,
): Promise<LocationPoint | null> {
  const res = await pool.query<{
    latitude: number;
    longitude: number;
    altitude: number | null;
    speed: number | null;
    battery_level: number | null;
    recorded_at: Date;
  }>(
    `SELECT ST_Y(coords::geometry) AS latitude,
            ST_X(coords::geometry) AS longitude,
            altitude,
            speed,
            battery_level,
            recorded_at
     FROM location_history
     WHERE user_id = $1
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    altitude: row.altitude,
    speed: row.speed,
    batteryLevel: row.battery_level,
    recordedAt: row.recorded_at.toISOString(),
  };
}

interface RawLocationRequestRow {
  id: string;
  group_id: string;
  requester_id: string;
  requester_username: string;
  target_user_id: string;
  target_username: string;
  status: LocationRequestStatus;
  suggested_duration_minutes: number;
  message: string | null;
  expires_at: Date;
  responded_at: Date | null;
  created_at: Date;
}

function mapLocationRequestRow(row: RawLocationRequestRow): LocationRequestItem {
  return {
    id: row.id,
    groupId: row.group_id,
    requesterId: row.requester_id,
    requesterUsername: row.requester_username,
    targetUserId: row.target_user_id,
    targetUsername: row.target_username,
    status: row.status,
    suggestedDurationMinutes: row.suggested_duration_minutes,
    message: row.message,
    expiresAt: row.expires_at.toISOString(),
    respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

async function fetchLocationRequestById(
  queryable: Pick<pg.PoolClient, 'query'>,
  requestId: string,
): Promise<LocationRequestItem> {
  const res = await queryable.query<RawLocationRequestRow>(
    `SELECT lr.id, lr.group_id, lr.requester_id, req_u.username AS requester_username,
            lr.target_user_id, tgt_u.username AS target_username,
            lr.status, lr.suggested_duration_minutes, lr.message,
            lr.expires_at, lr.responded_at, lr.created_at
     FROM location_requests lr
     JOIN users req_u ON req_u.id = lr.requester_id
     JOIN users tgt_u ON tgt_u.id = lr.target_user_id
     WHERE lr.id = $1`,
    [requestId],
  );
  return mapLocationRequestRow(res.rows[0]);
}

export async function createLocationRequestRecord(
  pool: pg.Pool,
  input: {
    groupId: string;
    requesterId: string;
    targetUserId: string;
    suggestedDurationMinutes: number;
    expiresAt: Date;
    message?: string;
    now?: Date;
  },
): Promise<LocationRequestItem> {
  const now = input.now ?? new Date();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO location_requests (
       group_id, requester_id, target_user_id, status,
       suggested_duration_minutes, message, expires_at, created_at
     )
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
     RETURNING id`,
    [
      input.groupId,
      input.requesterId,
      input.targetUserId,
      input.suggestedDurationMinutes,
      input.message ?? null,
      input.expiresAt,
      now,
    ],
  );
  return fetchLocationRequestById(pool, res.rows[0].id);
}

export async function listLocationRequestsForUser(
  pool: pg.Pool,
  groupId: string,
  userId: string,
  now: Date = new Date(),
): Promise<LocationRequestItem[]> {
  await pool.query(
    `UPDATE location_requests
     SET status = 'expired'
     WHERE group_id = $1 AND status = 'pending' AND expires_at <= $2`,
    [groupId, now],
  );

  const res = await pool.query<RawLocationRequestRow>(
    `SELECT lr.id, lr.group_id, lr.requester_id, req_u.username AS requester_username,
            lr.target_user_id, tgt_u.username AS target_username,
            lr.status, lr.suggested_duration_minutes, lr.message,
            lr.expires_at, lr.responded_at, lr.created_at
     FROM location_requests lr
     JOIN users req_u ON req_u.id = lr.requester_id
     JOIN users tgt_u ON tgt_u.id = lr.target_user_id
     WHERE lr.group_id = $1
       AND (lr.requester_id = $2 OR lr.target_user_id = $2)
     ORDER BY lr.created_at DESC
     LIMIT 50`,
    [groupId, userId],
  );
  return res.rows.map(mapLocationRequestRow);
}

export type RespondLocationRequestDbResult =
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'expired' }
  | { kind: 'already_responded'; status: LocationRequestStatus }
  | { kind: 'ok'; request: LocationRequestItem; privacyOverrideUntil: string | null };

export async function respondToLocationRequestRecord(
  pool: pg.Pool,
  input: {
    groupId: string;
    requestId: string;
    responderUserId: string;
    action: 'accept' | 'decline';
    durationMinutes?: number;
    now?: Date;
  },
): Promise<RespondLocationRequestDbResult> {
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query<{
      id: string;
      target_user_id: string;
      status: LocationRequestStatus;
      suggested_duration_minutes: number;
      expires_at: Date;
    }>(
      `SELECT id, target_user_id, status, suggested_duration_minutes, expires_at
       FROM location_requests
       WHERE id = $1 AND group_id = $2
       FOR UPDATE`,
      [input.requestId, input.groupId],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }
    if (existing.target_user_id !== input.responderUserId) {
      await client.query('ROLLBACK');
      return { kind: 'forbidden' };
    }
    if (existing.status === 'expired' || (existing.status === 'pending' && existing.expires_at <= now)) {
      if (existing.status === 'pending') {
        await client.query(`UPDATE location_requests SET status = 'expired' WHERE id = $1`, [
          existing.id,
        ]);
      }
      await client.query('COMMIT');
      return { kind: 'expired' };
    }
    if (existing.status !== 'pending') {
      await client.query('ROLLBACK');
      return { kind: 'already_responded', status: existing.status };
    }

    const nextStatus: LocationRequestStatus = input.action === 'accept' ? 'accepted' : 'declined';
    await client.query(
      `UPDATE location_requests
       SET status = $1, responded_at = $2
       WHERE id = $3`,
      [nextStatus, now, existing.id],
    );

    let privacyOverrideUntil: string | null = null;
    if (input.action === 'accept') {
      const duration = input.durationMinutes ?? existing.suggested_duration_minutes;
      const until = new Date(now.getTime() + duration * 60_000);
      const gmRes = await client.query<{ privacy_override_until: Date | null }>(
        `UPDATE group_memberships
         SET privacy_override_until = GREATEST(COALESCE(privacy_override_until, $1::timestamptz), $1::timestamptz)
         WHERE user_id = $2 AND group_id = $3
         RETURNING privacy_override_until`,
        [until, input.responderUserId, input.groupId],
      );
      privacyOverrideUntil =
        gmRes.rows[0]?.privacy_override_until?.toISOString() ?? until.toISOString();
    }

    const updated = await fetchLocationRequestById(client, existing.id);
    await client.query('COMMIT');
    return { kind: 'ok', request: updated, privacyOverrideUntil };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface RawGroupPlaceRow {
  id: string;
  group_id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  created_by: string | null;
  created_at: Date;
}

function mapGroupPlaceRow(row: RawGroupPlaceRow): GroupPlace {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusMeters: Number(row.radius_meters),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createGroupPlaceRecord(
  pool: pg.Pool,
  input: {
    groupId: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    createdBy: string;
  },
): Promise<GroupPlace> {
  const res = await pool.query<RawGroupPlaceRow>(
    `INSERT INTO group_places (group_id, name, center, radius_meters, created_by)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)
     RETURNING id, group_id, name,
               ST_Y(center::geometry) AS latitude,
               ST_X(center::geometry) AS longitude,
               radius_meters, created_by, created_at`,
    [
      input.groupId,
      input.name,
      input.longitude,
      input.latitude,
      input.radiusMeters,
      input.createdBy,
    ],
  );
  return mapGroupPlaceRow(res.rows[0]);
}

export async function listGroupPlaces(pool: pg.Pool, groupId: string): Promise<GroupPlace[]> {
  const res = await pool.query<RawGroupPlaceRow>(
    `SELECT id, group_id, name,
            ST_Y(center::geometry) AS latitude,
            ST_X(center::geometry) AS longitude,
            radius_meters, created_by, created_at
     FROM group_places
     WHERE group_id = $1
     ORDER BY created_at ASC`,
    [groupId],
  );
  return res.rows.map(mapGroupPlaceRow);
}

export async function deleteGroupPlaceRecord(
  pool: pg.Pool,
  groupId: string,
  placeId: string,
): Promise<boolean> {
  const res = await pool.query('DELETE FROM group_places WHERE id = $1 AND group_id = $2', [
    placeId,
    groupId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

export async function listRecentPlaceTransitions(
  pool: pg.Pool,
  groupId: string,
  limit = 50,
): Promise<PlaceTransitionEvent[]> {
  const res = await pool.query<{
    id: string;
    group_id: string;
    place_id: string;
    place_name: string;
    user_id: string;
    username: string;
    transition: PlaceTransitionType;
    recorded_at: Date;
  }>(
    `SELECT gpe.id, gpe.group_id, gpe.place_id, gpe.place_name,
            gpe.user_id, u.username, gpe.transition, gpe.recorded_at
     FROM group_place_events gpe
     JOIN users u ON u.id = gpe.user_id
     WHERE gpe.group_id = $1
     ORDER BY gpe.recorded_at DESC, gpe.created_at DESC
     LIMIT $2`,
    [groupId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    placeId: r.place_id,
    placeName: r.place_name,
    userId: r.user_id,
    username: r.username,
    transition: r.transition,
    recordedAt: r.recorded_at.toISOString(),
  }));
}

/**
 * Evaluates all geofenced GroupPlaces for a group using PostGIS ST_DWithin and
 * records genuine enter/exit state transitions for a user sharing EXACT mode.
 */
export async function evaluateAndRecordPlaceTransitions(
  pool: pg.Pool,
  input: {
    groupId: string;
    userId: string;
    username: string;
    latitude: number;
    longitude: number;
    recordedAt: string;
  },
): Promise<PlaceTransitionEvent[]> {
  const res = await pool.query<{
    place_id: string;
    place_name: string;
    was_inside: boolean | null;
    is_inside_now: boolean;
  }>(
    `SELECT gp.id AS place_id,
            gp.name AS place_name,
            gps.is_inside AS was_inside,
            ST_DWithin(
              gp.center,
              ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
              gp.radius_meters
            ) AS is_inside_now
     FROM group_places gp
     LEFT JOIN group_place_states gps
       ON gps.place_id = gp.id AND gps.user_id = $2
     WHERE gp.group_id = $1`,
    [input.groupId, input.userId, input.longitude, input.latitude],
  );

  const transitions: PlaceTransitionEvent[] = [];
  const recordedAtDate = new Date(input.recordedAt);

  for (const row of res.rows) {
    // Only emit 'enter' when entering from outside (or uninitialized); never emit spurious 'exit' on initial outside fix
    if (row.was_inside === null && !row.is_inside_now) {
      await pool.query(
        `INSERT INTO group_place_states (place_id, user_id, is_inside, last_transition_at)
         VALUES ($1, $2, false, $3)
         ON CONFLICT (place_id, user_id) DO NOTHING`,
        [row.place_id, input.userId, recordedAtDate],
      );
      continue;
    }

    const previouslyInside = row.was_inside ?? false;
    if (previouslyInside === row.is_inside_now) {
      continue;
    }

    const transition: PlaceTransitionType = row.is_inside_now ? 'enter' : 'exit';
    await pool.query(
      `INSERT INTO group_place_states (place_id, user_id, is_inside, last_transition_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (place_id, user_id)
       DO UPDATE SET is_inside = EXCLUDED.is_inside,
                     last_transition_at = EXCLUDED.last_transition_at`,
      [row.place_id, input.userId, row.is_inside_now, recordedAtDate],
    );

    const evtRes = await pool.query<{ id: string }>(
      `INSERT INTO group_place_events (group_id, place_id, place_name, user_id, transition, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [input.groupId, row.place_id, row.place_name, input.userId, transition, recordedAtDate],
    );

    transitions.push({
      id: evtRes.rows[0]?.id,
      groupId: input.groupId,
      placeId: row.place_id,
      placeName: row.place_name,
      userId: input.userId,
      username: input.username,
      transition,
      recordedAt: recordedAtDate.toISOString(),
    });
  }

  return transitions;
}

export interface AuditContextSnapshot {
  actorUsername?: string;
  actorEmail?: string;
  targetUsername?: string;
  targetEmail?: string;
  groupName?: string;
  placeName?: string;
  membershipRole?: GroupRole;
  membershipPrivacy?: PrivacyMode;
}

export async function resolveAuditContext(
  pool: pg.Pool,
  params: {
    userId?: string;
    targetUserId?: string;
    groupId?: string;
    placeId?: string;
  },
): Promise<AuditContextSnapshot> {
  const snapshot: AuditContextSnapshot = {};
  const tasks: Array<Promise<void>> = [];

  if (params.userId) {
    tasks.push(
      pool
        .query<{ username: string; email: string }>(
          'SELECT username, email FROM users WHERE id = $1 LIMIT 1',
          [params.userId],
        )
        .then((res) => {
          const row = res.rows[0];
          if (row) {
            snapshot.actorUsername = row.username;
            snapshot.actorEmail = row.email;
          }
        })
        .catch(() => {}),
    );
  }

  if (params.targetUserId) {
    tasks.push(
      pool
        .query<{ username: string; email: string }>(
          'SELECT username, email FROM users WHERE id = $1 LIMIT 1',
          [params.targetUserId],
        )
        .then((res) => {
          const row = res.rows[0];
          if (row) {
            snapshot.targetUsername = row.username;
            snapshot.targetEmail = row.email;
          }
        })
        .catch(() => {}),
    );
  }

  if (params.groupId) {
    tasks.push(
      pool
        .query<{ name: string }>('SELECT name FROM groups WHERE id = $1 LIMIT 1', [params.groupId])
        .then((res) => {
          const row = res.rows[0];
          if (row) snapshot.groupName = row.name;
        })
        .catch(() => {}),
    );
  }

  if (params.placeId) {
    tasks.push(
      pool
        .query<{ name: string }>('SELECT name FROM group_places WHERE id = $1 LIMIT 1', [
          params.placeId,
        ])
        .then((res) => {
          const row = res.rows[0];
          if (row) snapshot.placeName = row.name;
        })
        .catch(() => {}),
    );
  }

  const membershipUserId = params.targetUserId ?? params.userId;
  if (membershipUserId && params.groupId) {
    tasks.push(
      pool
        .query<{ role: GroupRole; privacy: PrivacyMode }>(
          'SELECT role, privacy FROM group_memberships WHERE user_id = $1 AND group_id = $2 LIMIT 1',
          [membershipUserId, params.groupId],
        )
        .then((res) => {
          const row = res.rows[0];
          if (row) {
            snapshot.membershipRole = row.role;
            snapshot.membershipPrivacy = row.privacy;
          }
        })
        .catch(() => {}),
    );
  }

  await Promise.all(tasks);
  return snapshot;
}
