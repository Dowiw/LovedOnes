import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPrivacyFuzzing,
  ChangePasswordSchema,
  CreateGroupPlaceSchema,
  CreateLocationRequestSchema,
  isSafeAvatarUrl,
  LocationBatchSchema,
  LocationSnapshotQuerySchema,
  normalizeOverlandToPoints,
  normalizeOwnTracksToPoints,
  normalizePrivacyMode,
  parseBoundingBox,
  parseInviteInput,
  QrInvitePayloadSchema,
  RespondLocationRequestSchema,
  TrailQuerySchema,
  UpdateProfileSchema,
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
        acc: 12.5,
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
        accuracy: 12.5,
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
            horizontal_accuracy: 18,
            speed: 4.5,
          },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [13.406, 52.521],
          },
          properties: {
            timestamp: '2026-11-18T20:00:05Z',
            horizontal_accuracy: -1,
          },
        },
      ],
    });
    expect(overlandPoints).toEqual([
      {
        latitude: 52.52,
        longitude: 13.405,
        altitude: 48,
        accuracy: 18,
        speed: 4.5,
        batteryLevel: 76,
        recordedAt: '2026-11-18T20:00:00.000Z',
      },
      {
        latitude: 52.521,
        longitude: 13.406,
        altitude: null,
        accuracy: null,
        speed: null,
        batteryLevel: null,
        recordedAt: '2026-11-18T20:00:05.000Z',
      },
    ]);
  });

  it('validates snapshot since queries and PostGIS bounding-box trail queries', () => {
    expect(LocationSnapshotQuerySchema.parse({ since: '2026-11-19T12:00:00.000Z' }).since).toBe(
      '2026-11-19T12:00:00.000Z',
    );
    expect(LocationSnapshotQuerySchema.safeParse({ since: 'not-a-date' }).success).toBe(false);

    expect(parseBoundingBox('13.08,52.33,13.76,52.67')).toEqual({
      minLon: 13.08,
      minLat: 52.33,
      maxLon: 13.76,
      maxLat: 52.67,
    });
    expect(parseBoundingBox('13.8,52.3,13.0,52.6')).toBeNull(); // minLon >= maxLon
    expect(parseBoundingBox('13.0,52.3,190,52.6')).toBeNull(); // out of range
    expect(parseBoundingBox('13.0,52.3,13.8')).toBeNull();

    const parsedTrail = TrailQuerySchema.parse({
      from: '2026-11-19T10:00:00Z',
      to: '2026-11-19T12:00:00Z',
      bbox: '13.08,52.33,13.76,52.67',
      limit: '250',
    });
    expect(parsedTrail.limit).toBe(250);

    expect(
      TrailQuerySchema.safeParse({
        from: '2026-11-19T14:00:00Z',
        to: '2026-11-19T12:00:00Z',
      }).success,
    ).toBe(false);
    expect(TrailQuerySchema.safeParse({ bbox: 'invalid' }).success).toBe(false);
  });

  it('validates check-in request and geofenced group place payloads', () => {
    const req = CreateLocationRequestSchema.parse({
      targetUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      message: 'On your way?',
    });
    expect(req.suggestedDurationMinutes).toBe(15);
    expect(req.expiresInMinutes).toBe(15);

    expect(
      RespondLocationRequestSchema.parse({ action: 'accept', durationMinutes: 30 }),
    ).toEqual({ action: 'accept', durationMinutes: 30 });
    expect(RespondLocationRequestSchema.safeParse({ action: 'ignore' }).success).toBe(false);

    const place = CreateGroupPlaceSchema.parse({
      name: 'Home',
      latitude: 52.52,
      longitude: 13.405,
    });
    expect(place.radiusMeters).toBe(150);
    expect(
      CreateGroupPlaceSchema.safeParse({
        name: 'TooSmall',
        latitude: 52.52,
        longitude: 13.405,
        radiusMeters: 5,
      }).success,
    ).toBe(false);
  });

  it('validates account profile updates, password changes, and safe avatar URL allowlists', () => {
    expect(isSafeAvatarUrl('https://cdn.example.com/avatar.png')).toBe(true);
    expect(isSafeAvatarUrl('data:image/webp;base64,UklGRh4AAABXRUJQ')).toBe(true);
    expect(isSafeAvatarUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isSafeAvatarUrl('javascript:alert(1)')).toBe(false);

    expect(
      UpdateProfileSchema.parse({
        username: 'Alex',
        email: 'alex@example.com',
        avatarUrl: 'https://cdn.example.com/alex.jpg',
      }).username,
    ).toBe('Alex');
    expect(UpdateProfileSchema.parse({ avatarUrl: null }).avatarUrl).toBeNull();
    expect(UpdateProfileSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateProfileSchema.safeParse({ avatarUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }).success,
    ).toBe(false);

    expect(
      ChangePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'newpassword123' })
        .success,
    ).toBe(true);
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: 'samepassword', newPassword: 'samepassword' })
        .success,
    ).toBe(false);

    expect(
      parseInviteInput(
        JSON.stringify({
          v: 1,
          serverUrl: 'https://lovedones.doiw.dev/',
          inviteToken: 'inv_abc12345',
          groupName: 'Doiwki',
        }),
      ),
    ).toEqual({
      inviteToken: 'inv_abc12345',
      serverUrl: 'https://lovedones.doiw.dev',
      groupName: 'Doiwki',
    });
    expect(parseInviteInput('https://lovedones.doiw.dev/join?token=inv_abc12345')).toEqual({
      inviteToken: 'inv_abc12345',
      serverUrl: 'https://lovedones.doiw.dev',
      groupName: undefined,
    });
    expect(parseInviteInput('inv_abc12345')).toEqual({ inviteToken: 'inv_abc12345' });
    expect(() => parseInviteInput('   ')).toThrow();
    expect(() => parseInviteInput('https://lovedones.doiw.dev/join')).toThrow();
  });
});
