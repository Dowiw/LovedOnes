'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, Clock, Loader2, ShieldAlert, UserPlus } from 'lucide-react';
import {
  formatCountdownRemaining,
  isSafeLoginBackgroundUrl,
  withMinDelay,
  type PublicLoginConfig,
  type RegistrationRequestItem,
} from '@loved-ones/shared';
import { NavBar } from '@/components/NavBar';
import {
  apiCreateRegistrationRequest,
  apiFetchPublicConfig,
  apiFetchRegistrationRequestStatus,
  apiJoinInvite,
  apiLogin,
  apiPreviewInvite,
  apiRegister,
  InvitePreview,
  loadSession,
  saveSession,
  StoredSession,
} from '@/lib/api';

function JoinInviteInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') ?? '';

  const [session, setSession] = useState<StoredSession | null>(null);
  const [publicConfig, setPublicConfig] = useState<PublicLoginConfig | null>(null);
  const [pendingRequest, setPendingRequest] = useState<RegistrationRequestItem | null>(null);
  const [pendingNowMs, setPendingNowMs] = useState<number>(() => Date.now());
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    setSession(loadSession());
  }, []);

  useEffect(() => {
    if (session) return;
    let cancelled = false;
    void apiFetchPublicConfig()
      .then((cfg) => {
        if (!cancelled) setPublicConfig(cfg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (session || !pendingRequest || pendingRequest.status !== 'PENDING') return;
    const tick = window.setInterval(() => setPendingNowMs(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void apiFetchRegistrationRequestStatus(pendingRequest.id)
        .then(async (res) => {
          if (!res.request) return;
          setPendingRequest(res.request);
          if (res.request.status === 'APPROVED' && email && password) {
            try {
              const authed = await apiLogin(email, password);
              saveSession(authed);
              setSession(authed);
              router.push('/');
            } catch {
              // User can sign in manually on /
            }
          }
        })
        .catch(() => {});
    }, 4000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [session, pendingRequest, email, password, router]);

  useEffect(() => {
    if (!token) {
      setError('Missing invite token in URL.');
      setLoading(false);
      return;
    }
    void apiPreviewInvite(token)
      .then((data) => {
        setPreview(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Invite not found');
        setLoading(false);
      });
  }, [token]);

  async function handleJoinExisting() {
    if (!session || !token) return;
    setSubmitting(true);
    setError(null);
    try {
      await withMinDelay(apiJoinInvite(session.accessToken, token));
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join group');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegisterAndJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      const requireApproval = publicConfig ? publicConfig.requireAdminApproval : true;
      if (requireApproval) {
        const res = await withMinDelay(
          apiCreateRegistrationRequest({ email, username, password, inviteToken: token }),
        );
        setPendingRequest(res.request);
        setPendingNowMs(Date.now());
        return;
      }
      const created = await withMinDelay(
        apiRegister({ email, username, password, inviteToken: token }),
      );
      saveSession(created);
      setSession(created);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  const loginBgUrl =
    !session && isSafeLoginBackgroundUrl(publicConfig?.loginBackgroundUrl)
      ? publicConfig.loginBackgroundUrl
      : null;
  const requireApproval = publicConfig ? publicConfig.requireAdminApproval : true;

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#f4f4f5] pb-[var(--lo-safe-bottom,0px)] dark:bg-zinc-950">
      {loginBgUrl && (
        <>
          <img
            src={loginBgUrl}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/25 via-black/15 to-black/40 dark:from-zinc-950/55 dark:via-zinc-950/45 dark:to-zinc-950/70" />
        </>
      )}
      <div className="relative z-10">
        <NavBar
          user={session?.user ?? null}
          onSignOut={() => {
            saveSession(null);
            setSession(null);
          }}
        />
        <main className="mx-auto max-w-md px-4 py-14">
          <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-7 shadow-[0_12px_40px_rgba(9,9,11,0.08)] backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95 dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
            {loading ? (
              <div className="text-sm text-zinc-500 dark:text-zinc-400">Verifying invite token...</div>
            ) : error && !preview ? (
              <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400">
                <ShieldAlert className="h-5 w-5" />
                <span>{error}</span>
              </div>
            ) : preview ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950">
                    <UserPlus className="h-4 w-4" />
                  </span>
                  <h1 className="text-lg font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Group Invite</h1>
                </div>

                <div className="space-y-1.5 rounded-lg border border-zinc-200/80 bg-zinc-50/80 p-4 text-xs dark:border-zinc-800 dark:bg-zinc-950/60">
                  <div className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">{preview.groupName}</div>
                  <div className="text-zinc-500 dark:text-zinc-400">
                    Role: <span className="font-medium text-zinc-950 dark:text-zinc-100">{preview.assignedRole}</span>
                  </div>
                  <div className="text-zinc-500 dark:text-zinc-400">
                    Status:{' '}
                    <span
                      className={
                        preview.valid ? 'font-medium text-zinc-950 dark:text-zinc-100' : 'font-medium text-rose-600 dark:text-rose-400'
                      }
                    >
                      {preview.valid ? 'Active' : 'Expired / Exhausted'}
                    </span>
                  </div>
                </div>

                {error && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/50 dark:text-rose-300">
                    {error}
                  </div>
                )}

                {session ? (
                  <button
                    type="button"
                    disabled={!preview.valid || submitting}
                    onClick={() => void handleJoinExisting()}
                    className="lo-press relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-zinc-950 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-75 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
                  >
                    {submitting ? (
                      <>
                        <span className="lo-progress-bar absolute inset-y-0 left-0 w-1/3 bg-white/15 dark:bg-zinc-950/15" />
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </>
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    {submitting ? 'Joining...' : `Join as ${session.user.username}`}
                  </button>
                ) : pendingRequest ? (
                  <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/90 p-4 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200">
                    {pendingRequest.status === 'PENDING' ? (
                      <>
                        <div className="flex items-center gap-2 font-semibold">
                          <Clock className="h-4 w-4 shrink-0" />
                          <span>Waiting for Host Admin Approval</span>
                        </div>
                        <p className="leading-relaxed opacity-90">
                          Your request to create an account and join{' '}
                          <span className="font-semibold">{preview.groupName}</span> has been sent.
                          Once accepted by the Host Admin, you will be signed in automatically.
                        </p>
                        <div className="flex items-center justify-between font-mono text-[11px] opacity-80">
                          <span>
                            Expires in {formatCountdownRemaining(pendingRequest.expiresAt, pendingNowMs)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Checking...
                          </span>
                        </div>
                      </>
                    ) : pendingRequest.status === 'APPROVED' ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-300">
                          <CheckCircle2 className="h-4 w-4 shrink-0" />
                          <span>Account Approved!</span>
                        </div>
                        <Link
                          href="/"
                          className="lo-press inline-block rounded-lg bg-zinc-950 px-3.5 py-2 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950"
                        >
                          Continue to Sign In
                        </Link>
                      </div>
                    ) : (
                      <p>
                        {pendingRequest.status === 'DENIED'
                          ? 'Your account request was declined by the Host Admin.'
                          : 'Your account request expired.'}
                      </p>
                    )}
                  </div>
                ) : (
                  <form onSubmit={handleRegisterAndJoin} className="space-y-3">
                    {requireApproval && (
                      <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
                        New accounts require Host Admin approval before activation.
                      </div>
                    )}
                    <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Email
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
                      />
                    </label>
                    <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Username
                      <input
                        type="text"
                        required
                        minLength={2}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
                      />
                    </label>
                    <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Password
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={!preview.valid || submitting}
                      className="lo-press relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-zinc-950 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-75 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
                    >
                      {submitting && (
                        <>
                          <span className="lo-progress-bar absolute inset-y-0 left-0 w-1/3 bg-white/15 dark:bg-zinc-950/15" />
                          <Loader2 className="h-4 w-4 animate-spin" />
                        </>
                      )}
                      <span>
                        {submitting
                          ? requireApproval
                            ? 'Sending request...'
                            : 'Joining...'
                          : requireApproval
                            ? 'Request Account & Join'
                            : 'Register & Join Group'}
                      </span>
                    </button>
                    <div className="pt-1 text-center text-xs">
                      <Link
                        href="/"
                        className="font-medium text-zinc-600 hover:text-zinc-950 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
                      >
                        Already have an account? Sign in
                      </Link>
                    </div>
                  </form>
                )}
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

export default function JoinPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh bg-[#f4f4f5] p-8 pb-[var(--lo-safe-bottom,0px)] text-sm text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">Loading...</div>
      }
    >
      <JoinInviteInner />
    </Suspense>
  );
}
