import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type {
  BoundingBox,
  DatabaseBreakdown,
  DatabaseTableBreakdown,
  GroupPlace,
  GroupRole,
  LocationPoint,
  LocationRequestItem,
  LocationRequestStatus,
  MotionActivity,
  PlaceTransitionEvent,
  PlaceTransitionType,
  PrivacyMode,
  SystemRole,
} from '@loved-ones/shared';
import * as schema from './schema.js';

export * from './schema.js';

const { Pool } = pg;

export type Database = NodePgDatabase<typeof schema>;

export type PoolSslMode = 'disable' | 'require' | 'no-verify' | 'verify-full';

export function resolvePoolSslConfig(
  connectionString: string,
  sslModeOverride?: PoolSslMode | string,
  sslCaOverride?: string,
): pg.PoolConfig['ssl'] {
  const rawMode = (sslModeOverride ?? process.env.DATABASE_SSL ?? '').trim().toLowerCase();
  let effectiveMode = rawMode;
  if (!effectiveMode) {
    try {
      const parsed = new URL(connectionString);
      const urlSslMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
      if (urlSslMode === 'disable' || urlSslMode === 'require' || urlSslMode === 'no-verify' || urlSslMode === 'verify-full') {
        effectiveMode = urlSslMode;
      }
    } catch {
      // ignore non-standard URI parse failures
    }
  }

  if (!effectiveMode || effectiveMode === 'false' || effectiveMode === 'disable') {
    return undefined;
  }

  const rawCa = (sslCaOverride ?? process.env.DATABASE_SSL_CA ?? '').trim();
  let ca: string | undefined;
  if (rawCa) {
    ca = rawCa.includes('BEGIN CERTIFICATE') ? rawCa : fs.existsSync(rawCa) ? fs.readFileSync(rawCa, 'utf8') : undefined;
  }

  if (effectiveMode === 'no-verify' || effectiveMode === 'allow') {
    return { rejectUnauthorized: false, ...(ca ? { ca } : {}) };
  }
  if (effectiveMode === 'true' || effectiveMode === 'require' || effectiveMode === 'verify-full' || effectiveMode === 'verify-ca') {
    return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  }
  return undefined;
}

export function createPool(
  connectionString = process.env.DATABASE_URL,
  options?: { sslMode?: PoolSslMode | string; sslCa?: string },
): pg.Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const ssl = resolvePoolSslConfig(connectionString, options?.sslMode, options?.sslCa);
  return new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

const MIGRATIONS_ADVISORY_LOCK_KEY = 784512901;

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
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
    await client.query(sql);
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY])
      .catch(() => {});
    client.release();
  }
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
  const accuracies: Array<number | null> = [];
  const speeds: Array<number | null> = [];
  const headings: Array<number | null> = [];
  const activities: Array<string | null> = [];
  const batteryLevels: Array<number | null> = [];
  const recordedAts: string[] = [];

  for (const pt of uniquePoints) {
    longitudes.push(pt.longitude);
    latitudes.push(pt.latitude);
    altitudes.push(pt.altitude ?? null);
    accuracies.push(pt.accuracy ?? null);
    speeds.push(pt.speed ?? null);
    headings.push(pt.heading ?? null);
    activities.push(pt.activity ?? null);
    batteryLevels.push(pt.batteryLevel ?? null);
    recordedAts.push(pt.recordedAt);
  }

  const result = await pool.query(
    `INSERT INTO location_history (user_id, coords, altitude, accuracy, speed, heading, activity, battery_level, recorded_at)
     SELECT
       $1::uuid,
       ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326)::geography,
       u.alt,
       u.acc,
       u.spd,
       u.hdg,
       u.act,
       u.batt,
       u.rec_at
     FROM UNNEST(
       $2::double precision[],
       $3::double precision[],
       $4::double precision[],
       $5::double precision[],
       $6::double precision[],
       $7::double precision[],
       $8::varchar[],
       $9::smallint[],
       $10::timestamptz[]
     ) AS u(lon, lat, alt, acc, spd, hdg, act, batt, rec_at)
     ON CONFLICT (user_id, recorded_at) DO NOTHING`,
    [
      userId,
      longitudes,
      latitudes,
      altitudes,
      accuracies,
      speeds,
      headings,
      activities,
      batteryLevels,
      recordedAts,
    ],
  );

  return result.rowCount ?? 0;
}

export interface GroupMemberLocationRow {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  haloColor?: string | null;
  fuzzCircleColor?: string | null;
  role: GroupRole;
  privacy: PrivacyMode;
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy?: number | null;
  speed: number | null;
  heading?: number | null;
  activity?: MotionActivity | null;
  batteryLevel: number | null;
  recordedAt: string;
}

interface RawGroupLocationRow {
  user_id: string;
  username: string;
  avatar_url?: string | null;
  halo_color?: string | null;
  fuzz_circle_color?: string | null;
  role: GroupRole;
  privacy: PrivacyMode;
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy?: number | null;
  speed: number | null;
  heading?: number | null;
  activity?: MotionActivity | null;
  battery_level: number | null;
  recorded_at: Date;
}

