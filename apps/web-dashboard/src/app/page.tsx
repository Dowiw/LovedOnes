'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import {
  Activity,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  Compass,
  Copy,
  EyeOff,
  Globe,
  KeyRound,
  Layers,
  LocateFixed,
  LogOut,
  MapPin,
  Menu,
  MessageSquare,
  PanelRight,
  Plus,
  QrCode,
  Radio,
  Route,
  Send,
  Settings,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  isSafeAvatarUrl,
  type ChatMessage,
  type GroupPlace,
  type LocationBroadcast,
  type LocationRequestItem,
  type PlaceTransitionEvent,
  type PrivacyMode,
} from '@loved-ones/shared';
import { AccountSettingsModal } from '@/components/AccountSettingsModal';
import { MapCanvas, type MapLabelLanguage } from '@/components/MapCanvas';
import { QrJoinModal } from '@/components/QrJoinModal';
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
  apiGetMe,
  apiGetTrackerTokenStatus,
  apiJoinInvite,
  apiLogin,
  apiRegister,
  apiRequestPasswordReset,
  apiResetPasswordWithCode,
  apiRespondLocationRequest,
  apiRevokeTrackerToken,
  apiSendLocationBatch,
  apiUpdatePrivacy,
  getServiceBaseUrls,
  GroupItem,
  InvitePreview,
  loadSession,
  saveSession,
  SESSION_UPDATED_EVENT,
  StoredSession,
  TrackerTokenResponse,
} from '@/lib/api';

type InspectorTab = 'people' | 'chat' | 'places' | 'requests';
type MapViewMode = 'live' | 'trails' | 'places';

function playChatChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    gain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    osc1.connect(gain);
    osc1.start(now);
    osc1.stop(now + 0.11);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.09);
    osc2.connect(gain);
    osc2.start(now + 0.09);
    osc2.stop(now + 0.24);

    window.setTimeout(() => {
      void ctx.close().catch(() => { });
    }, 350);
  } catch {
    // Ignore blocked autoplay or unsupported Web Audio environments
  }
}

