'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Compass,
  Eye,
  EyeOff,
  LocateFixed,
  MessageSquare,
  Plus,
  Radio,
  Send,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { ChatMessage, LocationBroadcast, PrivacyMode } from '@loved-ones/shared';
import { MapCanvas } from '@/components/MapCanvas';
import { NavBar } from '@/components/NavBar';
import {
  apiCreateGroup,
  apiFetchGroupLocations,
  apiFetchGroupMessages,
  apiFetchGroups,
  apiLogin,
  apiRegister,
  apiSendLocationBatch,
  apiUpdatePrivacy,
  getServiceBaseUrls,
  GroupItem,
  loadSession,
  saveSession,
  StoredSession,
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
  }, [session, refreshGroups]);

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
      return;
    }

    socketRef.current?.emit('group:join', activeGroup.id);

    void apiFetchGroupLocations(session.accessToken, activeGroup.id)
      .then(setLocations)
      .catch(() => setLocations([]));
    void apiFetchGroupMessages(session.accessToken, activeGroup.id)
      .then(setMessages)
      .catch(() => setMessages([]));
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
        </aside>

        {/* Center: Live PMTiles Map */}
        <section className="min-h-[420px] lg:min-h-[640px]">
          <MapCanvas locations={locations} selectedUserId={selectedUserId} />
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
