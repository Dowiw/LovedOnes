'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, ShieldAlert, UserPlus } from 'lucide-react';
import { withMinDelay } from '@loved-ones/shared';
import { NavBar } from '@/components/NavBar';
import {
  apiJoinInvite,
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

  return (
    <div className="min-h-dvh bg-[#f4f4f5] pb-[var(--lo-safe-bottom,0px)]">
      <NavBar
        user={session?.user ?? null}
        onSignOut={() => {
          saveSession(null);
          setSession(null);
        }}
      />
      <main className="mx-auto max-w-md px-4 py-14">
        <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-7 shadow-[0_12px_40px_rgba(9,9,11,0.08)] backdrop-blur-xl">
          {loading ? (
            <div className="text-sm text-zinc-500">Verifying invite token...</div>
          ) : error && !preview ? (
            <div className="flex items-center gap-2 text-sm text-rose-600">
              <ShieldAlert className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : preview ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-950 text-white">
                  <UserPlus className="h-4 w-4" />
                </span>
                <h1 className="text-lg font-bold tracking-tight text-zinc-950">Group Invite</h1>
              </div>

              <div className="space-y-1.5 rounded-lg border border-zinc-200/80 bg-zinc-50/80 p-4 text-xs">
                <div className="text-sm font-semibold text-zinc-950">{preview.groupName}</div>
                <div className="text-zinc-500">
                  Role: <span className="font-medium text-zinc-950">{preview.assignedRole}</span>
                </div>
                <div className="text-zinc-500">
                  Status:{' '}
                  <span
                    className={
                      preview.valid ? 'font-medium text-zinc-950' : 'font-medium text-rose-600'
                    }
                  >
                    {preview.valid ? 'Active' : 'Expired / Exhausted'}
                  </span>
                </div>
              </div>

              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {error}
                </div>
              )}

              {session ? (
                <button
                  type="button"
                  disabled={!preview.valid || submitting}
                  onClick={() => void handleJoinExisting()}
                  className="lo-press relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-zinc-950 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-75"
                >
                  {submitting ? (
                    <>
                      <span className="lo-progress-bar absolute inset-y-0 left-0 w-1/3 bg-white/15" />
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                    </>
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-white" />
                  )}
                  {submitting ? 'Joining...' : `Join as ${session.user.username}`}
                </button>
              ) : (
                <form onSubmit={handleRegisterAndJoin} className="space-y-3">
                  <label className="block text-xs font-medium text-zinc-600">
                    Email
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                    />
                  </label>
                  <label className="block text-xs font-medium text-zinc-600">
                    Username
                    <input
                      type="text"
                      required
                      minLength={2}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                    />
                  </label>
                  <label className="block text-xs font-medium text-zinc-600">
                    Password
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={!preview.valid || submitting}
                    className="lo-press relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-zinc-950 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-75"
                  >
                    {submitting && (
                      <>
                        <span className="lo-progress-bar absolute inset-y-0 left-0 w-1/3 bg-white/15" />
                        <Loader2 className="h-4 w-4 animate-spin text-white" />
                      </>
                    )}
                    <span>{submitting ? 'Joining...' : 'Register & Join Group'}</span>
                  </button>
                </form>
              )}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export default function JoinPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh bg-[#f4f4f5] p-8 pb-[var(--lo-safe-bottom,0px)] text-sm text-zinc-500">Loading...</div>
      }
    >
      <JoinInviteInner />
    </Suspense>
  );
}
