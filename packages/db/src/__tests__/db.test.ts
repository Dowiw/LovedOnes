import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  createPool,
  getDatabaseTelemetry,
  getLatestGroupLocations,
  insertLocationBatch,
  runMigrations,
} from '../index.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/lovedones';

describe('@loved-ones/db PostGIS integration', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('inserts PostGIS geography points and retrieves latest group locations & telemetry', async () => {
    const email = `dbtest-${Date.now()}@example.com`;
    const userRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, 'dbtester', 'hash', 'USER')
       RETURNING id`,
      [email],
    );
    const userId = userRes.rows[0].id;

    const groupRes = await pool.query<{ id: string }>(
      `INSERT INTO groups (name, created_by) VALUES ('DB Test Group', $1) RETURNING id`,
      [userId],
    );
    const groupId = groupRes.rows[0].id;

    await pool.query(
      `INSERT INTO group_memberships (user_id, group_id, role, privacy)
       VALUES ($1, $2, 'ADMIN', 'EXACT')`,
      [userId, groupId],
    );

    const inserted = await insertLocationBatch(pool, userId, [
      {
        latitude: 37.7749,
        longitude: -122.4194,
        altitude: 15,
        speed: 1.5,
        batteryLevel: 92,
        recordedAt: new Date().toISOString(),
      },
    ]);
    expect(inserted).toBe(1);

    const latest = await getLatestGroupLocations(pool, groupId);
    expect(latest.length).toBe(1);
    expect(latest[0].latitude).toBeCloseTo(37.7749, 4);
    expect(latest[0].longitude).toBeCloseTo(-122.4194, 4);

    const telemetry = await getDatabaseTelemetry(pool);
    expect(telemetry.databaseBytes).toBeGreaterThan(0);
    const tracked = telemetry.users.find((u) => u.userId === userId);
    expect(tracked).toBeDefined();
    expect(tracked!.locationPoints).toBeGreaterThanOrEqual(1);
    expect(tracked!.locationBytes).toBeGreaterThan(0);

    // Clean up test rows
    await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });
});
