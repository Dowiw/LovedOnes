import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Camera, type CameraRef, Map, Marker } from '@maplibre/maplibre-react-native';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { io, Socket } from 'socket.io-client';
import {
  isSafeAvatarUrl,
  parseInviteInput,
  type ChatMessage,
  type GroupRole,
  type LocationBroadcast,
  type PrivacyMode,
} from '@loved-ones/shared';
import {
  isBackgroundTrackingActive,
  startBackgroundTracking,
  stopBackgroundTracking,
} from '../services/backgroundLocation';
import {
  LocationPermissionResult,
  requestLocationPermissionsOnLaunch,
} from '../services/locationPermissions';
import {
  enqueueLocationPoints,
  flushOfflineLocations,
  getPendingLocationCount,
} from '../services/offlineQueue';
import {
  buildMobileMapStyle,
  checkForOtaUpdate,
  downloadOfflineRegionPmtiles,
  getCachedRegionPmtilesUri,
  type MapLabelLanguage,
} from '../services/pmtilesStyle';
import { clearStoredConfig, MobileStoredConfig, saveStoredConfig } from '../services/secureConfig';

interface GroupSummary {
  id: string;
  name: string;
  myPrivacy: PrivacyMode;
}

interface MobileMapScreenProps {
  config: MobileStoredConfig;
  onSignedOut: () => void;
}