export default function HomePage() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  const [forgotMode, setForgotMode] = useState(false);
  const [forgotStep, setForgotStep] = useState<'request' | 'reset'>('request');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');

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
  const [selfLocation, setSelfLocation] = useState<{
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recordedAt: string;
  } | null>(null);
  const [focusCoords, setFocusCoords] = useState<{
    latitude: number;
    longitude: number;
    zoom?: number;
    nonce: number;
  } | null>(null);
  const geoAutoZoomedRef = useRef(false);
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

  const [groupPopoverOpen, setGroupPopoverOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('people');
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [chatToast, setChatToast] = useState<ChatMessage | null>(null);
  const [chatAlertsEnabled, setChatAlertsEnabled] = useState(true);
  const [browserNotifyPermission, setBrowserNotifyPermission] = useState<
    NotificationPermission | 'unsupported'
  >('unsupported');
  const [labelLanguage, setLabelLanguage] = useState<MapLabelLanguage>('en');
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);

  const leftDockRef = useRef<HTMLDivElement | null>(null);
  const rightOpenRef = useRef(rightOpen);
  rightOpenRef.current = rightOpen;
  const inspectorTabRef = useRef(inspectorTab);
  inspectorTabRef.current = inspectorTab;
  const chatAlertsEnabledRef = useRef(chatAlertsEnabled);
  chatAlertsEnabledRef.current = chatAlertsEnabled;
  const chatToastTimerRef = useRef<number | null>(null);
  const notifiedMessageIdsRef = useRef<Set<string>>(new Set());
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  const [preAuthInvite, setPreAuthInvite] = useState<InvitePreview | null>(null);
  const [preAuthQrOpen, setPreAuthQrOpen] = useState(false);
  const [joinQrOpen, setJoinQrOpen] = useState(false);
  const [joinQrOnboardingPrompt, setJoinQrOnboardingPrompt] = useState(false);
  const [invitePromptDismissed, setInvitePromptDismissed] = useState(false);
  const [groupsLoaded, setGroupsLoaded] = useState(false);

  useEffect(() => {
    setSession(loadSession());
    try {
      const savedLang = window.localStorage.getItem('lovedones_map_lang_v1');
      if (savedLang === 'en' || savedLang === 'local') {
        setLabelLanguage(savedLang);
      }
      const savedAlerts = window.localStorage.getItem('lovedones_chat_alerts_v1');
      if (savedAlerts === 'off') {
        setChatAlertsEnabled(false);
      }
    } catch {
      // ignore storage failures
    }

    if (typeof window !== 'undefined' && 'Notification' in window) {
      setBrowserNotifyPermission(Notification.permission);
    }

    const onSessionSync = (event: Event) => {
      const custom = event as CustomEvent<StoredSession | null>;
      setSession((prev) => {
        if (!custom.detail && prev) {
          setAccountSettingsOpen(false);
          setAuthError('Session expired — please sign in again.');
        }
        return custom.detail ?? null;
      });
    };
    window.addEventListener(SESSION_UPDATED_EVENT, onSessionSync);
    return () => {
      window.removeEventListener(SESSION_UPDATED_EVENT, onSessionSync);
      if (chatToastTimerRef.current !== null) {
        window.clearTimeout(chatToastTimerRef.current);
      }
    };
  }, []);

  function handleChangeLabelLanguage(lang: MapLabelLanguage) {
    setLabelLanguage(lang);
    try {
      window.localStorage.setItem('lovedones_map_lang_v1', lang);
    } catch {
      // ignore storage failures
    }
  }

  function handleToggleChatAlerts() {
    setChatAlertsEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('lovedones_chat_alerts_v1', next ? 'on' : 'off');
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }

  async function handleEnableBrowserNotifications() {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    try {
      const result = await Notification.requestPermission();
      setBrowserNotifyPermission(result);
    } catch {
      // ignore unsupported environments
    }
  }

  useEffect(() => {
    if (!groupPopoverOpen && !menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGroupPopoverOpen(false);
        setMenuOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (leftDockRef.current && !leftDockRef.current.contains(event.target as Node)) {
        setGroupPopoverOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [groupPopoverOpen, menuOpen]);

  function openChatTab() {
    setGroupPopoverOpen(false);
    setMenuOpen(false);
    setRightOpen(true);
    setInspectorTab('chat');
    setUnreadChatCount(0);
    setChatToast(null);
  }

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  );
  const activeGroupNameRef = useRef<string>('');
  activeGroupNameRef.current = activeGroup?.name ?? 'Group Chat';

  useEffect(() => {
    const clearIfViewingChat = () => {
      if (
        typeof document !== 'undefined' &&
        !document.hidden &&
        rightOpenRef.current &&
        inspectorTabRef.current === 'chat'
      ) {
        setUnreadChatCount(0);
        setChatToast(null);
      }
    };

    clearIfViewingChat();
    window.addEventListener('focus', clearIfViewingChat);
    document.addEventListener('visibilitychange', clearIfViewingChat);
    return () => {
      window.removeEventListener('focus', clearIfViewingChat);
      document.removeEventListener('visibilitychange', clearIfViewingChat);
    };
  }, [rightOpen, inspectorTab, activeGroup?.id]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title =
      unreadChatCount > 0
        ? `(${unreadChatCount}) LovedOnes — Private Group Map`
        : 'LovedOnes — Private Group Map';
    return () => {
      document.title = 'LovedOnes — Private Group Map';
    };
  }, [unreadChatCount]);

  useEffect(() => {
    if (rightOpen && inspectorTab === 'chat') {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, rightOpen, inspectorTab]);

  const isPickingPlace =
    rightOpen && inspectorTab === 'places' && activeGroup?.myRole === 'ADMIN';

  const draftPlace = useMemo(() => {
    if (!isPickingPlace || !placeLat.trim() || !placeLon.trim()) return null;
    const lat = Number(placeLat);
    const lon = Number(placeLon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return null;
    }
    return { latitude: lat, longitude: lon, name: placeName };
  }, [isPickingPlace, placeLat, placeLon, placeName]);

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
    setGroupsLoaded(true);
    setActiveGroupId((prev) => (prev && list.some((g) => g.id === prev) ? prev : list[0]?.id ?? ''));
    return list;
  }, []);

  useEffect(() => {
    if (!session) {
      setGroupsLoaded(false);
      return;
    }
    const token = session.accessToken;
    void refreshGroups(token).catch(() => { });
    void apiGetMe(token)
      .then((res) => {
        setSession((prev) => {
          if (!prev || prev.accessToken !== token) return prev;
          const next: StoredSession = { ...prev, user: res.user };
          saveSession(next);
          return next;
        });
      })
      .catch(() => { });
    void apiGetTrackerTokenStatus(token)
      .then((st) => {
        setTrackerActive(st.active);
        setTrackerTtlSeconds(st.ttlSeconds);
      })
      .catch(() => { });
  }, [session?.accessToken, refreshGroups]);

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

    socket.on('connect', () => {
      if (activeGroup) {
        socket.emit('group:join', activeGroup.id);
      }
    });

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
      const isMatchingGroup = !activeGroup || msg.groupId === activeGroup.id;
      setMessages((prev) => {
        if (!isMatchingGroup) return prev;
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });

      if (!isMatchingGroup) return;
      if (msg.senderId === session.user.id) return;
      if (notifiedMessageIdsRef.current.has(msg.id)) return;
      notifiedMessageIdsRef.current.add(msg.id);

      const viewingChatRightNow =
        typeof document !== 'undefined' &&
        !document.hidden &&
        rightOpenRef.current &&
        inspectorTabRef.current === 'chat';

      if (viewingChatRightNow) return;

      setUnreadChatCount((c) => c + 1);
      setChatToast(msg);
      if (chatToastTimerRef.current !== null) {
        window.clearTimeout(chatToastTimerRef.current);
      }
      chatToastTimerRef.current = window.setTimeout(() => {
        setChatToast((prev) => (prev?.id === msg.id ? null : prev));
      }, 6000);

      if (chatAlertsEnabledRef.current) {
        playChatChime();
        if (
          typeof window !== 'undefined' &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          try {
            const note = new Notification(
              `${msg.senderUsername} · ${activeGroupNameRef.current || 'Group Chat'}`,
              {
                body: msg.content,
                tag: `lovedones-chat-${msg.groupId}`,
              },
            );
            note.onclick = () => {
              window.focus();
              openChatTab();
              note.close();
            };
          } catch {
            // Ignore browser Notification failures
          }
        }
      }
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

    socket.on(
      'member:profile:updated',
      (evt: { userId: string; username: string; avatarUrl: string | null }) => {
        setLocations((prev) =>
          prev.map((loc) =>
            loc.userId === evt.userId
              ? { ...loc, username: evt.username, avatarUrl: evt.avatarUrl }
              : loc,
          ),
        );
        setGroups((prev) =>
          prev.map((grp) => ({
            ...grp,
            members: grp.members.map((m) =>
              m.userId === evt.userId
                ? { ...m, username: evt.username, avatarUrl: evt.avatarUrl }
                : m,
            ),
          })),
        );
        setMessages((prev) =>
          prev.map((m) =>
            m.senderId === evt.userId
              ? { ...m, senderUsername: evt.username, senderAvatarUrl: evt.avatarUrl }
              : m,
          ),
        );
        setSession((prev) => {
          if (!prev || prev.user.id !== evt.userId) return prev;
          const next: StoredSession = {
            ...prev,
            user: { ...prev.user, username: evt.username, avatarUrl: evt.avatarUrl },
          };
          saveSession(next);
          return next;
        });
      },
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session?.accessToken, activeGroup]);

  // Fetch snapshots when active group changes
  useEffect(() => {
    setUnreadChatCount(0);
    setChatToast(null);
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
      geoAutoZoomedRef.current = false;
      setSelfLocation(null);
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoStatus('Browser geolocation unavailable');
      setGeoSharing(false);
      return;
    }

    let cancelled = false;
    geoAutoZoomedRef.current = false;
    setGeoStatus('Locating browser GPS...');

    const handleGeoPosition = (pos: GeolocationPosition) => {
      if (cancelled) return;
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

      setSelfLocation({
        latitude: point.latitude,
        longitude: point.longitude,
        accuracy: point.accuracy,
        recordedAt: point.recordedAt,
      });

      if (!geoAutoZoomedRef.current) {
        geoAutoZoomedRef.current = true;
        setSelectedUserId(null);
        setSelectedPlaceId(null);
        setMapViewMode((prev) => (prev === 'places' ? 'live' : prev));
        setFocusCoords({
          latitude: point.latitude,
          longitude: point.longitude,
          zoom: 15,
          nonce: Date.now(),
        });
      }

      const accText =
        point.accuracy !== null ? ` (±${Math.round(point.accuracy)}m)` : '';

      if (socketRef.current?.connected) {
        socketRef.current.emit(
          'location:batch',
          { points: [point] },
          (ack?: { ok: boolean; inserted?: number; error?: string }) => {
            if (cancelled) return;
            if (ack && !ack.ok) {
              setGeoStatus(ack.error ?? 'Failed to upload GPS fix');
            } else if (ack && ack.inserted === 0 && point.accuracy !== null && point.accuracy > 1000) {
              setGeoStatus(
                `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}${accText} · Local only (>1km coarse fix)`,
              );
            }
          },
        );
      } else {
        void apiSendLocationBatch(session.accessToken, [point]).catch(() => { });
      }

      setGeoStatus(
        `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}${accText} · ${new Date().toLocaleTimeString()}`,
      );
    };

    const handleGeoError = (err: GeolocationPositionError) => {
      if (cancelled) return;
      setGeoStatus(`Geolocation error: ${err.message}`);
    };

    navigator.geolocation.getCurrentPosition(handleGeoPosition, () => { }, {
      enableHighAccuracy: true,
      maximumAge: 10000,
      timeout: 10000,
    });

    const id = navigator.geolocation.watchPosition(handleGeoPosition, handleGeoError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    });
    watchIdRef.current = id;

    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(id);
      watchIdRef.current = null;
    };
  }, [geoSharing, session]);

  useEffect(() => {
    if (
      session &&
      groupsLoaded &&
      groups.length === 0 &&
      session.user.role !== 'HOST_ADMIN' &&
      !invitePromptDismissed &&
      !joinQrOpen
    ) {
      setJoinQrOnboardingPrompt(true);
      setJoinQrOpen(true);
    }
  }, [session, groupsLoaded, groups.length, invitePromptDismissed, joinQrOpen]);

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const boundToken = preAuthInvite?.token;
      const nextSession =
        authMode === 'login'
          ? await apiLogin(email, password)
          : await apiRegister({
              email,
              username,
              password,
              ...(boundToken ? { inviteToken: boundToken } : {}),
            });

      if (authMode === 'login' && boundToken) {
        await apiJoinInvite(nextSession.accessToken, boundToken).catch(() => {});
      }

      setPreAuthInvite(null);
      setInvitePromptDismissed(Boolean(boundToken));
      setGroupsLoaded(false);
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
    setGroupsLoaded(false);
    setJoinQrOpen(false);
    setJoinQrOnboardingPrompt(false);
    setInvitePromptDismissed(false);
    setLocations([]);
    setTrails([]);
    setMessages([]);
    setUnreadChatCount(0);
    setChatToast(null);
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
      setPlaceLat('');
      setPlaceLon('');
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

  async function handleForgotPasswordRequest(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthNotice(null);
    setAuthLoading(true);
    try {
      const res = await apiRequestPasswordReset(forgotEmail.trim());
      setForgotStep('reset');
      setAuthNotice(res.message);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Failed to request reset code');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleForgotPasswordReset(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthNotice(null);
    if (forgotNewPassword.length < 8) {
      setAuthError('New password must be at least 8 characters');
      return;
    }
    if (forgotNewPassword !== forgotConfirmPassword) {
      setAuthError('New passwords do not match');
      return;
    }
    setAuthLoading(true);
    try {
      await apiResetPasswordWithCode({
        email: forgotEmail.trim(),
        code: forgotCode.trim(),
        newPassword: forgotNewPassword,
      });
      setEmail(forgotEmail.trim());
      setPassword('');
      setForgotCode('');
      setForgotNewPassword('');
      setForgotConfirmPassword('');
      setForgotMode(false);
      setForgotStep('request');
      setAuthMode('login');
      setAuthNotice('Password reset! Sign in with your new password.');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setAuthLoading(false);
    }
  }

  if (!session) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f4f4f5] px-4">
        <div className="lo-orb-drift pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-zinc-300/40 blur-3xl" />
        <div className="lo-orb-drift pointer-events-none absolute -bottom-24 -right-24 h-96 w-96 rounded-full bg-zinc-200/60 blur-3xl" />

        <div className="lo-float-in relative w-full max-w-md rounded-xl border border-white/80 bg-white/88 p-8 shadow-[0_24px_60px_rgba(15,23,42,0.09)] backdrop-blur-xl">
          <div className="mb-6 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-950 text-white">
              <MapPin className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-zinc-900">LovedOnes</h1>
              <p className="text-xs text-zinc-500">Private group map &amp; check-ins</p>
            </div>
          </div>

          {forgotMode ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-bold text-zinc-900">Recover forgotten password</h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Enter your account email or verified backup email to receive a 6-digit reset code.
                </p>
              </div>

              {forgotStep === 'request' ? (
                <form onSubmit={handleForgotPasswordRequest} className="space-y-3.5">
                  <label className="block text-xs font-medium text-zinc-600">
                    Account or Verified Backup Email
                    <input
                      type="email"
                      required
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                      placeholder="you@example.com"
                    />
                  </label>

                  {authError && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
                      {authError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={authLoading}
                    className="lo-press w-full rounded-lg bg-zinc-900 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {authLoading ? 'Sending code...' : 'Send Reset Code'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleForgotPasswordReset} className="space-y-3">
                  <label className="block text-xs font-medium text-zinc-600">
                    6-Digit Reset Code
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      required
                      value={forgotCode}
                      onChange={(e) => setForgotCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 font-mono text-sm tracking-widest text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                      placeholder="123456"
                    />
                  </label>

                  <label className="block text-xs font-medium text-zinc-600">
                    New Password
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={forgotNewPassword}
                      onChange={(e) => setForgotNewPassword(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                      placeholder="Minimum 8 characters"
                    />
                  </label>

                  <label className="block text-xs font-medium text-zinc-600">
                    Confirm New Password
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={forgotConfirmPassword}
                      onChange={(e) => setForgotConfirmPassword(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                      placeholder="Repeat new password"
                    />
                  </label>

                  {authNotice && (
                    <div className="rounded-lg border border-zinc-200 bg-zinc-100 px-3.5 py-2.5 text-xs text-zinc-800">
                      {authNotice}
                    </div>
                  )}

                  {authError && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
                      {authError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={authLoading}
                    className="lo-press w-full rounded-lg bg-zinc-900 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {authLoading ? 'Resetting password...' : 'Reset Password'}
                  </button>
                </form>
              )}

              <div className="flex items-center justify-between pt-1 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setForgotMode(false);
                    setForgotStep('request');
                    setAuthError(null);
                    setAuthNotice(null);
                  }}
                  className="font-medium text-zinc-600 hover:text-zinc-950 hover:underline"
                >
                  Back to sign in
                </button>
                {forgotStep === 'reset' && (
                  <button
                    type="button"
                    onClick={() => {
                      setForgotStep('request');
                      setAuthError(null);
                    }}
                    className="font-medium text-zinc-600 hover:text-zinc-950 hover:underline"
                  >
                    Use another email / resend
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="mb-5 flex rounded-lg bg-slate-100 p-1 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError(null);
                    setAuthNotice(null);
                  }}
                  className={`flex-1 rounded-md py-2 transition ${authMode === 'login' ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-600'
                    }`}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('register');
                    setAuthError(null);
                    setAuthNotice(null);
                  }}
                  className={`flex-1 rounded-md py-2 transition ${authMode === 'register' ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-600'
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
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
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
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
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
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                    placeholder="••••••••"
                  />
                </label>

                {authNotice && (
                  <div className="rounded-lg border border-zinc-200 bg-zinc-100 px-3.5 py-2.5 text-xs font-medium text-zinc-900">
                    {authNotice}
                  </div>
                )}

                {authError && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700">
                    {authError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authLoading}
                  className="lo-press w-full rounded-lg bg-zinc-900 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  {authLoading
                    ? 'Please wait...'
                    : authMode === 'login'
                      ? 'Continue'
                      : 'Create account'}
                </button>

                {authMode === 'login' && (
                  <div className="text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setForgotEmail(email.trim());
                        setForgotMode(true);
                        setForgotStep('request');
                        setAuthError(null);
                        setAuthNotice(null);
                      }}
                      className="text-xs font-medium text-zinc-600 hover:text-zinc-950 hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                )}
              </form>
            </>
          )}

          <div className="mt-4 border-t border-zinc-100 pt-4">
            {preAuthInvite ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 text-xs">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-zinc-900">
                    Joining: {preAuthInvite.groupName}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    Role {preAuthInvite.assignedRole} on {authMode === 'register' ? 'registration' : 'sign in'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPreAuthInvite(null)}
                  className="rounded-full p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-950"
                  title="Remove invite"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPreAuthQrOpen(true)}
                className="lo-press flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white py-2.5 text-xs font-semibold text-zinc-800 transition hover:bg-zinc-50 hover:text-zinc-950"
              >
                <QrCode className="h-3.5 w-3.5" />
                Have an invite QR or link? Scan or paste
              </button>
            )}
          </div>

          <p className="mt-3 text-center text-[11px] text-zinc-400">
            First registered account automatically becomes Host Admin.
          </p>
        </div>

        <QrJoinModal
          open={preAuthQrOpen}
          mode="pre-auth"
          onClose={() => setPreAuthQrOpen(false)}
          onBindPreAuthInvite={(preview) => setPreAuthInvite(preview)}
        />
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
        currentUserId={session.user.id}
        currentUserAvatarUrl={session.user.avatarUrl ?? null}
        selfLocation={selfLocation}
        focusCoords={focusCoords}
        draftPlace={draftPlace}
        pickingPlace={isPickingPlace}
        labelLanguage={labelLanguage}
        onMapSelectCoords={(lat, lon) => {
          if (!isPickingPlace) return;
          setPlaceLat(String(lat));
          setPlaceLon(String(lon));
        }}
      />

      {/* Incoming Chat Toast Notification */}
      {chatToast && (
        <div className="pointer-events-none fixed left-1/2 top-3 z-30 w-[calc(100vw-1.5rem)] max-w-sm -translate-x-1/2 sm:top-4">
          <div className="lo-float-in pointer-events-auto flex items-start gap-2.5 rounded-xl border border-zinc-200/90 bg-white/95 p-3 shadow-[0_14px_38px_rgba(15,23,42,0.16)] backdrop-blur-xl">
            <button
              type="button"
              onClick={openChatTab}
              className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-950 text-xs font-bold text-white">
                {isSafeAvatarUrl(chatToast.senderAvatarUrl) ? (
                  <img
                    src={chatToast.senderAvatarUrl}
                    alt={chatToast.senderUsername}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  chatToast.senderUsername.slice(0, 1).toUpperCase()
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-900">
                  <MessageSquare className="h-3 w-3 shrink-0" />
                  <span className="truncate">{chatToast.senderUsername}</span>
                  <span className="text-[10px] font-normal text-zinc-400">
                    · {activeGroup?.name ?? 'Chat'}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-zinc-600">{chatToast.content}</p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setChatToast(null)}
              aria-label="Dismiss chat notification"
              className="shrink-0 rounded-md p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Top-Left Calm Capsule & Progressive Disclosure Popovers */}
      <div
        ref={leftDockRef}
        className="pointer-events-none absolute left-3 top-3 z-20 flex max-w-[calc(100vw-1.5rem)] flex-col gap-2.5 sm:left-4 sm:top-4 sm:w-[316px]"
      >
        <div className="lo-float-in pointer-events-auto flex items-center justify-between gap-1.5 rounded-xl border border-zinc-200/80 bg-white/92 p-1.5 shadow-[0_8px_28px_rgba(9,9,11,0.08)] backdrop-blur-xl">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setGroupPopoverOpen((v) => {
                const next = !v;
                if (next && typeof window !== 'undefined' && window.innerWidth < 768) {
                  setRightOpen(false);
                }
                return next;
              });
            }}
            aria-expanded={groupPopoverOpen}
            title="Switch active group or privacy mode"
            className={`lo-press flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition ${
              groupPopoverOpen ? 'bg-zinc-100 text-zinc-950' : 'hover:bg-zinc-100/80'
            }`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-white">
              <MapPin className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-xs font-bold tracking-tight text-zinc-950">
                {activeGroup?.name ?? 'LovedOnes'}
              </div>
              <div className="truncate text-[10px] font-medium text-zinc-500">
                {activeGroup ? activeGroup.myPrivacy : 'Select or join group'}
              </div>
            </div>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-200 ${
                groupPopoverOpen ? 'rotate-180 text-zinc-950' : ''
              }`}
            />
          </button>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setGroupPopoverOpen(false);
                setMenuOpen((v) => {
                  const next = !v;
                  if (next && typeof window !== 'undefined' && window.innerWidth < 768) {
                    setRightOpen(false);
                  }
                  return next;
                });
              }}
              aria-expanded={menuOpen}
              title="Workspace menu (GPS, labels, tracker, account)"
              className={`lo-press relative rounded-lg p-2 transition ${
                menuOpen
                  ? 'bg-zinc-950 text-white'
                  : 'text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950'
              }`}
            >
              <Menu className="h-4 w-4" />
              {geoSharing && !menuOpen && (
                <span
                  title="Live GPS active"
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-zinc-950 ring-2 ring-white"
                />
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setGroupPopoverOpen(false);
                setMenuOpen(false);
                setRightOpen((v) => !v);
              }}
              title="Toggle inspector panel"
              className={`lo-press relative rounded-lg p-2 transition md:hidden ${
                rightOpen
                  ? 'bg-zinc-950 text-white'
                  : 'text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950'
              }`}
            >
              <PanelRight className="h-4 w-4" />
              {!rightOpen && unreadChatCount + pendingIncomingCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-zinc-950 px-1 text-[9px] font-bold text-white ring-2 ring-white">
                  {unreadChatCount + pendingIncomingCount > 9
                    ? '9+'
                    : unreadChatCount + pendingIncomingCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {groupPopoverOpen && (
          <div className="lo-float-in pointer-events-auto rounded-xl border border-zinc-200/80 bg-white/95 p-3.5 shadow-[0_14px_40px_rgba(9,9,11,0.12)] backdrop-blur-xl">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <Users className="h-3.5 w-3.5" />
                Groups ({groups.length})
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setGroupPopoverOpen(false);
                    setJoinQrOnboardingPrompt(false);
                    setJoinQrOpen(true);
                  }}
                  className="lo-press flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-800 hover:bg-zinc-100"
                >
                  <QrCode className="h-3 w-3" />
                  Join QR
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewGroupForm((v) => !v)}
                  className="lo-press flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-200 hover:text-zinc-950"
                >
                  <Plus className="h-3 w-3" />
                  New
                </button>
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setActiveGroupId(g.id)}
                  className={`lo-press rounded-lg px-3 py-1 text-xs font-medium transition ${
                    activeGroup?.id === g.id
                      ? 'bg-zinc-950 text-white shadow-sm'
                      : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 hover:text-zinc-950'
                  }`}
                >
                  {g.name}
                </button>
              ))}
              {groups.length === 0 && (
                <div className="w-full space-y-2 pt-0.5">
                  <p className="text-xs text-zinc-500">
                    Not in a group yet. Scan an invite QR code or create one.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setGroupPopoverOpen(false);
                      setJoinQrOnboardingPrompt(false);
                      setJoinQrOpen(true);
                    }}
                    className="lo-press flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-950 py-2 text-xs font-semibold text-white transition hover:bg-zinc-800"
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    Scan or Paste QR Invite
                  </button>
                </div>
              )}
            </div>

            {showNewGroupForm && (
              <form onSubmit={handleCreateGroup} className="mt-2.5 flex gap-1.5">
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="Group name..."
                  className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={creatingGroup || !newGroupName.trim()}
                  className="lo-press rounded-lg bg-zinc-950 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Add
                </button>
              </form>
            )}

            {activeGroup && (
              <div className="mt-3 border-t border-zinc-100 pt-3">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="font-medium">Sharing mode</span>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600">
                    {activeGroup.myRole}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-zinc-100 p-1">
                  {(['EXACT', 'FUZZED', 'GHOST'] as PrivacyMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => void handlePrivacyChange(mode)}
                      className={`lo-press flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] font-semibold transition ${
                        activeGroup.myPrivacy === mode
                          ? 'bg-zinc-950 text-white shadow-sm'
                          : 'text-zinc-600 hover:text-zinc-950'
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
                  <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-100 px-2.5 py-1.5 text-[11px] font-medium text-zinc-900">
                    Exact check-in active until{' '}
                    {new Date(myPrivacyOverrideUntil).toLocaleTimeString()}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {menuOpen && (
          <div className="lo-float-in pointer-events-auto max-h-[calc(100vh-5.5rem)] space-y-3 overflow-y-auto rounded-xl border border-zinc-200/80 bg-white/95 p-3.5 shadow-[0_14px_40px_rgba(9,9,11,0.12)] backdrop-blur-xl">
            {/* Live GPS Beacon */}
            <div>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Location Beacon
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setGeoSharing((s) => !s)}
                  className={`lo-press flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                    geoSharing
                      ? 'border border-zinc-950 bg-white text-zinc-950 shadow-sm hover:bg-zinc-100'
                      : 'bg-zinc-950 text-white shadow-sm hover:bg-zinc-800'
                  }`}
                >
                  <Radio className="h-3.5 w-3.5" />
                  {geoSharing ? 'Stop Live GPS' : 'Share Live GPS'}
                </button>
                {selfLocation && (
                  <button
                    type="button"
                    title="Zoom to my live location"
                    onClick={() => {
                      setSelectedUserId(null);
                      setSelectedPlaceId(null);
                      setMapViewMode((prev) => (prev === 'places' ? 'live' : prev));
                      setFocusCoords({
                        latitude: selfLocation.latitude,
                        longitude: selfLocation.longitude,
                        zoom: 15,
                        nonce: Date.now(),
                      });
                    }}
                    className="lo-press rounded-lg border border-zinc-200 bg-white p-2 text-zinc-800 hover:bg-zinc-50"
                  >
                    <LocateFixed className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleSendTestPing()}
                  className="lo-press rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 hover:text-zinc-950"
                >
                  Test Ping
                </button>
              </div>
              {geoStatus && (
                <p className="mt-2 truncate font-mono text-[11px] text-zinc-500">{geoStatus}</p>
              )}
            </div>

            {/* Map Label Language */}
            <div className="flex items-center justify-between border-t border-zinc-100 pt-3">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-800">
                <Globe className="h-3.5 w-3.5 text-zinc-500" />
                Map Labels
              </div>
              <div className="flex items-center gap-1 rounded-lg bg-zinc-100 p-0.5">
                {(
                  [
                    ['en', 'EN'],
                    ['local', 'Local'],
                  ] as const
                ).map(([lang, label]) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => handleChangeLabelLanguage(lang)}
                    className={`lo-press rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                      labelLanguage === lang
                        ? 'bg-zinc-950 text-white shadow-sm'
                        : 'text-zinc-600 hover:text-zinc-950'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* HTTP Tracker Token */}
            <div className="border-t border-zinc-100 pt-2.5">
              <button
                type="button"
                onClick={() => setTrackerOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-lg px-1.5 py-1.5 text-left transition hover:bg-zinc-100"
              >
                <span className="flex items-center gap-2 text-xs font-medium text-zinc-800">
                  <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
                  HTTP Tracker Token
                </span>
                <span className="flex items-center gap-1.5">
                  {trackerActive && (
                    <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-900">
                      {Math.max(1, Math.ceil(trackerTtlSeconds / 86400))}d left
                    </span>
                  )}
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${
                      trackerOpen ? 'rotate-180 text-zinc-800' : ''
                    }`}
                  />
                </span>
              </button>

              {trackerOpen && (
                <div className="mt-2 space-y-2.5 px-1">
                  <div className="flex items-center gap-1.5">
                    <select
                      value={trackerDays}
                      onChange={(e) => setTrackerDays(Number(e.target.value))}
                      className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[11px] text-zinc-800 focus:border-zinc-400 focus:bg-white focus:outline-none"
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
                      className="lo-press flex-1 rounded-lg bg-zinc-950 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {trackerActive ? 'Rotate' : 'Generate'}
                    </button>
                    {trackerActive && (
                      <button
                        type="button"
                        disabled={trackerLoading}
                        onClick={() => void handleRevokeTrackerToken()}
                        title="Revoke token"
                        className="rounded-lg border border-rose-200 bg-rose-50 p-1.5 text-rose-600 hover:bg-rose-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {trackerIssued && (
                    <div className="space-y-1.5 rounded-lg border border-zinc-200/70 bg-zinc-50 p-2.5 text-[10px]">
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
                              className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 font-mono text-[10px] text-zinc-800"
                            />
                            <button
                              type="button"
                              onClick={() => handleCopyText(key, val)}
                              className="shrink-0 rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-700 hover:bg-zinc-100"
                            >
                              {copiedField === key ? (
                                <Check className="h-3 w-3 text-zinc-950" />
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

            {/* Account, Host Admin & Sign Out */}
            <div className="space-y-1 border-t border-zinc-100 pt-2.5">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setAccountSettingsOpen(true);
                }}
                className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition hover:bg-zinc-100"
              >
                <span className="flex items-center gap-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-950 text-[10px] font-bold text-white">
                    {isSafeAvatarUrl(session.user.avatarUrl) ? (
                      <img
                        src={session.user.avatarUrl}
                        alt={session.user.username}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      session.user.username.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="text-xs font-medium text-zinc-800">
                    Account Settings
                    <span className="ml-1.5 text-[10px] text-zinc-400">
                      @{session.user.username}
                    </span>
                  </span>
                </span>
                <Settings className="h-3.5 w-3.5 text-zinc-400" />
              </button>

              {session.user.role === 'HOST_ADMIN' && (
                <>
                  <Link
                    href="/admin"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-950"
                  >
                    <span className="flex items-center gap-2">
                      <Activity className="h-3.5 w-3.5 text-zinc-500" />
                      System Telemetry
                    </span>
                  </Link>
                  <Link
                    href="/admin/invites"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-950"
                  >
                    <span className="flex items-center gap-2">
                      <QrCode className="h-3.5 w-3.5 text-zinc-500" />
                      QR Invites
                    </span>
                  </Link>
                </>
              )}

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  handleSignOut();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-950"
              >
                <LogOut className="h-3.5 w-3.5 text-zinc-500" />
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Top-Right Single Inspector Toggle & Floating Tabbed Inspector */}
      <div className="pointer-events-none absolute bottom-16 left-3 right-3 z-20 flex flex-col items-end gap-2.5 md:bottom-auto md:left-auto md:right-4 md:top-4 md:w-[350px]">
        <div className="lo-float-in pointer-events-auto hidden items-center md:flex">
          <button
            type="button"
            onClick={() => {
              setGroupPopoverOpen(false);
              setMenuOpen(false);
              setRightOpen((v) => !v);
            }}
            aria-expanded={rightOpen}
            title="Toggle group inspector (People, Chat, Places, Ask)"
            className={`lo-press relative flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium shadow-[0_8px_24px_rgba(9,9,11,0.08)] backdrop-blur-xl transition ${
              rightOpen
                ? 'bg-zinc-950 text-white hover:bg-zinc-800'
                : 'border border-zinc-200/80 bg-white/92 text-zinc-800 hover:bg-white hover:text-zinc-950'
            }`}
          >
            <PanelRight className="h-4 w-4" />
            <span>Inspector</span>
            {!rightOpen && unreadChatCount + pendingIncomingCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-zinc-950 px-1.5 text-[10px] font-bold text-white">
                {unreadChatCount + pendingIncomingCount > 9
                  ? '9+'
                  : unreadChatCount + pendingIncomingCount}
              </span>
            )}
          </button>
        </div>

        {rightOpen && (
          <div className="lo-float-in pointer-events-auto flex max-h-[44vh] w-full flex-col overflow-hidden rounded-xl border border-zinc-200/80 bg-white/92 shadow-[0_16px_44px_rgba(9,9,11,0.1)] backdrop-blur-xl md:max-h-[calc(100vh-140px)]">
            {/* Segmented Pill Tabs */}
            <div className="border-b border-zinc-100 p-2">
              <div className="grid grid-cols-4 gap-1 rounded-lg bg-zinc-100 p-1 text-[11px] font-semibold">
                {(
                  [
                    ['people', `People (${locations.length})`],
                    ['chat', unreadChatCount > 0 ? `Chat (${unreadChatCount})` : 'Chat'],
                    ['places', `Places`],
                    ['requests', pendingIncomingCount > 0 ? `Ask (${pendingIncomingCount})` : 'Ask'],
                  ] as const
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      if (tab === 'chat') {
                        openChatTab();
                      } else {
                        setInspectorTab(tab);
                      }
                    }}
                    className={`lo-press rounded-md py-1.5 transition ${inspectorTab === tab
                      ? 'bg-zinc-950 text-white shadow-sm'
                      : 'text-zinc-600 hover:text-zinc-950'
                      }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* People Tab */}
            {inspectorTab === 'people' && (
              <div key="tab-people" className="lo-tab-enter flex-1 space-y-1.5 overflow-y-auto p-3">
                {locations.map((loc) => (
                  <div
                    key={loc.userId}
                    className="flex items-center justify-between rounded-lg border border-zinc-100 bg-zinc-50/75 px-3 py-2.5 transition hover:border-zinc-200 hover:bg-white"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedUserId(loc.userId)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-950 text-xs font-bold text-white">
                        {isSafeAvatarUrl(loc.avatarUrl) ? (
                          <img
                            src={loc.avatarUrl}
                            alt={loc.username}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          loc.username.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-zinc-950">
                          {loc.username}
                        </div>
                        <div className="truncate font-mono text-[10px] text-zinc-400">
                          {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                        </div>
                      </div>
                    </button>
                    <span
                      className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${loc.isFuzzed
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-zinc-950 text-white'
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
              <div key="tab-chat" className="lo-tab-enter flex min-h-[260px] flex-1 flex-col overflow-hidden">
                <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-500">
                  <button
                    type="button"
                    onClick={handleToggleChatAlerts}
                    className="lo-press flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-zinc-700 transition hover:bg-zinc-100"
                    title={chatAlertsEnabled ? 'Mute chat sound and desktop alerts' : 'Unmute chat alerts'}
                  >
                    {chatAlertsEnabled ? (
                      <Bell className="h-3 w-3 text-zinc-950" />
                    ) : (
                      <BellOff className="h-3 w-3 text-zinc-400" />
                    )}
                    {chatAlertsEnabled ? 'Alerts on' : 'Muted'}
                  </button>
                  {browserNotifyPermission === 'default' && (
                    <button
                      type="button"
                      onClick={() => void handleEnableBrowserNotifications()}
                      className="lo-press rounded-md bg-zinc-950 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-zinc-800"
                    >
                      Enable desktop alerts
                    </button>
                  )}
                  {browserNotifyPermission === 'granted' && (
                    <span className="text-[10px] text-zinc-400">Desktop alerts ready</span>
                  )}
                  {browserNotifyPermission === 'denied' && (
                    <span className="text-[10px] text-zinc-400">Desktop blocked</span>
                  )}
                </div>

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
                          className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${mine
                            ? 'bg-zinc-950 text-white'
                            : 'border border-zinc-200/80 bg-zinc-50 text-zinc-900'
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
                  <div ref={chatBottomRef} />
                </div>

                <form
                  onSubmit={handleSendChat}
                  className="flex gap-1.5 border-t border-zinc-100 p-2.5"
                >
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={!activeGroup}
                    placeholder={activeGroup ? 'Message group...' : 'Select a group'}
                    className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!activeGroup || !chatInput.trim()}
                    className="lo-press flex shrink-0 items-center justify-center rounded-lg bg-zinc-950 px-3.5 py-2 text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </button>
                </form>
              </div>
            )}

            {/* Places Tab */}
            {inspectorTab === 'places' && (
              <div key="tab-places" className="lo-tab-enter flex-1 space-y-3 overflow-y-auto p-3">
                {activeGroup?.myRole === 'ADMIN' && (
                  <form
                    onSubmit={handleCreatePlace}
                    className="space-y-2 rounded-lg border border-zinc-200/70 bg-zinc-50/80 p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-600">
                      <span className="flex items-center gap-1 font-medium">
                        <MapPin className="h-3 w-3 text-zinc-950" />
                        {draftPlace
                          ? `Pin at ${draftPlace.latitude.toFixed(4)}, ${draftPlace.longitude.toFixed(4)}`
                          : 'Click or tap map to place pin'}
                      </span>
                      {(placeLat || placeLon) && (
                        <button
                          type="button"
                          onClick={() => {
                            setPlaceLat('');
                            setPlaceLon('');
                          }}
                          className="text-[10px] font-semibold text-zinc-500 hover:text-zinc-950"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={placeName}
                        onChange={(e) => setPlaceName(e.target.value)}
                        placeholder="Home, School, Office..."
                        className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:outline-none"
                      />
                      <input
                        type="number"
                        min={25}
                        max={10000}
                        value={placeRadius}
                        onChange={(e) => setPlaceRadius(Number(e.target.value))}
                        title="Radius (m)"
                        className="w-16 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:outline-none"
                      />
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={placeLat}
                        onChange={(e) => setPlaceLat(e.target.value)}
                        placeholder="Lat (click map)"
                        className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1 font-mono text-[11px] text-zinc-900 focus:border-zinc-400 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={placeLon}
                        onChange={(e) => setPlaceLon(e.target.value)}
                        placeholder="Lon (click map)"
                        className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1 font-mono text-[11px] text-zinc-900 focus:border-zinc-400 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={placeBusy}
                        className="lo-press shrink-0 rounded-lg bg-zinc-950 px-3 py-1 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
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
                      className="flex items-center justify-between rounded-lg border border-zinc-100 bg-zinc-50/75 px-3 py-2 text-xs transition hover:border-zinc-200 hover:bg-white"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedPlaceId(p.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate font-semibold text-zinc-950">{p.name}</div>
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
                          className="ml-2 rounded-md p-1.5 text-zinc-400 hover:bg-rose-50 hover:text-rose-600"
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
                  <div className="border-t border-zinc-100 pt-2.5">
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
                            <span className="font-semibold text-zinc-950">{evt.username}</span>{' '}
                            {evt.transition === 'enter' ? 'arrived at' : 'left'}{' '}
                            <span className="font-medium text-zinc-950">{evt.placeName}</span>
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
              <div key="tab-requests" className="lo-tab-enter flex-1 space-y-3 overflow-y-auto p-3">
                {activeGroup && activeGroup.members.some((m) => m.userId !== session.user.id) ? (
                  <form onSubmit={handleSendCheckInRequest} className="flex gap-1.5">
                    <select
                      value={checkinTargetUserId}
                      onChange={(e) => setCheckinTargetUserId(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
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
                      className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-900 focus:border-zinc-400 focus:bg-white focus:outline-none"
                    >
                      <option value={15}>15m</option>
                      <option value={30}>30m</option>
                      <option value={60}>60m</option>
                    </select>
                    <button
                      type="submit"
                      disabled={checkinBusy || !checkinTargetUserId}
                      className="lo-press shrink-0 rounded-lg bg-zinc-950 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
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
                        className="rounded-lg border border-zinc-100 bg-zinc-50/75 p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-zinc-950">
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
                              className="lo-press flex flex-1 items-center justify-center gap-1 rounded-lg bg-zinc-950 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800"
                            >
                              <Check className="h-3 w-3" /> Accept
                            </button>
                            <button
                              type="button"
                              disabled={checkinBusy}
                              onClick={() => void handleRespondCheckIn(req.id, 'decline')}
                              className="lo-press flex flex-1 items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-white py-1.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100"
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

      {/* Bottom-Left Floating Profile Pill & Map Credits */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-20 hidden items-end gap-2 sm:bottom-4 sm:left-4 sm:flex">
        <div className="lo-float-in pointer-events-auto flex items-center gap-2 rounded-xl border border-zinc-200/80 bg-white/92 py-1.5 pl-2 pr-2 shadow-[0_8px_28px_rgba(9,9,11,0.08)] backdrop-blur-xl">
          <button
            type="button"
            onClick={() => setAccountSettingsOpen(true)}
            title="Account settings & profile photo"
            className="lo-press flex items-center gap-2.5 rounded-lg pr-1 text-left transition hover:opacity-85"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-950 text-xs font-bold text-white">
              {isSafeAvatarUrl(session.user.avatarUrl) ? (
                <img
                  src={session.user.avatarUrl}
                  alt={session.user.username}
                  className="h-full w-full object-cover"
                />
              ) : (
                session.user.username.slice(0, 1).toUpperCase()
              )}
            </span>
            <div className="leading-tight">
              <div className="text-xs font-semibold text-zinc-950">{session.user.username}</div>
              <div className="text-[10px] text-zinc-500">
                {session.user.role === 'HOST_ADMIN' ? 'Host Admin · Settings' : 'Account Settings'}
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setAccountSettingsOpen(true)}
            title="Account settings"
            className="lo-press rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            title="Sign out"
            className="lo-press rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="pointer-events-auto relative">
          {creditsOpen && (
            <div className="lo-float-in mb-2 w-60 rounded-xl border border-zinc-200/80 bg-white/95 p-3 text-[11px] leading-relaxed text-zinc-600 shadow-[0_12px_32px_rgba(9,9,11,0.12)] backdrop-blur-xl">
              <div className="mb-1 font-semibold text-zinc-950">Map Credits</div>
              <p>
                Icons:{' '}
                <a
                  href="https://github.com/mapbox/maki"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-zinc-950 underline decoration-zinc-300 underline-offset-2"
                >
                  Mapbox Maki
                </a>{' '}
                (CC0 1.0)
              </p>
              <p>
                Font:{' '}
                <a
                  href="https://github.com/tokotype/PlusJakartaSans"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-zinc-950 underline decoration-zinc-300 underline-offset-2"
                >
                  Plus Jakarta Sans
                </a>{' '}
                (OFL 1.1)
              </p>
              <p>Data: OpenStreetMap · Protomaps</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCreditsOpen((v) => !v)}
            className="lo-press rounded-lg border border-zinc-200/80 bg-white/90 px-2.5 py-1.5 text-[10px] font-medium text-zinc-500 shadow-sm backdrop-blur-xl transition hover:bg-white hover:text-zinc-950"
          >
            © Maki · OSM
          </button>
        </div>
      </div>

      {/* Bottom-Center Floating Map View Mode Switcher */}
      <div className="pointer-events-auto absolute bottom-3 left-1/2 z-20 -translate-x-1/2 sm:bottom-4">
        <div className="lo-float-in flex items-center gap-1 rounded-xl border border-zinc-200/80 bg-white/92 p-1 text-xs font-semibold shadow-[0_8px_28px_rgba(9,9,11,0.1)] backdrop-blur-xl">
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
              className={`lo-press flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 transition ${mapViewMode === mode
                ? 'bg-zinc-950 text-white shadow-sm'
                : 'text-zinc-600 hover:text-zinc-950'
                }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <QrJoinModal
        open={joinQrOpen}
        mode="authenticated"
        accessToken={session.accessToken}
        isOnboardingPrompt={joinQrOnboardingPrompt}
        onClose={() => {
          if (joinQrOnboardingPrompt) {
            setInvitePromptDismissed(true);
          }
          setJoinQrOpen(false);
          setJoinQrOnboardingPrompt(false);
        }}
        onJoinedGroup={(groupId) => {
          setInvitePromptDismissed(true);
          void refreshGroups(session.accessToken).then(() => {
            setActiveGroupId(groupId);
          });
        }}
      />

      <AccountSettingsModal
        open={accountSettingsOpen}
        session={session}
        onClose={() => setAccountSettingsOpen(false)}
        onSessionUpdated={(next) => {
          setSession(next);
          setLocations((prev) =>
            prev.map((loc) =>
              loc.userId === next.user.id
                ? { ...loc, username: next.user.username, avatarUrl: next.user.avatarUrl ?? null }
                : loc,
            ),
          );
          setGroups((prev) =>
            prev.map((grp) => ({
              ...grp,
              members: grp.members.map((m) =>
                m.userId === next.user.id
                  ? { ...m, username: next.user.username, avatarUrl: next.user.avatarUrl ?? null }
                  : m,
              ),
            })),
          );
        }}
      />
    </div>
  );
}
