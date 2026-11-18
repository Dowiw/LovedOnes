import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPrivacyFuzzing,
  LocationBatchSchema,
  normalizeOverlandToPoints,
  normalizeOwnTracksToPoints,
  normalizePrivacyMode,
  QrInvitePayloadSchema,
} from '../index.js';
import { createServiceLogger } from '../logger.js';
import {
  createTokenService,
  extractBearerToken,
  extractIngestionToken,
} from '../auth.js';

describe('@loved-ones/shared', () => {
  it('validates QR invite payloads', () => {
    const parsed = QrInvitePayloadSchema.parse({
      v: 1,
      serverUrl: 'https://track.example.com',
      inviteToken: 'inv_9f8a7d6c5b4a3f2e1d',
      groupName: 'Family Group',
    });
    expect(parsed.v).toBe(1);
    expect(parsed.inviteToken).toBe('inv_9f8a7d6c5b4a3f2e1d');
  });

  it('normalizes legacy and spec privacy modes', () => {
    expect(normalizePrivacyMode('ACTIVE')).toBe('EXACT');
    expect(normalizePrivacyMode('FUZZED_1KM')).toBe('FUZZED');
    expect(normalizePrivacyMode('GHOST')).toBe('GHOST');
  });

  it('applies privacy fuzzing accurately', () => {
    const exact = applyPrivacyFuzzing(37.7749, -122.4194, 'EXACT', 'u1');
    expect(exact).toEqual({
      visible: true,
      latitude: 37.7749,
      longitude: -122.4194,
      isFuzzed: false,
    });

    const fuzzed1 = applyPrivacyFuzzing(37.7749, -122.4194, 'FUZZED', 'u1', 1_700_000_000_000);
    const fuzzed2 = applyPrivacyFuzzing(37.7749, -122.4194, 'FUZZED', 'u1', 1_700_000_000_000);
    expect(fuzzed1.visible).toBe(true);
    expect(fuzzed1.isFuzzed).toBe(true);
    expect(fuzzed1.latitude).toBe(fuzzed2.latitude);
    expect(fuzzed1.longitude).toBe(fuzzed2.longitude);
    expect(Math.abs(fuzzed1.latitude - 37.7749)).toBeLessThan(0.02);

    const ghost = applyPrivacyFuzzing(37.7749, -122.4194, 'GHOST', 'u1');
    expect(ghost.visible).toBe(false);
  });

  it('validates location batches', () => {
    const batch = LocationBatchSchema.parse({
      points: [
        {
          latitude: 52.52,
          longitude: 13.405,
          batteryLevel: 88,
          recordedAt: new Date().toISOString(),
        },
      ],
    });
    expect(batch.points).toHaveLength(1);
  });

  it('writes NDJSON logs to rotating file transport', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovedones-logs-'));
    const handle = await createServiceLogger('test-service', {
      logDir: tmpDir,
      disableRedis: true,
    });
    handle.logger.info({ testKey: 'hello-world' }, 'logger test event');
    await handle.close();

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBeGreaterThan(0);
    const contents = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    expect(contents).toContain('"service":"test-service"');
    expect(contents).toContain('"msg":"logger test event"');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('issues and strictly verifies access vs refresh JWTs via jose', async () => {
    const tokens = createTokenService({
      jwtSecret: 'shared-test-secret-minimum-32-chars!!',
      jwtRefreshSecret: 'shared-test-secret-minimum-32-chars!!',
    });
    const pair = await tokens.issueTokenPair({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'alice@example.com',
      username: 'Alice',
      role: 'HOST_ADMIN',
    });

    const verifiedAccess = await tokens.verifyAccessToken(pair.accessToken);
    expect(verifiedAccess.type).toBe('access');
    expect(verifiedAccess.role).toBe('HOST_ADMIN');

    await expect(tokens.verifyAccessToken(pair.refreshToken)).rejects.toThrow();
    await expect(tokens.verifyRefreshToken(pair.accessToken)).rejects.toThrow();
    expect(extractBearerToken(`Bearer ${pair.accessToken}`)).toBe(pair.accessToken);
    expect(extractBearerToken('Basic abc')).toBeNull();
  });

  it('issues scoped tracker JWTs and extracts Basic/Bearer/query tokens', async () => {
    const tokens = createTokenService({
      jwtSecret: 'shared-test-secret-minimum-32-chars!!',
      jwtRefreshSecret: 'shared-test-secret-minimum-32-chars!!',
    });
    const issued = await tokens.issueTrackerToken(
      {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'alice@example.com',
        username: 'Alice',
        role: 'USER',
      },
      { jti: 'jti-123', expiresInDays: 30 },
    );

    // Tracker token is rejected by verifyAccessToken and verifyRefreshToken
    await expect(tokens.verifyAccessToken(issued.token)).rejects.toThrow();
    await expect(tokens.verifyRefreshToken(issued.token)).rejects.toThrow();

    // Tracker token is accepted by verifyIngestionToken
    const verified = await tokens.verifyIngestionToken(issued.token);
    expect(verified.type).toBe('tracker');
    expect(verified.jti).toBe('jti-123');

    const basicHeader = `Basic ${Buffer.from(`alice:${issued.token}`, 'utf8').toString('base64')}`;
    expect(extractIngestionToken(basicHeader)).toBe(issued.token);
    expect(extractIngestionToken(undefined, issued.token)).toBe(issued.token);
  });

  it('normalizes OwnTracks and Overland payloads into LocationPoints', () => {
    // OwnTracks location + non-location lwt event
    const otPoints = normalizeOwnTracksToPoints([
      {
        _type: 'location',
        lat: 52.52,
        lon: 13.405,
        tst: 1_700_000_000,
        vel: 36, // 36 km/h -> 10 m/s
        batt: 82,
        alt: 44,
      },
      {
        _type: 'lwt',
        tst: 1_700_000_005,
      },
    ]);
    expect(otPoints).toEqual([
      {
        latitude: 52.52,
        longitude: 13.405,
        altitude: 44,
        speed: 10,
        batteryLevel: 82,
        recordedAt: new Date(1_700_000_000 * 1000).toISOString(),
      },
    ]);

    // Overland GeoJSON [lon, lat] + 0..1 float battery_level
    const overlandPoints = normalizeOverlandToPoints({
      locations: [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [13.405, 52.52, 48],
          },
          properties: {
            timestamp: '2026-11-18T20:00:00Z',
            battery_level: 0.76,
            speed: 4.5,
          },
        },
      ],
    });
    expect(overlandPoints).toEqual([
      {
        latitude: 52.52,
        longitude: 13.405,
        altitude: 48,
        speed: 4.5,
        batteryLevel: 76,
        recordedAt: '2026-11-18T20:00:00.000Z',
      },
    ]);
  });
});
