'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import type { GroupRole } from '@loved-ones/shared';
import { NavBar } from '@/components/NavBar';
import { QrInvitePanel } from '@/components/QrInviteModal';
import {
  apiDeleteInvite,
  apiFetchGroups,
  apiListInvites,
  GroupItem,
  loadSession,
  saveSession,
  SESSION_UPDATED_EVENT,
  StoredSession,
} from '@/lib/api';

interface InviteRow {
  token: string;
  groupId: string;
  groupName: string;
  assignedRole: GroupRole;
  maxUses: number;
  uses: number;
  expiresAt: string;
}

export default function AdminInvitesPage() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [deletingToken, setDeletingToken] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setSession(loadSession());
    const onSessionSync = (event: Event) => {
      const custom = event as CustomEvent<StoredSession | null>;
      setSession(custom.detail ?? null);
    };
    window.addEventListener(SESSION_UPDATED_EVENT, onSessionSync);
    return () => window.removeEventListener(SESSION_UPDATED_EVENT, onSessionSync);
  }, []);

  const refresh = useCallback(async (token: string) => {
    const [grpList, invList] = await Promise.all([apiFetchGroups(token), apiListInvites(token)]);
    setGroups(grpList);
    setInvites(invList);
  }, []);

  useEffect(() => {
    if (!session) return;
    void refresh(session.accessToken).catch(() => {});
  }, [session, refresh]);

  async function handleDeleteInvite(token: string) {
    if (!session) return;
    setDeletingToken(token);
    setDeleteError(null);
    try {
      await apiDeleteInvite(session.accessToken, token);
      setInvites((prev) => prev.filter((inv) => inv.token !== token));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete invite');
    } finally {
      setDeletingToken((prev) => (prev === token ? null : prev));
    }
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-[#f4f4f5]">
        <NavBar user={null} onSignOut={() => {}} />
        <main className="mx-auto max-w-md px-4 py-16 text-center">
          <div className="rounded-3xl border border-slate-200/80 bg-white/90 p-8 shadow-sm backdrop-blur-xl">
            <Link href="/" className="text-sm font-medium text-zinc-900 hover:underline">
              Sign in on the main map to manage invites
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

      <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-900">Group Invites</h1>
          <p className="text-xs text-zinc-500">
            Generate single-use or multi-use QR codes and links for mobile and web onboarding.
          </p>
        </div>

        <QrInvitePanel
          accessToken={session.accessToken}
          groups={groups}
          onCreated={() => void refresh(session.accessToken)}
        />

        <section className="overflow-hidden rounded-3xl border border-slate-200/80 bg-white/90 shadow-sm backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <span className="text-sm font-semibold text-zinc-900">
              Active &amp; Recent Invites ({invites.length})
            </span>
            {deleteError && <span className="text-xs font-medium text-rose-600">{deleteError}</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 text-zinc-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Token</th>
                  <th className="px-5 py-3 font-medium">Group</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Uses</th>
                  <th className="px-5 py-3 font-medium">Expires</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invites.map((inv) => (
                  <tr key={inv.token} className="hover:bg-slate-50/70">
                    <td className="px-5 py-3 font-mono text-zinc-700">{inv.token}</td>
                    <td className="px-5 py-3 font-medium text-zinc-900">{inv.groupName}</td>
                    <td className="px-5 py-3 text-zinc-600">{inv.assignedRole}</td>
                    <td className="px-5 py-3 font-mono text-zinc-600">
                      {inv.uses} / {inv.maxUses}
                    </td>
                    <td className="px-5 py-3 text-zinc-500">
                      {new Date(inv.expiresAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        type="button"
                        disabled={deletingToken === inv.token}
                        onClick={() => void handleDeleteInvite(inv.token)}
                        title="Delete invite"
                        className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-rose-600 transition hover:border-rose-200 hover:bg-rose-50 disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        {deletingToken === inv.token ? 'Deleting...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
                {invites.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-6 text-center text-zinc-400">
                      No invites created yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