function mapGroupLocationRow(row: RawGroupLocationRow): GroupMemberLocationRow {
  return {
    userId: row.user_id,
    username: row.username,
    avatarUrl: row.avatar_url ?? null,
    haloColor: row.halo_color ?? null,
    fuzzCircleColor: row.fuzz_circle_color ?? null,
    role: row.role,
    privacy: row.privacy,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    altitude: row.altitude,
    accuracy: row.accuracy ?? null,
    speed: row.speed,
    heading: row.heading ?? null,
    activity: row.activity ?? null,
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
): Promise<{
  username: string;
  avatarUrl: string | null;
  haloColor: string | null;
  fuzzCircleColor: string | null;
} | null> {
  const res = await pool.query<{
    username: string;
    avatar_url: string | null;
    halo_color: string | null;
    fuzz_circle_color: string | null;
  }>('SELECT username, avatar_url, halo_color, fuzz_circle_color FROM users WHERE id = $1', [
    userId,
  ]);
  const row = res.rows[0];
  return row
    ? {
        username: row.username,
        avatarUrl: row.avatar_url ?? null,
        haloColor: row.halo_color ?? null,
        fuzzCircleColor: row.fuzz_circle_color ?? null,
      }
    : null;
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
       u.halo_color,
       u.fuzz_circle_color,
       gm.role,
       ${effectivePrivacySql(2)} AS privacy,
       ST_Y(lh.coords::geometry) AS latitude,
       ST_X(lh.coords::geometry) AS longitude,
       lh.altitude,
       lh.accuracy,
       lh.speed,
       lh.heading,
       lh.activity,
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

export interface GroupTrailSampledResult {
  rows: GroupMemberLocationRow[];
  totalCount: number;
  truncated: boolean;
}

function buildGroupTrailFilterSql(options: GroupTrailQueryOptions): {
  params: unknown[];
  privacyExpr: string;
  whereClause: string;
} {
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

  return {
    params,
    privacyExpr,
    whereClause: conditions.join(' AND '),
  };
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
  const { params, privacyExpr, whereClause } = buildGroupTrailFilterSql(options);
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 1000)), 10000);
  params.push(limit);

  const result = await pool.query<RawGroupLocationRow>(
    `SELECT
       gm.user_id,
       u.username,
       u.avatar_url,
       u.halo_color,
       u.fuzz_circle_color,
       gm.role,
       ${privacyExpr} AS privacy,
       ST_Y(lh.coords::geometry) AS latitude,
       ST_X(lh.coords::geometry) AS longitude,
       lh.altitude,
       lh.accuracy,
       lh.speed,
       lh.heading,
       lh.activity,
       lh.battery_level,
       lh.recorded_at
     FROM group_memberships gm
     JOIN users u ON u.id = gm.user_id
     JOIN location_history lh ON lh.user_id = gm.user_id
     WHERE ${whereClause}
     ORDER BY lh.recorded_at ASC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map(mapGroupLocationRow);
}

/**
 * Fetches historical trail points across `[from, to]` while avoiding silent cutoff of
 * recent days when total matching rows exceed `limit` by sampling uniformly per user.
 */
export async function getGroupTrailsSampled(
  pool: pg.Pool,
  options: GroupTrailQueryOptions,
): Promise<GroupTrailSampledResult> {
  const { params, privacyExpr, whereClause } = buildGroupTrailFilterSql(options);
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 2500)), 10000);

  const countRes = await pool.query<{ total_count: number }>(
    `SELECT COUNT(*)::int AS total_count
     FROM group_memberships gm
     JOIN location_history lh ON lh.user_id = gm.user_id
     WHERE ${whereClause}`,
    params,
  );
  const totalCount = countRes.rows[0]?.total_count ?? 0;
  if (totalCount === 0) {
    return { rows: [], totalCount: 0, truncated: false };
  }

  if (totalCount <= limit) {
    const rows = await getGroupTrails(pool, { ...options, limit });
    return { rows, totalCount, truncated: false };
  }

  const stride = Math.max(2, Math.ceil(totalCount / limit));
  const sampledParams = [...params, stride, limit];
  const strideParamIdx = params.length + 1;
  const limitParamIdx = params.length + 2;

  const result = await pool.query<RawGroupLocationRow>(
    `WITH ranked AS (
       SELECT
         gm.user_id,
         u.username,
         u.avatar_url,
         u.halo_color,
         u.fuzz_circle_color,
         gm.role,
         ${privacyExpr} AS privacy,
         ST_Y(lh.coords::geometry) AS latitude,
         ST_X(lh.coords::geometry) AS longitude,
         lh.altitude,
         lh.accuracy,
         lh.speed,
         lh.heading,
         lh.activity,
         lh.battery_level,
         lh.recorded_at,
         ROW_NUMBER() OVER (PARTITION BY gm.user_id ORDER BY lh.recorded_at ASC) AS rn,
         COUNT(*) OVER (PARTITION BY gm.user_id) AS user_total
       FROM group_memberships gm
       JOIN users u ON u.id = gm.user_id
       JOIN location_history lh ON lh.user_id = gm.user_id
       WHERE ${whereClause}
     )
     SELECT
       user_id,
       username,
       avatar_url,
       halo_color,
       fuzz_circle_color,
       role,
       privacy,
       latitude,
       longitude,
       altitude,
       accuracy,
       speed,
       heading,
       activity,
       battery_level,
       recorded_at
     FROM ranked
     WHERE rn = 1 OR rn = user_total OR ((rn - 1) % $${strideParamIdx}) = 0
     ORDER BY recorded_at ASC
     LIMIT $${limitParamIdx}`,
    sampledParams,
  );

  const rows = result.rows.map(mapGroupLocationRow);
  return {
    rows,
    totalCount,
    truncated: rows.length < totalCount,
  };
}

export interface UserDbFootprintRow {
  userId: string;
  username: string;
  email: string;
  role: SystemRole;
  locationBytes: number;
  locationPoints: number;
  estimatedIndexBytes?: number;
  messageBytes?: number;
  messageCount?: number;
  avatarBytes?: number;
  placeEventCount?: number;
  totalDbBytes?: number;
}

export interface DatabaseTelemetryResult {
  databaseBytes: number;
  users: UserDbFootprintRow[];
  breakdown?: DatabaseBreakdown;
}

const TABLE_CLASSIFICATION: Record<
  string,
  { label: string; category: 'system' | 'manageable'; deletable: boolean }
> = {
  location_history: { label: 'Location Pings', category: 'manageable', deletable: true },
  messages: { label: 'Chat Messages', category: 'manageable', deletable: true },
  group_place_events: { label: 'Geofence Events', category: 'manageable', deletable: true },
  location_requests: { label: 'Check-In Requests', category: 'manageable', deletable: true },
  registration_requests: { label: 'Registration Queue', category: 'manageable', deletable: true },
  location_share_links: { label: 'Share Links', category: 'manageable', deletable: true },
  location_share_guests: { label: 'Share Link Guests', category: 'manageable', deletable: true },
  users: { label: 'Accounts & Profiles', category: 'system', deletable: false },
  groups: { label: 'Groups', category: 'system', deletable: false },
  group_memberships: { label: 'Group Memberships', category: 'system', deletable: false },
  group_invites: { label: 'Group Invites', category: 'system', deletable: false },
  group_places: { label: 'Geofenced Places', category: 'system', deletable: false },
  group_place_states: { label: 'Geofence States', category: 'system', deletable: false },
  push_vapid_config: { label: 'VAPID Keys (System)', category: 'system', deletable: false },
  push_subscriptions: { label: 'Web Push Subscriptions', category: 'system', deletable: false },
  server_settings: { label: 'Server Settings', category: 'system', deletable: false },
  spatial_ref_sys: { label: 'PostGIS Spatial Reference', category: 'system', deletable: false },
};

export async function getDatabaseTelemetry(pool: pg.Pool): Promise<DatabaseTelemetryResult> {
  const [sizeRes, userRes, tableRes] = await Promise.all([
    pool.query<{ db_size: string }>('SELECT pg_database_size(current_database())::text AS db_size'),
    pool.query<{
      id: string;
      username: string;
      email: string;
      role: SystemRole;
      avatar_bytes: string;
      location_bytes: string;
      location_points: string;
      message_bytes: string;
      message_count: string;
      place_event_count: string;
    }>(
      `WITH loc AS (
         SELECT user_id,
                COALESCE(SUM(pg_column_size(location_history.*)), 0)::bigint AS location_bytes,
                COUNT(*)::bigint AS location_points
         FROM location_history
         GROUP BY user_id
       ),
       msg AS (
         SELECT sender_id AS user_id,
                COALESCE(SUM(pg_column_size(messages.*)), 0)::bigint AS message_bytes,
                COUNT(*)::bigint AS message_count
         FROM messages
         GROUP BY sender_id
       ),
       pe AS (
         SELECT user_id, COUNT(*)::bigint AS place_event_count
         FROM group_place_events
         GROUP BY user_id
       )
       SELECT u.id,
              u.username,
              u.email,
              u.role,
              octet_length(COALESCE(u.avatar_url, ''))::text AS avatar_bytes,
              COALESCE(loc.location_bytes, 0)::text AS location_bytes,
              COALESCE(loc.location_points, 0)::text AS location_points,
              COALESCE(msg.message_bytes, 0)::text AS message_bytes,
              COALESCE(msg.message_count, 0)::text AS message_count,
              COALESCE(pe.place_event_count, 0)::text AS place_event_count
       FROM users u
       LEFT JOIN loc ON loc.user_id = u.id
       LEFT JOIN msg ON msg.user_id = u.id
       LEFT JOIN pe ON pe.user_id = u.id`,
    ),
    pool.query<{
      table_name: string;
      row_bytes: string;
      index_bytes: string;
      total_bytes: string;
      live_rows: string;
      dead_rows: string;
    }>(
      `SELECT c.relname AS table_name,
              pg_relation_size(c.oid)::text AS row_bytes,
              pg_indexes_size(c.oid)::text AS index_bytes,
              pg_total_relation_size(c.oid)::text AS total_bytes,
              COALESCE(s.n_live_tup, 0)::text AS live_rows,
              COALESCE(s.n_dead_tup, 0)::text AS dead_rows
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
       ORDER BY pg_total_relation_size(c.oid) DESC`,
    ),
  ]);

  const databaseBytes = Number.parseInt(sizeRes.rows[0]?.db_size ?? '0', 10) || 0;

  const tables: DatabaseTableBreakdown[] = [];
  let sumTableBytes = 0;
  let systemBytes = 0;
  let manageableBytes = 0;
  let deadTupleBytesEstimate = 0;
  let locationHistoryIndexBytes = 0;

  for (const row of tableRes.rows) {
    const rowBytes = Number.parseInt(row.row_bytes, 10) || 0;
    const indexBytes = Number.parseInt(row.index_bytes, 10) || 0;
    const totalBytes = Number.parseInt(row.total_bytes, 10) || 0;
    const toastBytes = Math.max(0, totalBytes - rowBytes - indexBytes);
    const liveRows = Number.parseInt(row.live_rows, 10) || 0;
    const deadRows = Number.parseInt(row.dead_rows, 10) || 0;
    const meta = TABLE_CLASSIFICATION[row.table_name] ?? {
      label: row.table_name,
      category: 'system' as const,
      deletable: false,
    };

    sumTableBytes += totalBytes;
    if (meta.category === 'system') {
      systemBytes += totalBytes;
    } else {
      manageableBytes += totalBytes;
    }
    if (liveRows + deadRows > 0 && deadRows > 0) {
      deadTupleBytesEstimate += Math.round(rowBytes * (deadRows / (liveRows + deadRows)));
    }
    if (row.table_name === 'location_history') {
      locationHistoryIndexBytes = indexBytes;
    }

    tables.push({
      tableName: row.table_name,
      label: meta.label,
      category: meta.category,
      deletable: meta.deletable,
      rowBytes,
      indexBytes,
      toastBytes,
      totalBytes,
      liveRows,
      deadRows,
    });
  }

  const engineOverheadBytes = Math.max(0, databaseBytes - sumTableBytes);
  if (engineOverheadBytes > 0) {
    systemBytes += engineOverheadBytes;
    tables.push({
      tableName: 'pg_system_overhead',
      label: 'PostgreSQL Catalogs, WAL & Engine',
      category: 'system',
      deletable: false,
      rowBytes: engineOverheadBytes,
      indexBytes: 0,
      toastBytes: 0,
      totalBytes: engineOverheadBytes,
      liveRows: 0,
      deadRows: 0,
    });
  }

  const totalLocationPoints = userRes.rows.reduce(
    (sum, r) => sum + (Number.parseInt(r.location_points, 10) || 0),
    0,
  );

  return {
    databaseBytes,
    breakdown: {
      systemBytes,
      manageableBytes,
      deadTupleBytesEstimate,
      tables,
    },
    users: userRes.rows.map((row) => {
      const locationBytes = Number.parseInt(row.location_bytes, 10) || 0;
      const locationPoints = Number.parseInt(row.location_points, 10) || 0;
      const messageBytes = Number.parseInt(row.message_bytes, 10) || 0;
      const messageCount = Number.parseInt(row.message_count, 10) || 0;
      const avatarBytes = Number.parseInt(row.avatar_bytes, 10) || 0;
      const placeEventCount = Number.parseInt(row.place_event_count, 10) || 0;
      const estimatedIndexBytes =
        totalLocationPoints > 0 && locationPoints > 0
          ? Math.round((locationPoints / totalLocationPoints) * locationHistoryIndexBytes)
          : 0;
      return {
        userId: row.id,
        username: row.username,
        email: row.email,
        role: row.role,
        locationBytes,
        locationPoints,
        estimatedIndexBytes,
        messageBytes,
        messageCount,
        avatarBytes,
        placeEventCount,
        totalDbBytes: locationBytes + estimatedIndexBytes + messageBytes + avatarBytes,
      };
    }),
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
    accuracy: number | null;
    speed: number | null;
    heading: number | null;
    activity: MotionActivity | null;
    battery_level: number | null;
    recorded_at: Date;
  }>(
    `SELECT ST_Y(coords::geometry) AS latitude,
            ST_X(coords::geometry) AS longitude,
            altitude,
            accuracy,
            speed,
            heading,
            activity,
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
    accuracy: row.accuracy,
    speed: row.speed,
    heading: row.heading,
    activity: row.activity,
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
  group_id: string | null;
  group_name?: string | null;
  is_private?: boolean;
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
    groupName: row.group_name ?? null,
    isPrivate: Boolean(row.is_private),
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
    groupId: string | null;
    isPrivate?: boolean;
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    createdBy: string;
  },
): Promise<GroupPlace> {
  const isPrivate = Boolean(input.isPrivate || !input.groupId);
  const groupId = isPrivate ? null : input.groupId;
  const res = await pool.query<RawGroupPlaceRow>(
    `WITH inserted AS (
       INSERT INTO group_places (group_id, is_private, name, center, radius_meters, created_by)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7)
       RETURNING id, group_id, is_private, name,
                 ST_Y(center::geometry) AS latitude,
                 ST_X(center::geometry) AS longitude,
                 radius_meters, created_by, created_at
     )
     SELECT i.*, g.name AS group_name
     FROM inserted i
     LEFT JOIN groups g ON g.id = i.group_id`,
    [
      groupId,
      isPrivate,
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
    `SELECT gp.id, gp.group_id, g.name AS group_name, gp.is_private, gp.name,
            ST_Y(gp.center::geometry) AS latitude,
            ST_X(gp.center::geometry) AS longitude,
            gp.radius_meters, gp.created_by, gp.created_at
     FROM group_places gp
     LEFT JOIN groups g ON g.id = gp.group_id
     WHERE gp.group_id = $1 AND gp.is_private = FALSE
     ORDER BY gp.created_at ASC`,
    [groupId],
  );
  return res.rows.map(mapGroupPlaceRow);
}

export async function listPrivatePlaces(pool: pg.Pool, userId: string): Promise<GroupPlace[]> {
  const res = await pool.query<RawGroupPlaceRow>(
    `SELECT id, group_id, NULL::text AS group_name, is_private, name,
            ST_Y(center::geometry) AS latitude,
            ST_X(center::geometry) AS longitude,
            radius_meters, created_by, created_at
     FROM group_places
     WHERE created_by = $1 AND is_private = TRUE
     ORDER BY created_at ASC`,
    [userId],
  );
  return res.rows.map(mapGroupPlaceRow);
}

export async function listAccessiblePlaces(
  pool: pg.Pool,
  userId: string,
  groupId?: string,
): Promise<GroupPlace[]> {
  const params: unknown[] = [userId];
  const groupFilter = groupId
    ? (() => {
        params.push(groupId);
        return `gp.is_private = FALSE AND gp.group_id = $${params.length}`;
      })()
    : `gp.is_private = FALSE AND gp.group_id IN (SELECT group_id FROM group_memberships WHERE user_id = $1)`;

  const res = await pool.query<RawGroupPlaceRow>(
    `SELECT gp.id, gp.group_id, g.name AS group_name, gp.is_private, gp.name,
            ST_Y(gp.center::geometry) AS latitude,
            ST_X(gp.center::geometry) AS longitude,
            gp.radius_meters, gp.created_by, gp.created_at
     FROM group_places gp
     LEFT JOIN groups g ON g.id = gp.group_id
     WHERE (gp.is_private = TRUE AND gp.created_by = $1)
        OR (${groupFilter})
     ORDER BY gp.is_private DESC, gp.created_at ASC`,
    params,
  );
  return res.rows.map(mapGroupPlaceRow);
}

export async function findPlaceById(pool: pg.Pool, placeId: string): Promise<GroupPlace | null> {
  const res = await pool.query<RawGroupPlaceRow>(
    `SELECT gp.id, gp.group_id, g.name AS group_name, gp.is_private, gp.name,
            ST_Y(gp.center::geometry) AS latitude,
            ST_X(gp.center::geometry) AS longitude,
            gp.radius_meters, gp.created_by, gp.created_at
     FROM group_places gp
     LEFT JOIN groups g ON g.id = gp.group_id
     WHERE gp.id = $1
     LIMIT 1`,
    [placeId],
  );
  return res.rows[0] ? mapGroupPlaceRow(res.rows[0]) : null;
}

export async function deletePlaceById(pool: pg.Pool, placeId: string): Promise<boolean> {
  const res = await pool.query('DELETE FROM group_places WHERE id = $1', [placeId]);
  return (res.rowCount ?? 0) > 0;
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
     WHERE gp.group_id = $1 AND gp.is_private = FALSE`,
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

export interface StoredPushVapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface StoredPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function getOrCreatePushVapidConfig(
  pool: pg.Pool,
  generateKeys: () => StoredPushVapidConfig,
): Promise<StoredPushVapidConfig> {
  const existing = await pool.query<{
    public_key: string;
    private_key: string;
    subject: string;
  }>('SELECT public_key, private_key, subject FROM push_vapid_config WHERE id = 1 LIMIT 1');

  if (existing.rows[0]) {
    return {
      publicKey: existing.rows[0].public_key,
      privateKey: existing.rows[0].private_key,
      subject: existing.rows[0].subject,
    };
  }

  const fresh = generateKeys();
  await pool.query(
    `INSERT INTO push_vapid_config (id, public_key, private_key, subject)
     VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [fresh.publicKey, fresh.privateKey, fresh.subject],
  );

  const resolved = await pool.query<{
    public_key: string;
    private_key: string;
    subject: string;
  }>('SELECT public_key, private_key, subject FROM push_vapid_config WHERE id = 1 LIMIT 1');

  const row = resolved.rows[0];
  if (!row) {
    return fresh;
  }
  return {
    publicKey: row.public_key,
    privateKey: row.private_key,
    subject: row.subject,
  };
}

