import type { DiskMountTelemetry, SystemTelemetry } from '@loved-ones/shared';

export interface DeduplicatedVolume {
  fsId: string;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  mounts: Array<{
    service: string;
    hostname: string;
    mountLabel: DiskMountTelemetry['mountLabel'];
    path: string;
    pathSizeBytes: number;
  }>;
  deletableBytes: number;
  protectedLovedOnesBytes: number;
  systemOtherBytes: number;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function deduplicateClusterVolumes(telemetry: SystemTelemetry): DeduplicatedVolume[] {
  const nodes = telemetry.nodes ?? [];
  const map = new Map<
    string,
    {
      fsId: string;
      totalBytes: number;
      availableBytes: number;
      usedBytes: number;
      mounts: DeduplicatedVolume['mounts'];
    }
  >();

  for (const node of nodes) {
    for (const d of node.disks) {
      const existing = map.get(d.fsId);
      const entry = {
        service: node.service,
        hostname: node.hostname,
        mountLabel: d.mountLabel,
        path: d.path,
        pathSizeBytes: d.pathSizeBytes,
      };
      if (!existing) {
        map.set(d.fsId, {
          fsId: d.fsId,
          totalBytes: d.totalBytes,
          availableBytes: d.availableBytes,
          usedBytes: Math.max(0, d.totalBytes - d.availableBytes),
          mounts: [entry],
        });
      } else {
        const alreadyHasMount = existing.mounts.some(
          (m) => m.mountLabel === d.mountLabel && m.pathSizeBytes === d.pathSizeBytes,
        );
        if (!alreadyHasMount) {
          existing.mounts.push(entry);
        }
      }
    }
  }

  const regionsBytes = telemetry.mapStorage?.regionsBytes ?? 0;
  const primaryMapBytes = telemetry.mapStorage?.primaryBytes ?? 0;
  const logBytes = telemetry.logStorageBytes ?? 0;

  return Array.from(map.values()).map((vol) => {
    const hasTiles = vol.mounts.some((m) => m.mountLabel === 'tiles');
    const hasLogs = vol.mounts.some((m) => m.mountLabel === 'logs');
    const deletableBytes = (hasTiles ? regionsBytes : 0) + (hasLogs ? logBytes : 0);
    const protectedLovedOnesBytes = hasTiles ? primaryMapBytes : 0;
    const systemOtherBytes = Math.max(
      0,
      vol.usedBytes - deletableBytes - protectedLovedOnesBytes,
    );
    return {
      ...vol,
      deletableBytes,
      protectedLovedOnesBytes,
      systemOtherBytes,
    };
  });
}
