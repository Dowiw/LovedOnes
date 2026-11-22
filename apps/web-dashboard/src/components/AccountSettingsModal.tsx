'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Check, KeyRound, Loader2, Mail, ShieldCheck, Trash2, User, X } from 'lucide-react';
import {
  DEFAULT_EXACT_HALO_COLOR,
  DEFAULT_FUZZ_CIRCLE_COLOR,
  hexToRgba,
  isSafeAvatarUrl,
  isSafeHexColor,
  withMinDelay,
} from '@loved-ones/shared';

const COLOR_PRESETS = [
  { label: 'Amber', hex: '#f59e0b' },
  { label: 'Sky', hex: '#0ea5e9' },
  { label: 'Emerald', hex: '#10b981' },
  { label: 'Violet', hex: '#8b5cf6' },
  { label: 'Rose', hex: '#f43f5e' },
  { label: 'Ink', hex: '#18181b' },
] as const;
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
  const [haloColor, setHaloColor] = useState<string | null>(session.user.haloColor ?? null);
  const [fuzzCircleColor, setFuzzCircleColor] = useState<string | null>(
    session.user.fuzzCircleColor ?? null,
  );
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
  const [recoveryAction, setRecoveryAction] = useState<'send' | 'verify' | 'clear' | null>(null);
  const recoveryBusy = recoveryAction !== null;
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUsername(session.user.username);
    setEmail(session.user.email);
    setAvatarUrl(session.user.avatarUrl ?? null);
    setHaloColor(session.user.haloColor ?? null);
    setFuzzCircleColor(session.user.fuzzCircleColor ?? null);
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
      const next = await withMinDelay(
        apiUpdateProfile(session.accessToken, {
          username: username.trim(),
          email: email.trim(),
          avatarUrl,
          haloColor,
          fuzzCircleColor,
        }),
      );
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
      await withMinDelay(
        apiChangePassword(session.accessToken, {
          currentPassword,
          newPassword,
        }),
      );
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
    setRecoveryAction('send');
    try {
      const res = await withMinDelay(apiSendRecoveryCode(session.accessToken, target));
      const next: StoredSession = { ...session, user: res.user };
      saveSession(next);
      onSessionUpdated(next);
      setRecoveryEmailInput(res.recoveryEmail);
      setRecoveryCodeSentTo(res.recoveryEmail);
      setRecoveryNotice(`6-digit verification code sent to ${res.recoveryEmail}`);
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Failed to send verification code');
    } finally {
      setRecoveryAction(null);
    }
  }

  async function handleVerifyRecoveryEmail(e: React.FormEvent) {
    e.preventDefault();
    const target = (recoveryCodeSentTo ?? recoveryEmailInput).trim();
    if (!target || !recoveryCodeInput.trim()) return;
    setRecoveryError(null);
    setRecoveryNotice(null);
    setRecoveryAction('verify');
    try {
      const res = await withMinDelay(
        apiVerifyRecoveryEmail(session.accessToken, {
          recoveryEmail: target,
          code: recoveryCodeInput.trim(),
        }),
      );
      const next: StoredSession = { ...session, user: res.user };
      saveSession(next);
      onSessionUpdated(next);
      setRecoveryCodeInput('');
      setRecoveryCodeSentTo(null);
      setRecoveryNotice('Backup email verified! You can now use it to recover a forgotten password.');
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Failed to verify code');
    } finally {
      setRecoveryAction(null);
    }
  }

  async function handleClearRecoveryEmail() {
    setRecoveryError(null);
    setRecoveryNotice(null);
    setRecoveryAction('clear');
    try {
      const res = await withMinDelay(apiClearRecoveryEmail(session.accessToken));
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
      setRecoveryAction(null);
    }
  }

  return (
    <div
      className="lo-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 pb-[calc(1rem+var(--lo-safe-bottom,0px))] pl-[calc(1rem+var(--lo-safe-left,0px))] pr-[calc(1rem+var(--lo-safe-right,0px))] pt-[calc(1rem+var(--lo-safe-top,0px))] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Account Settings"
    >
      <div className="lo-modal-in max-h-[calc(var(--lo-app-height,100dvh)-2rem-var(--lo-safe-top,0px)-var(--lo-safe-bottom,0px))] w-full max-w-md overflow-y-auto rounded-xl border border-white/80 bg-white p-6 shadow-[0_24px_64px_rgba(15,23,42,0.22)] dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-[0_24px_64px_rgba(0,0,0,0.65)]">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Account Settings</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Your photo appears as a circle marker on group maps.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close account settings"
            className="rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Profile Form */}
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="flex items-center gap-4 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/60">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Change profile photo"
              className="group relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-white bg-zinc-950 text-lg font-bold text-white shadow-md ring-2 ring-zinc-900/15 dark:border-zinc-700 dark:ring-zinc-100/15"
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
                  className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
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
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowUrlField((v) => !v)}
                className="self-start text-[11px] font-medium text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 dark:text-zinc-400 dark:decoration-zinc-700 dark:hover:text-zinc-100"
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
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
              />
              <button
                type="button"
                onClick={handleApplyUrl}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
              >
                Apply
              </button>
            </div>
          )}

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              <User className="h-3 w-3" /> Display Name
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={64}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Email Address
            </label>
            <input
              type="email"
              required
              maxLength={255}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
            />
          </div>

          {/* Map Marker Halo & Fuzzed Area Circle Colors */}
          <div className="space-y-3 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3.5 dark:border-zinc-800 dark:bg-zinc-950/60">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
                  Map Pin Appearance
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Customize your marker halo and transparent fuzzed area ring.
                </p>
              </div>
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-dashed"
                style={{
                  backgroundColor: hexToRgba(
                    isSafeHexColor(fuzzCircleColor)
                      ? fuzzCircleColor
                      : DEFAULT_FUZZ_CIRCLE_COLOR,
                    0.18,
                  ),
                  borderColor: hexToRgba(
                    isSafeHexColor(fuzzCircleColor)
                      ? fuzzCircleColor
                      : DEFAULT_FUZZ_CIRCLE_COLOR,
                    0.7,
                  ),
                }}
                title="Live fuzzed area & halo preview"
              >
                <div
                  className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-zinc-900 text-[9px] font-bold text-white"
                  style={{
                    boxShadow: `0 0 0 3px ${hexToRgba(
                      isSafeHexColor(haloColor) ? haloColor : DEFAULT_EXACT_HALO_COLOR,
                      0.45,
                    )}`,
                  }}
                >
                  {(username || session.user.username).slice(0, 1).toUpperCase()}
                </div>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                <span>User Halo Color</span>
                {haloColor && (
                  <button
                    type="button"
                    onClick={() => setHaloColor(null)}
                    className="text-[10px] text-zinc-500 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {COLOR_PRESETS.map((preset) => {
                  const selected = haloColor?.toLowerCase() === preset.hex;
                  return (
                    <button
                      key={`halo-${preset.hex}`}
                      type="button"
                      title={preset.label}
                      onClick={() => setHaloColor(preset.hex)}
                      className={`h-6 w-6 rounded-full border-2 transition ${
                        selected
                          ? 'scale-110 border-zinc-950 ring-2 ring-zinc-900/20 dark:border-zinc-100 dark:ring-zinc-100/25'
                          : 'border-white shadow-sm dark:border-zinc-800'
                      }`}
                      style={{ backgroundColor: preset.hex }}
                    />
                  );
                })}
                <label className="ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700">
                  <input
                    type="color"
                    aria-label="Custom halo color"
                    value={isSafeHexColor(haloColor) ? haloColor : DEFAULT_EXACT_HALO_COLOR}
                    onChange={(e) => setHaloColor(e.target.value.toLowerCase())}
                    className="h-3.5 w-3.5 cursor-pointer border-0 bg-transparent p-0"
                  />
                  Custom
                </label>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                <span>Fuzzed Circle Color</span>
                {fuzzCircleColor && (
                  <button
                    type="button"
                    onClick={() => setFuzzCircleColor(null)}
                    className="text-[10px] text-zinc-500 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {COLOR_PRESETS.map((preset) => {
                  const selected = fuzzCircleColor?.toLowerCase() === preset.hex;
                  return (
                    <button
                      key={`fuzz-${preset.hex}`}
                      type="button"
                      title={preset.label}
                      onClick={() => setFuzzCircleColor(preset.hex)}
                      className={`h-6 w-6 rounded-full border-2 transition ${
                        selected
                          ? 'scale-110 border-zinc-950 ring-2 ring-zinc-900/20 dark:border-zinc-100 dark:ring-zinc-100/25'
                          : 'border-white shadow-sm dark:border-zinc-800'
                      }`}
                      style={{ backgroundColor: preset.hex }}
                    />
                  );
                })}
                <label className="ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700">
                  <input
                    type="color"
                    aria-label="Custom fuzzed circle color"
                    value={
                      isSafeHexColor(fuzzCircleColor)
                        ? fuzzCircleColor
                        : DEFAULT_FUZZ_CIRCLE_COLOR
                    }
                    onChange={(e) => setFuzzCircleColor(e.target.value.toLowerCase())}
                    className="h-3.5 w-3.5 cursor-pointer border-0 bg-transparent p-0"
                  />
                  Custom
                </label>
              </div>
            </div>
          </div>

          {profileError && (
            <div className="lo-feedback-in rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/50 dark:text-rose-300">
              {profileError}
            </div>
          )}
          {profileSaved && (
            <div className="lo-feedback-in flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              {profileSaved}
            </div>
          )}

          <button
            type="submit"
            disabled={profileBusy}
            className="lo-press relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-zinc-950 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-80 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
          >
            {profileBusy && (
              <>
                <span className="lo-progress-bar absolute inset-y-0 left-0 w-1/3 bg-white/15 dark:bg-zinc-950/15" />
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              </>
            )}
            <span>{profileBusy ? 'Saving Profile...' : 'Save Profile'}</span>
          </button>
        </form>

        {/* Backup / Recovery Email Verification */}
        <div className="my-5 border-t border-zinc-100 dark:border-zinc-800" />

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-900 dark:text-zinc-100">
              <Mail className="h-3.5 w-3.5" />
              Backup Email (Password Recovery)
            </div>
            {session.user.recoveryEmail && session.user.recoveryEmailVerified ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-950 px-2.5 py-0.5 text-[10px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950">
                <ShieldCheck className="h-3 w-3" />
                Verified
              </span>
            ) : session.user.recoveryEmail ? (
              <span className="rounded-full bg-zinc-200 px-2.5 py-0.5 text-[10px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                Unverified
              </span>
            ) : (
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                Not set
              </span>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
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
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
              />
              <button
                type="submit"
                disabled={recoveryBusy || !recoveryEmailInput.trim()}
                className="lo-press flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-zinc-950 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
              >
                {recoveryAction === 'send' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>{recoveryAction === 'send' ? 'Sending...' : 'Send Code'}</span>
              </button>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              {recoveryEmailInput.trim().toLowerCase() !== session.user.email.toLowerCase() ? (
                <button
                  type="button"
                  onClick={() => setRecoveryEmailInput(session.user.email)}
                  className="font-medium text-zinc-600 underline underline-offset-2 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100"
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
                  className="inline-flex items-center gap-1 font-medium text-zinc-500 hover:text-rose-600 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-rose-400"
                >
                  {recoveryAction === 'clear' && <Loader2 className="h-3 w-3 animate-spin" />}
                  {recoveryAction === 'clear' ? 'Removing...' : 'Remove backup email'}
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
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs tracking-widest text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
              />
              <button
                type="submit"
                disabled={recoveryBusy || recoveryCodeInput.trim().length !== 6}
                className="lo-press flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-950 bg-white px-3.5 py-2 text-xs font-semibold text-zinc-950 transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
              >
                {recoveryAction === 'verify' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>{recoveryAction === 'verify' ? 'Verifying...' : 'Verify Email'}</span>
              </button>
            </form>
          )}

          {recoveryError && (
            <div className="lo-feedback-in rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/50 dark:text-rose-300">
              {recoveryError}
            </div>
          )}
          {recoveryNotice && (
            <div className="lo-feedback-in flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>{recoveryNotice}</span>
            </div>
          )}
        </div>

        {/* Password Change Form */}
        <div className="my-5 border-t border-zinc-100 dark:border-zinc-800" />

        <form onSubmit={handleUpdatePassword} className="space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-900 dark:text-zinc-100">
            <KeyRound className="h-3.5 w-3.5" />
            Change Password
          </div>

          <input
            type="password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current password"
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (8+)"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
            />
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none dark:border-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-100 dark:focus:border-zinc-500 dark:focus:bg-zinc-950"
            />
          </div>

          {passwordError && (
            <div className="lo-feedback-in rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/50 dark:text-rose-300">
              {passwordError}
            </div>
          )}
          {passwordSaved && (
            <div className="lo-feedback-in flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              {passwordSaved}
            </div>
          )}

          <button
            type="submit"
            disabled={passwordBusy}
            className="lo-press relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg border border-zinc-950 bg-white py-2 text-xs font-semibold text-zinc-950 transition hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-70 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          >
            {passwordBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>{passwordBusy ? 'Updating Password...' : 'Update Password'}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