export async function upsertPushSubscription(
  pool: pg.Pool,
  input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, NOW())
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           updated_at = NOW()`,
    [input.userId, input.endpoint, input.p256dh, input.auth, input.userAgent ?? null],
  );
}

export async function deletePushSubscription(
  pool: pg.Pool,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const res = await pool.query(
    'DELETE FROM push_subscriptions WHERE user_id = $1::uuid AND endpoint = $2',
    [userId, endpoint],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deletePushSubscriptionByEndpoint(
  pool: pg.Pool,
  endpoint: string,
): Promise<void> {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

export async function listPushSubscriptionsForUsers(
  pool: pg.Pool,
  userIds: string[],
): Promise<StoredPushSubscription[]> {
  if (userIds.length === 0) return [];
  const res = await pool.query<{
    id: string;
    user_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    `SELECT id, user_id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE user_id = ANY($1::uuid[])`,
    [userIds],
  );
  return res.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
  }));
}

export async function listGroupMemberUserIds(
  pool: pg.Pool,
  groupId: string,
  excludeUserId?: string,
): Promise<string[]> {
  const res = await pool.query<{ user_id: string }>(
    excludeUserId
      ? 'SELECT user_id FROM group_memberships WHERE group_id = $1::uuid AND user_id <> $2::uuid'
      : 'SELECT user_id FROM group_memberships WHERE group_id = $1::uuid',
    excludeUserId ? [groupId, excludeUserId] : [groupId],
  );
  return res.rows.map((r) => r.user_id);
}

export interface StoredLocationShareLinkRow {
  token: string;
  userId: string;
  groupId: string;
  groupName: string;
  label: string | null;
  allowGuestSharing: boolean;
  activeGuestCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface StoredShareGuestRow {
  id: string;
  shareToken: string;
  guestSecret: string;
  displayName: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  updatedAt: string;
}

export async function createLocationShareLinkRecord(
  pool: pg.Pool,
  input: {
    token: string;
    userId: string;
    groupId: string;
    label: string | null;
    allowGuestSharing: boolean;
    expiresAt: Date;
    now: Date;
  },
): Promise<StoredLocationShareLinkRow> {
  await pool.query(
    `INSERT INTO location_share_links (token, user_id, group_id, label, allow_guest_sharing, expires_at, created_at)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
    [
      input.token,
      input.userId,
      input.groupId,
      input.label,
      input.allowGuestSharing,
      input.expiresAt,
      input.now,
    ],
  );
  const groupRes = await pool.query<{ name: string }>('SELECT name FROM groups WHERE id = $1::uuid', [
    input.groupId,
  ]);
  return {
    token: input.token,
    userId: input.userId,
    groupId: input.groupId,
    groupName: groupRes.rows[0]?.name ?? 'Group',
    label: input.label,
    allowGuestSharing: input.allowGuestSharing,
    activeGuestCount: 0,
    expiresAt: input.expiresAt.toISOString(),
    revokedAt: null,
    createdAt: input.now.toISOString(),
  };
}

