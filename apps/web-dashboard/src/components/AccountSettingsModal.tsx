'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Check, KeyRound, Mail, ShieldCheck, Trash2, User, X } from 'lucide-react';
import { isSafeAvatarUrl } from '@loved-ones/shared';
import {
  apiChangePassword,
  apiClearRecoveryEmail,
  apiSendRecoveryCode,
  apiUpdateProfile,
  apiVerifyRecoveryEmail,
  saveSession,
  StoredSession,
} from '@/lib/api';

interface AccountSettingsModalProps {
  open: boolean;
  session: StoredSession;
  onClose: () => void;
  onSessionUpdated: (next: StoredSession) => void;
}

const AVATAR_SIZE = 192;

async function cropAndResizeImageFile(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode image file'));
      el.src = objectUrl;
    });

    const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (!Number.isFinite(side) || side <= 0) {
      throw new Error('Invalid image dimensions');
    }
    const sx = Math.max(0, Math.floor(((img.naturalWidth || img.width) - side) / 2));
    const sy = Math.max(0, Math.floor(((img.naturalHeight || img.height) - side) / 2));

    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context unavailable');
    }
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    let dataUrl = canvas.toDataURL('image/webp', 0.85);
    if (!dataUrl.startsWith('data:image/webp') || !isSafeAvatarUrl(dataUrl)) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.84);
    }
    if (!isSafeAvatarUrl(dataUrl)) {
      throw new Error('Processed image exceeds 256 KB avatar limit');
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function AccountSettingsModal({
  open,
  session,
  onClose,
  onSessionUpdated,
}: AccountSettingsModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [username, setUsername] = useState(session.user.username);
  const [email, setEmail] = useState(session.user.email);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(session.user.avatarUrl ?? null);
  const [imageUrlInput, setImageUrlInput] = useState('');
  const [showUrlField, setShowUrlField] = useState(false);

  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState<string | null>(null);

  const [recoveryEmailInput, setRecoveryEmailInput] = useState(
    session.user.recoveryEmail ?? '',
  );
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [recoveryCodeSentTo, setRecoveryCodeSentTo] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUsername(session.user.username);
    setEmail(session.user.email);
    setAvatarUrl(session.user.avatarUrl ?? null);
    setImageUrlInput(
      session.user.avatarUrl && !session.user.avatarUrl.startsWith('data:')
        ? session.user.avatarUrl
        : '',
    );
    setProfileError(null);
    setProfileSaved(null);
    setPasswordError(null);
    setPasswordSaved(null);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setRecoveryEmailInput(session.user.recoveryEmail ?? '');
    setRecoveryCodeInput('');
    setRecoveryCodeSentTo(null);
    setRecoveryError(null);
    setRecoveryNotice(null);
  }, [open, session.user]);

  if (!open) return null;

  const hasSafeAvatar = isSafeAvatarUrl(avatarUrl);

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setProfileError(null);
    setProfileSaved(null);
    try {
      const processed = await cropAndResizeImageFile(file);
      setAvatarUrl(processed);
      setImageUrlInput('');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to process photo');
    }
  }

  function handleApplyUrl() {
    const trimmed = imageUrlInput.trim();
    if (!trimmed) {
      setAvatarUrl(null);
      return;
    }
    if (!isSafeAvatarUrl(trimmed)) {
      setProfileError('Enter a valid http(s) image URL.');
      return;
    }
    setProfileError(null);
    setAvatarUrl(trimmed);
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileError(null);
    setProfileSaved(null);
    setProfileBusy(true);
    try {
      const next = await apiUpdateProfile(session.accessToken, {
        username: username.trim(),
        email: email.trim(),
        avatarUrl,
      });
      saveSession(next);
      onSessionUpdated(next);
      setProfileSaved('Profile updated');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setProfileBusy(false);
    }
  }

  async function handleUpdatePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSaved(null);
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    setPasswordBusy(true);
    try {
      await apiChangePassword(session.accessToken, {
        currentPassword,
        newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSaved('Password updated');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setPasswordBusy(false);
    }
  }

  async function handleSendRecoveryCode(e?: React.FormEvent) {
    e?.preventDefault();
    const target = recoveryEmailInput.trim();
    if (!target) {
      setRecoveryError('Enter an email address to verify');
      return;
    }
    setRecoveryError(null);
    setRecoveryNotice(null);
    setRecoveryBusy(true);
    try {
      const res = await apiSendRecoveryCode(session.accessToken, target);
      const next: StoredSession = { ...session, user: res.user };
      saveSession(next);
      onSessionUpdated(next);
      setRecoveryEmailInput(res.recoveryEmail);
      setRecoveryCodeSentTo(res.recoveryEmail);
      setRecoveryNotice(`6-digit verification code sent to ${res.recoveryEmail}`);
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Failed to send verification code');
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function handleVerifyRecoveryEmail(e: React.FormEvent) {
    e.preventDefault();
    const target = (recoveryCodeSentTo ?? recoveryEmailInput).trim();
    if (!target || !recoveryCodeInput.trim()) return;
    setRecoveryError(null);
    setRecoveryNotice(null);
    setRecoveryBusy(true);
    try {
      const res = await apiVerifyRecoveryEmail(session.accessToken, {
        recoveryEmail: target,
        code: recoveryCodeInput.trim(),
      });
      const next: StoredSession = { ...session, user: res.user };
      saveSession(next);
      onSessionUpdated(next);
      setRecoveryCodeInput('');
      setRecoveryCodeSentTo(null);
      setRecoveryNotice('Backup email verified! You can now use it to recover a forgotten password.');
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Failed to verify code');
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function handleClearRecoveryEmail() {
    setRecoveryError(null);
    setRecoveryNotice(null);
    setRecoveryBusy(true);
    try {
      const res = await apiClearRecoveryEmail(session.accessToken);
      const next: StoredSession = { ...session, user: res.user };
      saveSession(next);
      onSessionUpdated(next);
      setRecoveryEmailInput('');
      setRecoveryCodeInput('');
      setRecoveryCodeSentTo(null);
      setRecoveryNotice('Backup email removed');
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Failed to remove backup email');
    } finally {
      setRecoveryBusy(false);
    }
  }

  return (
    <div
      className="lo-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Account Settings"
    >
      <div className="lo-modal-in max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-white/80 bg-white p-6 shadow-[0_24px_64px_rgba(15,23,42,0.22)]">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold tracking-tight text-zinc-950">Account Settings</h2>
            <p className="text-xs text-zinc-500">
              Your photo appears as a circle marker on group maps.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close account settings"
            className="rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Profile Form */}
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="flex items-center gap-4 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Change profile photo"
              className="group relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-white bg-zinc-950 text-lg font-bold text-white shadow-md ring-2 ring-zinc-900/15"
            >
              {hasSafeAvatar ? (
                <img
                  src={avatarUrl!}
                  alt={username || session.user.username}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span>{(username || session.user.username).slice(0, 1).toUpperCase()}</span>
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-zinc-950/45 opacity-0 transition group-hover:opacity-100">
                <Camera className="h-4 w-4 text-white" />
              </span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={handleFilePicked}
              className="hidden"
            />

            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800"
                >
                  <Camera className="h-3 w-3" />
                  Upload Photo
                </button>
                {avatarUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      setAvatarUrl(null);
                      setImageUrlInput('');
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowUrlField((v) => !v)}
                className="self-start text-[11px] font-medium text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900"
              >
                {showUrlField ? 'Hide image URL' : 'Or paste image URL'}
              </button>
            </div>
          </div>

          {showUrlField && (
            <div className="flex gap-1.5">
              <input
                type="url"
                value={imageUrlInput}
                onChange={(e) => setImageUrlInput(e.target.value)}
                placeholder="https://example.com/avatar.jpg"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
              />
              <button
                type="button"
                onClick={handleApplyUrl}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 hover:bg-zinc-100"
              >
                Apply
              </button>
            </div>
          )}

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <User className="h-3 w-3" /> Display Name
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={64}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Email Address
            </label>
            <input
              type="email"
              required
              maxLength={255}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
            />
          </div>

          {profileError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {profileError}
            </div>
          )}
          {profileSaved && (
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900">
              <Check className="h-3.5 w-3.5" />
              {profileSaved}
            </div>
          )}

          <button
            type="submit"
            disabled={profileBusy}
            className="lo-press w-full rounded-lg bg-zinc-950 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50"
          >
            {profileBusy ? 'Saving Profile...' : 'Save Profile'}
          </button>
        </form>

        {/* Backup / Recovery Email Verification */}
        <div className="my-5 border-t border-zinc-100" />

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-900">
              <Mail className="h-3.5 w-3.5" />
              Backup Email (Password Recovery)
            </div>
            {session.user.recoveryEmail && session.user.recoveryEmailVerified ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-0.5 text-[10px] font-semibold text-white">
                <ShieldCheck className="h-3 w-3" />
                Verified
              </span>
            ) : session.user.recoveryEmail ? (
              <span className="rounded-full bg-zinc-200 px-2.5 py-0.5 text-[10px] font-semibold text-zinc-700">
                Unverified
              </span>
            ) : (
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[10px] font-medium text-zinc-500">
                Not set
              </span>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-500">
            Save and verify an email with a 6-digit test code so you can reset a forgotten password later.
          </p>

          <form onSubmit={handleSendRecoveryCode} className="space-y-2">
            <div className="flex gap-1.5">
              <input
                type="email"
                required
                maxLength={255}
                value={recoveryEmailInput}
                onChange={(e) => setRecoveryEmailInput(e.target.value)}
                placeholder="backup@example.com"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
              />
              <button
                type="submit"
                disabled={recoveryBusy || !recoveryEmailInput.trim()}
                className="shrink-0 rounded-lg bg-zinc-950 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50"
              >
                {recoveryBusy ? 'Sending...' : 'Send Code'}
              </button>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              {recoveryEmailInput.trim().toLowerCase() !== session.user.email.toLowerCase() ? (
                <button
                  type="button"
                  onClick={() => setRecoveryEmailInput(session.user.email)}
                  className="font-medium text-zinc-600 underline underline-offset-2 hover:text-zinc-950"
                >
                  Use account email ({session.user.email})
                </button>
              ) : (
                <span />
              )}
              {session.user.recoveryEmail && (
                <button
                  type="button"
                  disabled={recoveryBusy}
                  onClick={() => void handleClearRecoveryEmail()}
                  className="font-medium text-zinc-500 hover:text-rose-600 disabled:opacity-50"
                >
                  Remove backup email
                </button>
              )}
            </div>
          </form>

          {(recoveryCodeSentTo || (session.user.recoveryEmail && !session.user.recoveryEmailVerified)) && (
            <form onSubmit={handleVerifyRecoveryEmail} className="flex gap-1.5 pt-0.5">
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                value={recoveryCodeInput}
                onChange={(e) => setRecoveryCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs tracking-widest text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
              />
              <button
                type="submit"
                disabled={recoveryBusy || recoveryCodeInput.trim().length !== 6}
                className="shrink-0 rounded-lg border border-zinc-950 bg-white px-3.5 py-2 text-xs font-semibold text-zinc-950 transition hover:bg-zinc-100 disabled:opacity-50"
              >
                Verify Email
              </button>
            </form>
          )}

          {recoveryError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {recoveryError}
            </div>
          )}
          {recoveryNotice && (
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span>{recoveryNotice}</span>
            </div>
          )}
        </div>

        {/* Password Change Form */}
        <div className="my-5 border-t border-zinc-100" />

        <form onSubmit={handleUpdatePassword} className="space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-900">
            <KeyRound className="h-3.5 w-3.5" />
            Change Password
          </div>

          <input
            type="password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current password"
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (8+)"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
            />
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
            />
          </div>

          {passwordError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {passwordError}
            </div>
          )}
          {passwordSaved && (
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900">
              <Check className="h-3.5 w-3.5" />
              {passwordSaved}
            </div>
          )}

          <button
            type="submit"
            disabled={passwordBusy}
            className="lo-press w-full rounded-lg border border-zinc-950 bg-white py-2 text-xs font-semibold text-zinc-950 transition hover:bg-zinc-100 disabled:opacity-50"
          >
            {passwordBusy ? 'Updating Password...' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
