'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, CheckCircle2, ImageUp, Link2, QrCode, ShieldAlert, X } from 'lucide-react';
import { parseInviteInput } from '@loved-ones/shared';
import {
  apiJoinInvite,
  apiPreviewInvite,
  InvitePreview,
} from '@/lib/api';

type InputTab = 'camera' | 'upload' | 'paste';

export interface QrJoinModalProps {
  open: boolean;
  mode: 'authenticated' | 'pre-auth';
  accessToken?: string;
  isOnboardingPrompt?: boolean;
  onClose: () => void;
  onJoinedGroup?: (groupId: string) => void;
  onBindPreAuthInvite?: (preview: InvitePreview) => void;
}

async function decodeQrFromImageFile(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read image file'));
      el.src = objectUrl;
    });

    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) {
      throw new Error('Invalid image dimensions');
    }
    const scale = Math.min(1, 1024 / Math.max(w0, h0));
    const width = Math.max(1, Math.round(w0 * scale));
    const height = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');

    ctx.drawImage(img, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const decoded = jsQR(imageData.data, width, height);
    if (!decoded?.data) {
      throw new Error('No QR code detected in that image');
    }
    return decoded.data;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function QrJoinModal({
  open,
  mode,
  accessToken,
  isOnboardingPrompt = false,
  onClose,
  onJoinedGroup,
  onBindPreAuthInvite,
}: QrJoinModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [tab, setTab] = useState<InputTab>('camera');
  const [pasteText, setPasteText] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [joining, setJoining] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const resolveRawInvite = useCallback(async (raw: string) => {
    setError(null);
    setLoadingPreview(true);
    try {
      const parsed = parseInviteInput(raw);
      const data = await apiPreviewInvite(parsed.inviteToken);
      setPreview(data);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : 'Invalid or expired invite');
    } finally {
      setLoadingPreview(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      stopCamera();
      setPreview(null);
      setPasteText('');
      setError(null);
      setCameraError(null);
      setTab('camera');
    }
  }, [open, stopCamera]);

  useEffect(() => {
    if (!open || tab !== 'camera' || preview) {
      stopCamera();
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCameraError('Camera access requires HTTPS or browser support. Upload a QR image or paste the invite link instead.');
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    const canvas = document.createElement('canvas');

    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(async (stream) => {
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        setCameraError(null);
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => {});

        const scanTick = () => {
          if (cancelled || !videoRef.current) return;
          const v = videoRef.current;
          if (v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const hit = jsQR(imgData.data, canvas.width, canvas.height);
              if (hit?.data) {
                stopCamera();
                void resolveRawInvite(hit.data);
                return;
              }
            }
          }
          timerId = window.setTimeout(scanTick, 160);
        };

        timerId = window.setTimeout(scanTick, 200);
      })
      .catch(() => {
        if (!cancelled) {
          setCameraError('Camera permission denied or unavailable. Upload a QR screenshot or paste an invite link instead.');
        }
      });

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      stopCamera();
    };
  }, [open, tab, preview, stopCamera, resolveRawInvite]);

  if (!open) return null;

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setLoadingPreview(true);
    try {
      const raw = await decodeQrFromImageFile(file);
      await resolveRawInvite(raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to decode QR image');
      setLoadingPreview(false);
    }
  }

  async function handleConfirm() {
    if (!preview || !preview.valid) return;
    if (mode === 'pre-auth') {
      onBindPreAuthInvite?.(preview);
      onClose();
      return;
    }
    if (!accessToken) {
      setError('Sign in required to join a group.');
      return;
    }
    setJoining(true);
    setError(null);
    try {
      const res = await apiJoinInvite(accessToken, preview.token);
      onJoinedGroup?.(res.groupId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join group');
    } finally {
      setJoining(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Join a Group via QR"
    >
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-3xl border border-white/80 bg-white p-6 shadow-[0_24px_64px_rgba(15,23,42,0.24)]">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white">
              <QrCode className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-bold tracking-tight text-zinc-950">
                {isOnboardingPrompt ? 'Were you invited to a group?' : 'Join Group via QR'}
              </h2>
              <p className="text-xs text-zinc-500">
                {isOnboardingPrompt
                  ? 'Scan an invite QR code, upload a screenshot, or paste the invite link — or skip to explore the map first.'
                  : 'Scan an admin QR code, upload an invite image, or paste an invite link/token.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!preview ? (
          <>
            <div className="mb-4 grid grid-cols-3 gap-1 rounded-full bg-zinc-100 p-1 text-[11px] font-semibold">
              {(
                [
                  ['camera', 'Camera', Camera],
                  ['upload', 'Upload QR', ImageUp],
                  ['paste', 'Paste Link', Link2],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setError(null);
                    setTab(id);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-full py-1.5 transition ${
                    tab === id
                      ? 'bg-zinc-950 text-white shadow-sm'
                      : 'text-zinc-600 hover:text-zinc-950'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {tab === 'camera' && (
              <div className="space-y-3">
                {cameraError ? (
                  <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-center text-xs text-zinc-600">
                    <p>{cameraError}</p>
                    <div className="mt-3 flex justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => setTab('upload')}
                        className="rounded-full bg-zinc-950 px-3.5 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800"
                      >
                        Upload QR Image
                      </button>
                      <button
                        type="button"
                        onClick={() => setTab('paste')}
                        className="rounded-full border border-zinc-300 bg-white px-3.5 py-1.5 text-[11px] font-semibold text-zinc-900 hover:bg-zinc-100"
                      >
                        Paste Link
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-zinc-950">
                    <video
                      ref={videoRef}
                      playsInline
                      muted
                      className="h-full w-full object-cover"
                    />
                    <div className="pointer-events-none absolute inset-8 rounded-2xl border-2 border-white/75" />
                    <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-zinc-950/80 px-3 py-1 text-[11px] font-medium text-white backdrop-blur">
                      Point camera at invite QR code
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'upload' && (
              <div className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelected}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={loadingPreview}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-zinc-300 bg-zinc-50/70 px-4 py-10 text-center transition hover:border-zinc-900 hover:bg-zinc-100/70 disabled:opacity-50"
                >
                  <ImageUp className="h-6 w-6 text-zinc-700" />
                  <span className="text-xs font-semibold text-zinc-900">
                    {loadingPreview ? 'Scanning QR image...' : 'Choose QR Screenshot or Photo'}
                  </span>
                  <span className="text-[11px] text-zinc-500">
                    PNG, JPG, or WebP screenshot of an admin invite QR
                  </span>
                </button>
              </div>
            )}

            {tab === 'paste' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void resolveRawInvite(pasteText);
                }}
                className="space-y-2.5"
              >
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Invite Link, Token, or QR JSON
                  <textarea
                    rows={3}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder="https://.../join?token=inv_... or inv_..."
                    className="mt-1.5 w-full rounded-2xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 font-mono text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                  />
                </label>
                <button
                  type="submit"
                  disabled={loadingPreview || !pasteText.trim()}
                  className="w-full rounded-full bg-zinc-950 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  {loadingPreview ? 'Checking invite...' : 'Verify Invite'}
                </button>
              </form>
            )}
          </>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-xs">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Invite Preview
              </div>
              <div className="text-base font-bold text-zinc-950">{preview.groupName}</div>
              <div className="flex flex-wrap gap-3 pt-1 text-zinc-600">
                <span>
                  Role: <strong className="text-zinc-950">{preview.assignedRole}</strong>
                </span>
                <span>
                  Status:{' '}
                  <strong className={preview.valid ? 'text-zinc-950' : 'text-rose-600'}>
                    {preview.valid ? 'Active' : 'Expired / Used Up'}
                  </strong>
                </span>
              </div>
            </div>

            {!preview.valid && (
              <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                This invite has expired or reached its max uses. Ask an admin for a new QR.
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setError(null);
                }}
                className="flex-1 rounded-full border border-zinc-200 bg-white py-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"
              >
                Scan Different QR
              </button>
              <button
                type="button"
                disabled={!preview.valid || joining}
                onClick={() => void handleConfirm()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-zinc-950 py-2.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {joining
                  ? 'Joining...'
                  : mode === 'pre-auth'
                    ? 'Use Invite'
                    : `Join ${preview.groupName}`}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
            {error}
          </div>
        )}

        {isOnboardingPrompt && (
          <div className="mt-4 border-t border-zinc-100 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-full border border-zinc-200 bg-white py-2 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-950"
            >
              Skip for now — take me to the map
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
