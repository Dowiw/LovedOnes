'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Clock,
  EyeOff,
  Loader2,
  MapPin,
  Moon,
  Navigation,
  Radio,
  ShieldAlert,
  Sun,
  Users,
} from 'lucide-react';
import {
  buildExternalMapsUrls,
  formatCountdownRemaining,
  type LocationBroadcast,
  type MapRegion,
  type PublicLocationShareSnapshot,
} from '@loved-ones/shared';
import { MapCanvas } from '@/components/MapCanvas';
import {
  apiFetchMapRegions,
  apiFetchPublicShareSnapshot,
  apiSendPublicSharePing,
  apiStopPublicSharePing,
} from '@/lib/api';
import { type MapThemePreference, resolveMapTheme } from '@/lib/mapTheme';

interface StoredGuestSession {
  guestId: string;
  guestSecret: string;
  displayName: string;
}

export default function PublicSharePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === 'string' ? params.token : '';

  const [snapshot, setSnapshot] = useState<PublicLocationShareSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mapRegions, setMapRegions] = useState<MapRegion[]>([]);
  const [mapRegionsLoaded, setMapRegionsLoaded] = useState(false);

  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [themePref, setThemePref] = useState<MapThemePreference>('system');
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [guestSession, setGuestSession] = useState<StoredGuestSession | null>(null);
  const [sharingLive, setSharingLive] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const guestSessionRef = useRef<StoredGuestSession | null>(guestSession);
  guestSessionRef.current = guestSession;
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (media) setSystemPrefersDark(media.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    media?.addEventListener?.('change', onChange);
    return () => media?.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    if (!token) return;
    try {
      const raw = window.sessionStorage.getItem(`lovedones_guest_share_${token}`);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredGuestSession;
        if (parsed.guestId && parsed.guestSecret && parsed.displayName) {
          setGuestSession(parsed);
          setDisplayName(parsed.displayName);
        }
      }
    } catch {
      // ignore storage errors
    }
  }, [token]);

  useEffect(() => {
    void apiFetchMapRegions()
      .then((res) => {
        setMapRegions(res.regions);
        setMapRegionsLoaded(true);
      })
      .catch(() => setMapRegionsLoaded(true));
  }, []);

  const refreshSnapshot = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiFetchPublicShareSnapshot(token);
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Share link unavailable');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refreshSnapshot();
    const pollTimer = window.setInterval(() => {
      void refreshSnapshot();
    }, 5000);
    const clockTimer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(pollTimer);
      window.clearInterval(clockTimer);
    };
  }, [refreshSnapshot]);

  const sendGuestCoordinate = useCallback(
    async (coords: { latitude: number; longitude: number; accuracy?: number | null }) => {
      if (!token) return;
      const cleanName = displayNameRef.current.trim();
      if (!cleanName) return;
      const activeGuest = guestSessionRef.current;
      const res = await apiSendPublicSharePing(token, {
        displayName: cleanName,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy ?? null,
        guestId: activeGuest?.guestId,
        guestSecret: activeGuest?.guestSecret,
      });
      const nextSession: StoredGuestSession = {
        guestId: res.guestId,
        guestSecret: res.guestSecret,
        displayName: cleanName,
      };
      setGuestSession(nextSession);
      setSnapshot(res.snapshot);
      try {
        window.sessionStorage.setItem(
          `lovedones_guest_share_${token}`,
          JSON.stringify(nextSession),
        );
      } catch {
        // ignore storage errors
      }
      setShareStatus(`Sharing live as ${cleanName}`);
      setShareError(null);
    },
    [token],
  );

  useEffect(() => {
    if (!sharingLive) {
      if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setShareError('Browser geolocation is unavailable on this device.');
      setSharingLive(false);
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        void sendGuestCoordinate({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }).catch((err) => {
          setShareError(err instanceof Error ? err.message : 'Failed to update guest pin');
        });
      },
      (geoErr) => {
        setShareError(geoErr.message || 'Location permission denied');
        setSharingLive(false);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );

    return () => {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [sharingLive, sendGuestCoordinate]);

  async function handleStartGuestShare(e: React.FormEvent) {
    e.preventDefault();
    const cleanName = displayName.trim();
    if (!cleanName) {
      setShareError('Enter your name so others on this link know who you are.');
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setShareError('Geolocation is not supported in this browser.');
      return;
    }
    setShareError(null);
    setShareBusy(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
        });
      });
      await sendGuestCoordinate({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      });
      setSharingLive(true);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Unable to get your location');
    } finally {
      setShareBusy(false);
    }
  }

  async function handleStopGuestShare() {
    setSharingLive(false);
    setShareStatus(null);
    setShareError(null);
    if (!token || !guestSession) return;
    setShareBusy(true);
    try {
      const res = await apiStopPublicSharePing(token, {
        guestId: guestSession.guestId,
        guestSecret: guestSession.guestSecret,
      });
      setSnapshot(res.snapshot);
      setGuestSession(null);
      try {
        window.sessionStorage.removeItem(`lovedones_guest_share_${token}`);
      } catch {
        // ignore storage errors
      }
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Failed to stop sharing');
    } finally {
      setShareBusy(false);
    }
  }

  const resolvedMapTheme = resolveMapTheme(themePref, systemPrefersDark);

  const visiblePins = useMemo<LocationBroadcast[]>(() => {
    if (!snapshot) return [];
    const pins: LocationBroadcast[] = [];
    if (
      !snapshot.creator.hidden &&
      snapshot.creator.latitude !== null &&
      snapshot.creator.longitude !== null
    ) {
      pins.push({
        userId: snapshot.creator.userId,
        username: snapshot.creator.username,
        avatarUrl: snapshot.creator.avatarUrl,
        haloColor: snapshot.creator.haloColor,
        fuzzCircleColor: snapshot.creator.fuzzCircleColor,
        groupId: snapshot.token,
        latitude: snapshot.creator.latitude,
        longitude: snapshot.creator.longitude,
        altitude: snapshot.creator.altitude,
        speed: snapshot.creator.speed,
        batteryLevel: snapshot.creator.batteryLevel,
        recordedAt: snapshot.creator.recordedAt ?? new Date().toISOString(),
        privacyMode: snapshot.creator.privacyMode,
        isFuzzed: snapshot.creator.isFuzzed,
      });
    }
    for (const g of snapshot.guests) {
      pins.push({
        userId: g.id,
        username: g.displayName,
        avatarUrl: null,
        haloColor: '#10b981',
        fuzzCircleColor: null,
        groupId: snapshot.token,
        latitude: g.latitude,
        longitude: g.longitude,
        altitude: null,
        speed: null,
        batteryLevel: null,
        recordedAt: g.updatedAt,
        privacyMode: 'EXACT',
        isFuzzed: false,
      });
    }
    return pins;
  }, [snapshot]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#f4f4f5] p-6 text-xs text-zinc-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading temporary share map...
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#f4f4f5] px-4 py-8">
        <div className="w-full max-w-md rounded-xl border border-zinc-200/80 bg-white p-7 text-center shadow-[0_18px_50px_rgba(9,9,11,0.08)]">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-rose-50 text-rose-600">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <h1 className="text-base font-bold text-zinc-950">Share Link Unavailable</h1>
          <p className="mt-1.5 text-xs text-zinc-500">
            {error ?? 'This temporary share link has expired or been revoked.'}
          </p>
          <Link
            href="/"
            className="lo-press mt-5 inline-flex items-center gap-1.5 rounded-lg bg-zinc-950 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-800"
          >
            <MapPin className="h-3.5 w-3.5" />
            Open LovedOnes
          </Link>
        </div>
      </div>
    );
  }

  const remainingLabel = formatCountdownRemaining(snapshot.expiresAt, nowTick);

  return (
    <div
      data-map-theme={resolvedMapTheme}
      className={`lo-app-shell relative w-full overflow-hidden transition-colors duration-300 ${
        resolvedMapTheme === 'dark' ? 'bg-[#0c141d]' : 'bg-[#cfe3ee]'
      }`}
    >
      <MapCanvas
        locations={visiblePins}
        regions={mapRegionsLoaded ? mapRegions : undefined}
        selectedUserId={selectedPinId}
        mapTheme={resolvedMapTheme}
      />

      {/* Top Capsule: Creator, Countdown & Participant Pills */}
      <div className="pointer-events-none absolute left-[calc(0.75rem+var(--lo-safe-left,0px))] right-[calc(0.75rem+var(--lo-safe-right,0px))] top-[calc(0.75rem+var(--lo-safe-top,0px))] z-20 flex flex-col gap-2 sm:left-[calc(1rem+var(--lo-safe-left,0px))] sm:right-auto sm:top-[calc(1rem+var(--lo-safe-top,0px))] sm:w-[360px]">
        <div className="lo-float-in pointer-events-auto rounded-xl border border-zinc-200/80 bg-white/94 p-3 shadow-[0_12px_36px_rgba(9,9,11,0.12)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-950 text-white">
                  <MapPin className="h-3.5 w-3.5" />
                </span>
                <span className="truncate text-xs font-bold text-zinc-950">
                  {snapshot.label ?? `${snapshot.creator.username}'s Live Share`}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {remainingLabel}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {visiblePins.length} active
                </span>
                {snapshot.creator.hidden && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-700">
                    <EyeOff className="h-2.5 w-2.5" />
                    {snapshot.creator.username} is in Ghost mode
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              title="Toggle map theme"
              onClick={() =>
                setThemePref((prev) =>
                  prev === 'system' ? 'dark' : prev === 'dark' ? 'light' : 'system',
                )
              }
              className="lo-press shrink-0 rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-700 hover:bg-zinc-100"
            >
              {resolvedMapTheme === 'dark' ? (
                <Moon className="h-3.5 w-3.5" />
              ) : (
                <Sun className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {visiblePins.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-2.5">
              {visiblePins.map((pin) => {
                const maps = buildExternalMapsUrls({
                  latitude: pin.latitude,
                  longitude: pin.longitude,
                  label: pin.isFuzzed ? `${pin.username} (~1km)` : pin.username,
                  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
                });
                const isSelected = selectedPinId === pin.userId;
                return (
                  <div
                    key={pin.userId}
                    className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition ${
                      isSelected
                        ? 'border-zinc-950 bg-zinc-950 text-white'
                        : 'border-zinc-200 bg-zinc-50 text-zinc-800'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedPinId(pin.userId)}
                      className="font-semibold"
                    >
                      {pin.username}
                      {pin.isFuzzed ? ' (~1km)' : ''}
                    </button>
                    <a
                      href={maps.primaryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${pin.username} in Maps`}
                      className={`ml-0.5 rounded p-0.5 ${
                        isSelected ? 'text-white/90 hover:text-white' : 'text-zinc-500 hover:text-zinc-950'
                      }`}
                    >
                      <Navigation className="h-3 w-3" />
                    </a>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Mutual Guest Share Controls */}
      {snapshot.allowGuestSharing && (
        <div className="pointer-events-none absolute bottom-[calc(0.75rem+var(--lo-safe-bottom,0px))] left-[calc(0.75rem+var(--lo-safe-left,0px))] right-[calc(3.25rem+var(--lo-safe-right,0px))] z-20 sm:bottom-[calc(1rem+var(--lo-safe-bottom,0px))] sm:left-1/2 sm:right-auto sm:w-full sm:max-w-md sm:-translate-x-1/2">
          <div className="lo-float-in pointer-events-auto rounded-xl border border-zinc-200/85 bg-white/95 p-3 shadow-[0_14px_38px_rgba(9,9,11,0.14)] backdrop-blur-xl">
            {sharingLive || guestSession ? (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-950">
                    <Radio className="h-3.5 w-3.5 text-emerald-600" />
                    <span className="truncate">
                      {shareStatus ?? `Visible on this link as ${guestSession?.displayName ?? displayName}`}
                    </span>
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    Only people on this exact link see your temporary pin.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={shareBusy}
                  onClick={() => void handleStopGuestShare()}
                  className="lo-press shrink-0 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60"
                >
                  Stop
                </button>
              </div>
            ) : (
              <form onSubmit={handleStartGuestShare} className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    maxLength={40}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your name to share back..."
                    className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={shareBusy}
                    className="lo-press flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
                  >
                    {shareBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Radio className="h-3.5 w-3.5" />
                    )}
                    Share My Pin
                  </button>
                </div>
                <p className="text-[10px] text-zinc-500">
                  Guests on this link see only each other—never private group members.
                </p>
              </form>
            )}
            {shareError && <p className="mt-1.5 text-[11px] text-rose-600">{shareError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
