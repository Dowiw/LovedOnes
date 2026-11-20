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
  const selectedGroupId = groups.some((g) => g.id === groupId) ? groupId : (groups[0]?.id ?? '');
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
    if (!selectedGroupId) {
      setError('Select a group first');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const created = await apiCreateInvite(accessToken, {
        groupId: selectedGroupId,
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
        color: { dark: '#18181b', light: '#ffffff' },
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
    <div className="rounded-xl border border-zinc-200/80 bg-white/95 p-6 shadow-sm backdrop-blur-xl">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-zinc-950">
            <QrCode className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold text-zinc-950">Create Group Invite</h3>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-950"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-4">
        <label className="block text-xs font-medium text-zinc-600">
          Group
          <select
            value={selectedGroupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
          >
            {groups.length === 0 && <option value="">No groups available</option>}
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs font-medium text-zinc-600">
          Role
          <select
            value={assignedRole}
            onChange={(e) => setAssignedRole(e.target.value as GroupRole)}
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
          >
            <option value="MEMBER">MEMBER</option>
            <option value="ADMIN">ADMIN</option>
            <option value="SPECTATOR">SPECTATOR</option>
          </select>
        </label>

        <label className="block text-xs font-medium text-zinc-600">
          Max Uses
          <input
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value) || 1)}
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
          />
        </label>

        <label className="block text-xs font-medium text-zinc-600">
          Expires (hours)
          <input
            type="number"
            min={1}
            max={8760}
            value={expiresInHours}
            onChange={(e) => setExpiresInHours(Number(e.target.value) || 24)}
            className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
          />
        </label>

        <div className="sm:col-span-4">
          <button
            type="submit"
            disabled={loading || groups.length === 0}
            className="lo-press rounded-lg bg-zinc-950 px-5 py-2 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? 'Generating...' : 'Generate Invite'}
          </button>
        </div>
      </form>

      {error && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}

      {invite && qrDataUrl && (
        <div className="mt-5 grid gap-5 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-4 md:grid-cols-[220px_1fr]">
          <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
            <img src={qrDataUrl} alt="Onboarding QR code" className="h-48 w-48" />
          </div>
          <div className="space-y-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Web Invite Link
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  readOnly
                  value={invite.joinUrl}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-xs text-zinc-800"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="lo-press flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-950 px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-800"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-white" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                QR Payload
              </div>
              <pre className="mt-1.5 overflow-x-auto rounded-lg border border-zinc-200 bg-white p-3 font-mono text-[11px] text-zinc-700">
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
