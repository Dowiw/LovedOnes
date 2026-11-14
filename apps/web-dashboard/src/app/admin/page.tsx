'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Cpu,
  Database,
  HardDrive,
  QrCode,
  Radio,
  RefreshCw,
} from 'lucide-react';
import type { SystemTelemetry } from '@loved-ones/shared';
import { LiveLogTerminal } from '@/components/LiveLogTerminal';
import { NavBar } from '@/components/NavBar';
import { QrInvitePanel } from '@/components/QrInviteModal';
import {
  apiFetchGroups,
  apiFetchTelemetry,
  formatBytes,
  GroupItem,
  loadSession,
  saveSession,
  StoredSession,
} from '@/lib/api';

export default function AdminDashboardPage() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(loadSession());
  }, []);

  const refreshData = useCallback(async (token: string) => {
    try {
      const [stats, grpList] = await Promise.all([
        apiFetchTelemetry(token),
        apiFetchGroups(token),
      ]);
      setTelemetry(stats);
      setGroups(grpList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load telemetry');
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void refreshData(session.accessToken);
    const interval = setInterval(() => {
      void refreshData(session.accessToken);
    }, 5000);
    return () => clearInterval(interval);
  }, [session, refreshData]);

  if (!session || session.user.role !== 'HOST_ADMIN') {
    return (
      <div className="min-h-screen bg-slate-950">
        <NavBar
          user={session?.user ?? null}
          onSignOut={() => {
            saveSession(null);
            setSession(null);
          }}
        />
        <main className="mx-auto max-w-xl px-4 py-16 text-center">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
            <h1 className="text-lg font-bold text-white">HOST_ADMIN Access Required</h1>
            <p className="mt-2 text-xs text-slate-400">
              Sign in as the Host Admin on the main portal to inspect storage, Redis/PostGIS
              telemetry, and live service logs.
            </p>
            <Link
              href="/"
              className="mt-5 inline-block rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950"
            >
              Return to Portal
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <NavBar
        user={session.user}
        onSignOut={() => {
          saveSession(null);
          setSession(null);
        }}
      />

      <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">Host Admin Telemetry & Operations</h1>
            <p className="text-xs text-slate-400">
              Live 5s polling · PostGIS per-user storage · Redis compute/RAM attribution
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshData(session.accessToken)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowInviteModal((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400"
            >
              <QrCode className="h-3.5 w-3.5" />
              QR Invite Generator
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
            {error}
          </div>
        )}

        {telemetry?.logStorageAlert && (
          <div className="flex items-center gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
            <span>
              Rotating log folder ({telemetry.logDir}) is at {telemetry.logStoragePercent}% of
              configured MAX_LOG_STORAGE_MB!
            </span>
          </div>
        )}

        {showInviteModal && (
          <QrInvitePanel
            accessToken={session.accessToken}
            groups={groups}
            onClose={() => setShowInviteModal(false)}
          />
        )}

        {/* Top Telemetry Cards */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Log Disk Usage</span>
              <HardDrive className="h-4 w-4 text-amber-400" />
            </div>
            <div className="mt-2 text-xl font-bold text-white">
              {telemetry ? formatBytes(telemetry.logStorageBytes) : '—'}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              Limit: {telemetry ? formatBytes(telemetry.maxLogStorageBytes) : '—'} (
              {telemetry?.logStoragePercent ?? 0}%)
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>PostGIS Database Size</span>
              <Database className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="mt-2 text-xl font-bold text-white">
              {telemetry ? formatBytes(telemetry.databaseBytes) : '—'}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              {telemetry?.totalLocationPoints.toLocaleString() ?? 0} total GPS rows
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Active Socket.io Clients</span>
              <Radio className="h-4 w-4 text-sky-400" />
            </div>
            <div className="mt-2 text-xl font-bold text-white">
              {telemetry?.totalActiveSockets ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">Tracked via Redis sockets:user:*</div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Tracked Users</span>
              <Cpu className="h-4 w-4 text-purple-400" />
            </div>
            <div className="mt-2 text-xl font-bold text-white">
              {telemetry?.users.length ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              Ranked by cpu_ms/min & events/min
            </div>
          </div>
        </section>

        {/* Per-User Compute, Memory & Storage Table */}
        <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
          <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
            Per-User Compute, RAM & PostGIS Storage Attribution
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">CPU / min</th>
                  <th className="px-4 py-2.5 font-medium">Pings / min</th>
                  <th className="px-4 py-2.5 font-medium">Total CPU</th>
                  <th className="px-4 py-2.5 font-medium">Total Events</th>
                  <th className="px-4 py-2.5 font-medium">Sockets</th>
                  <th className="px-4 py-2.5 font-medium">Redis RAM</th>
                  <th className="px-4 py-2.5 font-medium">PostGIS Bytes</th>
                  <th className="px-4 py-2.5 font-medium">Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {telemetry?.users.map((u) => (
                  <tr key={u.userId} className="hover:bg-slate-800/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-white">{u.username}</div>
                      <div className="text-[11px] text-slate-500">{u.email}</div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-emerald-300">
                      {u.cpuMsPerMin.toFixed(2)} ms
                    </td>
                    <td className="px-4 py-2.5 font-mono text-sky-300">{u.pingsPerMin}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">
                      {u.cpuMsTotal.toFixed(2)} ms
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">{u.eventsCount}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">{u.activeSockets}</td>
                    <td className="px-4 py-2.5 font-mono text-purple-300">
                      {formatBytes(u.redisMemoryBytes)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-amber-300">
                      {formatBytes(u.locationBytes)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">{u.locationPoints}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Live Scrolling STDOUT Log Terminal */}
        <LiveLogTerminal accessToken={session.accessToken} />
      </main>
    </div>
  );
}
