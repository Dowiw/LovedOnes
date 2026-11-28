'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowUpCircle,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  CloudDownload,
  Cpu,
  Database,
  Globe,
  HardDrive,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Loader2,
  QrCode,
  Radio,
  RefreshCw,
  Share2,
  Shield,
  Terminal,
  Trash2,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import {
  DEFAULT_EXACT_HALO_COLOR,
  DEFAULT_FEATURE_POLICIES,
  formatCountdownRemaining,
  isSafeAvatarUrl,
  isSafeLoginBackgroundUrl,
  isWorldOverviewRegion,
  type FeaturePolicies,
  type MapDownloadJob,
  type MapRegion,
  type RegistrationRequestItem,
  type SystemTelemetry,
  type SystemUpdateStatus,
  type TileDownloadPolicy,
  type TileDownloadRequestItem,
  WORLD_OVERVIEW_REGION_ID,
} from '@loved-ones/shared';
import {
  AdminNoticesBanner,
  ResourceAllocationPanels,
} from '@/components/AdminResourcePanels';
import { LiveLogTerminal } from '@/components/LiveLogTerminal';
import { LoadingInlineBadge, LoadingListSkeleton } from '@/components/LoadingSkeletons';
import { NavBar } from '@/components/NavBar';
import { QrInvitePanel } from '@/components/QrInviteModal';
import {
  ACCOUNT_REMOVED_EVENT,
  apiApproveAdminMapRequest,
  apiApproveRegistrationRequest,
  apiCancelScheduledSystemUpdate,
  apiDeleteMapRegion,
  apiDeleteUserAccount,
  apiDenyAdminMapRequest,
  apiDenyRegistrationRequest,
  apiDismissSystemUpdateError,
  apiFetchAdminFeaturePolicies,
  apiFetchAdminMapRequests,
  apiFetchGroups,
  apiFetchLoginAppearance,
  apiFetchMapJobs,
  apiFetchMapRegions,
  apiFetchRegistrationRequests,
  apiFetchSystemUpdateStatus,
  apiFetchTelemetry,
  apiRequestWorldOverviewDownload,
  apiScheduleSystemUpdate,
  apiTriggerSystemUpdate,
  apiUpdateAdminFeaturePolicies,
  apiUpdateLoginAppearance,
  formatBytes,
  GroupItem,
  loadSession,
  saveSession,
  StoredSession,
} from '@/lib/api';

const MAX_LOGIN_BG_WIDTH = 1600;
const MAX_LOGIN_BG_HEIGHT = 1200;

