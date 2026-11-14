import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPrivacyFuzzing,
  LocationBatchSchema,
  normalizePrivacyMode,
  QrInvitePayloadSchema,
} from '../index.js';
import { createServiceLogger } from '../logger.js';

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
});
