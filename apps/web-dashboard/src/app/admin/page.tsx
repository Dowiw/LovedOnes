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
      <div className="min-h-screen bg-[#f4f4f5]">
        <NavBar
          user={session?.user ?? null}
          onSignOut={() => {
            saveSession(null);
            setSession(null);
          }}
        />
        <main className="mx-auto max-w-md px-4 py-16 text-center">
          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-8 shadow-sm backdrop-blur-xl">
            <h1 className="text-lg font-bold tracking-tight text-zinc-950">
              Host Admin Access Required
            </h1>
            <p className="mt-2 text-xs text-zinc-500">
              Sign in as the Host Admin on the main map to inspect storage, telemetry, and live logs.
            </p>
            <Link
              href="/"
              className="lo-press mt-5 inline-block rounded-lg bg-zinc-950 px-5 py-2 text-xs font-semibold text-white hover:bg-zinc-800"
            >
              Back to Map
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f4f5]">
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
            <h1 className="text-xl font-bold tracking-tight text-zinc-950">System Telemetry</h1>
            <p className="text-xs text-zinc-500">
              Live 5s updates · Storage footprint · Per-account compute &amp; sockets
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshData(session.accessToken)}
              className="lo-press flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 hover:text-zinc-950"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowInviteModal((v) => !v)}
              className="lo-press flex items-center gap-1.5 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800"
            >
              <QrCode className="h-3.5 w-3.5 text-white" />
              New Invite
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
            {error}
          </div>
        )}

        {telemetry?.logStorageAlert && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              Log directory ({telemetry.logDir}) is at {telemetry.logStoragePercent}% of configured
              storage limit.
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

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl">
            <div className="flex items-center justify-between text-xs font-medium text-zinc-500">
              <span>Log Disk Usage</span>
              <HardDrive className="h-4 w-4 text-zinc-700" />
            </div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-950">
              {telemetry ? formatBytes(telemetry.logStorageBytes) : '—'}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">
              Limit: {telemetry ? formatBytes(telemetry.maxLogStorageBytes) : '—'} (
              {telemetry?.logStoragePercent ?? 0}%)
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl">
            <div className="flex items-center justify-between text-xs font-medium text-zinc-500">
              <span>Spatial Database</span>
              <Database className="h-4 w-4 text-zinc-700" />
            </div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-950">
              {telemetry ? formatBytes(telemetry.databaseBytes) : '—'}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">
              {telemetry?.totalLocationPoints.toLocaleString() ?? 0} stored pings
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl">
            <div className="flex items-center justify-between text-xs font-medium text-zinc-500">
              <span>Active Connections</span>
              <Radio className="h-4 w-4 text-zinc-700" />
            </div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-950">
              {telemetry?.totalActiveSockets ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">Open live WebSocket clients</div>
          </div>

          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl">
            <div className="flex items-center justify-between text-xs font-medium text-zinc-500">
              <span>Accounts</span>
              <Cpu className="h-4 w-4 text-zinc-700" />
            </div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-950">
              {telemetry?.users.length ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">Sorted by recent compute</div>
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl">
          <div className="border-b border-zinc-100 px-5 py-3.5 text-sm font-semibold text-zinc-950">
            Account Resource Usage
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50/90 text-zinc-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Account</th>
                  <th className="px-5 py-3 font-medium">CPU / min</th>
                  <th className="px-5 py-3 font-medium">Pings / min</th>
                  <th className="px-5 py-3 font-medium">Total CPU</th>
                  <th className="px-5 py-3 font-medium">Events</th>
                  <th className="px-5 py-3 font-medium">Sockets</th>
                  <th className="px-5 py-3 font-medium">Cache RAM</th>
                  <th className="px-5 py-3 font-medium">DB Storage</th>
                  <th className="px-5 py-3 font-medium">Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {telemetry?.users.map((u) => (
                  <tr key={u.userId} className="hover:bg-zinc-50/80">
                    <td className="px-5 py-3">
                      <div className="font-medium text-zinc-950">{u.username}</div>
                      <div className="text-[11px] text-zinc-400">{u.email}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-900">
                      {u.cpuMsPerMin.toFixed(2)} ms
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-900">{u.pingsPerMin}</td>
                    <td className="px-5 py-3 font-mono text-zinc-600">
                      {u.cpuMsTotal.toFixed(2)} ms
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-600">{u.eventsCount}</td>
                    <td className="px-5 py-3 font-mono text-zinc-600">{u.activeSockets}</td>
                    <td className="px-5 py-3 font-mono text-zinc-600">
                      {formatBytes(u.redisMemoryBytes)}
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-700">
                      {formatBytes(u.locationBytes)}
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-600">{u.locationPoints}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <LiveLogTerminal accessToken={session.accessToken} />
      </main>
    </div>
  );
}