export async function listActiveLocationShareLinksForUser(
  pool: pg.Pool,
  userId: string,
  now: Date,
  guestActiveWindowMs: number,
): Promise<StoredLocationShareLinkRow[]> {
  const cutoff = new Date(now.getTime() - guestActiveWindowMs);
  const res = await pool.query<{
    token: string;
    user_id: string;
    group_id: string;
    group_name: string;
    label: string | null;
    allow_guest_sharing: boolean;
    active_guest_count: string;
    expires_at: Date;
    revoked_at: Date | null;
    created_at: Date;
  }>(
    `SELECT l.token, l.user_id, l.group_id, g.name AS group_name, l.label, l.allow_guest_sharing,
            COUNT(sg.id) FILTER (WHERE sg.updated_at >= $3) AS active_guest_count,
            l.expires_at, l.revoked_at, l.created_at
     FROM location_share_links l
     INNER JOIN groups g ON g.id = l.group_id
     LEFT JOIN location_share_guests sg ON sg.share_token = l.token
     WHERE l.user_id = $1::uuid
       AND l.revoked_at IS NULL
       AND l.expires_at > $2
     GROUP BY l.token, g.name
     ORDER BY l.created_at DESC`,
    [userId, now, cutoff],
  );
  return res.rows.map((r) => ({
    token: r.token,
    userId: r.user_id,
    groupId: r.group_id,
    groupName: r.group_name,
    label: r.label,
    allowGuestSharing: r.allow_guest_sharing,
    activeGuestCount: Number.parseInt(r.active_guest_count, 10) || 0,
    expiresAt: r.expires_at.toISOString(),
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function getLocationShareLinkByToken(
  pool: pg.Pool,
  token: string,
): Promise<StoredLocationShareLinkRow | null> {
  const res = await pool.query<{
    token: string;
    user_id: string;
    group_id: string;
    group_name: string;
    label: string | null;
    allow_guest_sharing: boolean;
    expires_at: Date;
    revoked_at: Date | null;
    created_at: Date;
  }>(
    `SELECT l.token, l.user_id, l.group_id, g.name AS group_name, l.label, l.allow_guest_sharing,
            l.expires_at, l.revoked_at, l.created_at
     FROM location_share_links l
     INNER JOIN groups g ON g.id = l.group_id
     WHERE l.token = $1
     LIMIT 1`,
    [token],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    token: r.token,
    userId: r.user_id,
    groupId: r.group_id,
    groupName: r.group_name,
    label: r.label,
    allowGuestSharing: r.allow_guest_sharing,
    activeGuestCount: 0,
    expiresAt: r.expires_at.toISOString(),
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

export async function revokeLocationShareLinkRecord(
  pool: pg.Pool,
  userId: string,
  token: string,
  now: Date,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE location_share_links
     SET revoked_at = $3
     WHERE token = $1 AND user_id = $2::uuid AND revoked_at IS NULL`,
    [token, userId, now],
  );
  if ((res.rowCount ?? 0) > 0) {
    await pool.query('DELETE FROM location_share_guests WHERE share_token = $1', [token]);
    return true;
  }
  return false;
}

export async function listActiveShareGuests(
  pool: pg.Pool,
  shareToken: string,
  since: Date,
): Promise<StoredShareGuestRow[]> {
  const res = await pool.query<{
    id: string;
    share_token: string;
    guest_secret: string;
    display_name: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    updated_at: Date;
  }>(
    `SELECT id, share_token, guest_secret, display_name, latitude, longitude, accuracy, updated_at
     FROM location_share_guests
     WHERE share_token = $1 AND updated_at >= $2
     ORDER BY updated_at DESC`,
    [shareToken, since],
  );
  return res.rows.map((r) => ({
    id: r.id,
    shareToken: r.share_token,
    guestSecret: r.guest_secret,
    displayName: r.display_name,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracy: r.accuracy ?? null,
    updatedAt: r.updated_at.toISOString(),
  }));
}

export async function upsertShareGuestRecord(
  pool: pg.Pool,
  input: {
    id: string;
    shareToken: string;
    guestSecret: string;
    displayName: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    now: Date;
    staleCutoff: Date;
  },
): Promise<'inserted' | 'updated' | 'forbidden'> {
  // Prune stale guest entries for this link first
  await pool.query(
    'DELETE FROM location_share_guests WHERE share_token = $1 AND updated_at < $2',
    [input.shareToken, input.staleCutoff],
  );

  const existing = await pool.query<{ guest_secret: string }>(
    'SELECT guest_secret FROM location_share_guests WHERE id = $1::uuid AND share_token = $2 LIMIT 1',
    [input.id, input.shareToken],
  );

  if (existing.rows[0]) {
    if (existing.rows[0].guest_secret !== input.guestSecret) {
      return 'forbidden';
    }
    await pool.query(
      `UPDATE location_share_guests
       SET display_name = $3, latitude = $4, longitude = $5, accuracy = $6, updated_at = $7
       WHERE id = $1::uuid AND share_token = $2`,
      [
        input.id,
        input.shareToken,
        input.displayName,
        input.latitude,
        input.longitude,
        input.accuracy,
        input.now,
      ],
    );
    return 'updated';
  }

  await pool.query(
    `INSERT INTO location_share_guests (id, share_token, guest_secret, display_name, latitude, longitude, accuracy, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.shareToken,
      input.guestSecret,
      input.displayName,
      input.latitude,
      input.longitude,
      input.accuracy,
      input.now,
    ],
  );
  return 'inserted';
}

export async function deleteShareGuestRecord(
  pool: pg.Pool,
  input: { shareToken: string; guestId: string; guestSecret: string },
): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM location_share_guests
     WHERE id = $1::uuid AND share_token = $2 AND guest_secret = $3`,
    [input.guestId, input.shareToken, input.guestSecret],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface TrimmedLocationBatch {
  userId: string;
  username: string | null;
  deletedPoints: number;
  rangeStart: string;
  rangeEnd: string;
  scope: 'user_points' | 'user_storage' | 'global_database' | 'retention';
}

/**
 * Deletes location history rows older than `retentionDays` and returns per-user
 * summaries with deleted counts and timestamp bounds.
 */
export async function pruneLocationHistoryWithDetails(
  pool: pg.Pool,
  retentionDays: number,
): Promise<TrimmedLocationBatch[]> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return [];
  }
  const days = Math.floor(retentionDays);
  const res = await pool.query<{
    user_id: string;
    username: string | null;
    cnt: number;
    min_ts: Date;
    max_ts: Date;
  }>(
    `WITH deleted AS (
       DELETE FROM location_history
       WHERE recorded_at < NOW() - make_interval(days => $1)
       RETURNING user_id, recorded_at
     )
     SELECT d.user_id,
            u.username,
            COUNT(*)::int AS cnt,
            MIN(d.recorded_at) AS min_ts,
            MAX(d.recorded_at) AS max_ts
     FROM deleted d
     LEFT JOIN users u ON u.id = d.user_id
     GROUP BY d.user_id, u.username`,
    [days],
  );
  return res.rows
    .filter((r) => r.cnt > 0 && r.min_ts && r.max_ts)
    .map((r) => ({
      userId: r.user_id,
      username: r.username ?? null,
      deletedPoints: r.cnt,
      rangeStart: r.min_ts.toISOString(),
      rangeEnd: r.max_ts.toISOString(),
      scope: 'retention' as const,
    }));
}

/**
 * Deletes location history rows older than `retentionDays`.
 * Values <= 0 disable pruning and return 0.
 */
export async function pruneLocationHistory(
  pool: pg.Pool,
  retentionDays: number,
): Promise<number> {
  const details = await pruneLocationHistoryWithDetails(pool, retentionDays);
  return details.reduce((sum, item) => sum + item.deletedPoints, 0);
}

/**
 * Enforces Option A FIFO auto-trimming when per-user point/storage quotas or
 * the global database size ceiling are exceeded, returning exact deleted counts
 * and timestamp ranges per affected Account.
 */
export async function enforceLocationQuotas(
  pool: pg.Pool,
  options: {
    userId: string;
    perUserMaxPoints?: number;
    perUserMaxLocationBytes?: number;
    maxDatabaseBytes?: number;
    allowGlobalTrim?: boolean;
  },
): Promise<{ trims: TrimmedLocationBatch[]; globalTrimmed: boolean }> {
  const trims: TrimmedLocationBatch[] = [];
  let globalTrimmed = false;

  const userNameRes = await pool.query<{ username: string }>(
    'SELECT username FROM users WHERE id = $1::uuid LIMIT 1',
    [options.userId],
  );
  const targetUsername = userNameRes.rows[0]?.username ?? null;

  const maxPoints = Math.max(0, Math.floor(options.perUserMaxPoints ?? 0));
  if (maxPoints > 0) {
    const countRes = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM location_history WHERE user_id = $1::uuid',
      [options.userId],
    );
    const currentCount = countRes.rows[0]?.cnt ?? 0;
    const excess = currentCount - maxPoints;
    if (excess > 0) {
      const delRes = await pool.query<{ cnt: number; min_ts: Date | null; max_ts: Date | null }>(
        `WITH victim AS (
           SELECT id FROM location_history
           WHERE user_id = $1::uuid
           ORDER BY recorded_at ASC
           LIMIT $2
         ),
         deleted AS (
           DELETE FROM location_history lh
           USING victim v
           WHERE lh.id = v.id
           RETURNING lh.recorded_at
         )
         SELECT COUNT(*)::int AS cnt, MIN(recorded_at) AS min_ts, MAX(recorded_at) AS max_ts
         FROM deleted`,
        [options.userId, excess],
      );
      const row = delRes.rows[0];
      if (row && row.cnt > 0 && row.min_ts && row.max_ts) {
        trims.push({
          userId: options.userId,
          username: targetUsername,
          deletedPoints: row.cnt,
          rangeStart: row.min_ts.toISOString(),
          rangeEnd: row.max_ts.toISOString(),
          scope: 'user_points',
        });
      }
    }
  }

  const maxUserBytes = Math.max(0, Math.floor(options.perUserMaxLocationBytes ?? 0));
  if (maxUserBytes > 0) {
    const usageRes = await pool.query<{ cnt: number; bytes: string }>(
      `SELECT COUNT(*)::int AS cnt,
              COALESCE(SUM(pg_column_size(location_history.*)), 0)::text AS bytes
       FROM location_history
       WHERE user_id = $1::uuid`,
      [options.userId],
    );
    const cnt = usageRes.rows[0]?.cnt ?? 0;
    const usedBytes = Number.parseInt(usageRes.rows[0]?.bytes ?? '0', 10) || 0;
    if (cnt > 0 && usedBytes > maxUserBytes) {
      const avgBytesPerRow = Math.max(64, usedBytes / cnt);
      const rowsToDelete = Math.min(cnt, Math.max(1, Math.ceil((usedBytes - maxUserBytes) / avgBytesPerRow)));
      const delRes = await pool.query<{ cnt: number; min_ts: Date | null; max_ts: Date | null }>(
        `WITH victim AS (
           SELECT id FROM location_history
           WHERE user_id = $1::uuid
           ORDER BY recorded_at ASC
           LIMIT $2
         ),
         deleted AS (
           DELETE FROM location_history lh
           USING victim v
           WHERE lh.id = v.id
           RETURNING lh.recorded_at
         )
         SELECT COUNT(*)::int AS cnt, MIN(recorded_at) AS min_ts, MAX(recorded_at) AS max_ts
         FROM deleted`,
        [options.userId, rowsToDelete],
      );
      const row = delRes.rows[0];
      if (row && row.cnt > 0 && row.min_ts && row.max_ts) {
        trims.push({
          userId: options.userId,
          username: targetUsername,
          deletedPoints: row.cnt,
          rangeStart: row.min_ts.toISOString(),
          rangeEnd: row.max_ts.toISOString(),
          scope: 'user_storage',
        });
      }
    }
  }

  const maxDbBytes = Math.max(0, Math.floor(options.maxDatabaseBytes ?? 0));
  if (maxDbBytes > 0 && options.allowGlobalTrim !== false) {
    const dbRes = await pool.query<{ db_size: string; live_points: string }>(
      `SELECT pg_database_size(current_database())::text AS db_size,
              (SELECT COUNT(*)::text FROM location_history) AS live_points`,
    );
    const dbBytes = Number.parseInt(dbRes.rows[0]?.db_size ?? '0', 10) || 0;
    const livePoints = Number.parseInt(dbRes.rows[0]?.live_points ?? '0', 10) || 0;
    if (dbBytes > maxDbBytes && livePoints > 0) {
      const overage = dbBytes - maxDbBytes;
      const batchSize = Math.min(livePoints, 2000, Math.max(25, Math.ceil(overage / 160)));
      const delRes = await pool.query<{
        user_id: string;
        username: string | null;
        cnt: number;
        min_ts: Date;
        max_ts: Date;
      }>(
        `WITH victim AS (
           SELECT id FROM location_history
           ORDER BY recorded_at ASC
           LIMIT $1
         ),
         deleted AS (
           DELETE FROM location_history lh
           USING victim v
           WHERE lh.id = v.id
           RETURNING lh.user_id, lh.recorded_at
         )
         SELECT d.user_id,
                u.username,
                COUNT(*)::int AS cnt,
                MIN(d.recorded_at) AS min_ts,
                MAX(d.recorded_at) AS max_ts
         FROM deleted d
         LEFT JOIN users u ON u.id = d.user_id
         GROUP BY d.user_id, u.username`,
        [batchSize],
      );
      for (const row of delRes.rows) {
        if (row.cnt > 0 && row.min_ts && row.max_ts) {
          globalTrimmed = true;
          trims.push({
            userId: row.user_id,
            username: row.username ?? null,
            deletedPoints: row.cnt,
            rangeStart: row.min_ts.toISOString(),
            rangeEnd: row.max_ts.toISOString(),
            scope: 'global_database',
          });
        }
      }
    }
  }

  return { trims, globalTrimmed };
}

export async function pruneResourceTables(
  pool: pg.Pool,
  options: {
    locationRetentionDays?: number;
    messageRetentionDays?: number;
    placeEventRetentionDays?: number;
    resolvedRequestRetentionDays?: number;
    vacuum?: boolean;
  },
): Promise<{
  locationTrims: TrimmedLocationBatch[];
  deletedLocations: number;
  deletedMessages: number;
  deletedPlaceEvents: number;
  deletedLocationRequests: number;
  deletedRegistrationRequests: number;
  vacuumed: boolean;
}> {
  const locationTrims = await pruneLocationHistoryWithDetails(
    pool,
    options.locationRetentionDays ?? 0,
  );
  const deletedLocations = locationTrims.reduce((sum, t) => sum + t.deletedPoints, 0);

  let deletedMessages = 0;
  if ((options.messageRetentionDays ?? 0) > 0) {
    const res = await pool.query(
      `DELETE FROM messages WHERE created_at < NOW() - make_interval(days => $1)`,
      [Math.floor(options.messageRetentionDays!)],
    );
    deletedMessages = res.rowCount ?? 0;
  }

  let deletedPlaceEvents = 0;
  if ((options.placeEventRetentionDays ?? 0) > 0) {
    const res = await pool.query(
      `DELETE FROM group_place_events WHERE created_at < NOW() - make_interval(days => $1)`,
      [Math.floor(options.placeEventRetentionDays!)],
    );
    deletedPlaceEvents = res.rowCount ?? 0;
  }

  let deletedLocationRequests = 0;
  let deletedRegistrationRequests = 0;
  if ((options.resolvedRequestRetentionDays ?? 0) > 0) {
    const reqDays = Math.floor(options.resolvedRequestRetentionDays!);
    const [locReqRes, regReqRes] = await Promise.all([
      pool.query(
        `DELETE FROM location_requests
         WHERE status <> 'pending'
           AND created_at < NOW() - make_interval(days => $1)`,
        [reqDays],
      ),
      pool.query(
        `DELETE FROM registration_requests
         WHERE status IN ('DENIED', 'EXPIRED')
           AND created_at < NOW() - make_interval(days => $1)`,
        [reqDays],
      ),
    ]);
    deletedLocationRequests = locReqRes.rowCount ?? 0;
    deletedRegistrationRequests = regReqRes.rowCount ?? 0;
  }

  let vacuumed = false;
  if (options.vacuum) {
    await pool.query(
      'VACUUM (ANALYZE) location_history, messages, group_place_events, location_requests, registration_requests',
    );
    vacuumed = true;
  }

  return {
    locationTrims,
    deletedLocations,
    deletedMessages,
    deletedPlaceEvents,
    deletedLocationRequests,
    deletedRegistrationRequests,
    vacuumed,
  };
}

/**
 * Removes expired or revoked guest share links past the grace window (cascading to
 * their guests) plus stale guest ping rows older than `guestActiveWindowMs`.
 */
export async function pruneExpiredShareLinks(
  pool: pg.Pool,
  options?: { graceHours?: number; guestActiveWindowMs?: number },
): Promise<{ deletedLinks: number; deletedGuests: number }> {
  const graceHours = Math.max(0, Math.floor(options?.graceHours ?? 24));
  const guestActiveWindowMs = Math.max(60_000, Math.floor(options?.guestActiveWindowMs ?? 5 * 60 * 1000));
  const guestCutoff = new Date(Date.now() - guestActiveWindowMs);

  const linksRes = await pool.query(
    `DELETE FROM location_share_links
     WHERE expires_at < NOW() - make_interval(hours => $1)
        OR (revoked_at IS NOT NULL AND revoked_at < NOW() - make_interval(hours => $1))`,
    [graceHours],
  );
  const guestsRes = await pool.query(
    `DELETE FROM location_share_guests
     WHERE updated_at < $1`,
    [guestCutoff],
  );

  return {
    deletedLinks: linksRes.rowCount ?? 0,
    deletedGuests: guestsRes.rowCount ?? 0,
  };
}

export async function countUsers(pool: pg.Pool): Promise<number> {
  const res = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  return Number.parseInt(res.rows[0]?.count ?? '0', 10) || 0;
}

export async function getServerSetting(pool: pg.Pool, key: string): Promise<string | null> {
  const res = await pool.query<{ value: string | null }>(
    'SELECT value FROM server_settings WHERE key = $1 LIMIT 1',
    [key],
  );
  return res.rows[0]?.value ?? null;
}

export async function setServerSetting(
  pool: pg.Pool,
  key: string,
  value: string | null,
  updatedBy?: string | null,
): Promise<void> {
  if (value === null) {
    await pool.query('DELETE FROM server_settings WHERE key = $1', [key]);
    return;
  }
  await pool.query(
    `INSERT INTO server_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, value, updatedBy ?? null],
  );
}
