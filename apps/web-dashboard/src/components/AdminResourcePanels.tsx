'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Cpu,
  Database,
  HardDrive,
  Info,
  Loader2,
  Lock,
  MemoryStick,
  Server,
  Sliders,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AdminNotice,
  ResourceLimitsSettings,
  SystemTelemetry,
  UpdateResourceLimitsInput,
} from '@loved-ones/shared';
import {
  apiDismissAdminNotice,
  apiDismissAllAdminNotices,
  apiPruneResourceTables,
  apiUpdateResourceLimits,
  formatBytes,
} from '@/lib/api';
import { deduplicateClusterVolumes, formatUptime } from '@/lib/resourceVolumes';

interface AdminNoticesBannerProps {
  accessToken: string;
  notices: AdminNotice[];
  onUpdated: () => void;
}

export function AdminNoticesBanner({
  accessToken,
  notices,
  onUpdated,
}: AdminNoticesBannerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);

  if (notices.length === 0) return null;

  async function handleDismiss(id: string) {
    setBusyId(id);
    try {
      await apiDismissAdminNotice(accessToken, id);
      onUpdated();
    } finally {
      setBusyId(null);
    }
  }

  async function handleClearAll() {
    setClearingAll(true);
    try {
      await apiDismissAllAdminNotices(accessToken);
      onUpdated();
    } finally {
      setClearingAll(false);
    }
  }

  return (
    <section className="space-y-2" aria-label="Persistent Admin Notices">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Resource &amp; Quota Notices ({notices.length})
        </span>
        {notices.length > 1 && (
          <button
            type="button"
            disabled={clearingAll}
            onClick={() => void handleClearAll()}
            className="text-[11px] font-medium text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {clearingAll ? 'Clearing...' : 'Dismiss all'}
          </button>
        )}
      </div>
      {notices.map((notice) => {
        const isWarn = notice.severity === 'warning' || notice.severity === 'error';
        return (
          <div
            key={notice.id}
            className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-xs shadow-sm ${
              isWarn
                ? 'border-amber-200 bg-amber-50/95 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200'
                : 'border-zinc-200/80 bg-white/95 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-200'
            }`}
          >
            <div className="flex items-start gap-2.5">
              {isWarn ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
              )}
              <div className="space-y-0.5">
                <div className="font-semibold">{notice.title}</div>
                <p className="leading-relaxed">{notice.message}</p>
                <div className="flex flex-wrap items-center gap-3 text-[10px] opacity-75">
                  <span>Updated {new Date(notice.updatedAt).toLocaleString()}</span>
                  {notice.deletedPoints !== null && (
                    <span className="font-mono">
                      {notice.deletedPoints.toLocaleString()} pts trimmed
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss notice"
              disabled={busyId === notice.id}
              onClick={() => void handleDismiss(notice.id)}
              className="rounded-lg p-1 text-current opacity-70 hover:bg-black/5 hover:opacity-100 disabled:opacity-40 dark:hover:bg-white/10"
            >
              {busyId === notice.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        );
      })}
    </section>
  );
}

interface ResourceAllocationPanelsProps {
  accessToken: string;
  telemetry: SystemTelemetry | null;
  onUpdated: () => void;
}

export function ResourceAllocationPanels({
  accessToken,
  telemetry,
  onUpdated,
}: ResourceAllocationPanelsProps) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [tablesOpen, setTablesOpen] = useState(false);
  const [limitsInitialized, setLimitsInitialized] = useState(false);
  const [maxDbMb, setMaxDbMb] = useState('0');
  const [perUserMb, setPerUserMb] = useState('0');
  const [perUserPts, setPerUserPts] = useState('0');
  const [locDays, setLocDays] = useState('0');
  const [msgDays, setMsgDays] = useState('0');
  const [placeDays, setPlaceDays] = useState('0');
  const [reqDays, setReqDays] = useState('30');
  const [mapCapMb, setMapCapMb] = useState('0');
  const [autoTrim, setAutoTrim] = useState(true);
  const [savingLimits, setSavingLimits] = useState(false);
  const [pruningDb, setPruningDb] = useState<'prune' | 'vacuum' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const syncForm = (s: ResourceLimitsSettings) => {
    setMaxDbMb(String(s.maxDatabaseMb));
    setPerUserMb(String(s.perUserMaxLocationMb));
    setPerUserPts(String(s.perUserMaxPoints));
    setLocDays(String(s.locationRetentionDays));
    setMsgDays(String(s.messageRetentionDays));
    setPlaceDays(String(s.placeEventRetentionDays));
    setReqDays(String(s.resolvedRequestRetentionDays));
    setMapCapMb(String(s.maxMapStorageMb));
    setAutoTrim(s.autoTrimOnQuota);
  };

  useEffect(() => {
    if (!limitsInitialized && telemetry?.resourceLimits) {
      syncForm(telemetry.resourceLimits);
      setLimitsInitialized(true);
    }
  }, [limitsInitialized, telemetry?.resourceLimits]);

  const volumes = useMemo(
    () => (telemetry ? deduplicateClusterVolumes(telemetry) : []),
    [telemetry],
  );

  async function handleSaveLimits(e: React.FormEvent) {
    e.preventDefault();
    setSavingLimits(true);
    setPanelError(null);
    setFeedback(null);
    try {
      const payload: UpdateResourceLimitsInput = {
        maxDatabaseMb: Math.max(0, Number(maxDbMb) || 0),
        perUserMaxLocationMb: Math.max(0, Number(perUserMb) || 0),
        perUserMaxPoints: Math.max(0, Math.round(Number(perUserPts) || 0)),
        locationRetentionDays: Math.max(0, Math.round(Number(locDays) || 0)),
        messageRetentionDays: Math.max(0, Math.round(Number(msgDays) || 0)),
        placeEventRetentionDays: Math.max(0, Math.round(Number(placeDays) || 0)),
        resolvedRequestRetentionDays: Math.max(0, Math.round(Number(reqDays) || 0)),
        maxMapStorageMb: Math.max(0, Number(mapCapMb) || 0),
        autoTrimOnQuota: autoTrim,
      };
      const res = await apiUpdateResourceLimits(accessToken, payload);
      syncForm(res.settings);
      setFeedback('Resource allocation limits saved.');
      onUpdated();
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Failed to save resource limits');
    } finally {
      setSavingLimits(false);
    }
  }

  async function handlePruneNow(vacuum: boolean) {
    setPruningDb(vacuum ? 'vacuum' : 'prune');
    setPanelError(null);
    setFeedback(null);
    try {
      const res = await apiPruneResourceTables(accessToken, { vacuum });
      setFeedback(
        `Cleanup complete: ${res.deletedLocations} ping(s), ${res.deletedMessages} message(s), ${res.deletedPlaceEvents} geofence event(s), ${res.deletedLocationRequests + res.deletedRegistrationRequests} old request(s) removed${res.vacuumed ? ' + VACUUM ANALYZE ran' : ''}.`,
      );
      onUpdated();
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Database cleanup failed');
    } finally {
      setPruningDb(null);
    }
  }

  const breakdown = telemetry?.databaseBreakdown;
  const dbBytes = telemetry?.databaseBytes ?? 0;
  const maxDbBytes = (telemetry?.resourceLimits?.maxDatabaseMb ?? 0) * 1024 * 1024;
  const dbCapPct =
    maxDbBytes > 0 ? Math.min(100, Math.round((dbBytes / maxDbBytes) * 100)) : null;

  const sysPct =
    breakdown && dbBytes > 0
      ? Math.min(100, Math.round((breakdown.systemBytes / dbBytes) * 100))
      : 0;
  const mgmtPct =
    breakdown && dbBytes > 0 ? Math.max(0, 100 - sysPct) : 0;

  return (
    <div className="space-y-6">
      {/* Host Volumes & Database System-vs-Deletable Storage */}
      <section className="grid gap-4 lg:grid-cols-2">
        {/* Host / Volume Disk Allocation */}
        <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              <HardDrive className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
              Host Disk &amp; Volume Allocation
            </div>
            {telemetry?.mapStorage && (
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Maps: {formatBytes(telemetry.mapStorage.totalBytes)}
                {telemetry.mapStorage.maxMapStorageBytes > 0
                  ? ` / ${formatBytes(telemetry.mapStorage.maxMapStorageBytes)} cap`
                  : ''}
              </span>
            )}
          </div>

          {volumes.length === 0 ? (
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Waiting for service node disk heartbeats...
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {volumes.map((vol) => {
                const sysWidth =
                  vol.totalBytes > 0
                    ? Math.round((vol.systemOtherBytes / vol.totalBytes) * 100)
                    : 0;
                const protWidth =
                  vol.totalBytes > 0
                    ? Math.round((vol.protectedLovedOnesBytes / vol.totalBytes) * 100)
                    : 0;
                const delWidth =
                  vol.totalBytes > 0
                    ? Math.round((vol.deletableBytes / vol.totalBytes) * 100)
                    : 0;
                const usedPct =
                  vol.totalBytes > 0
                    ? Math.round((vol.usedBytes / vol.totalBytes) * 100)
                    : 0;
                return (
                  <div key={vol.fsId} className="space-y-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">
                        Volume ({vol.mounts.map((m) => m.mountLabel).join(', ')})
                      </span>
                      <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                        {formatBytes(vol.usedBytes)} used / {formatBytes(vol.totalBytes)} ({usedPct}%)
                        · {formatBytes(vol.availableBytes)} free
                      </span>
                    </div>

                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div
                        style={{ width: `${sysWidth}%` }}
                        title={`OS / System / Other: ${formatBytes(vol.systemOtherBytes)}`}
                        className="bg-zinc-500 dark:bg-zinc-500"
                      />
                      <div
                        style={{ width: `${protWidth}%` }}
                        title={`Protected Primary Map: ${formatBytes(vol.protectedLovedOnesBytes)}`}
                        className="bg-zinc-900 dark:bg-zinc-200"
                      />
                      <div
                        style={{ width: `${delWidth}%` }}
                        title={`Deletable Extracts & Logs: ${formatBytes(vol.deletableBytes)}`}
                        className="bg-amber-500"
                      />
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-zinc-500" />
                        System / Host (non-deletable): {formatBytes(vol.systemOtherBytes)}
                      </span>
                      {vol.protectedLovedOnesBytes > 0 && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-zinc-900 dark:bg-zinc-200" />
                          Primary Map (protected): {formatBytes(vol.protectedLovedOnesBytes)}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-amber-500" />
                        Deletable (logs &amp; city maps): {formatBytes(vol.deletableBytes)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* PostgreSQL System vs Deletable Breakdown */}
        <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              <Database className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
              Database Allocation
            </div>
            <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              {formatBytes(dbBytes)}
              {maxDbBytes > 0 ? ` / ${formatBytes(maxDbBytes)} (${dbCapPct}%)` : ' (no cap)'}
            </span>
          </div>

          {breakdown ? (
            <div className="mt-4 space-y-3">
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  style={{ width: `${sysPct}%` }}
                  title={`System & Protected Tables: ${formatBytes(breakdown.systemBytes)}`}
                  className="bg-zinc-700 dark:bg-zinc-300"
                />
                <div
                  style={{ width: `${mgmtPct}%` }}
                  title={`Prunable / Deletable Data: ${formatBytes(breakdown.manageableBytes)}`}
                  className="bg-amber-500"
                />
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="h-3 w-3 text-zinc-700 dark:text-zinc-300" />
                  System &amp; Identity (non-deletable):{' '}
                  <strong className="font-mono text-zinc-900 dark:text-zinc-100">
                    {formatBytes(breakdown.systemBytes)}
                  </strong>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Trash2 className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                  Prunable History &amp; Events:{' '}
                  <strong className="font-mono text-zinc-900 dark:text-zinc-100">
                    {formatBytes(breakdown.manageableBytes)}
                  </strong>
                </span>
                {breakdown.deadTupleBytesEstimate > 0 && (
                  <span className="font-mono text-zinc-500 dark:text-zinc-400">
                    Reclaimable (VACUUM): ~{formatBytes(breakdown.deadTupleBytesEstimate)}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => setTablesOpen((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {tablesOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {tablesOpen ? 'Hide table breakdown' : `Inspect ${breakdown.tables.length} database components`}
              </button>

              {tablesOpen && (
                <div className="max-h-56 overflow-auto rounded-lg border border-zinc-200/80 dark:border-zinc-800">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
                      <tr>
                        <th className="px-3 py-2 font-medium">Component</th>
                        <th className="px-3 py-2 font-medium">Policy</th>
                        <th className="px-3 py-2 font-medium">Rows</th>
                        <th className="px-3 py-2 font-medium">Data</th>
                        <th className="px-3 py-2 font-medium">Indexes</th>
                        <th className="px-3 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {breakdown.tables.map((t) => (
                        <tr key={t.tableName}>
                          <td className="px-3 py-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                            {t.label}
                          </td>
                          <td className="px-3 py-1.5">
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                t.deletable
                                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                              }`}
                            >
                              {t.deletable ? 'Prunable' : 'System'}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 font-mono text-zinc-600 dark:text-zinc-300">
                            {t.liveRows.toLocaleString()}
                            {t.deadRows > 0 ? ` (${t.deadRows} dead)` : ''}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-zinc-600 dark:text-zinc-300">
                            {formatBytes(t.rowBytes)}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-zinc-600 dark:text-zinc-300">
                            {formatBytes(t.indexBytes)}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono font-medium text-zinc-900 dark:text-zinc-100">
                            {formatBytes(t.totalBytes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Loading database breakdown...</p>
          )}
        </div>
      </section>

      {/* Cluster Nodes (CPU & RAM) + Redis */}
      <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
            <Server className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
            Service Nodes (CPU &amp; RAM)
          </div>
          {telemetry?.redis && (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <MemoryStick className="h-3.5 w-3.5" />
                Redis:{' '}
                <strong className="font-mono text-zinc-900 dark:text-zinc-100">
                  {telemetry.redis.available ? formatBytes(telemetry.redis.usedMemoryBytes) : 'N/A'}
                </strong>
                {telemetry.redis.maxMemoryBytes
                  ? ` / ${formatBytes(telemetry.redis.maxMemoryBytes)}`
                  : ''}
              </span>
              {telemetry.redis.connectedClients !== null && (
                <span className="font-mono">{telemetry.redis.connectedClients} clients</span>
              )}
              {telemetry.redis.opsPerSec !== null && (
                <span className="font-mono">{telemetry.redis.opsPerSec} ops/s</span>
              )}
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-50/90 text-zinc-500 dark:bg-zinc-950/60 dark:text-zinc-400">
              <tr>
                <th className="px-5 py-3 font-medium">Service</th>
                <th className="px-5 py-3 font-medium">Host / PID</th>
                <th className="px-5 py-3 font-medium">CPU</th>
                <th className="px-5 py-3 font-medium">Load (1m)</th>
                <th className="px-5 py-3 font-medium">Process RAM (RSS / Heap)</th>
                <th className="px-5 py-3 font-medium">Node Memory</th>
                <th className="px-5 py-3 text-right font-medium">Uptime</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {(telemetry?.nodes ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-4 text-xs text-zinc-500 dark:text-zinc-400">
                    Waiting for live service heartbeats from running containers...
                  </td>
                </tr>
              ) : (
                (telemetry?.nodes ?? []).map((n) => {
                  const memDenominator = n.cgroupMemLimitBytes ?? n.systemMemTotalBytes;
                  const memUsed = n.cgroupMemUsedBytes ?? n.systemMemUsedBytes;
                  const memPct =
                    memDenominator > 0 ? Math.min(100, Math.round((memUsed / memDenominator) * 100)) : 0;
                  return (
                    <tr key={n.nodeKey} className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/50">
                      <td className="px-5 py-3 font-semibold text-zinc-950 dark:text-zinc-50">
                        {n.service}
                        {n.version && (
                          <span className="ml-2 font-mono text-[10px] font-normal text-zinc-400">
                            v{n.version}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                        {n.hostname}:{n.pid}
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-900 dark:text-zinc-100">
                        <span className="inline-flex items-center gap-1">
                          <Cpu className="h-3 w-3 text-zinc-400" />
                          {n.cpuPercent.toFixed(1)}%
                        </span>
                        <span className="ml-1 text-[10px] text-zinc-400">({n.cpuCores}c)</span>
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-600 dark:text-zinc-300">
                        {n.loadAvg1m.toFixed(2)}
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-700 dark:text-zinc-200">
                        {formatBytes(n.rssBytes)}
                        <span className="ml-1 text-[10px] text-zinc-400">
                          (heap {formatBytes(n.heapUsedBytes)})
                        </span>
                      </td>
                      <td className="px-5 py-3 font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                        {formatBytes(memUsed)} / {formatBytes(memDenominator)} ({memPct}%)
                        {n.cgroupMemLimitBytes ? ' cgroup' : ' host'}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-zinc-600 dark:text-zinc-300">
                        {formatUptime(n.uptimeSeconds)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Resource Allocation Limits & Retention Controls */}
      <section className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              <Sliders className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
              Resource Allocation &amp; Retention Quotas
            </div>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Configure storage caps, FIFO auto-trimming (Option A), map storage limits, and table retention. Set 0 for unlimited.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={Boolean(pruningDb)}
              onClick={() => void handlePruneNow(false)}
              className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              {pruningDb === 'prune' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Prune Expired Now
            </button>
            <button
              type="button"
              disabled={Boolean(pruningDb)}
              onClick={() => void handlePruneNow(true)}
              className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              {pruningDb === 'vacuum' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Prune &amp; VACUUM
            </button>
            <button
              type="button"
              onClick={() => setLimitsOpen((v) => !v)}
              className="lo-press inline-flex items-center gap-1 rounded-lg bg-zinc-950 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              {limitsOpen ? 'Hide Limits' : 'Configure Quotas'}
            </button>
          </div>
        </div>

        {panelError && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300">
            {panelError}
          </div>
        )}
        {feedback && (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-300">
            {feedback}
          </div>
        )}

        {limitsOpen && (
          <form onSubmit={(e) => void handleSaveLimits(e)} className="mt-4 space-y-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Global DB Cap (MB)</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={maxDbMb}
                  onChange={(e) => setMaxDbMb(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Per-User Location Cap (MB)</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={perUserMb}
                  onChange={(e) => setPerUserMb(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Per-User Max Pings</span>
                <input
                  type="number"
                  min={0}
                  value={perUserPts}
                  onChange={(e) => setPerUserPts(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">City Map Extracts Cap (MB)</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={mapCapMb}
                  onChange={(e) => setMapCapMb(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Location Retention (Days)</span>
                <input
                  type="number"
                  min={0}
                  value={locDays}
                  onChange={(e) => setLocDays(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Messages Retention (Days)</span>
                <input
                  type="number"
                  min={0}
                  value={msgDays}
                  onChange={(e) => setMsgDays(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Geofence Events (Days)</span>
                <input
                  type="number"
                  min={0}
                  value={placeDays}
                  onChange={(e) => setPlaceDays(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Old Requests Cleanup (Days)</span>
                <input
                  type="number"
                  min={0}
                  value={reqDays}
                  onChange={(e) => setReqDays(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={autoTrim}
                  onChange={(e) => setAutoTrim(e.target.checked)}
                  className="rounded border-zinc-300 dark:border-zinc-700"
                />
                Auto-trim oldest location points (FIFO) &amp; post persistent admin notice when quotas are reached
              </label>
              <button
                type="submit"
                disabled={savingLimits}
                className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                {savingLimits && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save Limits
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
