'use client';

import { useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, QrCode, X } from 'lucide-react';
import type { GroupRole } from '@loved-ones/shared';
import { apiCreateInvite, CreatedInviteResponse, GroupItem } from '@/lib/api';

interface QrInvitePanelProps {
  accessToken: string;
  groups: GroupItem[];
  onClose?: () => void;
  onCreated?: () => void;
}

export function QrInvitePanel({ accessToken, groups, onClose, onCreated }: QrInvitePanelProps) {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [assignedRole, setAssignedRole] = useState<GroupRole>('MEMBER');
  const [maxUses, setMaxUses] = useState(1);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<CreatedInviteResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!groupId) {
      setError('Select a group first');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const created = await apiCreateInvite(accessToken, {
        groupId,
        assignedRole,
        maxUses,
        expiresInHours,
      });
      const qrJson = JSON.stringify({
        v: created.v,
        serverUrl: created.serverUrl,
        inviteToken: created.inviteToken,
        groupName: created.groupName,
      });
      const dataUrl = await QRCode.toDataURL(qrJson, {
        width: 240,
        margin: 2,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      setInvite(created);
      setQrDataUrl(dataUrl);
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!invite) return;
    await navigator.clipboard.writeText(invite.joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <QrCode className="h-5 w-5 text-sky-400" />
          <h3 className="text-base font-semibold text-white">Generate Zero-Config QR Invite</h3>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-4">
        <label className="block text-xs text-slate-300">
          Group
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          >
            {groups.length === 0 && <option value="">No groups available</option>}
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-slate-300">
          Assigned Role
          <select
            value={assignedRole}
            onChange={(e) => setAssignedRole(e.target.value as GroupRole)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          >
            <option value="MEMBER">MEMBER</option>
            <option value="ADMIN">ADMIN</option>
            <option value="SPECTATOR">SPECTATOR</option>
          </select>
        </label>

        <label className="block text-xs text-slate-300">
          Max Uses
          <input
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value) || 1)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          />
        </label>

        <label className="block text-xs text-slate-300">
          Expires (hours)
          <input
            type="number"
            min={1}
            max={8760}
            value={expiresInHours}
            onChange={(e) => setExpiresInHours(Number(e.target.value) || 24)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          />
        </label>

        <div className="sm:col-span-4">
          <button
            type="submit"
            disabled={loading || groups.length === 0}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
          >
            {loading ? 'Generating...' : 'Create QR Invite'}
          </button>
        </div>
      </form>

      {error && (
        <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      {invite && qrDataUrl && (
        <div className="mt-5 grid gap-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4 md:grid-cols-[240px_1fr]">
          <div className="flex flex-col items-center justify-center rounded-lg bg-white p-3">
            <img src={qrDataUrl} alt="Onboarding QR code" className="h-52 w-52" />
          </div>
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Web Invite Link
              </div>
              <div className="mt-1 flex items-center gap-2">
                <input
                  readOnly
                  value={invite.joinUrl}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-200"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white hover:bg-slate-700"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Mobile QR Onboarding Payload
              </div>
              <pre className="mt-1 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-emerald-300">
                {JSON.stringify(
                  {
                    v: invite.v,
                    serverUrl: invite.serverUrl,
                    inviteToken: invite.inviteToken,
                    groupName: invite.groupName,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
