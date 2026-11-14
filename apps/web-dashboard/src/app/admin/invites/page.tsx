'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { GroupRole } from '@loved-ones/shared';
import { NavBar } from '@/components/NavBar';
import { QrInvitePanel } from '@/components/QrInviteModal';
import {
  apiFetchGroups,
  apiListInvites,
  GroupItem,
  loadSession,
  saveSession,
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

  useEffect(() => {
    setSession(loadSession());
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

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-950">
        <NavBar user={null} onSignOut={() => {}} />
        <main className="mx-auto max-w-md px-4 py-16 text-center">
          <Link href="/" className="text-sm text-sky-400 hover:underline">
            Sign in on the main portal to manage QR invites
          </Link>
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

      <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-xl font-bold text-white">Zero-Config QR Onboarding Invites</h1>
          <p className="text-xs text-slate-400">
            Generate single-use or multi-use QR tokens for mobile and web onboarding.
          </p>
        </div>

        <QrInvitePanel
          accessToken={session.accessToken}
          groups={groups}
          onCreated={() => void refresh(session.accessToken)}
        />

        <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
          <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
            Generated Invites ({invites.length})
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Token</th>
                  <th className="px-4 py-2.5 font-medium">Group</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Uses</th>
                  <th className="px-4 py-2.5 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {invites.map((inv) => (
                  <tr key={inv.token}>
                    <td className="px-4 py-2.5 font-mono text-sky-300">{inv.token}</td>
                    <td className="px-4 py-2.5 text-white">{inv.groupName}</td>
                    <td className="px-4 py-2.5 text-slate-300">{inv.assignedRole}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">
                      {inv.uses} / {inv.maxUses}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">
                      {new Date(inv.expiresAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
