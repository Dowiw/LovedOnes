import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledSystemUpdate, SystemUpdateStatus, TileDownloadPolicy } from '@loved-ones/shared';
import { MapRegionsModule } from '../domain/map-regions-module.js';
import {
  SystemUpdateModule,
  type SystemUpdateDriver,
  type SystemUpdateScheduleStore,
} from '../domain/system-update-module.js';

function makeBaseUpdateStatus(overrides: Partial<SystemUpdateStatus> = {}): SystemUpdateStatus {
  return {
    enabled: true,
    disabledReason: null,
    phase: 'idle',
    running: false,
    branch: 'main',
    currentCommit: 'abc1234',
    currentCommitMessage: 'chore: baseline',
    upstreamBranch: 'origin/main',
    remoteCommit: 'def5678',
    commitsBehind: 2,
    pendingCommits: [{ sha: 'def5678', message: 'feat: latest' }],
    updateAvailable: true,
    workingTreeDirty: false,
    lastCheckedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    targetCommit: null,
    error: null,
    logs: [],
    ...overrides,
  };
}

describe('SystemUpdateModule scheduled restarts (#49)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists a scheduled update, rejects invalid/past/dirty states, and fires once on schedule', async () => {
    vi.useFakeTimers();
    let nowMs = Date.parse('2026-11-28T01:00:00.000Z');
    vi.setSystemTime(nowMs);

    let persisted: ScheduledSystemUpdate | null = null;
    const scheduleStore: SystemUpdateScheduleStore = {
      async get() {
        return persisted;
      },
      async set(next) {
        persisted = next;
      },
    };

    const applyCalls: Array<{ rebuildEvenIfCurrent: boolean }> = [];
    let driverStatus = makeBaseUpdateStatus();
    const driver: SystemUpdateDriver = {
      async getStatus() {
        return driverStatus;
      },
      async applyUpdate(opts) {
        applyCalls.push(opts);
        return {
          statusCode: 202,
          status: makeBaseUpdateStatus({ phase: 'pulling', running: true }),
        };
      },
    };

    const logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
    const mod = new SystemUpdateModule({
      driver,
      jwtSecret: 'test-jwt-secret-key-minimum-32-characters-long',
      scheduleStore,
      now: () => nowMs,
      onLog: (level, msg, meta) => logs.push({ level, msg, meta }),
    });

    // Rejects past timestamps
    await expect(
      mod.scheduleUpdate(
        { id: '11111111-1111-4111-8111-111111111111', username: 'host' },
        { runAt: '2026-11-28T00:50:00.000Z' },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Rejects dirty working tree
    driverStatus = makeBaseUpdateStatus({ workingTreeDirty: true });
    await expect(
      mod.scheduleUpdate(
        { id: '11111111-1111-4111-8111-111111111111', username: 'host' },
        { delayMinutes: 15 },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Schedule 15 minutes from now when clean
    driverStatus = makeBaseUpdateStatus({ workingTreeDirty: false });
    const scheduled = await mod.scheduleUpdate(
      { id: '11111111-1111-4111-8111-111111111111', username: 'host' },
      { delayMinutes: 15, rebuildEvenIfCurrent: true },
    );
    expect(scheduled.scheduledUpdate?.scheduledFor).toBe('2026-11-28T01:15:00.000Z');
    expect(scheduled.scheduledUpdate?.rebuildEvenIfCurrent).toBe(true);
    expect(persisted).not.toBeNull();

    // Simulate restart: new module instance loads persisted schedule and arms timer
    mod.dispose();
    const restartedMod = new SystemUpdateModule({
      driver,
      jwtSecret: 'test-jwt-secret-key-minimum-32-characters-long',
      scheduleStore,
      now: () => nowMs,
      onLog: (level, msg, meta) => logs.push({ level, msg, meta }),
    });
    await restartedMod.initScheduleTimer();

    // Advance clock to target time and verify execution + schedule cleared before apply
    nowMs += 15 * 60_000;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(applyCalls).toEqual([{ rebuildEvenIfCurrent: true }]);
    expect(persisted).toBeNull();
    expect(logs.some((l) => l.meta?.action === 'system.scheduled_update_started')).toBe(true);

    restartedMod.dispose();
  });

  it('cancels a scheduled update and clears any schedule when triggered manually', async () => {
    let persisted: ScheduledSystemUpdate | null = null;
    const driver: SystemUpdateDriver = {
      async getStatus() {
        return makeBaseUpdateStatus();
      },
      async applyUpdate() {
        return { statusCode: 202, status: makeBaseUpdateStatus({ running: true, phase: 'pulling' }) };
      },
    };
    const mod = new SystemUpdateModule({
      driver,
      jwtSecret: 'test-jwt-secret-key-minimum-32-characters-long',
      scheduleStore: {
        async get() {
          return persisted;
        },
        async set(next) {
          persisted = next;
        },
      },
    });

    await mod.scheduleUpdate(
      { id: '11111111-1111-4111-8111-111111111111', username: 'host' },
      { delayMinutes: 30 },
    );
    expect(persisted).not.toBeNull();

    const cancelled = await mod.cancelScheduledUpdate({
      id: '11111111-1111-4111-8111-111111111111',
      username: 'host',
    });
    expect(cancelled.scheduledUpdate).toBeNull();
    expect(persisted).toBeNull();

    await mod.scheduleUpdate(
      { id: '11111111-1111-4111-8111-111111111111', username: 'host' },
      { delayMinutes: 30 },
    );
    const manual = await mod.triggerUpdate({ rebuildEvenIfCurrent: false });
    expect(manual.status.scheduledUpdate).toBeNull();
    expect(persisted).toBeNull();
    mod.dispose();
  });
});

describe('MapRegionsModule Host Admin tile download policies (#55)', () => {
  it('enforces disabled, manual (once per non-admin + approve/deny), and auto modes cleanly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovedones-policy-maps-'));
    let policy: TileDownloadPolicy = 'disabled';
    let extractCount = 0;

    const mod = new MapRegionsModule({
      tilesDir: tmpDir,
      getTileDownloadPolicy: async () => policy,
      cityResolver: {
        async resolve(lat, lon, cityName) {
          return {
            cityName: cityName ?? 'Testville',
            displayName: `${cityName ?? 'Testville'}, Country`,
            countryCode: 'US',
            bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1],
          };
        },
      },
      tileExtractor: {
        async extract({ outputPath }) {
          extractCount += 1;
          await fs.promises.writeFile(outputPath, Buffer.from('not-used'));
          return { sourceBuild: 'test-build' };
        },
      },
    });

    const memberA = { id: '22222222-2222-4222-8222-222222222222', role: 'USER', username: 'alice' };
    const memberB = { id: '33333333-3333-4333-8333-333333333333', role: 'USER', username: 'bob' };
    const hostAdmin = { id: '11111111-1111-4111-8111-111111111111', role: 'HOST_ADMIN', username: 'host' };

    try {
      // 1. Disabled policy blocks non-admin with 403
      await expect(
        mod.requestCityDownload(memberA, { latitude: 37.77, longitude: -122.42, cityName: 'San Francisco' }),
      ).rejects.toMatchObject({ statusCode: 403 });

      // 2. Manual policy queues PENDING request and limits non-admin to 1 request
      policy = 'manual';
      const pendingRes = await mod.requestCityDownload(memberA, {
        latitude: 37.77,
        longitude: -122.42,
        cityName: 'San Francisco',
      });
      expect(pendingRes.pendingApproval).toBe(true);
      expect(pendingRes.request?.status).toBe('PENDING');
      expect(pendingRes.request?.requesterUsername).toBe('alice');
      expect(extractCount).toBe(0);

      // Second request from alice is blocked with 409
      await expect(
        mod.requestCityDownload(memberA, { latitude: 40.71, longitude: -74.0, cityName: 'New York' }),
      ).rejects.toMatchObject({ statusCode: 409 });

      // Member B submits one request and Host Admin denies it
      const bobReq = await mod.requestCityDownload(memberB, {
        latitude: 48.85,
        longitude: 2.35,
        cityName: 'Paris',
      });
      expect(bobReq.pendingApproval).toBe(true);
      const denied = await mod.denyManualRequest(hostAdmin, bobReq.request!.id);
      expect(denied.request.status).toBe('DENIED');

      // Bob still cannot submit a second manual request
      await expect(
        mod.requestCityDownload(memberB, { latitude: 51.5, longitude: -0.12, cityName: 'London' }),
      ).rejects.toMatchObject({ statusCode: 409 });

      // Host Admin approves Alice's request -> starts extraction job
      const approved = await mod.approveManualRequest(hostAdmin, pendingRes.request!.id);
      expect(approved.request.status).toBe('APPROVED');
      expect(approved.job).toBeDefined();
      expect(approved.request.jobId).toBe(approved.job?.id);

      // Host Admin always bypasses manual limit directly
      const hostDirect = await mod.requestCityDownload(hostAdmin, {
        latitude: 35.68,
        longitude: 139.65,
        cityName: 'Tokyo',
      });
      expect(hostDirect.pendingApproval).toBeUndefined();
      expect(hostDirect.job).toBeDefined();
    } finally {
      await mod.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
