'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  Clock,
  CloudDownload,
  Cpu,
  Database,
  HardDrive,
  Loader2,
  QrCode,
  Radio,
  RefreshCw,
  Terminal,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  DEFAULT_EXACT_HALO_COLOR,
  formatCountdownRemaining,
  isSafeAvatarUrl,
  type MapDownloadJob,
  type MapRegion,
  type RegistrationRequestItem,
  type SystemTelemetry,
  type SystemUpdateStatus,
} from '@loved-ones/shared';
import { LiveLogTerminal } from '@/components/LiveLogTerminal';
import { NavBar } from '@/components/NavBar';
import { QrInvitePanel } from '@/components/QrInviteModal';
import {
  apiApproveRegistrationRequest,
  apiDeleteMapRegion,
  apiDenyRegistrationRequest,
  apiFetchGroups,
  apiFetchMapJobs,
  apiFetchMapRegions,
  apiFetchRegistrationRequests,
  apiFetchSystemUpdateStatus,
  apiFetchTelemetry,
  apiTriggerSystemUpdate,
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
  const [mapRegions, setMapRegions] = useState<MapRegion[]>([]);
  const [mapJobs, setMapJobs] = useState<MapDownloadJob[]>([]);
  const [registrationRequests, setRegistrationRequests] = useState<RegistrationRequestItem[]>([]);
  const [reviewingRequestId, setReviewingRequestId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [startingUpdate, setStartingUpdate] = useState(false);
  const [confirmUpdateMode, setConfirmUpdateMode] = useState<'pull' | 'rebuild' | null>(null);
  const [reconnectingDuringUpdate, setReconnectingDuringUpdate] = useState(false);
  const [showUpdateLogs, setShowUpdateLogs] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(loadSession());
  }, []);

  const refreshData = useCallback(async (token: string) => {
    try {
      const [stats, grpList, regionsData, jobs, sysUpdate, regReqs] = await Promise.all([
        apiFetchTelemetry(token),
        apiFetchGroups(token),
        apiFetchMapRegions(),
        apiFetchMapJobs(token),
        apiFetchSystemUpdateStatus(token, false).catch(() => null),
        apiFetchRegistrationRequests(token).catch(() => null),
      ]);
      setTelemetry(stats);
      setGroups(grpList);
      setMapRegions(regionsData.regions);
      setMapJobs(jobs);
      if (regReqs) {
        setRegistrationRequests(regReqs);
      }
      if (sysUpdate) {
        setUpdateStatus(sysUpdate);
        setReconnectingDuringUpdate(false);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load telemetry');
    }
  }, []);

  useEffect(() => {
    if (!registrationRequests.some((r) => r.status === 'PENDING')) return;
    const ticker = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, [registrationRequests]);

  const handleReviewRegistrationRequest = useCallback(
    async (requestId: string, action: 'approve' | 'deny') => {
      if (!session) return;
      setReviewingRequestId(requestId);
      try {
        if (action === 'approve') {
          await apiApproveRegistrationRequest(session.accessToken, requestId);
        } else {
          await apiDenyRegistrationRequest(session.accessToken, requestId);
        }
        await refreshData(session.accessToken);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${action} account request`);
      } finally {
        setReviewingRequestId(null);
      }
    },
    [session, refreshData],
  );

  const handleCheckForUpdates = useCallback(async () => {
    if (!session) return;
    setCheckingUpdate(true);
    try {
      const next = await apiFetchSystemUpdateStatus(session.accessToken, true);
      setUpdateStatus(next);
      setReconnectingDuringUpdate(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check for system updates');
    } finally {
      setCheckingUpdate(false);
    }
  }, [session]);

  const handleTriggerUpdate = useCallback(
    async (rebuildEvenIfCurrent: boolean) => {
      if (!session) return;
      setStartingUpdate(true);
      setConfirmUpdateMode(null);
      setShowUpdateLogs(true);
      try {
        const next = await apiTriggerSystemUpdate(session.accessToken, {
          rebuildEvenIfCurrent,
        });
        setUpdateStatus(next);
        setReconnectingDuringUpdate(false);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start system update');
      } finally {
        setStartingUpdate(false);
      }
    },
    [session],
  );

  useEffect(() => {
    if (!session) return;
    void refreshData(session.accessToken);
    const interval = setInterval(() => {
      void refreshData(session.accessToken);
    }, 5000);
    return () => clearInterval(interval);
  }, [session, refreshData]);

  // Poll update job faster while running, tolerating transient 502/network drops during container swap
  useEffect(() => {
    if (!session || !updateStatus?.running) return;
    const token = session.accessToken;
    const timer = setInterval(async () => {
      try {
        const next = await apiFetchSystemUpdateStatus(token, false);
        setUpdateStatus(next);
        setReconnectingDuringUpdate(false);
        if (!next.running) {
          void refreshData(token);
        }
      } catch {
        setReconnectingDuringUpdate(true);
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [session, updateStatus?.running, refreshData]);

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

        <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-5 py-3.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
              <UserPlus className="h-4 w-4 text-zinc-700" />
              Account Requests
              {registrationRequests.filter((r) => r.status === 'PENDING').length > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                  {registrationRequests.filter((r) => r.status === 'PENDING').length} pending
                </span>
              )}
            </div>
            <span className="text-[11px] text-zinc-500">
              1 request per IP · Expires automatically after 24h
            </span>
          </div>

          {registrationRequests.length === 0 ? (
            <div className="px-5 py-5 text-xs text-zinc-500">
              No pending or recent account requests yet. New mobile onboarding requests appear here
              with a 24-hour countdown timer.
            </div>
          ) : (
            <div className="divide-y divide-zinc-100">
              {registrationRequests.map((req) => {
                const isPending = req.status === 'PENDING';
                const countdown = isPending ? formatCountdownRemaining(req.expiresAt, nowMs) : null;
                const halo = req.haloColor ?? DEFAULT_EXACT_HALO_COLOR;
                const busy = reviewingRequestId === req.id;
                const initials = req.username
                  .trim()
                  .split(/\s+/)
                  .map((p) => p[0] ?? '')
                  .join('')
                  .slice(0, 2)
                  .toUpperCase();

                return (
                  <div
                    key={req.id}
                    className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 text-xs font-bold text-zinc-800"
                        style={{ boxShadow: `0 0 0 2.5px ${halo}` }}
                      >
                        {isSafeAvatarUrl(req.avatarUrl) ? (
                          <img
                            src={req.avatarUrl}
                            alt={req.username}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          initials || '?'
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-zinc-950">
                            {req.username}
                          </span>
                          <span className="text-xs text-zinc-500">{req.email}</span>
                          {req.groupName && (
                            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-700">
                              Group: {req.groupName}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
                          <span className="font-mono">IP {req.requesterIp}</span>
                          {isPending && countdown && (
                            <span className="inline-flex items-center gap-1 font-mono text-amber-700">
                              <Clock className="h-3 w-3" />
                              Expires in {countdown}
                            </span>
                          )}
                          {!isPending && (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                req.status === 'APPROVED'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : req.status === 'DENIED'
                                    ? 'bg-rose-50 text-rose-700'
                                    : 'bg-zinc-100 text-zinc-500'
                              }`}
                            >
                              {req.status}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {isPending && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleReviewRegistrationRequest(req.id, 'approve')}
                          className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                          Accept
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleReviewRegistrationRequest(req.id, 'deny')}
                          className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60"
                        >
                          <X className="h-3.5 w-3.5" />
                          Deny
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-zinc-950">Remote System Update</h2>
                {updateStatus ? (
                  updateStatus.running ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {updateStatus.phase === 'pulling'
                        ? 'Pulling updates'
                        : updateStatus.phase === 'building'
                          ? 'Building containers'
                          : 'Restarting services'}
                    </span>
                  ) : !updateStatus.enabled ? (
                    <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-medium text-zinc-600">
                      Local / Disabled
                    </span>
                  ) : updateStatus.updateAvailable ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
                      <ArrowUpCircle className="h-3 w-3" />
                      {updateStatus.commitsBehind} update
                      {updateStatus.commitsBehind === 1 ? '' : 's'} available
                    </span>
                  ) : updateStatus.phase === 'failed' ? (
                    <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700">
                      Last update failed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800">
                      <CheckCircle2 className="h-3 w-3" />
                      Up to date
                    </span>
                  )
                ) : (
                  <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] text-zinc-500">
                    Checking...
                  </span>
                )}
              </div>

              <p className="text-xs text-zinc-500">
                {updateStatus?.currentCommit ? (
                  <>
                    Running{' '}
                    <span className="font-mono font-medium text-zinc-800">
                      {updateStatus.branch ?? 'HEAD'}@{updateStatus.currentCommit}
                    </span>
                    {updateStatus.currentCommitMessage
                      ? ` — ${updateStatus.currentCommitMessage}`
                      : ''}
                  </>
                ) : updateStatus?.disabledReason ? (
                  updateStatus.disabledReason
                ) : (
                  'Inspect git upstream and rebuild/restart LovedOnes containers remotely.'
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={checkingUpdate || Boolean(updateStatus?.running) || !updateStatus?.enabled}
                onClick={() => void handleCheckForUpdates()}
                className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3.5 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
                {checkingUpdate ? 'Checking...' : 'Check Updates'}
              </button>

              {confirmUpdateMode ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1">
                  <span className="text-[11px] font-medium text-zinc-700">
                    {confirmUpdateMode === 'pull'
                      ? 'Pull & restart stack?'
                      : 'Rebuild & restart stack?'}
                  </span>
                  <button
                    type="button"
                    disabled={startingUpdate}
                    onClick={() => void handleTriggerUpdate(confirmUpdateMode === 'rebuild')}
                    className="lo-press inline-flex items-center gap-1 rounded-md bg-zinc-950 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {startingUpdate && <Loader2 className="h-3 w-3 animate-spin" />}
                    Confirm
                  </button>
                  <button
                    type="button"
                    disabled={startingUpdate}
                    onClick={() => setConfirmUpdateMode(null)}
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-200/70"
                  >
                    Cancel
                  </button>
                </div>
              ) : updateStatus?.updateAvailable ? (
                <button
                  type="button"
                  disabled={
                    startingUpdate ||
                    Boolean(updateStatus.running) ||
                    !updateStatus.enabled ||
                    updateStatus.workingTreeDirty
                  }
                  onClick={() => setConfirmUpdateMode('pull')}
                  className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  Update System
                </button>
              ) : (
                <button
                  type="button"
                  disabled={
                    startingUpdate ||
                    !updateStatus?.enabled ||
                    Boolean(updateStatus?.running) ||
                    Boolean(updateStatus?.workingTreeDirty)
                  }
                  onClick={() => setConfirmUpdateMode('rebuild')}
                  className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  Rebuild &amp; Restart
                </button>
              )}

              {updateStatus && updateStatus.logs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowUpdateLogs((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
                >
                  <Terminal className="h-3.5 w-3.5" />
                  {showUpdateLogs ? 'Hide Output' : 'Build Output'}
                </button>
              )}
            </div>
          </div>

          {updateStatus?.workingTreeDirty && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                Host repository has uncommitted changes to tracked files. Clean or commit them on
                the host before triggering a remote update.
              </span>
            </div>
          )}

          {reconnectingDuringUpdate && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-700" />
              <span>
                Updated containers are swapping cleanly — reconnecting automatically in a few
                seconds...
              </span>
            </div>
          )}

          {updateStatus?.error && !updateStatus.running && (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {updateStatus.error}
            </div>
          )}

          {updateStatus?.phase === 'completed' && updateStatus.finishedAt && !updateStatus.running && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>
                Last update completed cleanly
                {updateStatus.targetCommit ? ` at ${updateStatus.targetCommit}` : ''} (
                {new Date(updateStatus.finishedAt).toLocaleString()}).
              </span>
            </div>
          )}

          {updateStatus && updateStatus.pendingCommits.length > 0 && (
            <div className="mt-3 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Pending Updates ({updateStatus.upstreamBranch ?? 'upstream'})
              </div>
              <ul className="mt-1.5 space-y-1 text-xs text-zinc-700">
                {updateStatus.pendingCommits.map((c) => (
                  <li key={c.sha} className="flex items-baseline gap-2">
                    <span className="font-mono text-[11px] font-semibold text-zinc-900">
                      {c.sha}
                    </span>
                    <span className="truncate">{c.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(showUpdateLogs || updateStatus?.running) &&
            updateStatus &&
            updateStatus.logs.length > 0 && (
              <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200">
                {updateStatus.logs.join('\n')}
              </pre>
            )}
        </section>

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

        <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
              <CloudDownload className="h-4 w-4 text-zinc-700" />
              Downloaded Map Regions ({mapRegions.filter((r) => !r.isStub).length})
            </div>
            {mapJobs.some((j) => j.status === 'resolving' || j.status === 'downloading') && (
              <span className="rounded-full bg-zinc-950 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                Download active
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50/90 text-zinc-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Region</th>
                  <th className="px-5 py-3 font-medium">Bounds (Lon/Lat)</th>
                  <th className="px-5 py-3 font-medium">Zoom</th>
                  <th className="px-5 py-3 font-medium">Size</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {mapRegions.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-50/80">
                    <td className="px-5 py-3">
                      <div className="font-medium text-zinc-950">
                        {r.displayName ?? r.name}
                      </div>
                      <div className="font-mono text-[11px] text-zinc-400">{r.url}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-zinc-600">
                      {r.minLon.toFixed(2)}, {r.minLat.toFixed(2)} → {r.maxLon.toFixed(2)},{' '}
                      {r.maxLat.toFixed(2)}
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-700">
                      z{r.minZoom}–{r.maxZoom}
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-700">
                      {formatBytes(r.sizeBytes)}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          r.isStub
                            ? 'bg-zinc-100 text-zinc-500'
                            : 'bg-zinc-950 text-white'
                        }`}
                      >
                        {r.isStub ? 'Placeholder Stub' : r.isPrimary ? 'Primary' : 'City Extract'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {!r.isPrimary && (
                        <button
                          type="button"
                          onClick={() => {
                            if (!session) return;
                            void apiDeleteMapRegion(session.accessToken, r.id)
                              .then(() => refreshData(session.accessToken))
                              .catch((err) =>
                                setError(err instanceof Error ? err.message : 'Delete failed'),
                              );
                          }}
                          className="lo-press inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100"
                        >
                          <Trash2 className="h-3 w-3" />
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <LiveLogTerminal
          accessToken={session.accessToken}
          onRetentionUpdated={() => void refreshData(session.accessToken)}
        />
      </main>
    </div>
  );
}
