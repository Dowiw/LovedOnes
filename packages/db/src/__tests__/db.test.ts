import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  createPool,
  deduplicateLocationPoints,
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

  it('deduplicates intra-batch points and performs idempotent bulk UNNEST upserts on retry', async () => {
    const t1 = '2026-11-18T12:00:00.000Z';
    const t1Equivalent = '2026-11-18T12:00:00.000+00:00';
    const t2 = '2026-11-18T12:01:00.000Z';

    const deduped = deduplicateLocationPoints([
      { latitude: 52.52, longitude: 13.405, recordedAt: t1 },
      { latitude: 52.5201, longitude: 13.4051, recordedAt: t1Equivalent },
      { latitude: 52.53, longitude: 13.41, recordedAt: t2 },
    ]);
    expect(deduped).toHaveLength(2);

    const email = `dbdedup-${Date.now()}@example.com`;
    const userRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, 'deduptester', 'hash', 'USER')
       RETURNING id`,
      [email],
    );
    const userId = userRes.rows[0].id;

    try {
      const batch = [
        { latitude: 52.52, longitude: 13.405, batteryLevel: 85, recordedAt: t1 },
        { latitude: 52.52, longitude: 13.405, batteryLevel: 85, recordedAt: t1Equivalent },
        { latitude: 52.53, longitude: 13.41, batteryLevel: 84, recordedAt: t2 },
      ];

      // First batch insert: 2 unique timestamps inserted
      const firstInsertCount = await insertLocationBatch(pool, userId, batch);
      expect(firstInsertCount).toBe(2);

      // Exact retry of the same batch: 0 newly inserted rows (idempotent)
      const retryInsertCount = await insertLocationBatch(pool, userId, batch);
      expect(retryInsertCount).toBe(0);

      // Partial overlap batch (t2 already exists, t3 is new): only 1 inserted
      const t3 = '2026-11-18T12:02:00.000Z';
      const partialRetryCount = await insertLocationBatch(pool, userId, [
        { latitude: 52.53, longitude: 13.41, recordedAt: t2 },
        { latitude: 52.54, longitude: 13.42, recordedAt: t3 },
      ]);
      expect(partialRetryCount).toBe(1);

      const countRes = await pool.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM location_history WHERE user_id = $1',
        [userId],
      );
      expect(countRes.rows[0].cnt).toBe(3);
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });
});
