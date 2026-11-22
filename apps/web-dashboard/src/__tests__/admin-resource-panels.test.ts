import { describe, expect, it } from 'vitest';
import type { SystemTelemetry } from '@loved-ones/shared';
import { deduplicateClusterVolumes } from '../lib/resourceVolumes';

describe('deduplicateClusterVolumes', () => {
  it('deduplicates shared host volumes across containers and separates protected vs deletable disk usage', () => {
    const baseNode = {
      pid: 1,
      version: '0.1.2',
      uptimeSeconds: 120,
      cpuPercent: 5,
      cpuCores: 4,
      loadAvg1m: 0.4,
      rssBytes: 64_000_000,
      heapUsedBytes: 32_000_000,
      heapTotalBytes: 48_000_000,
      systemMemTotalBytes: 8_000_000_000,
      systemMemUsedBytes: 2_000_000_000,
      cgroupMemLimitBytes: null,
      cgroupMemUsedBytes: null,
      updatedAt: '2026-11-22T15:00:00.000Z',
    };

    const telemetry: SystemTelemetry = {
      timestamp: '2026-11-22T15:00:00.000Z',
      logDir: '/var/log/app',
      logStorageBytes: 50_000_000,
      maxLogStorageBytes: 500_000_000,
      logStoragePercent: 10,
      logStorageAlert: false,
      databaseBytes: 120_000_000,
      totalLocationPoints: 1000,
      totalActiveSockets: 2,
      users: [],
      mapStorage: {
        totalBytes: 300_000_000,
        primaryBytes: 100_000_000,
        regionsBytes: 200_000_000,
        maxMapStorageBytes: 1_000_000_000,
        regionCount: 2,
      },
      nodes: [
        {
          ...baseNode,
          nodeKey: 'auth-admin-service:c1-1',
          service: 'auth-admin-service',
          instanceId: 'c1-1',
          hostname: 'c1',
          disks: [
            {
              mountLabel: 'logs',
              path: '/var/log/app',
              fsId: '2049:10000000000',
              totalBytes: 10_000_000_000,
              freeBytes: 6_000_000_000,
              availableBytes: 5_500_000_000,
              usedBytes: 4_000_000_000,
              pathSizeBytes: 50_000_000,
            },
            {
              mountLabel: 'tiles',
              path: '/srv/tiles',
              fsId: '2049:10000000000',
              totalBytes: 10_000_000_000,
              freeBytes: 6_000_000_000,
              availableBytes: 5_500_000_000,
              usedBytes: 4_000_000_000,
              pathSizeBytes: 300_000_000,
            },
          ],
        },
        {
          ...baseNode,
          nodeKey: 'realtime-service:c2-1',
          service: 'realtime-service',
          instanceId: 'c2-1',
          hostname: 'c2',
          disks: [
            {
              mountLabel: 'logs',
              path: '/var/log/app',
              fsId: '2049:10000000000',
              totalBytes: 10_000_000_000,
              freeBytes: 6_000_000_000,
              availableBytes: 5_500_000_000,
              usedBytes: 4_000_000_000,
              pathSizeBytes: 50_000_000,
            },
          ],
        },
      ],
    };

    const vols = deduplicateClusterVolumes(telemetry);
    expect(vols).toHaveLength(1);
    expect(vols[0].deletableBytes).toBe(250_000_000); // 200MB city extracts + 50MB logs
    expect(vols[0].protectedLovedOnesBytes).toBe(100_000_000); // primary region.pmtiles
    expect(vols[0].usedBytes).toBe(4_500_000_000); // totalBytes - availableBytes
    expect(vols[0].systemOtherBytes).toBe(4_150_000_000);
  });
});
