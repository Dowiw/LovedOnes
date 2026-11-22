import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPrivacyFuzzing,
  averageNearbyTrailPings,
  buildExternalMapsUrls,
  buildGeodesicCircleRing,
  ChangePasswordSchema,
  compareSemver,
  computeCityFallbackBbox,
  CreateGroupPlaceSchema,
  CreateLocationRequestSchema,
  CreateRegistrationRequestSchema,
  detectExternalMapPlatform,
  evaluateClientVersion,
  findCoveringRegions,
  formatCountdownRemaining,
  haversineMeters,
  hexToRgba,
  isPointCoveredByRegions,
  isSafeAvatarUrl,
  isSafeHexColor,
  LocationBatchSchema,
  LocationSnapshotQuerySchema,
  type MapRegion,
  normalizeCityBbox,
  normalizeOverlandToPoints,
  normalizeOwnTracksToPoints,
  normalizePrivacyMode,
  parseBoundingBox,
  parseInviteInput,
  QrInvitePayloadSchema,
  RespondLocationRequestSchema,
  slugifyCityName,
  TrailQuerySchema,
  UpdateProfileSchema,
  withMinDelay,
} from '../index.js';
import { createServiceLogger, LOGS_RING_KEY, pruneLogArtifacts } from '../logger.js';
import {
  createEventThrottle,
  createRateLimiter,
  createTokenService,
  extractBearerToken,
  extractIngestionToken,
  isOriginAllowed,
  resolveClientIp,
} from '../auth.js';
import {
  collectServiceNodeTelemetry,
  dismissAdminNotice,
  dismissAllAdminNotices,
  listAdminNotices,
  loadResourceLimitsSettings,
  recordAdminNotice,
  saveResourceLimitsSettings,
} from '../telemetry.js';

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

  it('evaluates regional PMTiles coverage and normalizes city bounding boxes', () => {
    const regions: MapRegion[] = [
      {
        id: 'stub-only',
        name: 'Stub',
        url: '/tiles/region.pmtiles',
        minLon: -180,
        minLat: -85,
        maxLon: 180,
        maxLat: 85,
        minZoom: 0,
        maxZoom: 0,
        sizeBytes: 264,
        isStub: true,
        isPrimary: true,
      },
      {
        id: 'berlin',
        name: 'Berlin',
        url: '/tiles/regions/berlin.pmtiles',
        minLon: 13.2,
        minLat: 52.4,
        maxLon: 13.65,
        maxLat: 52.6,
        minZoom: 0,
        maxZoom: 15,
        sizeBytes: 50_000_000,
        isStub: false,
        isPrimary: false,
      },
    ];

    expect(isPointCoveredByRegions(52.52, 13.405, regions)).toBe(true);
    expect(isPointCoveredByRegions(48.8566, 2.3522, regions)).toBe(false);
    expect(findCoveringRegions(52.52, 13.405, regions).map((r) => r.id)).toEqual(['berlin']);

    const fallback = computeCityFallbackBbox(48.8566, 2.3522, 15);
    expect(fallback[0]).toBeLessThan(2.3522);
    expect(fallback[2]).toBeGreaterThan(2.3522);
    expect(fallback[1]).toBeLessThan(48.8566);
    expect(fallback[3]).toBeGreaterThan(48.8566);

    // Oversized administrative bbox should clamp sensibly around the requested coordinate
    const clamped = normalizeCityBbox(48.8566, 2.3522, [-5, 41, 10, 52]);
    expect(clamped[2] - clamped[0]).toBeLessThanOrEqual(2.5);
    expect(clamped[3] - clamped[1]).toBeLessThanOrEqual(1.7);
    expect(slugifyCityName('München', 48.1351, 11.582)).toContain('munchen-48_14n-11_58e');

    expect(isSafeHexColor('#0EA5E9')).toBe(true);
    expect(isSafeHexColor('red')).toBe(false);
    expect(hexToRgba('#0ea5e9', 0.25)).toBe('rgba(14, 165, 233, 0.25)');
    const ring = buildGeodesicCircleRing(13.405, 52.52, 1420, 32);
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[32]);
    expect(
      UpdateProfileSchema.parse({ haloColor: '#0EA5E9', fuzzCircleColor: '#8B5CF6' }),
    ).toEqual({
      haloColor: '#0ea5e9',
      fuzzCircleColor: '#8b5cf6',
    });
  });

  it('enforces minimum UI feedback duration on fast promises and rejections', async () => {
    const t0 = Date.now();
    const value = await withMinDelay(Promise.resolve('saved'), 45);
    expect(value).toBe('saved');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);

    const t1 = Date.now();
    await expect(withMinDelay(Promise.reject(new Error('boom')), 45)).rejects.toThrow('boom');
    expect(Date.now() - t1).toBeGreaterThanOrEqual(40);
  });

  it('averages nearby trail pings per user while preserving trips and fuzzed isolation', () => {
    const jitterHome = [
      { lat: 52.5200, lon: 13.5100, ts: '2026-11-20T08:00:00.000Z' },
      { lat: 52.5202, lon: 13.5103, ts: '2026-11-20T08:05:00.000Z' },
      { lat: 52.5198, lon: 13.5097, ts: '2026-11-20T08:10:00.000Z' },
      { lat: 52.5203, lon: 13.5101, ts: '2026-11-20T08:15:00.000Z' },
      { lat: 52.5199, lon: 13.5104, ts: '2026-11-20T08:20:00.000Z' },
    ];
    const workStop = [
      { lat: 52.5250, lon: 13.5250, ts: '2026-11-20T09:00:00.000Z' },
      { lat: 52.5252, lon: 13.5252, ts: '2026-11-20T09:10:00.000Z' },
    ];
    const returnHome = [
      { lat: 52.5201, lon: 13.5098, ts: '2026-11-20T18:00:00.000Z' },
      { lat: 52.5201, lon: 13.5102, ts: '2026-11-20T18:05:00.000Z' },
    ];

    const allHome = [...jitterHome, ...returnHome];
    const expectedHomeLat = Number(
      (allHome.reduce((s, p) => s + p.lat, 0) / allHome.length).toFixed(6),
    );
    const expectedHomeLon = Number(
      (allHome.reduce((s, p) => s + p.lon, 0) / allHome.length).toFixed(6),
    );

    const compacted = averageNearbyTrailPings([
      // Intentionally shuffled order + second user + fuzzed point near Home
      {
        userId: 'user-a',
        username: 'KB',
        latitude: returnHome[1].lat,
        longitude: returnHome[1].lon,
        recordedAt: returnHome[1].ts,
        isFuzzed: false,
      },
      ...jitterHome.map((p) => ({
        userId: 'user-a',
        username: 'KB',
        latitude: p.lat,
        longitude: p.lon,
        recordedAt: p.ts,
        isFuzzed: false,
      })),
      ...workStop.map((p) => ({
        userId: 'user-a',
        username: 'KB',
        latitude: p.lat,
        longitude: p.lon,
        recordedAt: p.ts,
        isFuzzed: false,
      })),
      {
        userId: 'user-a',
        username: 'KB',
        latitude: returnHome[0].lat,
        longitude: returnHome[0].lon,
        recordedAt: returnHome[0].ts,
        isFuzzed: false,
      },
      // Fuzzed ping at same coordinate should NOT merge with EXACT cluster
      {
        userId: 'user-a',
        username: 'KB',
        latitude: expectedHomeLat,
        longitude: expectedHomeLon,
        recordedAt: '2026-11-20T19:00:00.000Z',
        isFuzzed: true,
      },
      // Another user's nearby ping stays separate by userId
      {
        userId: 'user-b',
        username: 'Sam',
        latitude: 52.52005,
        longitude: 13.51005,
        recordedAt: '2026-11-20T08:02:00.000Z',
        isFuzzed: false,
      },
    ]);

    expect(compacted).toHaveLength(2);
    const userA = compacted.find((u) => u.userId === 'user-a')!;
    const userB = compacted.find((u) => u.userId === 'user-b')!;

    expect(userB.stops).toHaveLength(1);
    expect(userB.pathCoordinates).toHaveLength(1);

    // Stops: merged Home (7 pings), Work (2 pings), and separated Fuzzed stop (1 ping)
    expect(userA.stops).toHaveLength(3);
    const homeStop = userA.stops[0];
    expect(homeStop.pingCount).toBe(allHome.length);
    expect(homeStop.latitude).toBeCloseTo(expectedHomeLat, 6);
    expect(homeStop.longitude).toBeCloseTo(expectedHomeLon, 6);
    expect(homeStop.firstRecordedAt).toBe('2026-11-20T08:00:00.000Z');
    expect(homeStop.lastRecordedAt).toBe('2026-11-20T18:05:00.000Z');
    expect(homeStop.isFuzzed).toBe(false);

    const workAvgStop = userA.stops[1];
    expect(workAvgStop.pingCount).toBe(2);
    expect(workAvgStop.latitude).toBeCloseTo(52.5251, 6);
    expect(workAvgStop.longitude).toBeCloseTo(13.5251, 6);

    expect(userA.stops[2].isFuzzed).toBe(true);
    expect(userA.stops[2].pingCount).toBe(1);

    // Path preserves Home -> Work -> Home -> Fuzzed without intra-cluster zig-zags
    expect(userA.pathCoordinates).toEqual([
      [homeStop.longitude, homeStop.latitude],
      [workAvgStop.longitude, workAvgStop.latitude],
      [homeStop.longitude, homeStop.latitude],
      [userA.stops[2].longitude, userA.stops[2].latitude],
    ]);

    // Continuous walk with 110m steps should NOT chain into one giant cluster
    const walkPings = Array.from({ length: 10 }, (_, idx) => ({
      userId: 'walker',
      username: 'Walker',
      latitude: 52.5 + idx * 0.001, // ~111m per step
      longitude: 13.4,
      recordedAt: new Date(Date.UTC(2026, 10, 20, 10, idx, 0)).toISOString(),
    }));
    const [walkTrail] = averageNearbyTrailPings(walkPings);
    expect(walkTrail.stops).toHaveLength(10);
    expect(haversineMeters(52.5, 13.4, 52.501, 13.4)).toBeGreaterThan(100);
  });

  it('compares semantic versions and detects outdated APK/IPA installs', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1);
    expect(compareSemver('v0.1.9', '0.1.10')).toBe(-1);
    expect(compareSemver('0.2.0-rc.1', '0.2.0')).toBe(-1);
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('0.3.0', '0.2.5')).toBe(1);

    const outdated = evaluateClientVersion({
      clientVersion: '0.1.0',
      platform: 'android',
      serverVersion: '0.2.0',
      latestMobileVersion: '0.2.0',
      minSupportedVersion: '0.1.5',
      downloadUrl: 'https://github.com/Dowiw/LovedOnes/releases/latest',
    });
    expect(outdated.updateAvailable).toBe(true);
    expect(outdated.updateRequired).toBe(true);

    const softOutdated = evaluateClientVersion({
      clientVersion: '0.1.5',
      platform: 'ios',
      serverVersion: '0.2.0',
      latestMobileVersion: '0.2.0',
      minSupportedVersion: '0.1.5',
    });
    expect(softOutdated.updateAvailable).toBe(true);
    expect(softOutdated.updateRequired).toBe(false);

    const current = evaluateClientVersion({
      clientVersion: '0.2.0',
      platform: 'android',
      serverVersion: '0.2.0',
      latestMobileVersion: '0.2.0',
      minSupportedVersion: '0.1.5',
    });
    expect(current.updateAvailable).toBe(false);
    expect(current.updateRequired).toBe(false);
  });

  it('prunes rotated log files by retention age and file count while preserving non-log files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovedones-prune-'));
    try {
      const nowMs = Date.UTC(2026, 10, 21, 9, 0, 0);
      const tenDaysAgo = new Date(nowMs - 10 * 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(nowMs - 2 * 24 * 60 * 60 * 1000);
      const oneHourAgo = new Date(nowMs - 60 * 60 * 1000);

      const oldFile = path.join(tmpDir, 'auth-admin-service.log.1');
      const midFile = path.join(tmpDir, 'auth-admin-service.log.2');
      const freshFile = path.join(tmpDir, 'auth-admin-service.log.3');
      const keepGitkeep = path.join(tmpDir, '.gitkeep');
      const keepState = path.join(tmpDir, 'system-update.json');

      fs.writeFileSync(oldFile, 'old-log-entry\n', 'utf8');
      fs.writeFileSync(midFile, 'mid-log-entry\n', 'utf8');
      fs.writeFileSync(freshFile, 'fresh-log-entry\n', 'utf8');
      fs.writeFileSync(keepGitkeep, '', 'utf8');
      fs.writeFileSync(keepState, '{}', 'utf8');

      fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
      fs.utimesSync(midFile, twoDaysAgo, twoDaysAgo);
      fs.utimesSync(freshFile, oneHourAgo, oneHourAgo);
      fs.utimesSync(keepGitkeep, tenDaysAgo, tenDaysAgo);
      fs.utimesSync(keepState, tenDaysAgo, tenDaysAgo);

      // Retain 7 days, max 2 files -> oldFile (10d) deleted; midFile (2d) + freshFile (1h) kept
      const res = await pruneLogArtifacts({
        logDir: tmpDir,
        settings: {
          retentionDays: 7,
          maxFilesPerService: 2,
          maxRecentEntries: 500,
          maxStorageMb: 500,
          autoPruneDiskLogs: true,
        },
        nowMs,
      });

      expect(res.deletedFiles).toBe(1);
      expect(res.freedBytes).toBeGreaterThan(0);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(midFile)).toBe(true);
      expect(fs.existsSync(freshFile)).toBe(true);
      expect(fs.existsSync(keepGitkeep)).toBe(true);
      expect(fs.existsSync(keepState)).toBe(true);

      // Dropping maxFilesPerService to 1 removes midFile while preserving freshFile
      const resCount = await pruneLogArtifacts({
        logDir: tmpDir,
        settings: {
          retentionDays: 7,
          maxFilesPerService: 1,
          maxRecentEntries: 500,
          maxStorageMb: 500,
          autoPruneDiskLogs: true,
        },
        nowMs,
      });
      expect(resCount.deletedFiles).toBe(1);
      expect(fs.existsSync(midFile)).toBe(false);
      expect(fs.existsSync(freshFile)).toBe(true);
      expect(LOGS_RING_KEY).toBe('logs:ring');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates registration request payloads and formats 24h countdown timers', () => {
    const parsed = CreateRegistrationRequestSchema.parse({
      username: 'Jordan',
      email: 'jordan@example.com',
      password: 'Password123!',
      haloColor: '#0EA5E9',
      avatarUrl: 'https://cdn.example.com/j.png',
    });
    expect(parsed.haloColor).toBe('#0ea5e9');
    expect(
      CreateRegistrationRequestSchema.safeParse({
        username: 'Jordan',
        email: 'jordan@example.com',
        password: 'short',
      }).success,
    ).toBe(false);

    const now = Date.UTC(2026, 10, 21, 12, 0, 0);
    expect(
      formatCountdownRemaining(new Date(now + (23 * 3600 + 5 * 60 + 9) * 1000).toISOString(), now),
    ).toBe('23h 05m 09s');
    expect(formatCountdownRemaining(new Date(now + 125 * 1000).toISOString(), now)).toBe('2m 05s');
    expect(formatCountdownRemaining(new Date(now - 1000).toISOString(), now)).toBe('Expired');
  });

  it('builds default Maps deep links and fallbacks across Android, iOS, macOS, Windows, and Linux', () => {
    expect(detectExternalMapPlatform({ platformOs: 'android' })).toBe('android');
    expect(
      detectExternalMapPlatform({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
      }),
    ).toBe('windows');
    expect(
      detectExternalMapPlatform({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15',
      }),
    ).toBe('macos');

    const androidUrls = buildExternalMapsUrls({
      latitude: 52.520008,
      longitude: 13.404954,
      label: 'Alice (Home)',
      platformOs: 'android',
      isNativeApp: true,
    });
    expect(androidUrls.primaryUrl).toBe('geo:52.520008,13.404954?q=52.520008,13.404954(Alice%20Home)');
    expect(androidUrls.fallbackUrl).toBe('https://www.google.com/maps/search/?api=1&query=52.520008,13.404954');

    const iosNative = buildExternalMapsUrls({
      latitude: 52.52,
      longitude: 13.405,
      label: 'Bob',
      platformOs: 'ios',
      isNativeApp: true,
    });
    expect(iosNative.primaryUrl).toBe('maps://?ll=52.52,13.405&q=Bob');
    expect(iosNative.fallbackUrl).toBe('https://maps.apple.com/?ll=52.52,13.405&q=Bob');

    const windowsWeb = buildExternalMapsUrls({
      latitude: 52.52,
      longitude: 13.405,
      label: 'Home',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    expect(windowsWeb.primaryUrl).toBe('bingmaps:?cp=52.52~13.405&lvl=16&sp=point.52.52_13.405_Home');
    expect(windowsWeb.fallbackUrl).toBe('https://www.google.com/maps/search/?api=1&query=52.52,13.405');
  });

  it('resolves proxy client IPs, production CORS origins, and rate limits', async () => {
    // By default (non-Cloudflare), CF-Connecting-IP is ignored to prevent header spoofing
    expect(
      resolveClientIp(
        {
          'cf-connecting-ip': '198.51.100.42',
          'x-forwarded-for': '172.18.0.5, 10.0.0.1',
        },
        '::ffff:127.0.0.1',
      ),
    ).toBe('172.18.0.5');
    // When TRUST_CLOUDFLARE_HEADERS is enabled, CF-Connecting-IP takes precedence
    expect(
      resolveClientIp(
        {
          'cf-connecting-ip': '198.51.100.42',
          'x-forwarded-for': '172.18.0.5, 10.0.0.1',
        },
        '::ffff:127.0.0.1',
        { trustCloudflareHeaders: true },
      ),
    ).toBe('198.51.100.42');
    expect(
      resolveClientIp({ 'x-forwarded-for': '::ffff:203.0.113.9, 10.0.0.2' }, '127.0.0.1'),
    ).toBe('203.0.113.9');

    expect(
      isOriginAllowed('https://lovedones.example.com', 'api.internal', {
        nodeEnv: 'production',
        publicServerUrl: 'https://lovedones.example.com',
      }),
    ).toBe(true);
    expect(
      isOriginAllowed('http://192.168.1.50:8080', '192.168.1.50:8080', {
        nodeEnv: 'production',
        publicServerUrl: 'https://lovedones.example.com',
      }),
    ).toBe(true);
    expect(
      isOriginAllowed('https://evil.example.net', 'lovedones.example.com', {
        nodeEnv: 'production',
        publicServerUrl: 'https://lovedones.example.com',
      }),
    ).toBe(false);

    const limiter = createRateLimiter({ prefix: 'test', max: 2, windowMs: 60_000 });
    const statuses: number[] = [];
    const headers: Record<string, string> = {};
    for (let i = 0; i < 3; i += 1) {
      let statusCode = 200;
      await limiter(
        { headers: { 'cf-connecting-ip': '198.51.100.77' }, ip: '127.0.0.1' } as never,
        {
          header(k: string, v: string) {
            headers[k] = v;
            return this;
          },
          code(c: number) {
            statusCode = c;
            return this;
          },
          send() {
            return Promise.resolve();
          },
        } as never,
      );
      statuses.push(statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(headers['X-RateLimit-Limit']).toBe('2');
    expect(headers['Retry-After']).toBeTruthy();
  });

  it('throttles per-socket events within a window and resets after expiry or clearKey', () => {
    let fakeNow = 10_000;
    const throttle = createEventThrottle({
      max: 2,
      windowMs: 5_000,
      now: () => fakeNow,
    });

    expect(throttle.consume('sock-1').allowed).toBe(true);
    expect(throttle.consume('sock-1').allowed).toBe(true);
    const blocked = throttle.consume('sock-1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThanOrEqual(1000);

    // Independent socket key is unaffected
    expect(throttle.consume('sock-2').allowed).toBe(true);

    // Advancing past window resets budget
    fakeNow += 5_001;
    expect(throttle.consume('sock-1').allowed).toBe(true);

    // clearKey removes state cleanly
    throttle.clearKey('sock-1');
    expect(throttle.consume('sock-1').remaining).toBe(1);

    const disabledThrottle = createEventThrottle({ max: 1, windowMs: 1000, disabled: true });
    expect(disabledThrottle.consume('sock-1').allowed).toBe(true);
    expect(disabledThrottle.consume('sock-1').allowed).toBe(true);
  });

  it('persists, coalesces, and dismisses admin quota notices and resource limits', async () => {
    const kv = new Map<string, string>();
    const fakeRedis = {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async set(key: string, val: string) {
        kv.set(key, val);
        return 'OK';
      },
      async del(key: string) {
        return kv.delete(key) ? 1 : 0;
      },
    } as never;

    const defaults = await loadResourceLimitsSettings(fakeRedis);
    expect(defaults.autoTrimOnQuota).toBe(true);
    expect(defaults.maxDatabaseMb).toBe(0);

    const saved = await saveResourceLimitsSettings(fakeRedis, {
      maxDatabaseMb: 512,
      perUserMaxPoints: 5000,
      maxMapStorageMb: 1024,
    });
    expect(saved.maxDatabaseMb).toBe(512);
    expect(saved.perUserMaxPoints).toBe(5000);
    expect(saved.maxMapStorageMb).toBe(1024);

    const userId = '11111111-1111-4111-8111-111111111111';
    const first = await recordAdminNotice(fakeRedis, {
      kind: 'quota_trim',
      userId,
      username: 'Alice',
      deletedPoints: 40,
      rangeStart: '2026-11-01T10:00:00.000Z',
      rangeEnd: '2026-11-02T12:00:00.000Z',
      scope: 'user_points',
    });
    // Coalesces consecutive trims for the same user & scope
    const coalesced = await recordAdminNotice(fakeRedis, {
      kind: 'quota_trim',
      userId,
      username: 'Alice',
      deletedPoints: 15,
      rangeStart: '2026-11-02T12:01:00.000Z',
      rangeEnd: '2026-11-03T08:30:00.000Z',
      scope: 'user_points',
    });
    expect(coalesced.id).toBe(first.id);
    expect(coalesced.deletedPoints).toBe(55);
    expect(coalesced.rangeStart).toBe('2026-11-01T10:00:00.000Z');
    expect(coalesced.rangeEnd).toBe('2026-11-03T08:30:00.000Z');
    expect(coalesced.message).toContain('55 location point(s) for Alice');

    const listed = await listAdminNotices(fakeRedis);
    expect(listed).toHaveLength(1);

    expect(await dismissAdminNotice(fakeRedis, first.id)).toBe(true);
    expect(await listAdminNotices(fakeRedis)).toHaveLength(0);

    await recordAdminNotice(fakeRedis, {
      kind: 'system',
      title: 'Test notice',
      message: 'Cleared test',
    });
    expect(await dismissAllAdminNotices(fakeRedis)).toBe(1);
    expect(await listAdminNotices(fakeRedis)).toHaveLength(0);

    const nodeSnap = await collectServiceNodeTelemetry({
      service: 'test-service',
      mounts: [{ mountLabel: 'logs', path: os.tmpdir() }],
    });
    expect(nodeSnap.snapshot.service).toBe('test-service');
    expect(nodeSnap.snapshot.rssBytes).toBeGreaterThan(0);
    expect(nodeSnap.snapshot.disks.length).toBeGreaterThanOrEqual(1);
  });
});
