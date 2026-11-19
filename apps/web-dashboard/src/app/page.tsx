'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  BellRing,
  Check,
  Compass,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LocateFixed,
  MapPin,
  MessageSquare,
  Plus,
  Radio,
  Send,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  ChatMessage,
  GroupPlace,
  LocationBroadcast,
  LocationRequestItem,
  PlaceTransitionEvent,
  PrivacyMode,
} from '@loved-ones/shared';
import { MapCanvas } from '@/components/MapCanvas';
import { NavBar } from '@/components/NavBar';
import {
  apiCreateGroup,
  apiCreateGroupPlace,
  apiCreateLocationRequest,
  apiCreateTrackerToken,
  apiDeleteGroupPlace,
  apiFetchGroupLocations,
  apiFetchGroupMessages,
  apiFetchGroupPlaces,
  apiFetchGroups,
  apiFetchLocationRequests,
  apiGetTrackerTokenStatus,
  apiLogin,
  apiRegister,
  apiRespondLocationRequest,
  apiRevokeTrackerToken,
  apiSendLocationBatch,
  apiUpdatePrivacy,
  getServiceBaseUrls,
  GroupItem,
  loadSession,
  saveSession,
  StoredSession,
  TrackerTokenResponse,
} from '@/lib/api';

export default function HomePage() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>('');
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);

  const [locations, setLocations] = useState<LocationBroadcast[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');

  const [geoSharing, setGeoSharing] = useState(false);
  const [geoStatus, setGeoStatus] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const [trackerDays, setTrackerDays] = useState<number>(30);
  const [trackerActive, setTrackerActive] = useState(false);
  const [trackerTtlSeconds, setTrackerTtlSeconds] = useState(0);
  const [trackerIssued, setTrackerIssued] = useState<TrackerTokenResponse | null>(null);
  const [trackerLoading, setTrackerLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const [locationRequests, setLocationRequests] = useState<LocationRequestItem[]>([]);
  const [myPrivacyOverrideUntil, setMyPrivacyOverrideUntil] = useState<string | null>(null);
  const [checkinTargetUserId, setCheckinTargetUserId] = useState<string>('');
  const [checkinDuration, setCheckinDuration] = useState<number>(15);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [checkinError, setCheckinError] = useState<string | null>(null);

  const [places, setPlaces] = useState<GroupPlace[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [placeTransitions, setPlaceTransitions] = useState<PlaceTransitionEvent[]>([]);
  const [placeName, setPlaceName] = useState('');
  const [placeLat, setPlaceLat] = useState('');
  const [placeLon, setPlaceLon] = useState('');
  const [placeRadius, setPlaceRadius] = useState<number>(150);
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  useEffect(() => {
    setSession(loadSession());
  }, []);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  );

  const refreshGroups = useCallback(async (token: string) => {
    const list = await apiFetchGroups(token);
    setGroups(list);
    setActiveGroupId((prev) => (prev && list.some((g) => g.id === prev) ? prev : list[0]?.id ?? ''));
  }, []);

  useEffect(() => {
    if (!session) return;
    void refreshGroups(session.accessToken).catch(() => {});
    void apiGetTrackerTokenStatus(session.accessToken)
      .then((st) => {
        setTrackerActive(st.active);
        setTrackerTtlSeconds(st.ttlSeconds);
      })
      .catch(() => {});
  }, [session, refreshGroups]);

  async function handleGenerateTrackerToken() {
    if (!session) return;
    setTrackerLoading(true);
    try {
      const created = await apiCreateTrackerToken(session.accessToken, trackerDays);
      setTrackerIssued(created);
      setTrackerActive(true);
      setTrackerTtlSeconds(created.expiresInDays * 86400);
    } catch (err) {
      setGeoStatus(err instanceof Error ? err.message : 'Failed to generate tracker token');
    } finally {
      setTrackerLoading(false);
    }
  }

  async function handleRevokeTrackerToken() {
    if (!session) return;
    setTrackerLoading(true);
    try {
      await apiRevokeTrackerToken(session.accessToken);
      setTrackerIssued(null);
      setTrackerActive(false);
      setTrackerTtlSeconds(0);
    } catch {
      // ignore
    } finally {
      setTrackerLoading(false);
    }
  }

  function handleCopyText(key: string, value: string) {
    void navigator.clipboard.writeText(value);
    setCopiedField(key);
    setTimeout(() => setCopiedField((prev) => (prev === key ? null : prev)), 2000);
  }

  // Socket.io connection for live updates
  useEffect(() => {
    if (!session) return;

    const { realtimeBase } = getServiceBaseUrls();
    const socket = io(realtimeBase || undefined, {
      auth: { token: session.accessToken },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('location:update', (update: LocationBroadcast) => {
      setLocations((prev) => {
        if (activeGroup && update.groupId !== activeGroup.id) return prev;
        const idx = prev.findIndex((p) => p.userId === update.userId);
        if (idx === -1) return [...prev, update];
        const next = [...prev];
        next[idx] = update;
        return next;
      });
    });

    socket.on('chat:message', (msg: ChatMessage) => {
      setMessages((prev) => {
        if (activeGroup && msg.groupId !== activeGroup.id) return prev;
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    socket.on('checkin:request', (req: LocationRequestItem) => {
      setLocationRequests((prev) => {
        if (activeGroup && req.groupId !== activeGroup.id) return prev;
        if (prev.some((r) => r.id === req.id)) return prev;
        return [req, ...prev];
      });
    });

    socket.on('checkin:response', (req: LocationRequestItem) => {
      setLocationRequests((prev) => {
        if (activeGroup && req.groupId !== activeGroup.id) return prev;
        const exists = prev.some((r) => r.id === req.id);
        return exists ? prev.map((r) => (r.id === req.id ? req : r)) : [req, ...prev];
      });
    });

    socket.on('place:transition', (evt: PlaceTransitionEvent) => {
      setPlaceTransitions((prev) => {
        if (activeGroup && evt.groupId !== activeGroup.id) return prev;
        if (evt.id && prev.some((e) => e.id === evt.id)) return prev;
        return [evt, ...prev].slice(0, 30);
      });
    });

    socket.on('place:updated', (payload: { groupId: string; places: GroupPlace[] }) => {
      if (activeGroup && payload.groupId !== activeGroup.id) return;
      setPlaces(payload.places);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session, activeGroup]);

  // Fetch snapshot when active group changes
  useEffect(() => {
    if (!session || !activeGroup) {
      setLocations([]);
      setMessages([]);
      setLocationRequests([]);
      setMyPrivacyOverrideUntil(null);
      setPlaces([]);
      setPlaceTransitions([]);
      return;
    }

    socketRef.current?.emit('group:join', activeGroup.id);

    const otherMembers = activeGroup.members.filter((m) => m.userId !== session.user.id);
    setCheckinTargetUserId((prev) =>
      prev && otherMembers.some((m) => m.userId === prev) ? prev : otherMembers[0]?.userId ?? '',
    );

    void apiFetchGroupLocations(session.accessToken, activeGroup.id)
      .then(setLocations)
      .catch(() => setLocations([]));
    void apiFetchGroupMessages(session.accessToken, activeGroup.id)
      .then(setMessages)
      .catch(() => setMessages([]));
    void apiFetchLocationRequests(session.accessToken, activeGroup.id)
      .then((res) => {
        setLocationRequests(res.requests);
        setMyPrivacyOverrideUntil(res.myPrivacyOverrideUntil);
      })
      .catch(() => {
        setLocationRequests([]);
        setMyPrivacyOverrideUntil(null);
      });
    void apiFetchGroupPlaces(session.accessToken, activeGroup.id)
      .then((res) => {
        setPlaces(res.places);
        setPlaceTransitions(res.recentTransitions);
      })
      .catch(() => {
        setPlaces([]);
        setPlaceTransitions([]);
      });
  }, [session, activeGroup]);

  // Foreground Web Geolocation watcher
  useEffect(() => {
    if (!geoSharing || !session) {
      if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoStatus('Browser Geolocation API unavailable');
      setGeoSharing(false);
      return;
    }

    setGeoStatus('Sharing foreground browser location...');
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const point = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude ?? null,
          accuracy:
            typeof pos.coords.accuracy === 'number' && pos.coords.accuracy >= 0
              ? pos.coords.accuracy
              : null,
          speed: pos.coords.speed && pos.coords.speed >= 0 ? pos.coords.speed : null,
          batteryLevel: null,
          recordedAt: new Date(pos.timestamp || Date.now()).toISOString(),
        };
        if (socketRef.current?.connected) {
          socketRef.current.emit('location:batch', { points: [point] });
        } else {
          void apiSendLocationBatch(session.accessToken, [point]);
        }
        setGeoStatus(
          `Last ping: ${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)} (${new Date().toLocaleTimeString()})`,
        );
      },
      (err) => {
        setGeoStatus(`Geolocation error: ${err.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    watchIdRef.current = id;

    return () => {
      navigator.geolocation.clearWatch(id);
      watchIdRef.current = null;
    };
  }, [geoSharing, session]);

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const nextSession =
        authMode === 'login'
          ? await apiLogin(email, password)
          : await apiRegister({ email, username, password });
      saveSession(nextSession);
      setSession(nextSession);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !newGroupName.trim()) return;
    setCreatingGroup(true);
    try {
      const created = await apiCreateGroup(session.accessToken, newGroupName.trim());
      setNewGroupName('');
      await refreshGroups(session.accessToken);
      setActiveGroupId(created.id);
    } finally {
      setCreatingGroup(false);
    }
  }

  async function handlePrivacyChange(mode: PrivacyMode) {
    if (!session || !activeGroup) return;
    await apiUpdatePrivacy(session.accessToken, activeGroup.id, mode);
    await refreshGroups(session.accessToken);
  }

  async function handleSendTestPing() {
    if (!session) return;
    const jitterLat = 48.8566 + (Math.random() - 0.5) * 0.01;
    const jitterLon = 2.3522 + (Math.random() - 0.5) * 0.01;
    const point = {
      latitude: Number(jitterLat.toFixed(6)),
      longitude: Number(jitterLon.toFixed(6)),
      altitude: 35,
      speed: 1.4,
      batteryLevel: 94,
      recordedAt: new Date().toISOString(),
    };
    if (socketRef.current?.connected) {
      socketRef.current.emit('location:batch', { points: [point] });
    } else {
      await apiSendLocationBatch(session.accessToken, [point]);
    }
    setGeoStatus(`Sent ping at ${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`);
  }

  function handleSendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!activeGroup || !chatInput.trim() || !socketRef.current) return;
    socketRef.current.emit('chat:send', {
      groupId: activeGroup.id,
      content: chatInput.trim(),
    });
    setChatInput('');
  }

  function handleSignOut() {
    setGeoSharing(false);
    saveSession(null);
    setSession(null);
    setGroups([]);
    setLocations([]);
    setMessages([]);
    setLocationRequests([]);
    setMyPrivacyOverrideUntil(null);
    setPlaces([]);
    setPlaceTransitions([]);
  }

  async function handleSendCheckInRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !activeGroup || !checkinTargetUserId) return;
    setCheckinBusy(true);
    setCheckinError(null);
    try {
      const created = await apiCreateLocationRequest(session.accessToken, activeGroup.id, {
        targetUserId: checkinTargetUserId,
        suggestedDurationMinutes: checkinDuration,
      });
      setLocationRequests((prev) =>
        prev.some((r) => r.id === created.id) ? prev : [created, ...prev],
      );
    } catch (err) {
      setCheckinError(err instanceof Error ? err.message : 'Failed to request check-in');
    } finally {
      setCheckinBusy(false);
    }
  }

  async function handleRespondCheckIn(requestId: string, action: 'accept' | 'decline') {
    if (!session || !activeGroup) return;
    setCheckinBusy(true);
    setCheckinError(null);
    try {
      const res = await apiRespondLocationRequest(
        session.accessToken,
        activeGroup.id,
        requestId,
        action,
      );
      setLocationRequests((prev) => prev.map((r) => (r.id === res.request.id ? res.request : r)));
      if (res.privacyOverrideUntil) {
        setMyPrivacyOverrideUntil(res.privacyOverrideUntil);
      }
    } catch (err) {
      setCheckinError(err instanceof Error ? err.message : 'Failed to respond');
    } finally {
      setCheckinBusy(false);
    }
  }

  async function handleCreatePlace(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !activeGroup) return;
    const latitude = Number(placeLat);
    const longitude = Number(placeLon);
    if (!placeName.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setPlaceError('Enter place name and valid numeric coordinates (or click the map).');
      return;
    }
    setPlaceBusy(true);
    setPlaceError(null);
    try {
      const created = await apiCreateGroupPlace(session.accessToken, activeGroup.id, {
        name: placeName.trim(),
        latitude,
        longitude,
        radiusMeters: placeRadius,
      });
      setPlaceName('');
      setPlaces((prev) => (prev.some((p) => p.id === created.id) ? prev : [...prev, created]));
    } catch (err) {
      setPlaceError(err instanceof Error ? err.message : 'Failed to create place');
    } finally {
      setPlaceBusy(false);
    }
  }

  async function handleDeletePlace(placeId: string) {
    if (!session || !activeGroup) return;
    try {
      await apiDeleteGroupPlace(session.accessToken, activeGroup.id, placeId);
      setPlaces((prev) => prev.filter((p) => p.id !== placeId));
    } catch {
      // ignore
    }
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-950">
        <NavBar user={null} onSignOut={() => {}} />
        <main className="mx-auto flex max-w-md flex-col justify-center px-4 py-16">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <h1 className="text-xl font-bold text-white">
              {authMode === 'login' ? 'Sign in to LovedOnes' : 'Create your LovedOnes account'}
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Self-hosted group location sharing & encrypted messaging. The first account becomes Host
              Admin.
            </p>

            <form onSubmit={handleAuthSubmit} className="mt-5 space-y-3">
              <label className="block text-xs text-slate-300">
                Email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                  placeholder="you@example.com"
                />
              </label>

              {authMode === 'register' && (
                <label className="block text-xs text-slate-300">
                  Username
                  <input
                    type="text"
                    required
                    minLength={2}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                    placeholder="Alex"
                  />
                </label>
              )}

              <label className="block text-xs text-slate-300">
                Password
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                  placeholder="••••••••"
                />
              </label>

              {authError && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className="w-full rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                {authLoading
                  ? 'Please wait...'
                  : authMode === 'login'
                    ? 'Sign in'
                    : 'Create account'}
              </button>
            </form>

            <button
              type="button"
              onClick={() => {
                setAuthMode((m) => (m === 'login' ? 'register' : 'login'));
                setAuthError(null);
              }}
              className="mt-4 w-full text-center text-xs text-sky-400 hover:underline"
            >
              {authMode === 'login'
                ? 'Need an account? Register here'
                : 'Already registered? Sign in'}
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-950">
      <NavBar user={session.user} onSignOut={handleSignOut} />

      <div className="mx-auto grid w-full max-w-7xl flex-1 gap-4 p-4 lg:grid-cols-[320px_1fr_340px]">
        {/* Left Sidebar: Groups, Privacy, Geolocation */}
        <aside className="flex flex-col gap-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Users className="h-4 w-4 text-emerald-400" />
                Groups
              </div>
              <span className="text-xs text-slate-400">{groups.length}</span>
            </div>

            <div className="mt-3 space-y-1.5">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setActiveGroupId(g.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition ${
                    activeGroup?.id === g.id
                      ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40'
                      : 'bg-slate-950/60 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <span className="font-medium">{g.name}</span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {g.myRole}
                  </span>
                </button>
              ))}
              {groups.length === 0 && (
                <p className="text-xs text-slate-500">Create a group below to start sharing.</p>
              )}
            </div>

            <form onSubmit={handleCreateGroup} className="mt-3 flex gap-2">
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="New group name..."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white"
              />
              <button
                type="submit"
                disabled={creatingGroup || !newGroupName.trim()}
                className="flex shrink-0 items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </form>
          </div>

          {activeGroup && (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <ShieldCheck className="h-4 w-4 text-sky-400" />
                Privacy Mode
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Control how {activeGroup.name} sees your GPS location.
              </p>

              <div className="mt-3 grid grid-cols-3 gap-1.5">
                {(['EXACT', 'FUZZED', 'GHOST'] as PrivacyMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => void handlePrivacyChange(mode)}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-medium transition ${
                      activeGroup.myPrivacy === mode
                        ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {mode === 'EXACT' && <LocateFixed className="h-3.5 w-3.5" />}
                    {mode === 'FUZZED' && <Compass className="h-3.5 w-3.5" />}
                    {mode === 'GHOST' && <EyeOff className="h-3.5 w-3.5" />}
                    {mode}
                  </button>
                ))}
              </div>
              {myPrivacyOverrideUntil && Date.parse(myPrivacyOverrideUntil) > Date.now() && (
                <div className="mt-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-300">
                  Temporary EXACT check-in active until{' '}
                  {new Date(myPrivacyOverrideUntil).toLocaleTimeString()}
                </div>
              )}
            </div>
          )}

          {activeGroup && (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <BellRing className="h-4 w-4 text-amber-400" />
                Location Check-Ins
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Ask a member in GHOST/FUZZED mode for temporary exact sharing.
              </p>

              {activeGroup.members.some((m) => m.userId !== session.user.id) ? (
                <form onSubmit={handleSendCheckInRequest} className="mt-3 flex gap-1.5">
                  <select
                    value={checkinTargetUserId}
                    onChange={(e) => setCheckinTargetUserId(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white"
                  >
                    {activeGroup.members
                      .filter((m) => m.userId !== session.user.id)
                      .map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.username}
                        </option>
                      ))}
                  </select>
                  <select
                    value={checkinDuration}
                    onChange={(e) => setCheckinDuration(Number(e.target.value))}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white"
                  >
                    <option value={15}>15m</option>
                    <option value={30}>30m</option>
                    <option value={60}>60m</option>
                  </select>
                  <button
                    type="submit"
                    disabled={checkinBusy || !checkinTargetUserId}
                    className="shrink-0 rounded-lg bg-amber-500 px-2.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                  >
                    Ask
                  </button>
                </form>
              ) : (
                <p className="mt-2 text-[11px] text-slate-500">
                  Invite another member to send check-in requests.
                </p>
              )}

              {checkinError && (
                <p className="mt-2 text-[11px] text-rose-400">{checkinError}</p>
              )}

              {locationRequests.length > 0 && (
                <div className="mt-3 max-h-40 space-y-1.5 overflow-y-auto">
                  {locationRequests.map((req) => {
                    const isIncoming = req.targetUserId === session.user.id;
                    return (
                      <div
                        key={req.id}
                        className="rounded-lg border border-slate-800 bg-slate-950/70 p-2 text-[11px]"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-medium text-slate-200">
                            {isIncoming
                              ? `${req.requesterUsername} asked (${req.suggestedDurationMinutes}m)`
                              : `To ${req.targetUsername} (${req.suggestedDurationMinutes}m)`}
                          </span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">
                            {req.status}
                          </span>
                        </div>
                        {isIncoming && req.status === 'pending' && (
                          <div className="mt-1.5 flex gap-1.5">
                            <button
                              type="button"
                              disabled={checkinBusy}
                              onClick={() => void handleRespondCheckIn(req.id, 'accept')}
                              className="flex flex-1 items-center justify-center gap-1 rounded bg-emerald-500 py-1 text-[10px] font-semibold text-slate-950 hover:bg-emerald-400"
                            >
                              <Check className="h-3 w-3" /> Accept
                            </button>
                            <button
                              type="button"
                              disabled={checkinBusy}
                              onClick={() => void handleRespondCheckIn(req.id, 'decline')}
                              className="flex flex-1 items-center justify-center gap-1 rounded border border-slate-700 bg-slate-800 py-1 text-[10px] text-slate-200 hover:bg-slate-700"
                            >
                              <X className="h-3 w-3" /> Decline
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Radio className="h-4 w-4 text-emerald-400" />
              Foreground Web Beacon
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Browser foreground geolocation sharing for desktop & iOS Safari users.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setGeoSharing((s) => !s)}
                className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                  geoSharing
                    ? 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/40'
                    : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                }`}
              >
                {geoSharing ? 'Stop Web Geolocation' : 'Start Web Geolocation'}
              </button>
              <button
                type="button"
                onClick={() => void handleSendTestPing()}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
              >
                Send Test GPS Ping
              </button>
            </div>
            {geoStatus && <p className="mt-2 text-[11px] text-slate-400">{geoStatus}</p>}
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <KeyRound className="h-4 w-4 text-sky-400" />
                Tracker Setup (OwnTracks / Overland)
              </div>
              {trackerActive && (
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                  Active ({Math.max(1, Math.ceil(trackerTtlSeconds / 86400))}d left)
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Generate a scoped, expiring ingestion token for iOS/Android background tracker apps.
            </p>

            <div className="mt-3 flex items-center gap-2">
              <select
                value={trackerDays}
                onChange={(e) => setTrackerDays(Number(e.target.value))}
                className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white"
              >
                <option value={7}>Expires in 7 days</option>
                <option value={30}>Expires in 30 days</option>
                <option value={90}>Expires in 90 days</option>
                <option value={365}>Expires in 1 year</option>
              </select>
              <button
                type="button"
                disabled={trackerLoading}
                onClick={() => void handleGenerateTrackerToken()}
                className="flex-1 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
              >
                {trackerActive ? 'Rotate Token' : 'Generate Token'}
              </button>
              {trackerActive && (
                <button
                  type="button"
                  disabled={trackerLoading}
                  onClick={() => void handleRevokeTrackerToken()}
                  title="Revoke active tracker token"
                  className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {trackerIssued && (
              <div className="mt-3 space-y-2 rounded-lg border border-slate-800 bg-slate-950/80 p-2.5 text-[11px]">
                <div>
                  <div className="text-slate-400">OwnTracks HTTP URL</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      readOnly
                      value={trackerIssued.owntracksUrl}
                      className="w-full rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[10px] text-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopyText('owntracks', trackerIssued.owntracksUrl)}
                      className="shrink-0 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700"
                    >
                      {copiedField === 'owntracks' ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-slate-400">Overland Receiver URL</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      readOnly
                      value={trackerIssued.overlandUrl}
                      className="w-full rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[10px] text-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopyText('overland', trackerIssued.overlandUrl)}
                      className="shrink-0 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700"
                    >
                      {copiedField === 'overland' ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-slate-400">Scoped Ingestion Token (Bearer / Basic Password)</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      readOnly
                      value={trackerIssued.token}
                      className="w-full rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[10px] text-emerald-300"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopyText('token', trackerIssued.token)}
                      className="shrink-0 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700"
                    >
                      {copiedField === 'token' ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Eye className="h-4 w-4 text-slate-300" />
              Visible Members ({locations.length})
            </div>
            <div className="mt-2 space-y-1.5">
              {locations.map((loc) => (
                <button
                  key={loc.userId}
                  type="button"
                  onClick={() => setSelectedUserId(loc.userId)}
                  className="flex w-full items-center justify-between rounded-lg bg-slate-950/70 px-3 py-2 text-left text-xs hover:bg-slate-800"
                >
                  <div>
                    <div className="font-medium text-white">{loc.username}</div>
                    <div className="text-[11px] text-slate-400">
                      {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                    </div>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      loc.isFuzzed
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-emerald-500/20 text-emerald-300'
                    }`}
                  >
                    {loc.privacyMode}
                  </span>
                </button>
              ))}
              {locations.length === 0 && (
                <p className="text-xs text-slate-500">No active beacons in this group.</p>
              )}
            </div>
          </div>

          {activeGroup && (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <MapPin className="h-4 w-4 text-sky-400" />
                  Group Places ({places.length})
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Arrival &amp; departure zones (EXACT mode members only).
              </p>

              {activeGroup.myRole === 'ADMIN' && (
                <form onSubmit={handleCreatePlace} className="mt-3 space-y-2">
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={placeName}
                      onChange={(e) => setPlaceName(e.target.value)}
                      placeholder="Home, School, Work..."
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white"
                    />
                    <input
                      type="number"
                      min={25}
                      max={10000}
                      value={placeRadius}
                      onChange={(e) => setPlaceRadius(Number(e.target.value))}
                      title="Radius in meters"
                      className="w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={placeLat}
                      onChange={(e) => setPlaceLat(e.target.value)}
                      placeholder="Lat (click map)"
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-white"
                    />
                    <input
                      type="text"
                      value={placeLon}
                      onChange={(e) => setPlaceLon(e.target.value)}
                      placeholder="Lon (click map)"
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-white"
                    />
                    <button
                      type="submit"
                      disabled={placeBusy}
                      className="shrink-0 rounded-lg bg-sky-500 px-2.5 py-1 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                  {placeError && <p className="text-[11px] text-rose-400">{placeError}</p>}
                </form>
              )}

              <div className="mt-2.5 space-y-1.5">
                {places.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg bg-slate-950/70 px-2.5 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedPlaceId(p.id)}
                      className="min-w-0 flex-1 text-left hover:text-sky-300"
                    >
                      <div className="truncate font-medium text-slate-200">{p.name}</div>
                      <div className="text-[10px] text-slate-400">
                        {p.latitude.toFixed(4)}, {p.longitude.toFixed(4)} · {Math.round(p.radiusMeters)}m
                      </div>
                    </button>
                    {activeGroup.myRole === 'ADMIN' && (
                      <button
                        type="button"
                        onClick={() => void handleDeletePlace(p.id)}
                        title="Remove place"
                        className="ml-2 rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {places.length === 0 && (
                  <p className="text-[11px] text-slate-500">No geofenced places defined yet.</p>
                )}
              </div>

              {placeTransitions.length > 0 && (
                <div className="mt-3 border-t border-slate-800 pt-2">
                  <div className="mb-1 text-[11px] font-medium text-slate-400">
                    Recent Arrivals &amp; Departures
                  </div>
                  <div className="max-h-28 space-y-1 overflow-y-auto text-[11px]">
                    {placeTransitions.map((evt, idx) => (
                      <div
                        key={evt.id ?? `${evt.placeId}-${evt.userId}-${evt.recordedAt}-${idx}`}
                        className="flex items-center justify-between text-slate-300"
                      >
                        <span className="truncate">
                          <span className="font-medium text-white">{evt.username}</span>{' '}
                          {evt.transition === 'enter' ? 'arrived at' : 'left'}{' '}
                          <span className="text-sky-300">{evt.placeName}</span>
                        </span>
                        <span className="ml-2 shrink-0 text-[10px] text-slate-500">
                          {new Date(evt.recordedAt).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>

        {/* Center: Live PMTiles Map */}
        <section className="min-h-[420px] lg:min-h-[640px]">
          <MapCanvas
            locations={locations}
            places={places}
            selectedUserId={selectedUserId}
            selectedPlaceId={selectedPlaceId}
            onMapSelectCoords={(lat, lon) => {
              setPlaceLat(String(lat));
              setPlaceLon(String(lon));
            }}
          />
        </section>

        {/* Right Column: Live Group Chat */}
        <aside className="flex h-[520px] flex-col rounded-xl border border-slate-800 bg-slate-900 lg:h-auto">
          <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
            <MessageSquare className="h-4 w-4 text-sky-400" />
            {activeGroup ? `${activeGroup.name} Chat` : 'Group Chat'}
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto p-4">
            {messages.map((m) => {
              const mine = m.senderId === session.user.id;
              return (
                <div
                  key={m.id}
                  className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                >
                  <div className="mb-0.5 text-[10px] text-slate-400">
                    {m.senderUsername} · {new Date(m.createdAt).toLocaleTimeString()}
                  </div>
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-xs ${
                      mine
                        ? 'bg-emerald-500/20 text-emerald-100 ring-1 ring-emerald-500/30'
                        : 'bg-slate-800 text-slate-200'
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              );
            })}
            {messages.length === 0 && (
              <div className="text-center text-xs text-slate-500">
                No messages yet. Say hello to your group!
              </div>
            )}
          </div>

          <form onSubmit={handleSendChat} className="flex gap-2 border-t border-slate-800 p-3">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              disabled={!activeGroup}
              placeholder={activeGroup ? 'Message group...' : 'Select a group first'}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!activeGroup || !chatInput.trim()}
              className="flex shrink-0 items-center justify-center rounded-lg bg-sky-500 px-3 py-2 text-slate-950 hover:bg-sky-400 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}
