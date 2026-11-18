import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { GroupRole, LocationPoint, PrivacyMode, SystemRole } from '@loved-ones/shared';
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
  role: GroupRole;
  privacy: PrivacyMode;
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  batteryLevel: number | null;
  recordedAt: string;
}

export async function getLatestGroupLocations(
  pool: pg.Pool,
  groupId: string,
): Promise<GroupMemberLocationRow[]> {
  const result = await pool.query<{
    user_id: string;
    username: string;
    role: GroupRole;
    privacy: PrivacyMode;
    latitude: number;
    longitude: number;
    altitude: number | null;
    speed: number | null;
    battery_level: number | null;
    recorded_at: Date;
  }>(
    `SELECT DISTINCT ON (gm.user_id)
       gm.user_id,
       u.username,
       gm.role,
       gm.privacy,
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
    [groupId],
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    role: row.role,
    privacy: row.privacy,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    altitude: row.altitude,
    speed: row.speed,
    batteryLevel: row.battery_level,
    recordedAt: row.recorded_at.toISOString(),
  }));
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
