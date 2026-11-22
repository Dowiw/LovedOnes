import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  createGroupPlaceRecord,
  createLocationRequestRecord,
  createPool,
  deduplicateLocationPoints,
  deleteGroupPlaceRecord,
  enforceLocationQuotas,
  evaluateAndRecordPlaceTransitions,
  getDatabaseTelemetry,
  getGroupMembershipPrivacyInfo,
  getGroupTrails,
  getLatestGroupLocations,
  insertLocationBatch,
  listLocationRequestsForUser,
  listRecentPlaceTransitions,
  pruneLocationHistory,
  pruneResourceTables,
  resolvePoolSslConfig,
  respondToLocationRequestRecord,
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

  it('filters historical group trails by PostGIS bounding box, time window, and privacy/role rules', async () => {
    const suffix = Date.now();
    const visibleRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, 'trail-visible', 'hash', 'USER') RETURNING id`,
      [`trail-v-${suffix}@example.com`],
    );
    const ghostRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, 'trail-ghost', 'hash', 'USER') RETURNING id`,
      [`trail-g-${suffix}@example.com`],
    );
    const visibleId = visibleRes.rows[0].id;
    const ghostId = ghostRes.rows[0].id;

    const groupRes = await pool.query<{ id: string }>(
      `INSERT INTO groups (name, created_by) VALUES ('Trail Test Group', $1) RETURNING id`,
      [visibleId],
    );
    const groupId = groupRes.rows[0].id;

    try {
      await pool.query(
        `INSERT INTO group_memberships (user_id, group_id, role, privacy)
         VALUES ($1, $2, 'ADMIN', 'EXACT'), ($3, $2, 'MEMBER', 'GHOST')`,
        [visibleId, groupId, ghostId],
      );

      // Two Berlin points (one inside window, one outside window) + one Munich point (outside Berlin bbox)
      await insertLocationBatch(pool, visibleId, [
        { latitude: 52.52, longitude: 13.405, recordedAt: '2026-11-19T08:00:00.000Z' },
        {
          latitude: 52.522,
          longitude: 13.41,
          accuracy: 11.5,
          heading: 184,
          recordedAt: '2026-11-19T10:30:00.000Z',
        },
        { latitude: 48.1351, longitude: 11.582, recordedAt: '2026-11-19T11:00:00.000Z' },
      ]);
      // Ghost point inside Berlin bbox & time window must be excluded in SQL
      await insertLocationBatch(pool, ghostId, [
        { latitude: 52.521, longitude: 13.406, recordedAt: '2026-11-19T10:45:00.000Z' },
      ]);

      const trails = await getGroupTrails(pool, {
        groupId,
        from: new Date('2026-11-19T10:00:00.000Z'),
        to: new Date('2026-11-19T12:00:00.000Z'),
        bbox: { minLon: 13.0, minLat: 52.3, maxLon: 13.8, maxLat: 52.7 },
      });

      expect(trails).toHaveLength(1);
      expect(trails[0].userId).toBe(visibleId);
      expect(trails[0].recordedAt).toBe('2026-11-19T10:30:00.000Z');
      expect(trails[0].accuracy).toBe(11.5);
      expect(trails[0].heading).toBe(184);
    } finally {
      await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[visibleId, ghostId]]);
    }
  });

  it('handles expiring location check-in overrides and ST_DWithin geofence enter/exit transitions', async () => {
    const suffix = Date.now();
    const adminRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, 'gf-admin', 'hash', 'USER') RETURNING id`,
      [`gf-admin-${suffix}@example.com`],
    );
    const bobRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, 'gf-bob', 'hash', 'USER') RETURNING id`,
      [`gf-bob-${suffix}@example.com`],
    );
    const adminId = adminRes.rows[0].id;
    const bobId = bobRes.rows[0].id;

    const groupRes = await pool.query<{ id: string }>(
      `INSERT INTO groups (name, created_by) VALUES ('Geofence Group', $1) RETURNING id`,
      [adminId],
    );
    const groupId = groupRes.rows[0].id;

    try {
      await pool.query(
        `INSERT INTO group_memberships (user_id, group_id, role, privacy)
         VALUES ($1, $2, 'ADMIN', 'EXACT'), ($3, $2, 'MEMBER', 'GHOST')`,
        [adminId, groupId, bobId],
      );

      const tBase = new Date('2026-11-19T12:00:00.000Z');
      await insertLocationBatch(pool, bobId, [
        { latitude: 52.52, longitude: 13.405, recordedAt: tBase.toISOString() },
      ]);

      // Before override, Bob is GHOST in DB (still returned as GHOST from getLatestGroupLocations)
      const initialLatest = await getLatestGroupLocations(pool, groupId, tBase);
      expect(initialLatest.find((r) => r.userId === bobId)?.privacy).toBe('GHOST');

      // 1. Admin creates check-in request that expires at tBase + 10m; test expiration first
      const expiredReq = await createLocationRequestRecord(pool, {
        groupId,
        requesterId: adminId,
        targetUserId: bobId,
        suggestedDurationMinutes: 15,
        expiresAt: new Date(tBase.getTime() + 10 * 60_000),
        message: 'Check in?',
        now: tBase,
      });
      const lateRespond = await respondToLocationRequestRecord(pool, {
        groupId,
        requestId: expiredReq.id,
        responderUserId: bobId,
        action: 'accept',
        now: new Date(tBase.getTime() + 11 * 60_000),
      });
      expect(lateRespond.kind).toBe('expired');

      // 2. Fresh request accepted -> temporary EXACT override for 15 minutes
      const activeReq = await createLocationRequestRecord(pool, {
        groupId,
        requesterId: adminId,
        targetUserId: bobId,
        suggestedDurationMinutes: 15,
        expiresAt: new Date(tBase.getTime() + 10 * 60_000),
        now: tBase,
      });
      const accepted = await respondToLocationRequestRecord(pool, {
        groupId,
        requestId: activeReq.id,
        responderUserId: bobId,
        action: 'accept',
        now: tBase,
      });
      expect(accepted.kind).toBe('ok');

      // During override (tBase + 5m), effective privacy is EXACT
      const midOverride = new Date(tBase.getTime() + 5 * 60_000);
      expect(
        (await getGroupMembershipPrivacyInfo(pool, bobId, groupId, midOverride))?.effectivePrivacy,
      ).toBe('EXACT');
      expect(
        (await getLatestGroupLocations(pool, groupId, midOverride)).find((r) => r.userId === bobId)
          ?.privacy,
      ).toBe('EXACT');

      // After override (tBase + 16m), reverts automatically to baseline GHOST
      const afterOverride = new Date(tBase.getTime() + 16 * 60_000);
      expect(
        (await getGroupMembershipPrivacyInfo(pool, bobId, groupId, afterOverride))
          ?.effectivePrivacy,
      ).toBe('GHOST');
      expect(
        (await getLatestGroupLocations(pool, groupId, afterOverride)).find((r) => r.userId === bobId)
          ?.privacy,
      ).toBe('GHOST');

      const listReqs = await listLocationRequestsForUser(pool, groupId, bobId, tBase);
      expect(listReqs.map((r) => r.status)).toContain('accepted');
      expect(listReqs.map((r) => r.status)).toContain('expired');

      // 3. ST_DWithin geofenced group place enter/exit detection
      const home = await createGroupPlaceRecord(pool, {
        groupId,
        name: 'Home',
        latitude: 52.52,
        longitude: 13.405,
        radiusMeters: 200,
        createdBy: adminId,
      });

      // Initially outside (~5 km away) -> initializes outside quietly, 0 transitions
      expect(
        await evaluateAndRecordPlaceTransitions(pool, {
          groupId,
          userId: adminId,
          username: 'gf-admin',
          latitude: 52.56,
          longitude: 13.405,
          recordedAt: '2026-11-19T12:00:00.000Z',
        }),
      ).toHaveLength(0);

      // Moves inside (50 m from center) -> emits enter
      const entered = await evaluateAndRecordPlaceTransitions(pool, {
        groupId,
        userId: adminId,
        username: 'gf-admin',
        latitude: 52.5203,
        longitude: 13.405,
        recordedAt: '2026-11-19T12:05:00.000Z',
      });
      expect(entered).toHaveLength(1);
      expect(entered[0].transition).toBe('enter');
      expect(entered[0].placeName).toBe('Home');

      // Staying inside -> 0 duplicate transitions
      expect(
        await evaluateAndRecordPlaceTransitions(pool, {
          groupId,
          userId: adminId,
          username: 'gf-admin',
          latitude: 52.5204,
          longitude: 13.4051,
          recordedAt: '2026-11-19T12:06:00.000Z',
        }),
      ).toHaveLength(0);

      // Moves outside (~1 km away) -> emits exit
      const exited = await evaluateAndRecordPlaceTransitions(pool, {
        groupId,
        userId: adminId,
        username: 'gf-admin',
        latitude: 52.53,
        longitude: 13.405,
        recordedAt: '2026-11-19T12:10:00.000Z',
      });
      expect(exited).toHaveLength(1);
      expect(exited[0].transition).toBe('exit');

      const recentEvents = await listRecentPlaceTransitions(pool, groupId);
      expect(recentEvents).toHaveLength(2);
      expect(await deleteGroupPlaceRecord(pool, groupId, home.id)).toBe(true);
    } finally {
      await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[adminId, bobId]]);
    }
  });

  it('resolves pool SSL configs and prunes stale location_history rows', async () => {
    await Promise.all([runMigrations(pool), runMigrations(pool)]);
    expect(resolvePoolSslConfig('postgresql://user:pass@localhost:5432/db')).toBeUndefined();
    expect(resolvePoolSslConfig('postgresql://user:pass@db.example.com:5432/db', 'require')).toEqual({
      rejectUnauthorized: true,
    });
    expect(
      resolvePoolSslConfig('postgresql://user:pass@db.example.com:5432/db?sslmode=no-verify'),
    ).toEqual({ rejectUnauthorized: false });

    const email = `retention-${Date.now()}@example.com`;
    const userRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, 'retention-tester', 'hash', 'USER')
       RETURNING id`,
      [email],
    );
    const userId = userRes.rows[0].id;
    try {
      const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
      const recentDate = new Date().toISOString();
      await insertLocationBatch(pool, userId, [
        { latitude: 52.5, longitude: 13.4, recordedAt: oldDate },
        { latitude: 52.51, longitude: 13.41, recordedAt: recentDate },
      ]);
      const deleted = await pruneLocationHistory(pool, 30);
      expect(deleted).toBeGreaterThanOrEqual(1);
      const remaining = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM location_history WHERE user_id = $1',
        [userId],
      );
      expect(Number(remaining.rows[0].count)).toBe(1);

      // Verify FIFO quota enforcement returns exact deleted count and timestamp bounds
      const t1 = '2026-11-20T10:00:00.000Z';
      const t2 = '2026-11-20T10:05:00.000Z';
      const t3 = '2026-11-20T10:10:00.000Z';
      await insertLocationBatch(pool, userId, [
        { latitude: 52.52, longitude: 13.42, recordedAt: t1 },
        { latitude: 52.53, longitude: 13.43, recordedAt: t2 },
        { latitude: 52.54, longitude: 13.44, recordedAt: t3 },
      ]);
      const quotaRes = await enforceLocationQuotas(pool, {
        userId,
        perUserMaxPoints: 2,
      });
      expect(quotaRes.trims).toHaveLength(1);
      expect(quotaRes.trims[0].deletedPoints).toBe(2);
      expect(quotaRes.trims[0].scope).toBe('user_points');
      expect(new Date(quotaRes.trims[0].rangeEnd).getTime()).toBeLessThanOrEqual(
        new Date(t2).getTime(),
      );

      const telemetryAfter = await getDatabaseTelemetry(pool);
      expect(telemetryAfter.breakdown).toBeDefined();
      expect(telemetryAfter.breakdown!.tables.length).toBeGreaterThan(0);

      const pruned = await pruneResourceTables(pool, {
        locationRetentionDays: 0,
        resolvedRequestRetentionDays: 30,
      });
      expect(pruned.deletedLocations).toBe(0);
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });
});
