'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, ShieldAlert, UserPlus } from 'lucide-react';
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
      await apiJoinInvite(session.accessToken, token);
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
      const created = await apiRegister({ email, username, password, inviteToken: token });
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
    <div className="min-h-screen bg-slate-950">
      <NavBar
        user={session?.user ?? null}
        onSignOut={() => {
          saveSession(null);
          setSession(null);
        }}
      />
      <main className="mx-auto max-w-md px-4 py-14">
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          {loading ? (
            <div className="text-sm text-slate-400">Verifying invite token...</div>
          ) : error && !preview ? (
            <div className="flex items-center gap-2 text-sm text-rose-400">
              <ShieldAlert className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : preview ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-400">
                <UserPlus className="h-5 w-5" />
                <h1 className="text-lg font-bold text-white">Group Invite</h1>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs space-y-1.5">
                <div className="text-sm font-semibold text-white">{preview.groupName}</div>
                <div className="text-slate-400">
                  Role: <span className="font-medium text-sky-300">{preview.assignedRole}</span>
                </div>
                <div className="text-slate-400">
                  Status:{' '}
                  <span className={preview.valid ? 'text-emerald-400' : 'text-rose-400'}>
                    {preview.valid ? 'Active' : 'Expired / Exhausted'}
                  </span>
                </div>
              </div>

              {error && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                  {error}
                </div>
              )}

              {session ? (
                <button
                  type="button"
                  disabled={!preview.valid || submitting}
                  onClick={() => void handleJoinExisting()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {submitting ? 'Joining...' : `Join as ${session.user.username}`}
                </button>
              ) : (
                <form onSubmit={handleRegisterAndJoin} className="space-y-3">
                  <label className="block text-xs text-slate-300">
                    Email
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                    />
                  </label>
                  <label className="block text-xs text-slate-300">
                    Username
                    <input
                      type="text"
                      required
                      minLength={2}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                    />
                  </label>
                  <label className="block text-xs text-slate-300">
                    Password
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={!preview.valid || submitting}
                    className="w-full rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                  >
                    {submitting ? 'Joining...' : 'Register & Join Group'}
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
      fallback={<div className="min-h-screen bg-slate-950 p-8 text-sm text-slate-400">Loading...</div>}
    >
      <JoinInviteInner />
    </Suspense>
  );
}