async function resizeLoginBackgroundFile(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode image file'));
      el.src = objectUrl;
    });

    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    if (!Number.isFinite(natW) || !Number.isFinite(natH) || natW <= 0 || natH <= 0) {
      throw new Error('Invalid image dimensions');
    }

    const scale = Math.min(1, MAX_LOGIN_BG_WIDTH / natW, MAX_LOGIN_BG_HEIGHT / natH);
    const targetW = Math.max(1, Math.round(natW * scale));
    const targetH = Math.max(1, Math.round(natH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context unavailable');
    }
    ctx.drawImage(img, 0, 0, targetW, targetH);

    let dataUrl = canvas.toDataURL('image/webp', 0.84);
    if (!dataUrl.startsWith('data:image/webp') || !isSafeLoginBackgroundUrl(dataUrl)) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    }
    if (!isSafeLoginBackgroundUrl(dataUrl)) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.68);
    }
    if (!isSafeLoginBackgroundUrl(dataUrl)) {
      throw new Error('Processed photo exceeds the 1.5 MB limit. Try a smaller image.');
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function AdminDashboardPage() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [mapRegions, setMapRegions] = useState<MapRegion[]>([]);
  const [mapJobs, setMapJobs] = useState<MapDownloadJob[]>([]);
  const [registrationRequests, setRegistrationRequests] = useState<RegistrationRequestItem[]>([]);
  const [reviewingRequestId, setReviewingRequestId] = useState<string | null>(null);
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [startingUpdate, setStartingUpdate] = useState(false);
  const [dismissingUpdateError, setDismissingUpdateError] = useState(false);
  const [confirmUpdateMode, setConfirmUpdateMode] = useState<'pull' | 'rebuild' | null>(null);
  const [reconnectingDuringUpdate, setReconnectingDuringUpdate] = useState(false);
  const [showUpdateLogs, setShowUpdateLogs] = useState(false);
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduleDateTimeInput, setScheduleDateTimeInput] = useState('');
  const [scheduleRebuildEvenIfCurrent, setScheduleRebuildEvenIfCurrent] = useState(false);
  const [schedulingUpdate, setSchedulingUpdate] = useState(false);
  const [featurePolicies, setFeaturePolicies] = useState<FeaturePolicies>(DEFAULT_FEATURE_POLICIES);
  const [savingPolicyKey, setSavingPolicyKey] = useState<string | null>(null);
  const [policyFeedback, setPolicyFeedback] = useState<string | null>(null);
  const [mapRequests, setMapRequests] = useState<TileDownloadRequestItem[]>([]);
  const [reviewingMapRequestId, setReviewingMapRequestId] = useState<string | null>(null);
  const [loginBackgroundUrl, setLoginBackgroundUrl] = useState<string | null>(null);
  const [loginBgUrlInput, setLoginBgUrlInput] = useState('');
  const [showLoginBgUrlInput, setShowLoginBgUrlInput] = useState(false);
  const [savingLoginBg, setSavingLoginBg] = useState(false);
  const [loginBgFeedback, setLoginBgFeedback] = useState<string | null>(null);
  const [loginBgError, setLoginBgError] = useState<string | null>(null);
  const loginBgFileInputRef = useRef<HTMLInputElement | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [downloadingWorldOverview, setDownloadingWorldOverview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(loadSession());
    const onRemoved = () => {
      window.location.assign('/?removed=1');
    };
    window.addEventListener(ACCOUNT_REMOVED_EVENT, onRemoved);
    return () => window.removeEventListener(ACCOUNT_REMOVED_EVENT, onRemoved);
  }, []);

  const refreshData = useCallback(async (token: string, isManual = false) => {
    if (isManual) setManualRefreshing(true);
    try {
      const [stats, grpList, regionsData, jobs, sysUpdate, regReqs, appearance, policies, tileReqs] =
        await Promise.all([
          apiFetchTelemetry(token),
          apiFetchGroups(token),
          apiFetchMapRegions(),
          apiFetchMapJobs(token),
          apiFetchSystemUpdateStatus(token, false).catch(() => null),
          apiFetchRegistrationRequests(token).catch(() => null),
          apiFetchLoginAppearance(token).catch(() => null),
          apiFetchAdminFeaturePolicies(token).catch(() => null),
          apiFetchAdminMapRequests(token).catch(() => null),
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
      if (appearance) {
        setLoginBackgroundUrl(appearance.loginBackgroundUrl);
      }
      if (policies) {
        setFeaturePolicies(policies);
      }
      if (tileReqs) {
        setMapRequests(tileReqs);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load telemetry');
    } finally {
      setTelemetryLoading(false);
      if (isManual) setManualRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const hasCountdown =
      registrationRequests.some((r) => r.status === 'PENDING') ||
      Boolean(updateStatus?.scheduledUpdate?.scheduledFor);
    if (!hasCountdown) return;
    const ticker = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, [registrationRequests, updateStatus?.scheduledUpdate?.scheduledFor]);

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

  const handleRemoveUser = useCallback(
    async (userId: string) => {
      if (!session) return;
      setRemovingUserId(userId);
      try {
        await apiDeleteUserAccount(session.accessToken, userId);
        setConfirmRemoveUserId(null);
        await refreshData(session.accessToken);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove profile');
      } finally {
        setRemovingUserId(null);
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

  const handleDismissUpdateError = useCallback(async () => {
    if (!session) return;
    setDismissingUpdateError(true);
    try {
      const next = await apiDismissSystemUpdateError(session.accessToken);
      setUpdateStatus(next);
      setShowUpdateLogs(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss system update status');
    } finally {
      setDismissingUpdateError(false);
    }
  }, [session]);

  const handleSaveLoginBackground = useCallback(
    async (nextUrl: string | null) => {
      if (!session) return;
      setSavingLoginBg(true);
      setLoginBgError(null);
      setLoginBgFeedback(null);
      try {
        const res = await apiUpdateLoginAppearance(session.accessToken, nextUrl);
        setLoginBackgroundUrl(res.loginBackgroundUrl);
        setShowLoginBgUrlInput(false);
        setLoginBgUrlInput('');
        setLoginBgFeedback(
          res.loginBackgroundUrl ? 'Login background photo updated.' : 'Reset to default background.',
        );
      } catch (err) {
        setLoginBgError(
          err instanceof Error ? err.message : 'Failed to update login screen background',
        );
      } finally {
        setSavingLoginBg(false);
      }
    },
    [session],
  );

  const handleSelectLoginBgFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      setSavingLoginBg(true);
      setLoginBgError(null);
      setLoginBgFeedback(null);
      try {
        const dataUrl = await resizeLoginBackgroundFile(file);
        await handleSaveLoginBackground(dataUrl);
      } catch (err) {
        setLoginBgError(err instanceof Error ? err.message : 'Could not process image file');
        setSavingLoginBg(false);
      }
    },
    [handleSaveLoginBackground],
  );

  const handleApplyLoginBgUrl = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = loginBgUrlInput.trim();
      if (!isSafeLoginBackgroundUrl(trimmed)) {
        setLoginBgError('Enter a valid http:// or https:// image URL.');
        return;
      }
      await handleSaveLoginBackground(trimmed);
    },
    [loginBgUrlInput, handleSaveLoginBackground],
  );

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

  const handleScheduleUpdate = useCallback(
    async (input: { runAt?: string; delayMinutes?: number; rebuildEvenIfCurrent?: boolean }) => {
      if (!session) return;
      setSchedulingUpdate(true);
      try {
        const next = await apiScheduleSystemUpdate(session.accessToken, {
          ...input,
          rebuildEvenIfCurrent: input.rebuildEvenIfCurrent ?? scheduleRebuildEvenIfCurrent,
        });
        setUpdateStatus(next);
        setShowSchedulePicker(false);
        setScheduleDateTimeInput('');
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to schedule system update');
      } finally {
        setSchedulingUpdate(false);
      }
    },
    [session, scheduleRebuildEvenIfCurrent],
  );

  const handleCancelScheduledUpdate = useCallback(async () => {
    if (!session) return;
    setSchedulingUpdate(true);
    try {
      const next = await apiCancelScheduledSystemUpdate(session.accessToken);
      setUpdateStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel scheduled update');
    } finally {
      setSchedulingUpdate(false);
    }
  }, [session]);

  const handleUpdateFeaturePolicy = useCallback(
    async (
      key: string,
      patch: Partial<Pick<FeaturePolicies, 'shareLinksEnabled' | 'trackerTokensEnabled' | 'tileDownloadPolicy'>>,
    ) => {
      if (!session) return;
      setSavingPolicyKey(key);
      setPolicyFeedback(null);
      try {
        const updated = await apiUpdateAdminFeaturePolicies(session.accessToken, patch);
        setFeaturePolicies(updated);
        setPolicyFeedback('Feature access policy saved.');
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update feature policy');
      } finally {
        setSavingPolicyKey(null);
      }
    },
    [session],
  );

  const handleReviewMapRequest = useCallback(
    async (requestId: string, action: 'approve' | 'deny') => {
      if (!session) return;
      setReviewingMapRequestId(requestId);
      try {
        if (action === 'approve') {
          await apiApproveAdminMapRequest(session.accessToken, requestId);
        } else {
          await apiDenyAdminMapRequest(session.accessToken, requestId);
        }
        await refreshData(session.accessToken);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${action} tile download request`);
      } finally {
        setReviewingMapRequestId(null);
      }
    },
    [session, refreshData],
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
      <div className="min-h-dvh bg-[#f4f4f5] pb-[var(--lo-safe-bottom,0px)] dark:bg-zinc-950">
        <NavBar
          user={session?.user ?? null}
          onSignOut={() => {
            saveSession(null);
            setSession(null);
          }}
        />
        <main className="mx-auto max-w-md px-4 py-16 text-center">
          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-8 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
            <h1 className="text-lg font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
              Host Admin Access Required
            </h1>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Sign in as the Host Admin on the main map to inspect storage, telemetry, and live logs.
            </p>
            <Link
              href="/"
              className="lo-press mt-5 inline-block rounded-lg bg-zinc-950 px-5 py-2 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              Back to Map
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#f4f4f5] pb-[var(--lo-safe-bottom,0px)] dark:bg-zinc-950">
      <NavBar
        user={session.user}
        onSignOut={() => {
          saveSession(null);
          setSession(null);
        }}
      />

      <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
                  System Telemetry
                </h1>
                {telemetry === null && telemetryLoading && (
                  <LoadingInlineBadge label="Loading telemetry…" />
                )}
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Live 5s updates · Storage footprint · Per-account compute &amp; sockets
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={manualRefreshing}
              onClick={() => void refreshData(session.accessToken, true)}
              className="lo-press flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 hover:text-zinc-950 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${manualRefreshing ? 'animate-spin' : ''}`} />
              {manualRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => setShowInviteModal((v) => !v)}
              className="lo-press flex items-center gap-1.5 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              <QrCode className="h-3.5 w-3.5" />
              New Invite
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300">
            {error}
          </div>
        )}

        {telemetry?.logStorageAlert && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              Log directory ({telemetry.logDir}) is at {telemetry.logStoragePercent}% of configured
              storage limit.
            </span>
          </div>
        )}

        {telemetry?.notices && telemetry.notices.length > 0 && (
          <AdminNoticesBanner
            accessToken={session.accessToken}
            notices={telemetry.notices}
            onUpdated={() => void refreshData(session.accessToken)}
          />
        )}

        {showInviteModal && (
          <QrInvitePanel
            accessToken={session.accessToken}
            groups={groups}
            onClose={() => setShowInviteModal(false)}
          />
        )}

        <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              <UserPlus className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
              Account Requests
              {registrationRequests.filter((r) => r.status === 'PENDING').length > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/70 dark:text-amber-300">
                  {registrationRequests.filter((r) => r.status === 'PENDING').length} pending
                </span>
              )}
            </div>
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
              1 request per IP · Expires automatically after 24h
            </span>
          </div>

          {telemetryLoading && telemetry === null && registrationRequests.length === 0 ? (
            <div className="p-4">
              <LoadingListSkeleton rows={2} variant="people" label="Checking account requests…" />
            </div>
          ) : registrationRequests.length === 0 ? (
            <div className="px-5 py-5 text-xs text-zinc-500 dark:text-zinc-400">
              No pending or recent account requests yet. New website and mobile account requests
              appear here with a 24-hour countdown timer.
            </div>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
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
                        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-100 text-xs font-bold text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
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
                          <span className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                            {req.username}
                          </span>
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">{req.email}</span>
                          {req.groupName && (
                            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                              Group: {req.groupName}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
                          <span className="font-mono">IP {req.requesterIp}</span>
                          {isPending && countdown && (
                            <span className="inline-flex items-center gap-1 font-mono text-amber-700 dark:text-amber-300">
                              <Clock className="h-3 w-3" />
                              Expires in {countdown}
                            </span>
                          )}
                          {!isPending && (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                req.status === 'APPROVED'
                                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                                  : req.status === 'DENIED'
                                    ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                                    : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
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
                          className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
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
                          className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-950"
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

        <section className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
                <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                  Feature Access Policies
                </h2>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Control which optional member capabilities are enabled server-wide. Changes take
                effect immediately across Web and Mobile.
              </p>
            </div>
            {policyFeedback && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                <Check className="h-3 w-3" />
                {policyFeedback}
              </span>
            )}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {/* Public Share Links Toggle */}
            <div className="flex flex-col justify-between gap-3 rounded-lg border border-zinc-200/80 bg-zinc-50/60 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-950 dark:text-zinc-50">
                    <Share2 className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                    Public Share Links
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      featurePolicies.shareLinksEnabled
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                        : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {featurePolicies.shareLinksEnabled ? 'On' : 'Disabled'}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                  Allow members to generate temporary public meetup share links.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {([true, false] as const).map((val) => {
                  const active = featurePolicies.shareLinksEnabled === val;
                  return (
                    <button
                      key={String(val)}
                      type="button"
                      disabled={savingPolicyKey !== null}
                      onClick={() =>
                        void handleUpdateFeaturePolicy('shareLinksEnabled', {
                          shareLinksEnabled: val,
                        })
                      }
                      className={`lo-press flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition disabled:opacity-60 ${
                        active
                          ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                          : 'border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {val ? 'On' : 'Disabled'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* HTTP Tracker Token Toggle */}
            <div className="flex flex-col justify-between gap-3 rounded-lg border border-zinc-200/80 bg-zinc-50/60 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-950 dark:text-zinc-50">
                    <KeyRound className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                    HTTP Tracker Tokens
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      featurePolicies.trackerTokensEnabled
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                        : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {featurePolicies.trackerTokensEnabled ? 'On' : 'Disabled'}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                  Allow members to issue OwnTracks / Overland HTTP ingestion tokens.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {([true, false] as const).map((val) => {
                  const active = featurePolicies.trackerTokensEnabled === val;
                  return (
                    <button
                      key={String(val)}
                      type="button"
                      disabled={savingPolicyKey !== null}
                      onClick={() =>
                        void handleUpdateFeaturePolicy('trackerTokensEnabled', {
                          trackerTokensEnabled: val,
                        })
                      }
                      className={`lo-press flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition disabled:opacity-60 ${
                        active
                          ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                          : 'border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {val ? 'On' : 'Disabled'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Server Tile Downloads Policy */}
            <div className="flex flex-col justify-between gap-3 rounded-lg border border-zinc-200/80 bg-zinc-50/60 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-950 dark:text-zinc-50">
                    <CloudDownload className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                    Server Tile Downloads
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      featurePolicies.tileDownloadPolicy === 'auto'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                        : featurePolicies.tileDownloadPolicy === 'manual'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300'
                          : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {featurePolicies.tileDownloadPolicy === 'auto'
                      ? 'Auto'
                      : featurePolicies.tileDownloadPolicy === 'manual'
                        ? 'Manual'
                        : 'Disabled'}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                  {featurePolicies.tileDownloadPolicy === 'manual'
                    ? 'Non-admins may request a tile download once and wait for Host Admin approval.'
                    : featurePolicies.tileDownloadPolicy === 'disabled'
                      ? 'Only Host Admins can trigger new regional map downloads.'
                      : 'Members can automatically trigger regional PMTiles downloads.'}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    ['auto', 'Auto'],
                    ['manual', 'Manual'],
                    ['disabled', 'Disabled'],
                  ] as readonly [TileDownloadPolicy, string][]
                ).map(([mode, label]) => {
                  const active = featurePolicies.tileDownloadPolicy === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      disabled={savingPolicyKey !== null}
                      onClick={() =>
                        void handleUpdateFeaturePolicy('tileDownloadPolicy', {
                          tileDownloadPolicy: mode,
                        })
                      }
                      className={`lo-press rounded-md px-2 py-1.5 text-[11px] font-semibold transition disabled:opacity-60 ${
                        active
                          ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                          : 'border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                  Remote System Update
                </h2>
                {updateStatus ? (
                  updateStatus.running ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-0.5 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {updateStatus.phase === 'pulling'
                        ? 'Pulling updates'
                        : updateStatus.phase === 'building'
                          ? 'Building containers'
                          : 'Restarting services'}
                    </span>
                  ) : !updateStatus.enabled ? (
                    <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      Local / Disabled
                    </span>
                  ) : updateStatus.updateAvailable ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/70 dark:text-amber-300">
                      <ArrowUpCircle className="h-3 w-3" />
                      {updateStatus.commitsBehind} update
                      {updateStatus.commitsBehind === 1 ? '' : 's'} available
                    </span>
                  ) : updateStatus.phase === 'failed' ? (
                    <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-950/70 dark:text-rose-300">
                      Last update failed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Up to date
                    </span>
                  )
                ) : (
                  <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    Checking...
                  </span>
                )}
              </div>

              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {updateStatus?.currentCommit ? (
                  <>
                    Running{' '}
                    <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">
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
                className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3.5 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:hover:text-white"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
                {checkingUpdate ? 'Checking...' : 'Check Updates'}
              </button>

              {confirmUpdateMode ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                    {confirmUpdateMode === 'pull'
                      ? 'Pull & restart stack?'
                      : 'Rebuild & restart stack?'}
                  </span>
                  <button
                    type="button"
                    disabled={startingUpdate}
                    onClick={() => void handleTriggerUpdate(confirmUpdateMode === 'rebuild')}
                    className="lo-press inline-flex items-center gap-1 rounded-md bg-zinc-950 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
                  >
                    {startingUpdate && <Loader2 className="h-3 w-3 animate-spin" />}
                    Confirm
                  </button>
                  <button
                    type="button"
                    disabled={startingUpdate}
                    onClick={() => setConfirmUpdateMode(null)}
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-700"
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
                  className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
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
                  className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  Rebuild &amp; Restart
                </button>
              )}

              {updateStatus && updateStatus.enabled && !updateStatus.running && (
                <button
                  type="button"
                  disabled={schedulingUpdate || Boolean(updateStatus.workingTreeDirty)}
                  onClick={() => setShowSchedulePicker((v) => !v)}
                  className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:hover:text-white"
                >
                  <CalendarClock className="h-3.5 w-3.5" />
                  {updateStatus.scheduledUpdate ? 'Reschedule' : 'Schedule'}
                </button>
              )}

              {updateStatus && updateStatus.logs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowUpdateLogs((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                >
                  <Terminal className="h-3.5 w-3.5" />
                  {showUpdateLogs ? 'Hide Output' : 'Build Output'}
                </button>
              )}
            </div>
          </div>

          {updateStatus?.scheduledUpdate && !updateStatus.running && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50/90 px-3.5 py-2.5 text-xs text-sky-900 dark:border-sky-500/30 dark:bg-sky-950/40 dark:text-sky-100">
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2 font-semibold">
                  <CalendarClock className="h-3.5 w-3.5 text-sky-700 dark:text-sky-300" />
                  <span>
                    Scheduled Restart in{' '}
                    <span className="font-mono">
                      {formatCountdownRemaining(updateStatus.scheduledUpdate.scheduledFor, nowMs)}
                    </span>
                  </span>
                  {updateStatus.scheduledUpdate.rebuildEvenIfCurrent && (
                    <span className="rounded-full bg-sky-200/70 px-2 py-0.5 text-[10px] font-semibold text-sky-900 dark:bg-sky-900/70 dark:text-sky-200">
                      Force rebuild
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-sky-800/80 dark:text-sky-200/80">
                  Local: {new Date(updateStatus.scheduledUpdate.scheduledFor).toLocaleString()} ·
                  UTC: {new Date(updateStatus.scheduledUpdate.scheduledFor).toUTCString()} · Set by{' '}
                  {updateStatus.scheduledUpdate.scheduledByUsername}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={startingUpdate || schedulingUpdate}
                  onClick={() =>
                    void handleTriggerUpdate(
                      Boolean(updateStatus.scheduledUpdate?.rebuildEvenIfCurrent),
                    )
                  }
                  className="lo-press rounded-md bg-zinc-950 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
                >
                  Run Now
                </button>
                <button
                  type="button"
                  disabled={schedulingUpdate}
                  onClick={() => void handleCancelScheduledUpdate()}
                  className="lo-press rounded-md border border-sky-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-sky-900 hover:bg-sky-100 disabled:opacity-50 dark:border-sky-500/40 dark:bg-sky-950/60 dark:text-sky-100 dark:hover:bg-sky-900"
                >
                  Cancel Schedule
                </button>
              </div>
            </div>
          )}

          {showSchedulePicker && updateStatus?.enabled && !updateStatus.running && (
            <div className="mt-3 space-y-2.5 rounded-lg border border-zinc-200/80 bg-zinc-50/80 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-800/70">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                  Schedule Update &amp; Restart
                </span>
                <label className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                  <input
                    type="checkbox"
                    checked={scheduleRebuildEvenIfCurrent}
                    onChange={(e) => setScheduleRebuildEvenIfCurrent(e.target.checked)}
                    className="rounded border-zinc-300 dark:border-zinc-600 dark:bg-zinc-800"
                  />
                  Rebuild even if already up to date
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={schedulingUpdate}
                  onClick={() => void handleScheduleUpdate({ delayMinutes: 15 })}
                  className="lo-press rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-800 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-700"
                >
                  In 15m
                </button>
                <button
                  type="button"
                  disabled={schedulingUpdate}
                  onClick={() => void handleScheduleUpdate({ delayMinutes: 60 })}
                  className="lo-press rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-800 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-700"
                >
                  In 1h
                </button>
                <button
                  type="button"
                  disabled={schedulingUpdate}
                  onClick={() => {
                    const target = new Date();
                    target.setHours(3, 0, 0, 0);
                    if (target.getTime() <= Date.now() + 60_000) {
                      target.setDate(target.getDate() + 1);
                    }
                    void handleScheduleUpdate({ runAt: target.toISOString() });
                  }}
                  className="lo-press rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-800 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-700"
                >
                  Tonight 03:00
                </button>
                <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
                  <input
                    type="datetime-local"
                    value={scheduleDateTimeInput}
                    onChange={(e) => setScheduleDateTimeInput(e.target.value)}
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <button
                    type="button"
                    disabled={schedulingUpdate || !scheduleDateTimeInput}
                    onClick={() => {
                      const parsed = new Date(scheduleDateTimeInput);
                      if (Number.isNaN(parsed.getTime())) {
                        setError('Enter a valid local date and time.');
                        return;
                      }
                      void handleScheduleUpdate({ runAt: parsed.toISOString() });
                    }}
                    className="lo-press rounded-md bg-zinc-950 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
                  >
                    Set Time
                  </button>
                </div>
              </div>
            </div>
          )}

          {updateStatus?.workingTreeDirty && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                Host repository has uncommitted changes to tracked files. Clean or commit them on
                the host before triggering a remote update.
              </span>
            </div>
          )}

          {reconnectingDuringUpdate && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-700 dark:text-zinc-300" />
              <span>
                Updated containers are swapping cleanly — reconnecting automatically in a few
                seconds...
              </span>
            </div>
          )}

          {updateStatus?.error && !updateStatus.running && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300">
              <span className="min-w-0 break-words">{updateStatus.error}</span>
              <button
                type="button"
                disabled={dismissingUpdateError}
                onClick={() => void handleDismissUpdateError()}
                className="lo-press inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-300/70 bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-white disabled:opacity-60 dark:border-rose-500/40 dark:bg-rose-950/80 dark:text-rose-200 dark:hover:bg-rose-900"
              >
                {dismissingUpdateError ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <X className="h-3 w-3" />
                )}
                Dismiss
              </button>
            </div>
          )}

          {updateStatus?.phase === 'completed' && updateStatus.finishedAt && !updateStatus.running && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>
                Last update completed cleanly
                {updateStatus.targetCommit ? ` at ${updateStatus.targetCommit}` : ''} (
                {new Date(updateStatus.finishedAt).toLocaleString()}).
              </span>
            </div>
          )}

          {updateStatus && updateStatus.pendingCommits.length > 0 && (
            <div className="mt-3 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3 dark:border-zinc-700 dark:bg-zinc-800/70">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Pending Updates ({updateStatus.upstreamBranch ?? 'upstream'})
              </div>
              <ul className="mt-1.5 space-y-1 text-xs text-zinc-700 dark:text-zinc-300">
                {updateStatus.pendingCommits.map((c) => (
                  <li key={c.sha} className="flex items-baseline gap-2">
                    <span className="font-mono text-[11px] font-semibold text-zinc-900 dark:text-zinc-100">
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
              <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200 dark:border dark:border-zinc-800">
                {updateStatus.logs.join('\n')}
              </pre>
            )}
        </section>

        <section className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
                <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                  Login Screen Background
                </h2>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Choose a custom photo displayed behind the sign-in and invite cards. Photos are
                automatically resized for fast loading.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={loginBgFileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => void handleSelectLoginBgFile(e)}
                className="hidden"
              />
              <button
                type="button"
                disabled={savingLoginBg}
                onClick={() => loginBgFileInputRef.current?.click()}
                className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                {savingLoginBg ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {loginBackgroundUrl ? 'Change Photo' : 'Upload Photo'}
              </button>
              <button
                type="button"
                disabled={savingLoginBg}
                onClick={() => {
                  setShowLoginBgUrlInput((v) => !v);
                  setLoginBgError(null);
                  setLoginBgFeedback(null);
                }}
                className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 hover:text-zinc-950 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 dark:hover:text-white"
              >
                <Link2 className="h-3.5 w-3.5" />
                Image URL
              </button>
              {loginBackgroundUrl && (
                <button
                  type="button"
                  disabled={savingLoginBg}
                  onClick={() => void handleSaveLoginBackground(null)}
                  className="lo-press inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-60 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-950"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Reset Default
                </button>
              )}
            </div>
          </div>

          {showLoginBgUrlInput && (
            <form onSubmit={(e) => void handleApplyLoginBgUrl(e)} className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="url"
                required
                value={loginBgUrlInput}
                onChange={(e) => setLoginBgUrlInput(e.target.value)}
                placeholder="https://example.com/photo.jpg"
                className="min-w-[220px] flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
              <button
                type="submit"
                disabled={savingLoginBg}
                className="lo-press rounded-lg bg-zinc-950 px-3.5 py-2 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                Apply URL
              </button>
            </form>
          )}

          {loginBgError && (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300">
              {loginBgError}
            </div>
          )}

          {loginBgFeedback && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>{loginBgFeedback}</span>
            </div>
          )}

          <div className="relative mt-4 flex h-44 w-full items-center justify-center overflow-hidden rounded-xl border border-zinc-200/80 bg-[#f4f4f5] dark:border-zinc-800 dark:bg-zinc-950">
            {isSafeLoginBackgroundUrl(loginBackgroundUrl) ? (
              <>
                <img
                  src={loginBackgroundUrl}
                  alt="Login screen background preview"
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/15 to-black/35 dark:from-zinc-950/45 dark:via-zinc-950/35 dark:to-zinc-950/60" />
              </>
            ) : (
              <>
                <div className="pointer-events-none absolute -left-10 -top-10 h-32 w-32 rounded-full bg-zinc-300/50 blur-2xl dark:bg-zinc-800/40" />
                <div className="pointer-events-none absolute -bottom-10 -right-10 h-32 w-32 rounded-full bg-zinc-200/70 blur-2xl dark:bg-zinc-800/30" />
              </>
            )}
            <div className="relative w-48 rounded-lg border border-white/75 bg-white/85 px-4 py-3 text-center shadow-lg backdrop-blur-md dark:border-zinc-700/80 dark:bg-zinc-900/85">
              <div className="text-xs font-bold text-zinc-900 dark:text-zinc-50">LovedOnes</div>
              <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                {loginBackgroundUrl ? 'Custom background active' : 'Default monochrome background'}
              </div>
              <div className="mt-2 h-2 w-full rounded bg-zinc-200/80 dark:bg-zinc-800" />
              <div className="mt-1.5 h-4 w-full rounded bg-zinc-900 dark:bg-zinc-100" />
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
            <div className="flex items-center justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <span>Log Disk Usage</span>
              <HardDrive className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
            </div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
              {telemetry ? (
                formatBytes(telemetry.logStorageBytes)
              ) : (
                <span className="inline-block h-7 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              )}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-50">
              Limit: {telemetry ? formatBytes(telemetry.maxLogStorageBytes) : '—'} (
              {telemetry?.logStoragePercent ?? 0}%)
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
            <div className="flex items-center justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <span>Spatial Database</span>
              <Database className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
            </div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
              {telemetry ? (
                formatBytes(telemetry.databaseBytes)
              ) : (
                <span className="inline-block h-7 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              )}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              {telemetry?.totalLocationPoints.toLocaleString() ?? 0} stored pings
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
            <div className="flex items-center justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <span>Active Connections</span>
              <Radio className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
            </div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
              {telemetry ? (
                telemetry.totalActiveSockets
              ) : (
                <span className="inline-block h-7 w-12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              )}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              Open live WebSocket clients
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
            <div className="flex items-center justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <span>Accounts</span>
              <Cpu className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
            </div>
            <div className="mt-2 text-2xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
              {telemetry ? (
                telemetry.users.length
              ) : (
                <span className="inline-block h-7 w-12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              )}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              Sorted by recent compute
            </div>
          </div>
        </section>

        <ResourceAllocationPanels
          accessToken={session.accessToken}
          telemetry={telemetry}
          onUpdated={() => void refreshData(session.accessToken)}
        />

        <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="border-b border-zinc-100 px-5 py-3.5 text-sm font-semibold text-zinc-950 dark:border-zinc-800 dark:text-zinc-50">
            Account Resource Usage
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50/90 text-zinc-500 dark:bg-zinc-950/60 dark:text-zinc-400">
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
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {!telemetry && telemetryLoading && (
                  <tr>
                    <td colSpan={10} className="px-5 py-6">
                      <LoadingListSkeleton
                        rows={3}
                        variant="compact"
                        label="Loading account resource usage…"
                      />
                    </td>
                  </tr>
                )}
                {telemetry?.users.map((u) => {
                  const isSelf = u.userId === session.user.id;
                  const confirming = confirmRemoveUserId === u.userId;
                  const busy = removingUserId === u.userId;
                  return (
                    <tr key={u.userId} className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/50">
                      <td className="px-5 py-3">
                        <div className="font-medium text-zinc-950 dark:text-zinc-50">
                          {u.username}
                        </div>
                        <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                          {u.email}
                        </div>
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-900 dark:text-zinc-100">
                        {u.cpuMsPerMin.toFixed(2)} ms
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-900 dark:text-zinc-100">
                        {u.pingsPerMin}
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-600 dark:text-zinc-300">
                        {u.cpuMsTotal.toFixed(2)} ms
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-600 dark:text-zinc-300">
                        {u.eventsCount}
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-600 dark:text-zinc-300">
                        {u.activeSockets}
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-600 dark:text-zinc-300">
                        {formatBytes(u.redisMemoryBytes)}
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-700 dark:text-zinc-200">
                        <div>{formatBytes(u.totalDbBytes || u.locationBytes)}</div>
                        <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
                          {formatBytes(u.locationBytes)} pts · {formatBytes(u.estimatedIndexBytes)} idx
                          {u.messageBytes > 0 ? ` · ${formatBytes(u.messageBytes)} msg` : ''}
                          {u.avatarBytes > 0 ? ` · ${formatBytes(u.avatarBytes)} img` : ''}
                        </div>
                      </td>
                      <td className="px-5 py-3 font-mono text-zinc-600 dark:text-zinc-300">
                        {u.locationPoints}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {isSelf ? (
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            You
                          </span>
                        ) : confirming ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRemoveUser(u.userId)}
                              className="lo-press inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                            >
                              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                              Confirm
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmRemoveUserId(null)}
                              className="rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRemoveUserId(u.userId)}
                            className="lo-press inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-950"
                          >
                            <Trash2 className="h-3 w-3" />
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white/95 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              <CloudDownload className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
              Downloaded Map Regions ({mapRegions.filter((r) => !r.isStub).length})
            </div>
            <div className="flex items-center gap-2">
              {mapJobs.some((j) => j.status === 'resolving' || j.status === 'downloading') && (
                <span className="rounded-full bg-zinc-950 px-2.5 py-0.5 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950">
                  Download active
                </span>
              )}
              {(() => {
                const hasWorldOverview = mapRegions.some(
                  (r) => !r.isStub && isWorldOverviewRegion(r),
                );
                const worldJobActive = mapJobs.some(
                  (j) =>
                    (j.regionId === WORLD_OVERVIEW_REGION_ID ||
                      j.cityName === 'World Overview (z0-z5)') &&
                    (j.status === 'queued' || j.status === 'resolving' || j.status === 'downloading'),
                );
                if (hasWorldOverview) {
                  return (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-950/60 dark:text-emerald-300">
                      <Globe className="h-3 w-3" />
                      World Overview Ready
                    </span>
                  );
                }
                return (
                  <button
                    type="button"
                    disabled={downloadingWorldOverview || worldJobActive}
                    onClick={() => {
                      if (!session) return;
                      setDownloadingWorldOverview(true);
                      setError(null);
                      void apiRequestWorldOverviewDownload(session.accessToken)
                        .then(() => refreshData(session.accessToken))
                        .catch((err) =>
                          setError(
                            err instanceof Error
                              ? err.message
                              : 'Failed to request world overview download',
                          ),
                        )
                        .finally(() => setDownloadingWorldOverview(false));
                    }}
                    className="lo-press inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
                  >
                    {downloadingWorldOverview || worldJobActive ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Globe className="h-3.5 w-3.5" />
                    )}
                    {worldJobActive
                      ? 'Downloading World Overview…'
                      : 'Download World Overview (z0–z5)'}
                  </button>
                );
              })()}
            </div>
          </div>
          {mapRequests.length > 0 && (
            <div className="border-b border-zinc-100 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                  Member Tile Download Requests
                </span>
                {mapRequests.some((r) => r.status === 'PENDING') && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/70 dark:text-amber-300">
                    {mapRequests.filter((r) => r.status === 'PENDING').length} pending approval
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {mapRequests.map((req) => {
                  const isPending = req.status === 'PENDING';
                  const busy = reviewingMapRequestId === req.id;
                  return (
                    <div
                      key={req.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200/80 bg-white px-3.5 py-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-zinc-950 dark:text-zinc-50">
                            {req.displayName ?? req.cityName ?? 'Requested Region'}
                          </span>
                          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            by @{req.requesterUsername}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                          <span>
                            {req.latitude.toFixed(4)}, {req.longitude.toFixed(4)}
                          </span>
                          <span>· {new Date(req.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                      {isPending ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleReviewMapRequest(req.id, 'approve')}
                            className="lo-press inline-flex items-center gap-1 rounded-md bg-zinc-950 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
                          >
                            {busy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Check className="h-3 w-3" />
                            )}
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleReviewMapRequest(req.id, 'deny')}
                            className="lo-press inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-950"
                          >
                            <X className="h-3 w-3" />
                            Deny
                          </button>
                        </div>
                      ) : (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            req.status === 'APPROVED'
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                              : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                          }`}
                        >
                          {req.status}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50/90 text-zinc-500 dark:bg-zinc-950/60 dark:text-zinc-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Region</th>
                  <th className="px-5 py-3 font-medium">Bounds (Lon/Lat)</th>
                  <th className="px-5 py-3 font-medium">Zoom</th>
                  <th className="px-5 py-3 font-medium">Size</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {mapRegions.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/50">
                    <td className="px-5 py-3">
                      <div className="font-medium text-zinc-950 dark:text-zinc-50">
                        {r.displayName ?? r.name}
                      </div>
                      <div className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                        {r.url}
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                      {r.minLon.toFixed(2)}, {r.minLat.toFixed(2)} → {r.maxLon.toFixed(2)},{' '}
                      {r.maxLat.toFixed(2)}
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-700 dark:text-zinc-200">
                      z{r.minZoom}–{r.maxZoom}
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-700 dark:text-zinc-200">
                      {formatBytes(r.sizeBytes)}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          r.isStub
                            ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                            : isWorldOverviewRegion(r)
                              ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300'
                              : 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                        }`}
                      >
                        {r.isStub
                          ? 'Placeholder Stub'
                          : isWorldOverviewRegion(r)
                            ? 'World Overview'
                            : r.isPrimary
                              ? 'Primary'
                              : 'City Extract'}
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
                          className="lo-press inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-950"
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
