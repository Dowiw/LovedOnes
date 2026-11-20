'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import {
  Activity,
  BellRing,
  Check,
  Compass,
  Copy,
  EyeOff,
  KeyRound,
  Layers,
  LocateFixed,
  LogOut,
  MapPin,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Plus,
  QrCode,
  Radio,
  Route,
  Send,
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
  apiFetchGroupTrails,
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

type InspectorTab = 'people' | 'chat' | 'places' | 'requests';
type MapViewMode = 'live' | 'trails' | 'places';

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
  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);

  const [locations, setLocations] = useState<LocationBroadcast[]>([]);
  const [trails, setTrails] = useState<LocationBroadcast[]>([]);
  const [mapViewMode, setMapViewMode] = useState<MapViewMode>('live');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');

  const [geoSharing, setGeoSharing] = useState(false);
  const [geoStatus, setGeoStatus] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const [trackerOpen, setTrackerOpen] = useState(false);
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

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('people');

  useEffect(() => {
    setSession(loadSession());
  }, []);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  );

  const pendingIncomingCount = useMemo(
    () =>
      session
        ? locationRequests.filter(
            (r) => r.targetUserId === session.user.id && r.status === 'pending',
          ).length
        : 0,
    [locationRequests, session],
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

  function handleCopyText(key: string, value: string) {
    void navigator.clipboard.writeText(value);
    setCopiedField(key);
    setTimeout(() => setCopiedField((prev) => (prev === key ? null : prev)), 2000);
  }

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

  // Fetch snapshots when active group changes
  useEffect(() => {
    if (!session || !activeGroup) {
      setLocations([]);
      setTrails([]);
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

  // Load 24h trails when user switches map view to Trails
  useEffect(() => {
    if (!session || !activeGroup || mapViewMode !== 'trails') return;
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    void apiFetchGroupTrails(session.accessToken, activeGroup.id, { from, to, limit: 1000 })
      .then(setTrails)
      .catch(() => setTrails([]));
  }, [session, activeGroup, mapViewMode]);

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
      setGeoStatus('Browser geolocation unavailable');
      setGeoSharing(false);
      return;
    }

    setGeoStatus('Sharing live browser location...');
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
          `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)} · ${new Date().toLocaleTimeString()}`,
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
      setShowNewGroupForm(false);
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
    const jitterLat = 52.5069 + (Math.random() - 0.5) * 0.02;
    const jitterLon = 13.4448 + (Math.random() - 0.5) * 0.02;
    const point = {
      latitude: Number(jitterLat.toFixed(6)),
      longitude: Number(jitterLon.toFixed(6)),
      altitude: 35,
      accuracy: 10,
      speed: 1.4,
      batteryLevel: 94,
      recordedAt: new Date().toISOString(),
    };
    if (socketRef.current?.connected) {
      socketRef.current.emit('location:batch', { points: [point] });
    } else {
      await apiSendLocationBatch(session.accessToken, [point]);
    }
    setGeoStatus(`Ping ${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`);
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
    setTrails([]);
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
      setPlaceError('Enter a name and valid coordinates (or click the map).');
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
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#e8eff4] px-4">
        <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-[#80f15a]/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -right-24 h-96 w-96 rounded-full bg-sky-300/30 blur-3xl" />

        <div className="relative w-full max-w-md rounded-3xl border border-white/80 bg-white/88 p-8 shadow-[0_24px_60px_rgba(15,23,42,0.09)] backdrop-blur-xl">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 text-[#80f15a]">
              <MapPin className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-zinc-900">LovedOnes</h1>
              <p className="text-xs text-zinc-500">Private group map &amp; check-ins</p>
            </div>
          </div>

          <div className="mb-5 flex rounded-full bg-slate-100 p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => {
                setAuthMode('login');
                setAuthError(null);
              }}
              className={`flex-1 rounded-full py-2 transition ${
                authMode === 'login' ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-600'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode('register');
                setAuthError(null);
              }}
              className={`flex-1 rounded-full py-2 transition ${
                authMode === 'register' ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-600'
              }`}
            >
              Create account
            </button>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-3.5">
            <label className="block text-xs font-medium text-zinc-600">
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                placeholder="you@example.com"
              />
            </label>

            {authMode === 'register' && (
              <label className="block text-xs font-medium text-zinc-600">
                Username
                <input
                  type="text"
                  required
                  minLength={2}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                  placeholder="Alex"
                />
              </label>
            )}

            <label className="block text-xs font-medium text-zinc-600">
              Password
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                placeholder="••••••••"
              />
            </label>

            {authError && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full rounded-full bg-zinc-900 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:opacity-50"
            >
              {authLoading
                ? 'Please wait...'
                : authMode === 'login'
                  ? 'Continue'
                  : 'Create account'}
            </button>
          </form>

          <p className="mt-4 text-center text-[11px] text-zinc-400">
            First registered account automatically becomes Host Admin.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#cfe3ee]">
      {/* Full-bleed Map Canvas */}
      <MapCanvas
        locations={mapViewMode === 'places' ? [] : locations}
        places={places}
        trails={trails}
        showTrails={mapViewMode === 'trails'}
        selectedUserId={selectedUserId}
        selectedPlaceId={selectedPlaceId}
        onMapSelectCoords={(lat, lon) => {
          setPlaceLat(String(lat));
          setPlaceLon(String(lon));
        }}
      />

      {/* Top-Left Floating Dock & Controls */}
      <div className="pointer-events-none absolute left-3 top-3 z-20 flex max-w-[calc(100vw-1.5rem)] flex-col gap-2.5 sm:left-4 sm:top-4 sm:w-[300px]">
        {/* Compact Icon Bar */}
        <div className="pointer-events-auto flex items-center justify-between rounded-full border border-white/75 bg-white/88 px-2.5 py-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.08)] backdrop-blur-xl">
          <div className="flex items-center gap-1.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-[#80f15a]">
              <MapPin className="h-4 w-4" />
            </span>
            <span className="pr-1 text-xs font-bold tracking-tight text-zinc-900">LovedOnes</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLeftOpen((v) => !v)}
              title="Toggle workspace controls"
              className={`rounded-full p-2 transition ${
                leftOpen ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-slate-100'
              }`}
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setLeftOpen(true);
                setTrackerOpen((v) => !v);
              }}
              title="HTTP Tracker Setup"
              className={`rounded-full p-2 transition ${
                trackerOpen ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-slate-100'
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
            </button>
            {session.user.role === 'HOST_ADMIN' && (
              <>
                <Link
                  href="/admin"
                  title="System Telemetry"
                  className="rounded-full p-2 text-zinc-600 transition hover:bg-slate-100 hover:text-zinc-900"
                >
                  <Activity className="h-3.5 w-3.5" />
                </Link>
                <Link
                  href="/admin/invites"
                  title="QR Invites"
                  className="rounded-full p-2 text-zinc-600 transition hover:bg-slate-100 hover:text-zinc-900"
                >
                  <QrCode className="h-3.5 w-3.5" />
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={() => setRightOpen((v) => !v)}
              title="Toggle inspector panel"
              className={`rounded-full p-2 transition md:hidden ${
                rightOpen ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-slate-100'
              }`}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {leftOpen && (
          <>
            {/* Group & Privacy Floating Card */}
            <div className="pointer-events-auto rounded-3xl border border-white/75 bg-white/88 p-3.5 shadow-[0_12px_36px_rgba(15,23,42,0.08)] backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  <Users className="h-3.5 w-3.5" />
                  Groups ({groups.length})
                </span>
                <button
                  type="button"
                  onClick={() => setShowNewGroupForm((v) => !v)}
                  className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-slate-200"
                >
                  <Plus className="h-3 w-3" />
                  New
                </button>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setActiveGroupId(g.id)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                      activeGroup?.id === g.id
                        ? 'bg-zinc-900 text-white shadow-sm'
                        : 'bg-slate-100 text-zinc-700 hover:bg-slate-200'
                    }`}
                  >
                    {g.name}
                  </button>
                ))}
                {groups.length === 0 && (
                  <p className="text-xs text-zinc-400">Create a group to start sharing.</p>
                )}
              </div>

              {showNewGroupForm && (
                <form onSubmit={handleCreateGroup} className="mt-2.5 flex gap-1.5">
                  <input
                    type="text"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="Group name..."
                    className="min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-zinc-900 focus:border-zinc-400 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={creatingGroup || !newGroupName.trim()}
                    className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Add
                  </button>
                </form>
              )}

              {activeGroup && (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="mb-1.5 flex items-center justify-between text-[11px] text-zinc-500">
                    <span className="font-medium">Sharing mode</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
                      {activeGroup.myRole}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 rounded-full bg-slate-100 p-1">
                    {(['EXACT', 'FUZZED', 'GHOST'] as PrivacyMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => void handlePrivacyChange(mode)}
                        className={`flex items-center justify-center gap-1 rounded-full py-1.5 text-[11px] font-semibold transition ${
                          activeGroup.myPrivacy === mode
                            ? 'bg-zinc-900 text-white shadow-sm'
                            : 'text-zinc-600 hover:text-zinc-900'
                        }`}
                      >
                        {mode === 'EXACT' && <LocateFixed className="h-3 w-3" />}
                        {mode === 'FUZZED' && <Compass className="h-3 w-3" />}
                        {mode === 'GHOST' && <EyeOff className="h-3 w-3" />}
                        {mode}
                      </button>
                    ))}
                  </div>
                  {myPrivacyOverrideUntil && Date.parse(myPrivacyOverrideUntil) > Date.now() && (
                    <div className="mt-2 rounded-2xl bg-[#80f15a]/25 px-2.5 py-1.5 text-[11px] font-medium text-zinc-900">
                      Exact check-in active until{' '}
                      {new Date(myPrivacyOverrideUntil).toLocaleTimeString()}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Live Beacon Card */}
            <div className="pointer-events-auto rounded-3xl border border-white/75 bg-white/88 p-3.5 shadow-[0_12px_36px_rgba(15,23,42,0.08)] backdrop-blur-xl">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setGeoSharing((s) => !s)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold transition ${
                    geoSharing
                      ? 'bg-rose-500 text-white shadow-sm hover:bg-rose-600'
                      : 'bg-[#80f15a] text-zinc-950 shadow-sm hover:bg-[#72e34d]'
                  }`}
                >
                  <Radio className="h-3.5 w-3.5" />
                  {geoSharing ? 'Stop Live GPS' : 'Share Live GPS'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSendTestPing()}
                  className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-slate-50"
                >
                  Test Ping
                </button>
              </div>
              {geoStatus && <p className="mt-2 truncate text-[11px] text-zinc-500">{geoStatus}</p>}

              {trackerOpen && (
                <div className="mt-3 space-y-2.5 border-t border-slate-100 pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-zinc-800">
                      HTTP Tracker Token
                    </span>
                    {trackerActive && (
                      <span className="rounded-full bg-[#80f15a]/35 px-2 py-0.5 text-[10px] font-semibold text-zinc-900">
                        {Math.max(1, Math.ceil(trackerTtlSeconds / 86400))}d left
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={trackerDays}
                      onChange={(e) => setTrackerDays(Number(e.target.value))}
                      className="rounded-full border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-zinc-800"
                    >
                      <option value={7}>7 days</option>
                      <option value={30}>30 days</option>
                      <option value={90}>90 days</option>
                      <option value={365}>1 year</option>
                    </select>
                    <button
                      type="button"
                      disabled={trackerLoading}
                      onClick={() => void handleGenerateTrackerToken()}
                      className="flex-1 rounded-full bg-zinc-900 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {trackerActive ? 'Rotate' : 'Generate'}
                    </button>
                    {trackerActive && (
                      <button
                        type="button"
                        disabled={trackerLoading}
                        onClick={() => void handleRevokeTrackerToken()}
                        title="Revoke token"
                        className="rounded-full border border-rose-200 bg-rose-50 p-1.5 text-rose-600 hover:bg-rose-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {trackerIssued && (
                    <div className="space-y-1.5 rounded-2xl bg-slate-50 p-2.5 text-[10px]">
                      {(
                        [
                          ['owntracks', 'OwnTracks URL', trackerIssued.owntracksUrl],
                          ['overland', 'Overland URL', trackerIssued.overlandUrl],
                          ['token', 'Token', trackerIssued.token],
                        ] as const
                      ).map(([key, label, val]) => (
                        <div key={key}>
                          <div className="font-medium text-zinc-500">{label}</div>
                          <div className="mt-0.5 flex items-center gap-1">
                            <input
                              readOnly
                              value={val}
                              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] text-zinc-800"
                            />
                            <button
                              type="button"
                              onClick={() => handleCopyText(key, val)}
                              className="shrink-0 rounded-lg border border-slate-200 bg-white p-1.5 text-zinc-700 hover:bg-slate-100"
                            >
                              {copiedField === key ? (
                                <Check className="h-3 w-3 text-emerald-600" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Top-Right Action Pills & Floating Tabbed Inspector */}
      <div className="pointer-events-none absolute bottom-16 left-3 right-3 z-20 flex flex-col items-end gap-2.5 md:bottom-auto md:left-auto md:right-4 md:top-4 md:w-[350px]">
        <div className="pointer-events-auto hidden items-center gap-2 md:flex">
          <button
            type="button"
            onClick={() => {
              setRightOpen(true);
              setInspectorTab('requests');
            }}
            className="flex items-center gap-1.5 rounded-full border border-white/75 bg-white/90 px-3.5 py-2 text-xs font-medium text-zinc-800 shadow-[0_8px_24px_rgba(15,23,42,0.08)] backdrop-blur-xl hover:bg-white"
          >
            <BellRing className="h-3.5 w-3.5" />
            Check-In
            {pendingIncomingCount > 0 && (
              <span className="rounded-full bg-[#80f15a] px-1.5 py-0.2 text-[10px] font-bold text-zinc-950">
                {pendingIncomingCount}
              </span>
            )}
          </button>
          {activeGroup?.myRole === 'ADMIN' && (
            <button
              type="button"
              onClick={() => {
                setRightOpen(true);
                setInspectorTab('places');
              }}
              className="flex items-center gap-1 rounded-full bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-white shadow-[0_8px_24px_rgba(15,23,42,0.12)] hover:bg-zinc-800"
            >
              <Plus className="h-3.5 w-3.5 text-[#80f15a]" />
              New Place
            </button>
          )}
          <button
            type="button"
            onClick={() => setRightOpen((v) => !v)}
            title="Toggle inspector"
            className="rounded-full border border-white/75 bg-white/90 p-2 text-zinc-700 shadow-[0_8px_24px_rgba(15,23,42,0.08)] backdrop-blur-xl hover:bg-white"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>

        {rightOpen && (
          <div className="pointer-events-auto flex max-h-[44vh] w-full flex-col overflow-hidden rounded-3xl border border-white/75 bg-white/90 shadow-[0_16px_44px_rgba(15,23,42,0.1)] backdrop-blur-xl md:max-h-[calc(100vh-140px)]">
            {/* Segmented Pill Tabs (matching screenshot reference) */}
            <div className="border-b border-slate-100 p-2">
              <div className="grid grid-cols-4 gap-1 rounded-full bg-slate-100 p-1 text-[11px] font-semibold">
                {(
                  [
                    ['people', `People (${locations.length})`],
                    ['chat', `Chat`],
                    ['places', `Places`],
                    ['requests', pendingIncomingCount > 0 ? `Ask (${pendingIncomingCount})` : 'Ask'],
                  ] as const
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setInspectorTab(tab)}
                    className={`rounded-full py-1.5 transition ${
                      inspectorTab === tab
                        ? 'bg-zinc-900 text-white shadow-sm'
                        : 'text-zinc-600 hover:text-zinc-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* People Tab */}
            {inspectorTab === 'people' && (
              <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
                {locations.map((loc) => (
                  <div
                    key={loc.userId}
                    className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2.5 transition hover:bg-white"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedUserId(loc.userId)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-bold text-white">
                        {loc.username.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-zinc-900">
                          {loc.username}
                        </div>
                        <div className="truncate font-mono text-[10px] text-zinc-400">
                          {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                        </div>
                      </div>
                    </button>
                    <span
                      className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        loc.isFuzzed
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-[#80f15a]/35 text-zinc-900'
                      }`}
                    >
                      {loc.privacyMode}
                    </span>
                  </div>
                ))}
                {locations.length === 0 && (
                  <div className="py-8 text-center text-xs text-zinc-400">
                    No active pins in this group yet.
                  </div>
                )}
              </div>
            )}

            {/* Chat Tab */}
            {inspectorTab === 'chat' && (
              <div className="flex min-h-[260px] flex-1 flex-col overflow-hidden">
                <div className="flex-1 space-y-2 overflow-y-auto p-3">
                  {messages.map((m) => {
                    const mine = m.senderId === session.user.id;
                    return (
                      <div
                        key={m.id}
                        className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                      >
                        <div className="mb-0.5 text-[10px] text-zinc-400">
                          {m.senderUsername} · {new Date(m.createdAt).toLocaleTimeString()}
                        </div>
                        <div
                          className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs ${
                            mine
                              ? 'bg-zinc-900 text-white'
                              : 'border border-slate-200/80 bg-slate-50 text-zinc-900'
                          }`}
                        >
                          {m.content}
                        </div>
                      </div>
                    );
                  })}
                  {messages.length === 0 && (
                    <div className="py-8 text-center text-xs text-zinc-400">
                      No messages yet.
                    </div>
                  )}
                </div>

                <form
                  onSubmit={handleSendChat}
                  className="flex gap-1.5 border-t border-slate-100 p-2.5"
                >
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={!activeGroup}
                    placeholder={activeGroup ? 'Message group...' : 'Select a group'}
                    className="min-w-0 flex-1 rounded-full border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!activeGroup || !chatInput.trim()}
                    className="flex shrink-0 items-center justify-center rounded-full bg-zinc-900 px-3.5 py-2 text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </button>
                </form>
              </div>
            )}

            {/* Places Tab */}
            {inspectorTab === 'places' && (
              <div className="flex-1 space-y-3 overflow-y-auto p-3">
                {activeGroup?.myRole === 'ADMIN' && (
                  <form
                    onSubmit={handleCreatePlace}
                    className="space-y-2 rounded-2xl border border-slate-100 bg-slate-50/80 p-2.5"
                  >
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={placeName}
                        onChange={(e) => setPlaceName(e.target.value)}
                        placeholder="Home, School, Office..."
                        className="min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-zinc-900 focus:outline-none"
                      />
                      <input
                        type="number"
                        min={25}
                        max={10000}
                        value={placeRadius}
                        onChange={(e) => setPlaceRadius(Number(e.target.value))}
                        title="Radius (m)"
                        className="w-16 rounded-full border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900"
                      />
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={placeLat}
                        onChange={(e) => setPlaceLat(e.target.value)}
                        placeholder="Lat (click map)"
                        className="min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] text-zinc-900"
                      />
                      <input
                        type="text"
                        value={placeLon}
                        onChange={(e) => setPlaceLon(e.target.value)}
                        placeholder="Lon (click map)"
                        className="min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] text-zinc-900"
                      />
                      <button
                        type="submit"
                        disabled={placeBusy}
                        className="shrink-0 rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                    {placeError && <p className="text-[11px] text-rose-600">{placeError}</p>}
                  </form>
                )}

                <div className="space-y-1.5">
                  {places.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2 text-xs hover:bg-white"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedPlaceId(p.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate font-semibold text-zinc-900">{p.name}</div>
                        <div className="font-mono text-[10px] text-zinc-400">
                          {p.latitude.toFixed(4)}, {p.longitude.toFixed(4)} ·{' '}
                          {Math.round(p.radiusMeters)}m
                        </div>
                      </button>
                      {activeGroup?.myRole === 'ADMIN' && (
                        <button
                          type="button"
                          onClick={() => void handleDeletePlace(p.id)}
                          title="Delete place"
                          className="ml-2 rounded-full p-1.5 text-zinc-400 hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  {places.length === 0 && (
                    <p className="py-4 text-center text-xs text-zinc-400">
                      No geofenced places yet.
                    </p>
                  )}
                </div>

                {placeTransitions.length > 0 && (
                  <div className="border-t border-slate-100 pt-2.5">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      Activity
                    </div>
                    <div className="space-y-1 text-[11px]">
                      {placeTransitions.map((evt, idx) => (
                        <div
                          key={evt.id ?? `${evt.placeId}-${evt.userId}-${evt.recordedAt}-${idx}`}
                          className="flex items-center justify-between text-zinc-600"
                        >
                          <span className="truncate">
                            <span className="font-semibold text-zinc-900">{evt.username}</span>{' '}
                            {evt.transition === 'enter' ? 'arrived at' : 'left'}{' '}
                            <span className="font-medium text-zinc-900">{evt.placeName}</span>
                          </span>
                          <span className="ml-2 shrink-0 text-[10px] text-zinc-400">
                            {new Date(evt.recordedAt).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Check-Ins Tab */}
            {inspectorTab === 'requests' && (
              <div className="flex-1 space-y-3 overflow-y-auto p-3">
                {activeGroup && activeGroup.members.some((m) => m.userId !== session.user.id) ? (
                  <form onSubmit={handleSendCheckInRequest} className="flex gap-1.5">
                    <select
                      value={checkinTargetUserId}
                      onChange={(e) => setCheckinTargetUserId(e.target.value)}
                      className="min-w-0 flex-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-zinc-900"
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
                      className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-zinc-900"
                    >
                      <option value={15}>15m</option>
                      <option value={30}>30m</option>
                      <option value={60}>60m</option>
                    </select>
                    <button
                      type="submit"
                      disabled={checkinBusy || !checkinTargetUserId}
                      className="shrink-0 rounded-full bg-zinc-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
                    >
                      Ask
                    </button>
                  </form>
                ) : (
                  <p className="text-xs text-zinc-400">
                    Invite another member to request check-ins.
                  </p>
                )}

                {checkinError && <p className="text-[11px] text-rose-600">{checkinError}</p>}

                <div className="space-y-1.5">
                  {locationRequests.map((req) => {
                    const isIncoming = req.targetUserId === session.user.id;
                    return (
                      <div
                        key={req.id}
                        className="rounded-2xl border border-slate-100 bg-slate-50/70 p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-zinc-900">
                            {isIncoming
                              ? `${req.requesterUsername} asked (${req.suggestedDurationMinutes}m)`
                              : `Asked ${req.targetUsername} (${req.suggestedDurationMinutes}m)`}
                          </span>
                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase text-zinc-500">
                            {req.status}
                          </span>
                        </div>
                        {isIncoming && req.status === 'pending' && (
                          <div className="mt-2 flex gap-1.5">
                            <button
                              type="button"
                              disabled={checkinBusy}
                              onClick={() => void handleRespondCheckIn(req.id, 'accept')}
                              className="flex flex-1 items-center justify-center gap-1 rounded-full bg-[#80f15a] py-1.5 text-[11px] font-semibold text-zinc-950 hover:bg-[#72e34d]"
                            >
                              <Check className="h-3 w-3" /> Accept
                            </button>
                            <button
                              type="button"
                              disabled={checkinBusy}
                              onClick={() => void handleRespondCheckIn(req.id, 'decline')}
                              className="flex flex-1 items-center justify-center gap-1 rounded-full border border-slate-200 bg-white py-1.5 text-[11px] font-medium text-zinc-700 hover:bg-slate-100"
                            >
                              <X className="h-3 w-3" /> Decline
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {locationRequests.length === 0 && (
                    <p className="py-4 text-center text-xs text-zinc-400">
                      No check-in requests yet.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom-Left Floating Profile Pill */}
      <div className="pointer-events-auto absolute bottom-3 left-3 z-20 hidden items-center gap-2.5 rounded-full border border-white/75 bg-white/90 py-1.5 pl-2 pr-3 shadow-[0_8px_28px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:bottom-4 sm:left-4 sm:flex">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-xs font-bold text-white">
          {session.user.username.slice(0, 1).toUpperCase()}
        </span>
        <div className="leading-tight">
          <div className="text-xs font-semibold text-zinc-900">{session.user.username}</div>
          <div className="text-[10px] text-zinc-500">
            {session.user.role === 'HOST_ADMIN' ? 'Host Admin' : 'Member'}
          </div>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          title="Sign out"
          className="ml-1 rounded-full p-1.5 text-zinc-500 transition hover:bg-slate-100 hover:text-zinc-900"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Bottom-Center Floating Map View Mode Switcher */}
      <div className="pointer-events-auto absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/75 bg-white/90 p-1 shadow-[0_8px_28px_rgba(15,23,42,0.1)] backdrop-blur-xl sm:bottom-4">
        <div className="flex items-center gap-1 text-xs font-semibold">
          {(
            [
              ['live', 'Live', MapPin],
              ['trails', 'Trails', Route],
              ['places', 'Places', Layers],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setMapViewMode(mode)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 transition ${
                mapViewMode === mode
                  ? 'bg-zinc-900 text-white shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