export function MobileMapScreen({ config, onSignedOut }: MobileMapScreenProps) {
  const serverUrl = (config.serverUrl ?? '').replace(/\/$/, '');
  const [accessToken, setAccessToken] = useState(config.accessToken ?? '');
  const [refreshToken, setRefreshToken] = useState(config.refreshToken ?? '');

  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string>(config.activeGroupId ?? '');
  const [locations, setLocations] = useState<LocationBroadcast[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [chatBanner, setChatBanner] = useState<ChatMessage | null>(null);
  const chatOpenRef = useRef(false);
  const chatBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifiedMsgIdsRef = useRef<Set<string>>(new Set());
  chatOpenRef.current = chatOpen;

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [joinQrOpen, setJoinQrOpen] = useState(false);
  const [joinIsPrompt, setJoinIsPrompt] = useState(false);
  const [invitePromptDismissed, setInvitePromptDismissed] = useState(false);
  const [qrScanning, setQrScanning] = useState(false);
  const [qrPasteInput, setQrPasteInput] = useState('');
  const [qrPreview, setQrPreview] = useState<{
    token: string;
    groupId: string;
    groupName: string;
    assignedRole: GroupRole;
    valid: boolean;
  } | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);

  const [userProfile, setUserProfile] = useState(config.user);
  const [accountOpen, setAccountOpen] = useState(false);
  const [editUsername, setEditUsername] = useState(config.user?.username ?? '');
  const [editEmail, setEditEmail] = useState(config.user?.email ?? '');
  const [editAvatarUrl, setEditAvatarUrl] = useState(config.user?.avatarUrl ?? '');
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const [tracking, setTracking] = useState(false);
  const [selfCoord, setSelfCoord] = useState<[number, number] | null>(null);
  const [labelLanguage, setLabelLanguage] = useState<MapLabelLanguage>('en');
  const [queuedCount, setQueuedCount] = useState(0);
  const [localPmtilesUri, setLocalPmtilesUri] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [permissionInfo, setPermissionInfo] = useState<LocationPermissionResult | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const cameraRef = useRef<CameraRef | null>(null);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  );

  const mapStyle = useMemo(
    () => buildMobileMapStyle(serverUrl, localPmtilesUri, labelLanguage),
    [serverUrl, localPmtilesUri, labelLanguage],
  );

  const refreshQueueCount = useCallback(async () => {
    const cnt = await getPendingLocationCount();
    setQueuedCount(cnt);
  }, []);

  useEffect(() => {
    void requestLocationPermissionsOnLaunch()
      .then((perm) => {
        setPermissionInfo(perm);
      })
      .catch(() => {});
    void isBackgroundTrackingActive().then(setTracking).catch(() => {});
    void getCachedRegionPmtilesUri().then(setLocalPmtilesUri).catch(() => {});
    void refreshQueueCount().catch(() => {});
  }, [refreshQueueCount]);

  async function handleRequestPermissions() {
    try {
      const perm = await requestLocationPermissionsOnLaunch();
      setPermissionInfo(perm);
      setStatusBanner(perm.label);
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'Unable to request location permission');
    }
  }

  const fetchGroups = useCallback(async () => {
    if (!serverUrl || !accessToken) return;
    const res = await fetch(`${serverUrl}/api/auth/groups`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as { groups?: GroupSummary[] };
    const list = data.groups ?? [];
    setGroups(list);
    setGroupsLoaded(true);
    if (list.length > 0 && !activeGroupId) {
      setActiveGroupId(list[0].id);
      void saveStoredConfig({ activeGroupId: list[0].id });
    }
  }, [serverUrl, accessToken, activeGroupId]);

  useEffect(() => {
    if (!serverUrl || !accessToken) return;
    void fetch(`${serverUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { user?: MobileStoredConfig['user'] } | null) => {
        if (!data?.user) return;
        setUserProfile(data.user);
        setEditUsername(data.user.username);
        setEditEmail(data.user.email);
        setEditAvatarUrl(data.user.avatarUrl ?? '');
        void saveStoredConfig({ user: data.user });
      })
      .catch(() => {});

    void fetchGroups().catch(() => {});
  }, [serverUrl, accessToken, fetchGroups]);

  useEffect(() => {
    if (
      groupsLoaded &&
      groups.length === 0 &&
      userProfile?.role !== 'HOST_ADMIN' &&
      !invitePromptDismissed &&
      !joinQrOpen
    ) {
      setJoinIsPrompt(true);
      setJoinQrOpen(true);
    }
  }, [groupsLoaded, groups.length, userProfile?.role, invitePromptDismissed, joinQrOpen]);

  useEffect(() => {
    if (!serverUrl || !accessToken) return;
    const socket = io(serverUrl, {
      auth: { token: accessToken },
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
      const isMatchingGroup = !activeGroup || msg.groupId === activeGroup.id;
      setMessages((prev) => {
        if (!isMatchingGroup) return prev;
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });

      if (!isMatchingGroup) return;
      if (msg.senderId === userProfile?.id) return;
      if (notifiedMsgIdsRef.current.has(msg.id)) return;
      notifiedMsgIdsRef.current.add(msg.id);

      if (!chatOpenRef.current) {
        setUnreadChatCount((c) => c + 1);
        setChatBanner(msg);
        if (chatBannerTimerRef.current) {
          clearTimeout(chatBannerTimerRef.current);
        }
        chatBannerTimerRef.current = setTimeout(() => {
          setChatBanner((prev) => (prev?.id === msg.id ? null : prev));
        }, 5500);
      }
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
        setMessages((prev) =>
          prev.map((m) =>
            m.senderId === evt.userId
              ? { ...m, senderUsername: evt.username, senderAvatarUrl: evt.avatarUrl }
              : m,
          ),
        );
        if (userProfile?.id === evt.userId) {
          const updated = { ...userProfile, username: evt.username, avatarUrl: evt.avatarUrl };
          setUserProfile(updated);
          void saveStoredConfig({ user: updated });
        }
      },
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [serverUrl, accessToken, activeGroup]);

  useEffect(() => {
    setUnreadChatCount(0);
    setChatBanner(null);
    if (!serverUrl || !accessToken || !activeGroup) return;
    socketRef.current?.emit('group:join', activeGroup.id);

    void fetch(`${serverUrl}/api/realtime/groups/${activeGroup.id}/locations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((d: { locations?: LocationBroadcast[] }) => setLocations(d.locations ?? []))
      .catch(() => {});

    void fetch(`${serverUrl}/api/realtime/groups/${activeGroup.id}/messages`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((d: { messages?: ChatMessage[] }) => setMessages(d.messages ?? []))
      .catch(() => {});
  }, [serverUrl, accessToken, activeGroup]);

  async function captureFocusAndSyncPosition(): Promise<{ flushed: number; remaining: number } | null> {
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    }).catch(() => Location.getLastKnownPositionAsync().catch(() => null));
    if (!pos) return null;

    const coord: [number, number] = [pos.coords.longitude, pos.coords.latitude];
    setSelfCoord(coord);
    cameraRef.current?.flyTo({ center: coord, zoom: 14.5, duration: 700 });

    await enqueueLocationPoints([
      {
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
      },
    ]);
    const result = await flushOfflineLocations(serverUrl, accessToken);
    await refreshQueueCount();
    return result;
  }

  async function handleToggleTracking() {
    try {
      if (tracking) {
        await stopBackgroundTracking();
        setTracking(false);
        setSelfCoord(null);
        setStatusBanner('Location tracking paused');
      } else {
        const started = await startBackgroundTracking();
        setPermissionInfo(started.permission);
        setTracking(true);
        setStatusBanner(
          started.mode === 'background'
            ? 'Background GPS beacon active (Always Allow)'
            : 'Foreground GPS beacon active (While Using App fallback)',
        );
        await captureFocusAndSyncPosition().catch(() => null);
      }
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'Unable to toggle location tracking');
    }
  }

  async function handlePingAndSync() {
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        setStatusBanner('Location permission required');
        return;
      }
      const result = await captureFocusAndSyncPosition();
      if (result) {
        setStatusBanner(`Synced ${result.flushed} points (${result.remaining} queued)`);
      }
    } catch (err) {
      await refreshQueueCount();
      setStatusBanner(err instanceof Error ? err.message : 'Saved offline in SQLite queue');
    }
  }

  async function handlePrivacyChange(mode: PrivacyMode) {
    if (!activeGroup) return;
    await fetch(`${serverUrl}/api/auth/groups/${activeGroup.id}/privacy`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ privacy: mode }),
    });
    setGroups((prev) => prev.map((g) => (g.id === activeGroup.id ? { ...g, myPrivacy: mode } : g)));
  }

  async function handleCacheOfflineMap() {
    try {
      const uri = await downloadOfflineRegionPmtiles(serverUrl);
      setLocalPmtilesUri(uri);
      setStatusBanner('Cached regional PMTiles for offline rendering');
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'Tile cache failed');
    }
  }

  async function handleCheckOta() {
    try {
      const res = await checkForOtaUpdate();
      setStatusBanner(res.message);
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'OTA check failed');
    }
  }

  function handleSendChat() {
    if (!activeGroup || !chatText.trim() || !socketRef.current) return;
    socketRef.current.emit('chat:send', {
      groupId: activeGroup.id,
      content: chatText.trim(),
    });
    setChatText('');
  }

  function openJoinQrModal(asPrompt = false) {
    setJoinIsPrompt(asPrompt);
    setQrScanning(false);
    setQrPasteInput('');
    setQrPreview(null);
    setQrError(null);
    setJoinQrOpen(true);
  }

  function closeJoinQrModal() {
    if (joinIsPrompt) {
      setInvitePromptDismissed(true);
    }
    setQrScanning(false);
    setJoinQrOpen(false);
    setJoinIsPrompt(false);
  }

  async function resolveMobileInvite(raw: string) {
    setQrError(null);
    setQrLoading(true);
    try {
      const parsed = parseInviteInput(raw);
      const targetServer = (parsed.serverUrl ?? serverUrl).replace(/\/$/, '');
      const res = await fetch(
        `${targetServer}/api/auth/invites/${encodeURIComponent(parsed.inviteToken)}`,
      );
      const data = (await res.json()) as {
        error?: string;
        token?: string;
        groupId?: string;
        groupName?: string;
        assignedRole?: GroupRole;
        valid?: boolean;
      };
      if (!res.ok || !data.token || !data.groupName) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setQrPreview({
        token: data.token,
        groupId: data.groupId ?? '',
        groupName: data.groupName,
        assignedRole: data.assignedRole ?? 'MEMBER',
        valid: Boolean(data.valid),
      });
    } catch (err) {
      setQrPreview(null);
      setQrError(err instanceof Error ? err.message : 'Invalid QR invite');
    } finally {
      setQrLoading(false);
    }
  }

  async function handleMobileQrScanned(result: BarcodeScanningResult) {
    if (!qrScanning) return;
    setQrScanning(false);
    await resolveMobileInvite(result.data);
  }

  async function handleConfirmJoinInvite() {
    if (!qrPreview || !qrPreview.valid) return;
    setQrLoading(true);
    setQrError(null);
    try {
      const res = await authedFetch('/api/auth/join', {
        method: 'POST',
        body: JSON.stringify({ inviteToken: qrPreview.token }),
      });
      const data = (await res.json()) as { error?: string; groupId?: string; groupName?: string };
      if (!res.ok || !data.groupId) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setInvitePromptDismissed(true);
      await fetchGroups();
      setActiveGroupId(data.groupId);
      await saveStoredConfig({ activeGroupId: data.groupId });
      socketRef.current?.emit('group:join', data.groupId);
      setStatusBanner(`Joined ${data.groupName ?? qrPreview.groupName}`);
      setJoinQrOpen(false);
      setJoinIsPrompt(false);
    } catch (err) {
      setQrError(err instanceof Error ? err.message : 'Failed to join group');
    } finally {
      setQrLoading(false);
    }
  }

  function openAccountModal() {
    setEditUsername(userProfile?.username ?? '');
    setEditEmail(userProfile?.email ?? '');
    setEditAvatarUrl(userProfile?.avatarUrl ?? '');
    setAccountError(null);
    setAccountMessage(null);
    setPasswordError(null);
    setPasswordMessage(null);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setAccountOpen(true);
  }

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      return fetch(`${serverUrl}${path}`, { ...init, headers });
    };

    let res = await send(accessToken);
    if (res.status === 401 && refreshToken) {
      const refreshRes = await fetch(`${serverUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (refreshRes.ok) {
        const tokens = (await refreshRes.json()) as {
          accessToken?: string;
          refreshToken?: string;
        };
        if (tokens.accessToken && tokens.refreshToken) {
          setAccessToken(tokens.accessToken);
          setRefreshToken(tokens.refreshToken);
          await saveStoredConfig({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          });
          res = await send(tokens.accessToken);
        }
      } else if (refreshRes.status === 400 || refreshRes.status === 401) {
        await clearStoredConfig();
        onSignedOut();
      }
    }
    return res;
  }

  async function handleSaveProfile() {
    if (!serverUrl || !accessToken) return;
    setAccountError(null);
    setAccountMessage(null);
    const trimmedAvatar = editAvatarUrl.trim();
    if (trimmedAvatar && !isSafeAvatarUrl(trimmedAvatar)) {
      setAccountError('Avatar must be a valid http(s) URL or raster image data URI.');
      return;
    }
    setAccountBusy(true);
    try {
      const res = await authedFetch('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({
          username: editUsername.trim(),
          email: editEmail.trim(),
          avatarUrl: trimmedAvatar || null,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        accessToken?: string;
        refreshToken?: string;
        user?: MobileStoredConfig['user'];
      };
      if (!res.ok || !data.user) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setUserProfile(data.user);
      if (data.accessToken) setAccessToken(data.accessToken);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      await saveStoredConfig({
        accessToken: data.accessToken ?? accessToken,
        refreshToken: data.refreshToken ?? refreshToken,
        user: data.user,
      });
      setLocations((prev) =>
        prev.map((loc) =>
          loc.userId === data.user!.id
            ? { ...loc, username: data.user!.username, avatarUrl: data.user!.avatarUrl ?? null }
            : loc,
        ),
      );
      setAccountMessage('Profile saved');
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : 'Unable to save profile');
    } finally {
      setAccountBusy(false);
    }
  }

  async function handleChangePassword() {
    if (!serverUrl || !accessToken) return;
    setPasswordError(null);
    setPasswordMessage(null);
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    setPasswordBusy(true);
    try {
      const res = await authedFetch('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await res.json()) as { error?: string; updated?: boolean };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage('Password updated');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Unable to change password');
    } finally {
      setPasswordBusy(false);
    }
  }

  const centerCoord: [number, number] = selfCoord
    ? selfCoord
    : locations[0]
      ? [locations[0].longitude, locations[0].latitude]
      : [13.4448, 52.5069];

  const myUserId = userProfile?.id ?? config.user?.id;
  const showSelfMarker = Boolean(
    selfCoord && !locations.some((loc) => loc.userId === myUserId && !loc.isFuzzed),
  );
  const selfAvatarUrl = isSafeAvatarUrl(userProfile?.avatarUrl) ? userProfile!.avatarUrl : null;

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={mapStyle}>
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: centerCoord,
            zoom: 11,
          }}
        />
        {showSelfMarker && selfCoord && (
          <Marker id="self-live" lngLat={selfCoord}>
            <View style={styles.marker}>
              <Text style={styles.selfMarkerLabel}>You</Text>
              {selfAvatarUrl ? (
                <View style={styles.avatarRingSelf}>
                  <Image source={{ uri: selfAvatarUrl }} style={styles.markerAvatarImg} />
                </View>
              ) : (
                <View style={styles.selfMarkerHalo}>
                  <View style={styles.selfMarkerDot} />
                </View>
              )}
            </View>
          </Marker>
        )}
        {locations.map((loc) => {
          const pinAvatar =
            loc.avatarUrl ?? (loc.userId === myUserId ? userProfile?.avatarUrl : null) ?? null;
          const safePinAvatar = isSafeAvatarUrl(pinAvatar) ? pinAvatar : null;
          return (
            <Marker key={loc.userId} id={loc.userId} lngLat={[loc.longitude, loc.latitude]}>
              <View style={styles.marker}>
                <Text style={styles.markerLabel}>
                  {loc.username}
                  {loc.isFuzzed ? ' (~1km)' : ''}
                </Text>
                {safePinAvatar ? (
                  <View style={[styles.avatarRing, loc.isFuzzed && styles.avatarRingFuzzed]}>
                    <Image source={{ uri: safePinAvatar }} style={styles.markerAvatarImg} />
                  </View>
                ) : (
                  <View style={styles.markerHalo}>
                    <View
                      style={[styles.markerDot, loc.isFuzzed ? styles.dotFuzzed : styles.dotExact]}
                    />
                  </View>
                )}
              </View>
            </Marker>
          );
        })}
      </Map>

      {/* Top Floating Search / Group Capsule & Filter Chips */}
      <View style={styles.topOverlay} pointerEvents="box-none">
        <View style={styles.topCapsule}>
          <TouchableOpacity style={styles.topAvatarBtn} onPress={openAccountModal}>
            {selfAvatarUrl ? (
              <Image source={{ uri: selfAvatarUrl }} style={styles.topAvatarImg} />
            ) : (
              <Text style={styles.topAvatarInitial}>
                {(userProfile?.username ?? 'U').slice(0, 1).toUpperCase()}
              </Text>
            )}
          </TouchableOpacity>
          <View style={styles.topTitleWrap}>
            <Text style={styles.topTitle} numberOfLines={1}>
              {activeGroup?.name ?? 'LovedOnes'}
            </Text>
            <Text style={styles.topSubtitle} numberOfLines={1}>
              {userProfile?.username ?? 'Account'} · {activeGroup ? `${activeGroup.myPrivacy}` : 'Live map'}
            </Text>
          </View>
          <TouchableOpacity style={styles.joinQrPill} onPress={() => openJoinQrModal(false)}>
            <Text style={styles.joinQrPillText}>Join QR</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.signOutPill} onPress={openAccountModal}>
            <Text style={styles.signOutText}>Account</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipScroll}
        >
          {activeGroup &&
            (['EXACT', 'FUZZED', 'GHOST'] as PrivacyMode[]).map((mode) => {
              const selected = activeGroup.myPrivacy === mode;
              return (
                <TouchableOpacity
                  key={mode}
                  onPress={() => void handlePrivacyChange(mode)}
                  style={[styles.chipPill, selected && styles.chipPillActive]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                    {mode}
                  </Text>
                </TouchableOpacity>
              );
            })}

          {permissionInfo && (
            <TouchableOpacity
              onPress={() => void handleRequestPermissions()}
              style={styles.chipPill}
            >
              <Text style={styles.chipPermText}>{permissionInfo.label}</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {statusBanner && (
          <View style={styles.statusToast}>
            <Text style={styles.statusToastText} numberOfLines={1}>
              {statusBanner}
            </Text>
          </View>
        )}

        {chatBanner && !chatOpen && (
          <TouchableOpacity
            activeOpacity={0.9}
            style={styles.chatToastBanner}
            onPress={() => {
              setUnreadChatCount(0);
              setChatBanner(null);
              setChatOpen(true);
            }}
          >
            <View style={styles.chatToastTextWrap}>
              <Text style={styles.chatToastSender} numberOfLines={1}>
                New chat · {chatBanner.senderUsername}
              </Text>
              <Text style={styles.chatToastBody} numberOfLines={1}>
                {chatBanner.content}
              </Text>
            </View>
            <Text style={styles.chatToastAction}>Open</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Right-Side Floating Stacked Map Controls */}
      <View style={styles.rightStack}>
        <TouchableOpacity
          style={styles.stackBtn}
          onPress={() => void handleCacheOfflineMap()}
        >
          <Text style={styles.stackBtnText}>
            {localPmtilesUri ? 'Cached' : 'Cache'}
          </Text>
        </TouchableOpacity>
        <View style={styles.stackDivider} />
        <TouchableOpacity style={styles.stackBtn} onPress={() => void handleCheckOta()}>
          <Text style={styles.stackBtnText}>OTA</Text>
        </TouchableOpacity>
      </View>

      {/* Bottom Floating Mint CTA + White Rounded Sheet */}
      <View style={styles.bottomWrap} pointerEvents="box-none">
        <View style={styles.floatingCtaRow} pointerEvents="box-none">
          <TouchableOpacity
            style={styles.floatingCirclePill}
            onPress={() => void handlePingAndSync()}
          >
            <Text style={styles.floatingCircleText}>Sync ({queuedCount})</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.mintCta, tracking && styles.mintCtaTracking]}
            onPress={() => void handleToggleTracking()}
          >
            <View style={[styles.mintCtaDot, tracking && styles.mintCtaDotActive]} />
            <Text style={[styles.mintCtaText, tracking && styles.mintCtaTextActive]}>
              {tracking ? 'Live GPS On' : 'Start GPS'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.floatingCirclePill}
            onPress={() => setLabelLanguage((prev) => (prev === 'en' ? 'local' : 'en'))}
          >
            <Text style={styles.floatingCircleText}>
              {labelLanguage === 'en' ? 'EN' : 'Local'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.bottomSheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetSummary}>
            {locations.length} {locations.length === 1 ? 'member' : 'members'} visible
          </Text>

          {locations.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.memberStrip}
            >
              {locations.map((loc) => {
                const chipAvatar = isSafeAvatarUrl(loc.avatarUrl) ? loc.avatarUrl : null;
                return (
                  <View key={loc.userId} style={styles.memberChip}>
                    {chipAvatar ? (
                      <Image source={{ uri: chipAvatar }} style={styles.memberChipAvatar} />
                    ) : (
                      <View
                        style={[
                          styles.memberChipDot,
                          loc.isFuzzed ? styles.dotFuzzed : styles.dotExact,
                        ]}
                      />
                    )}
                    <Text style={styles.memberChipText}>
                      {loc.username}
                      {loc.isFuzzed ? ' ~1km' : ''}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.tabBar}>
            <TouchableOpacity style={[styles.tabItem, styles.tabItemActive]}>
              <Text style={[styles.tabLabel, styles.tabLabelActive]}>Map</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.tabItem}
              onPress={() => void handlePingAndSync()}
            >
              <Text style={styles.tabLabel}>Sync ({queuedCount})</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.tabItem}
              onPress={() => {
                setUnreadChatCount(0);
                setChatBanner(null);
                setChatOpen(true);
              }}
            >
              <View style={styles.chatTabRow}>
                <Text style={styles.tabLabel}>Chat ({messages.length})</Text>
                {unreadChatCount > 0 && (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadBadgeText}>
                      {unreadChatCount > 99 ? '99+' : unreadChatCount}
                    </Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Minimalist White Chat Sheet Modal */}
      <Modal visible={chatOpen} animationType="slide" onRequestClose={() => setChatOpen(false)}>
        <View style={styles.modalWrap}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>{activeGroup?.name ?? 'Group'} Chat</Text>
              <Text style={styles.modalSubtitle}>{messages.length} messages</Text>
            </View>
            <TouchableOpacity style={styles.closePill} onPress={() => setChatOpen(false)}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.chatList} contentContainerStyle={styles.chatListContent}>
            {messages.map((m) => (
              <View key={m.id} style={styles.chatBubble}>
                <Text style={styles.chatSender}>{m.senderUsername}</Text>
                <Text style={styles.chatBody}>{m.content}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.chatComposer}>
            <TextInput
              style={styles.chatInput}
              value={chatText}
              onChangeText={setChatText}
              placeholder="Write a message..."
              placeholderTextColor="#94a3b8"
            />
            <TouchableOpacity style={styles.sendBtn} onPress={handleSendChat}>
              <Text style={styles.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Account Settings Modal */}
      <Modal
        visible={accountOpen}
        animationType="slide"
        onRequestClose={() => setAccountOpen(false)}
      >
        <View style={styles.modalWrap}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>Account Settings</Text>
              <Text style={styles.modalSubtitle}>Profile photo, name, email & password</Text>
            </View>
            <TouchableOpacity style={styles.closePill} onPress={() => setAccountOpen(false)}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.settingsScroll}>
            <View style={styles.settingsCard}>
              <View style={styles.avatarPreviewRow}>
                <View style={styles.settingsAvatarCircle}>
                  {isSafeAvatarUrl(editAvatarUrl.trim()) ? (
                    <Image
                      source={{ uri: editAvatarUrl.trim() }}
                      style={styles.settingsAvatarImg}
                    />
                  ) : (
                    <Text style={styles.settingsAvatarInitial}>
                      {(editUsername || userProfile?.username || 'U').slice(0, 1).toUpperCase()}
                    </Text>
                  )}
                </View>
                <View style={styles.avatarMeta}>
                  <Text style={styles.settingsSectionTitle}>Profile Photo URL</Text>
                  <Text style={styles.settingsHint}>
                    Shown as a circle marker on your group maps.
                  </Text>
                  {Boolean(editAvatarUrl.trim()) && (
                    <TouchableOpacity
                      style={styles.removePhotoBtn}
                      onPress={() => setEditAvatarUrl('')}
                    >
                      <Text style={styles.removePhotoText}>Remove Photo</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              <Text style={styles.fieldLabel}>Photo URL</Text>
              <TextInput
                style={styles.fieldInput}
                value={editAvatarUrl}
                onChangeText={setEditAvatarUrl}
                autoCapitalize="none"
                placeholder="https://example.com/photo.jpg"
                placeholderTextColor="#94a3b8"
              />

              <Text style={styles.fieldLabel}>Display Name</Text>
              <TextInput
                style={styles.fieldInput}
                value={editUsername}
                onChangeText={setEditUsername}
                placeholder="Your name"
                placeholderTextColor="#94a3b8"
              />

              <Text style={styles.fieldLabel}>Email Address</Text>
              <TextInput
                style={styles.fieldInput}
                value={editEmail}
                onChangeText={setEditEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="you@example.com"
                placeholderTextColor="#94a3b8"
              />

              {accountError && <Text style={styles.errorText}>{accountError}</Text>}
              {accountMessage && <Text style={styles.successText}>{accountMessage}</Text>}

              <TouchableOpacity
                style={styles.primaryBlackBtn}
                disabled={accountBusy}
                onPress={() => void handleSaveProfile()}
              >
                <Text style={styles.primaryBlackText}>
                  {accountBusy ? 'Saving...' : 'Save Profile'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.settingsCard}>
              <Text style={styles.settingsSectionTitle}>Change Password</Text>

              <Text style={styles.fieldLabel}>Current Password</Text>
              <TextInput
                style={styles.fieldInput}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                secureTextEntry
                placeholder="Current password"
                placeholderTextColor="#94a3b8"
              />

              <Text style={styles.fieldLabel}>New Password</Text>
              <TextInput
                style={styles.fieldInput}
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                placeholder="Minimum 8 characters"
                placeholderTextColor="#94a3b8"
              />

              <Text style={styles.fieldLabel}>Confirm New Password</Text>
              <TextInput
                style={styles.fieldInput}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                placeholder="Repeat new password"
                placeholderTextColor="#94a3b8"
              />

              {passwordError && <Text style={styles.errorText}>{passwordError}</Text>}
              {passwordMessage && <Text style={styles.successText}>{passwordMessage}</Text>}

              <TouchableOpacity
                style={styles.outlineBlackBtn}
                disabled={passwordBusy}
                onPress={() => void handleChangePassword()}
              >
                <Text style={styles.outlineBlackText}>
                  {passwordBusy ? 'Updating...' : 'Update Password'}
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.signOutFullBtn}
              onPress={async () => {
                setAccountOpen(false);
                await stopBackgroundTracking().catch(() => {});
                await clearStoredConfig();
                onSignedOut();
              }}
            >
              <Text style={styles.signOutFullText}>Sign Out</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Join Group via QR Modal */}
      <Modal visible={joinQrOpen} animationType="slide" onRequestClose={closeJoinQrModal}>
        <View style={styles.modalWrap}>
          {qrScanning ? (
            <View style={styles.scannerFull}>
              <CameraView
                style={StyleSheet.absoluteFill}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={(res) => void handleMobileQrScanned(res)}
              />
              <View style={styles.scannerOverlayBar}>
                <Text style={styles.scannerOverlayText}>Point camera at Admin Invite QR</Text>
                <TouchableOpacity
                  style={styles.closePill}
                  onPress={() => setQrScanning(false)}
                >
                  <Text style={styles.closeText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <>
              <View style={styles.modalHeader}>
                <View style={styles.headerTitleFlex}>
                  <Text style={styles.modalTitle}>
                    {joinIsPrompt ? 'Were you invited to a group?' : 'Join Group via QR'}
                  </Text>
                  <Text style={styles.modalSubtitle}>
                    Scan an invite QR code or paste the invite link/token.
                  </Text>
                </View>
                <TouchableOpacity style={styles.closePill} onPress={closeJoinQrModal}>
                  <Text style={styles.closeText}>{joinIsPrompt ? 'Skip' : 'Done'}</Text>
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={styles.settingsScroll}>
                {qrPreview ? (
                  <View style={styles.settingsCard}>
                    <Text style={styles.fieldLabel}>Invite Preview</Text>
                    <Text style={styles.previewGroupName}>{qrPreview.groupName}</Text>
                    <Text style={styles.settingsHint}>
                      Role: {qrPreview.assignedRole} ·{' '}
                      {qrPreview.valid ? 'Active' : 'Expired / Used Up'}
                    </Text>
                    {qrError && <Text style={styles.errorText}>{qrError}</Text>}
                    <TouchableOpacity
                      style={styles.primaryBlackBtn}
                      disabled={!qrPreview.valid || qrLoading}
                      onPress={() => void handleConfirmJoinInvite()}
                    >
                      <Text style={styles.primaryBlackText}>
                        {qrLoading ? 'Joining...' : `Join ${qrPreview.groupName}`}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.outlineBlackBtn}
                      onPress={() => {
                        setQrPreview(null);
                        setQrError(null);
                      }}
                    >
                      <Text style={styles.outlineBlackText}>Scan Different QR</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <View style={styles.settingsCard}>
                      <TouchableOpacity
                        style={styles.primaryBlackBtn}
                        onPress={async () => {
                          if (!cameraPermission?.granted) {
                            const next = await requestCameraPermission();
                            if (!next.granted) {
                              setQrError('Camera permission is required to scan QR codes.');
                              return;
                            }
                          }
                          setQrError(null);
                          setQrScanning(true);
                        }}
                      >
                        <Text style={styles.primaryBlackText}>Scan QR Code</Text>
                      </TouchableOpacity>
                    </View>

                    <View style={styles.settingsCard}>
                      <Text style={styles.fieldLabel}>Or Paste Invite Link / Token / JSON</Text>
                      <TextInput
                        style={styles.fieldInput}
                        value={qrPasteInput}
                        onChangeText={setQrPasteInput}
                        autoCapitalize="none"
                        placeholder="https://.../join?token=inv_... or inv_..."
                        placeholderTextColor="#94a3b8"
                      />
                      {qrError && <Text style={styles.errorText}>{qrError}</Text>}
                      <TouchableOpacity
                        style={styles.outlineBlackBtn}
                        disabled={qrLoading || !qrPasteInput.trim()}
                        onPress={() => void resolveMobileInvite(qrPasteInput)}
                      >
                        <Text style={styles.outlineBlackText}>
                          {qrLoading ? 'Checking...' : 'Verify Invite'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}

                {joinIsPrompt && (
                  <TouchableOpacity style={styles.closePill} onPress={closeJoinQrModal}>
                    <Text style={styles.skipPromptText}>Skip for now — take me to the map</Text>
                  </TouchableOpacity>
                )}
              </ScrollView>
            </>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#cfe3ee' },
  map: { flex: 1 },
  marker: { alignItems: 'center' },
  markerLabel: {
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  markerHalo: {
    width: 24,
    height: 24,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  markerDot: { width: 12, height: 12, borderRadius: 999 },
  dotExact: { backgroundColor: '#18181b' },
  dotFuzzed: { backgroundColor: '#d97706' },
  selfMarkerLabel: {
    backgroundColor: '#18181b',
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    marginBottom: 4,
    overflow: 'hidden',
  },
  selfMarkerHalo: {
    width: 26,
    height: 26,
    borderRadius: 999,
    backgroundColor: 'rgba(24, 24, 27, 0.2)',
    borderWidth: 2,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selfMarkerDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    backgroundColor: '#18181b',
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  topOverlay: {
    position: 'absolute',
    top: 48,
    left: 14,
    right: 14,
    gap: 10,
  },
  topCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 999,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 10,
    borderWidth: 1,
    borderColor: 'rgba(226, 232, 240, 0.9)',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  topAvatarBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: '#18181b',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topAvatarImg: {
    width: '100%',
    height: '100%',
  },
  topAvatarInitial: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  avatarRing: {
    width: 36,
    height: 36,
    borderRadius: 999,
    borderWidth: 2.5,
    borderColor: '#ffffff',
    backgroundColor: '#18181b',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  avatarRingFuzzed: {
    borderColor: '#d97706',
  },
  avatarRingSelf: {
    width: 36,
    height: 36,
    borderRadius: 999,
    borderWidth: 2.5,
    borderColor: '#ffffff',
    backgroundColor: '#18181b',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  markerAvatarImg: {
    width: '100%',
    height: '100%',
  },
  memberChipAvatar: {
    width: 18,
    height: 18,
    borderRadius: 999,
  },
  topBrandDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: '#18181b',
  },
  topTitleWrap: {
    flex: 1,
  },
  topTitle: {
    color: '#18181b',
    fontWeight: '700',
    fontSize: 15,
  },
  topSubtitle: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '500',
  },
  signOutPill: {
    backgroundColor: '#f1f5f9',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  signOutText: {
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
  },
  joinQrPill: {
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  joinQrPillText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  chipScroll: {
    gap: 8,
    paddingRight: 12,
  },
  chipPill: {
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(226, 232, 240, 0.95)',
    shadowColor: '#0f172a',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  chipPillActive: {
    borderColor: '#18181b',
    backgroundColor: '#ffffff',
  },
  chipText: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#18181b',
    fontWeight: '700',
  },
  chipPermText: {
    color: '#18181b',
    fontSize: 12,
    fontWeight: '600',
  },
  statusToast: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(24, 24, 27, 0.88)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  statusToastText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  rightStack: {
    position: 'absolute',
    right: 14,
    top: 168,
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
    overflow: 'hidden',
  },
  chatToastBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: 'rgba(24, 24, 27, 0.95)',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    shadowColor: '#0f172a',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  chatToastTextWrap: { flex: 1 },
  chatToastSender: { color: '#e4e4e7', fontSize: 11, fontWeight: '700' },
  chatToastBody: { color: '#ffffff', fontSize: 13, fontWeight: '500', marginTop: 1 },
  chatToastAction: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  chatTabRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  unreadBadge: {
    backgroundColor: '#18181b',
    borderRadius: 999,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: { color: '#ffffff', fontSize: 10, fontWeight: '700' },
  stackBtn: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  stackBtnText: {
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
  },
  stackDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
  },
  bottomWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: 12,
  },
  floatingCtaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
  },
  floatingCirclePill: {
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  floatingCircleText: {
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
  },
  floatingSpacer: {
    width: 72,
  },
  mintCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 12,
    shadowColor: '#0f172a',
    shadowOpacity: 0.16,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
  mintCtaTracking: {
    backgroundColor: '#ffffff',
    borderWidth: 1.5,
    borderColor: '#18181b',
  },
  mintCtaDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#ffffff',
  },
  mintCtaDotActive: {
    backgroundColor: '#18181b',
  },
  mintCtaText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  mintCtaTextActive: {
    color: '#18181b',
  },
  bottomSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 10,
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -4 },
    elevation: 10,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#e2e8f0',
  },
  sheetSummary: {
    textAlign: 'center',
    color: '#18181b',
    fontSize: 15,
    fontWeight: '700',
  },
  memberStrip: {
    gap: 8,
    paddingVertical: 2,
  },
  memberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  memberChipDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  memberChipText: {
    color: '#18181b',
    fontSize: 12,
    fontWeight: '600',
  },
  tabBar: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 4,
  },
  tabItem: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabItemActive: {
    backgroundColor: '#f1f5f9',
  },
  tabLabel: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: '#18181b',
    fontWeight: '700',
  },
  modalWrap: { flex: 1, backgroundColor: '#eef3f6', paddingTop: 52 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { color: '#18181b', fontSize: 18, fontWeight: '700' },
  modalSubtitle: { color: '#64748b', fontSize: 12 },
  closePill: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  closeText: { color: '#18181b', fontSize: 13, fontWeight: '700' },
  chatList: { flex: 1 },
  chatListContent: { padding: 16, gap: 10 },
  chatBubble: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chatSender: { color: '#18181b', fontSize: 11, fontWeight: '700', marginBottom: 3 },
  chatBody: { color: '#18181b', fontSize: 14 },
  chatComposer: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 28,
    gap: 8,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#18181b',
    fontSize: 14,
  },
  sendBtn: {
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  sendBtnText: { color: '#ffffff', fontWeight: '700', fontSize: 13 },
  settingsScroll: { padding: 16, gap: 14, paddingBottom: 40 },
  settingsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e4e4e7',
    padding: 16,
    gap: 10,
  },
  avatarPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 4,
  },
  settingsAvatarCircle: {
    width: 60,
    height: 60,
    borderRadius: 999,
    backgroundColor: '#18181b',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsAvatarImg: { width: '100%', height: '100%' },
  settingsAvatarInitial: { color: '#ffffff', fontSize: 22, fontWeight: '700' },
  avatarMeta: { flex: 1, gap: 4 },
  settingsSectionTitle: { color: '#18181b', fontSize: 14, fontWeight: '700' },
  settingsHint: { color: '#71717a', fontSize: 12 },
  removePhotoBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#f4f4f5',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 2,
  },
  removePhotoText: { color: '#18181b', fontSize: 11, fontWeight: '600' },
  fieldLabel: { color: '#71717a', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  fieldInput: {
    backgroundColor: '#fafafa',
    borderColor: '#e4e4e7',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#18181b',
    fontSize: 14,
  },
  errorText: { color: '#be123c', fontSize: 12, fontWeight: '600' },
  successText: { color: '#18181b', fontSize: 12, fontWeight: '600' },
  primaryBlackBtn: {
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryBlackText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  outlineBlackBtn: {
    backgroundColor: '#ffffff',
    borderColor: '#18181b',
    borderWidth: 1.5,
    borderRadius: 999,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 4,
  },
  outlineBlackText: { color: '#18181b', fontSize: 13, fontWeight: '700' },
  signOutFullBtn: {
    backgroundColor: '#ffffff',
    borderColor: '#fecdd3',
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 13,
    alignItems: 'center',
  },
  signOutFullText: { color: '#be123c', fontSize: 13, fontWeight: '700' },
  scannerFull: { flex: 1, backgroundColor: '#000000' },
  scannerOverlayBar: {
    position: 'absolute',
    bottom: 48,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(24, 24, 27, 0.92)',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  scannerOverlayText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  headerTitleFlex: { flex: 1, paddingRight: 12 },
  previewGroupName: { color: '#18181b', fontSize: 18, fontWeight: '700' },
  skipPromptText: { color: '#18181b', fontSize: 12, fontWeight: '700', textAlign: 'center' },
});
