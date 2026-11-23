import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createAuthAdminServer } from '../index.js';

const BASE_PG_URL = 'postgresql://postgres:postgres@localhost:5432';
const TEST_DB_NAME = 'lovedones_test_maps';
const TEST_DB_URL = `${BASE_PG_URL}/${TEST_DB_NAME}`;
const TEST_REDIS_URL = 'redis://localhost:6379/2';

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return bytes;
}

/**
 * Builds a minimal valid PMTiles v3 binary archive with a single uncompressed
 * MVT tile at z=0, x=0, y=0 covering the supplied bounding box.
 */
function buildSingleTilePmtiles(params: {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  tilePayload: Buffer;
}): Buffer {
  // 1-entry root directory (numEntries=1, delta=0, runLen=1, len=tilePayload.length, offset=1 -> 0 + 1)
  const dir = Buffer.from([
    ...encodeVarint(1),
    ...encodeVarint(0),
    ...encodeVarint(1),
    ...encodeVarint(params.tilePayload.length),
    ...encodeVarint(1),
  ]);
  const meta = Buffer.from(JSON.stringify({ vector_layers: [{ id: 'roads' }] }), 'utf8');

  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);

  const rootOffset = 127n;
  const metaOffset = rootOffset + BigInt(dir.length);
  const tileDataOffset = metaOffset + BigInt(meta.length);

  header.writeBigUInt64LE(rootOffset, 8);
  header.writeBigUInt64LE(BigInt(dir.length), 16);
  header.writeBigUInt64LE(metaOffset, 24);
  header.writeBigUInt64LE(BigInt(meta.length), 32);
  header.writeBigUInt64LE(tileDataOffset, 40);
  header.writeBigUInt64LE(0n, 48);
  header.writeBigUInt64LE(tileDataOffset, 56);
  header.writeBigUInt64LE(BigInt(params.tilePayload.length), 64);
  header.writeBigUInt64LE(1n, 72); // numAddressedTiles
  header.writeBigUInt64LE(1n, 80); // numTileEntries
  header.writeBigUInt64LE(1n, 88); // numTileContents
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(1, 97); // internalCompression = None
  header.writeUInt8(1, 98); // tileCompression = None
  header.writeUInt8(1, 99); // tileType = MVT
  header.writeUInt8(0, 100); // minZoom
  header.writeUInt8(15, 101); // maxZoom

  header.writeInt32LE(Math.round(params.minLon * 10_000_000), 102);
  header.writeInt32LE(Math.round(params.minLat * 10_000_000), 106);
  header.writeInt32LE(Math.round(params.maxLon * 10_000_000), 110);
  header.writeInt32LE(Math.round(params.maxLat * 10_000_000), 114);
  header.writeUInt8(12, 118);
  header.writeInt32LE(Math.round(((params.minLon + params.maxLon) / 2) * 10_000_000), 119);
  header.writeInt32LE(Math.round(((params.minLat + params.maxLat) / 2) * 10_000_000), 123);

  return Buffer.concat([header, dir, meta, params.tilePayload]);
}

async function recreateTestDatabase(dbName: string): Promise<void> {
  const adminPool = new pg.Pool({ connectionString: `${BASE_PG_URL}/postgres` });
  try {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await adminPool.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await adminPool.end();
  }
}

describe('@loved-ones/auth-admin-service map regions', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let tilesDir: string;
  let extractCalls = 0;

  beforeAll(async () => {
    await recreateTestDatabase(TEST_DB_NAME);
    const flushRedis = new Redis(TEST_REDIS_URL);
    await flushRedis.flushdb();
    await flushRedis.quit();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovedones-maps-test-'));
    tilesDir = path.join(tmpDir, 'tiles');
    fs.mkdirSync(tilesDir, { recursive: true });

    // Primary stub covering Berlin only (actually non-stub small Berlin box for coverage check)
    fs.writeFileSync(
      path.join(tilesDir, 'region.pmtiles'),
      buildSingleTilePmtiles({
        minLon: 13.2,
        minLat: 52.4,
        maxLon: 13.65,
        maxLat: 52.6,
        tilePayload: Buffer.from('berlin-tile'),
      }),
    );

    const created = await createAuthAdminServer({
      databaseUrl: TEST_DB_URL,
      redisUrl: TEST_REDIS_URL,
      logDir: path.join(tmpDir, 'logs'),
      disableFileLog: true,
      disableRedisLog: true,
      mapRegions: {
        tilesDir,
        allowMemberDownloads: true,
        cityResolver: {
          async resolve(lat, lon) {
            return {
              cityName: 'Paris',
              displayName: 'Paris, FR',
              countryCode: 'FR',
              bbox: [lon - 0.15, lat - 0.12, lon + 0.15, lat + 0.12],
            };
          },
        },
        tileExtractor: {
          async extract(ctx) {
            extractCalls += 1;
            ctx.onProgress?.(60, 'Extracting Paris tiles...');
            const archive = buildSingleTilePmtiles({
              minLon: ctx.bbox[0],
              minLat: ctx.bbox[1],
              maxLon: ctx.bbox[2],
              maxLat: ctx.bbox[3],
              tilePayload: Buffer.from('paris-mock-mvt'),
            });
            fs.writeFileSync(ctx.outputPath, archive);
            return { sourceBuild: '20261118.pmtiles' };
          },
        },
      },
    });
    app = created.app;
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const adminPool = new pg.Pool({ connectionString: `${BASE_PG_URL}/postgres` });
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB_NAME],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.end();
  });

  it('downloads missing city PMTiles for authenticated members, deduplicates requests, serves composite tiles, and allows Host Admin cleanup', async () => {
    // Register Host Admin + standard member
    const adminReg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'host@lovedones.test',
        username: 'Host',
        password: 'SuperSecretPassword123',
      },
    });
    const adminToken = adminReg.json().accessToken as string;

    const memberReq = await app.inject({
      method: 'POST',
      url: '/api/auth/registration-requests',
      headers: { 'x-forwarded-for': '203.0.113.41' },
      payload: {
        email: 'member@lovedones.test',
        username: 'Member',
        password: 'SuperSecretPassword123',
      },
    });
    expect(memberReq.statusCode).toBe(201);
    const approveMember = await app.inject({
      method: 'POST',
      url: `/api/admin/registration-requests/${memberReq.json().request.id}/approve`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(approveMember.statusCode).toBe(200);
    const memberLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'member@lovedones.test',
        password: 'SuperSecretPassword123',
      },
    });
    const memberToken = memberLogin.json().accessToken as string;

    // Initial regions list includes only primary Berlin region
    const initialRes = await app.inject({ method: 'GET', url: '/api/maps/regions' });
    expect(initialRes.statusCode).toBe(200);
    expect(initialRes.json().regions).toHaveLength(1);
    expect(initialRes.json().regions[0].id).toBe('primary-region');

    // Request inside Berlin -> alreadyCovered: true without triggering extraction
    const coveredRes = await app.inject({
      method: 'POST',
      url: '/api/maps/download',
      headers: { Authorization: `Bearer ${memberToken}` },
      payload: { latitude: 52.52, longitude: 13.405 },
    });
    expect(coveredRes.statusCode).toBe(200);
    expect(coveredRes.json().alreadyCovered).toBe(true);
    expect(extractCalls).toBe(0);

    // Concurrent requests for uncovered Paris coordinates -> deduplicated single job
    const [req1, req2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/maps/download',
        headers: { Authorization: `Bearer ${memberToken}` },
        payload: { latitude: 48.8566, longitude: 2.3522 },
      }),
      app.inject({
        method: 'POST',
        url: '/api/maps/download',
        headers: { Authorization: `Bearer ${memberToken}` },
        payload: { latitude: 48.857, longitude: 2.353 },
      }),
    ]);
    expect(req1.statusCode).toBe(202);
    expect(req2.statusCode).toBe(202);
    const jobId = req1.json().job.id as string;
    expect(req2.json().job.id).toBe(jobId);

    // Poll until extraction finishes
    let finalJob: { status: string; regionId: string | null } | null = null;
    for (let i = 0; i < 30; i += 1) {
      const jobRes = await app.inject({
        method: 'GET',
        url: `/api/maps/jobs/${jobId}`,
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      finalJob = jobRes.json().job;
      if (finalJob?.status === 'completed' || finalJob?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(finalJob?.status).toBe('completed');
    expect(finalJob?.regionId).toBeTruthy();
    expect(extractCalls).toBe(1);

    // Updated regions list includes the extracted Paris archive
    const updatedRes = await app.inject({ method: 'GET', url: '/api/maps/regions' });
    const updatedRegions = updatedRes.json().regions as Array<{ id: string; name: string }>;
    expect(updatedRegions).toHaveLength(2);
    const parisRegion = updatedRegions.find((r) => r.name === 'Paris');
    expect(parisRegion).toBeDefined();

    // Composite tile endpoint serves vector tile data for z=0
    const tileRes = await app.inject({ method: 'GET', url: '/api/maps/tiles/0/0/0.pbf' });
    expect(tileRes.statusCode).toBe(200);
    expect(tileRes.headers['content-type']).toBe('application/x-protobuf');

    // Non-admin cannot delete region
    const forbiddenDel = await app.inject({
      method: 'DELETE',
      url: `/api/maps/regions/${parisRegion!.id}`,
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(forbiddenDel.statusCode).toBe(403);

    // Host Admin can delete downloaded city extract cleanly
    const adminDel = await app.inject({
      method: 'DELETE',
      url: `/api/maps/regions/${parisRegion!.id}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(adminDel.statusCode).toBe(200);
    expect(adminDel.json()).toEqual({ deleted: true, id: parisRegion!.id });

    // Primary bundled region is protected
    const primaryDel = await app.inject({
      method: 'DELETE',
      url: '/api/maps/regions/primary-region',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(primaryDel.statusCode).toBe(400);
  });
});
