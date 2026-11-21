import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { Camera, type CameraRef, GeoJSONSource, Layer, Map, Marker } from '@maplibre/maplibre-react-native';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { io, Socket } from 'socket.io-client';
import {
  buildExternalMapsUrls,
  buildGeodesicCircleRing,
  DEFAULT_EXACT_HALO_COLOR,
  DEFAULT_FUZZ_CIRCLE_COLOR,
  DEFAULT_FUZZED_HALO_COLOR,
  findCoveringRegions,
  FUZZED_AREA_RADIUS_METERS,
  hexToRgba,
  isPointCoveredByRegions,
  isSafeAvatarUrl,
  isSafeHexColor,
  parseInviteInput,
  withMinDelay,
  type AppVersionInfo,
  type ChatMessage,
  type GroupRole,
  type LocationBroadcast,
  type LocationShareLinkItem,
  type MapDownloadJob,
  type MapRegion,
  type PrivacyMode,
} from '@loved-ones/shared';
import {
  checkMobileAppVersion,
  formatAppUpdateNotice,
  INSTALLED_APP_VERSION,
} from '../services/appVersion';

const MOBILE_COLOR_PRESETS = ['#f59e0b', '#0ea5e9', '#10b981', '#8b5cf6', '#f43f5e', '#18181b'];
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
  deleteCachedRegionPmtiles,
  downloadOfflineRegionPmtilesWithProgress,
  estimateOfflineRegionSize,
  formatCacheBytes,
  getCachedRegionPmtilesInfo,
  getCachedRegionPmtilesUri,
  type MapLabelLanguage,
  type OfflineCacheInfo,
  type OfflineDownloadProgress,
  resolveMobileMapTheme,
} from '../services/pmtilesStyle';
import { groupChatMessagesForDisplay } from '../services/chatFormatting';
import { formatUserError } from '../services/errorFormatter';
import { useSafeAreaInsets } from '../services/safeArea';
import {
  clearSessionConfig,
  getMapThemePreference,
  type MobileMapThemePreference,
  MobileStoredConfig,
  saveMapThemePreference,
  saveStoredConfig,
} from '../services/secureConfig';
import {
  createMobileShareLink,
  listMobileShareLinks,
  resolveMobileShareUrl,
  revokeMobileShareLink,
} from '../services/shareLinks';
import { sendLocalNotification } from '../services/notifications';
import { Vibration } from 'react-native';

interface GroupSummary {
  id: string;
  name: string;
  myPrivacy: PrivacyMode;
}

interface MobileMapScreenProps {
  config: MobileStoredConfig;
  onSignedOut: (removedMessage?: string) => void;
}

export function MobileMapScreen({ config, onSignedOut }: MobileMapScreenProps) {
  const insets = useSafeAreaInsets();
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

  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(null);
  const [dismissedAppUpdateVersion, setDismissedAppUpdateVersion] = useState<string | null>(null);
  const alertedUpdateVersionRef = useRef<string | null>(null);

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
  const [editHaloColor, setEditHaloColor] = useState<string | null>(
    config.user?.haloColor ?? null,
  );
  const [editFuzzCircleColor, setEditFuzzCircleColor] = useState<string | null>(
    config.user?.fuzzCircleColor ?? null,
  );
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const [recoveryEmailInput, setRecoveryEmailInput] = useState(
    config.user?.recoveryEmail ?? '',
  );
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [recoveryCodeSentTo, setRecoveryCodeSentTo] = useState<string | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<'send' | 'verify' | 'clear' | null>(null);
  const recoveryBusy = recoveryAction !== null;
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);

  const [privacySavingMode, setPrivacySavingMode] = useState<PrivacyMode | null>(null);
  const [syncingBusy, setSyncingBusy] = useState(false);
  const [cachingOffline, setCachingOffline] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<OfflineCacheInfo | null>(null);
  const [offlineModalOpen, setOfflineModalOpen] = useState(false);
  const [estimatedRegionBytes, setEstimatedRegionBytes] = useState<number | null>(null);
  const [estimatingSize, setEstimatingSize] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<OfflineDownloadProgress | null>(null);
  const [menuModalOpen, setMenuModalOpen] = useState(false);
  const [privacySheetOpen, setPrivacySheetOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareLinks, setShareLinks] = useState<LocationShareLinkItem[]>([]);
  const [shareDurationMinutes, setShareDurationMinutes] = useState(60);
  const [shareLabelInput, setShareLabelInput] = useState('');
  const [shareAllowMutual, setShareAllowMutual] = useState(true);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  const [tracking, setTracking] = useState(false);
  const [selfCoord, setSelfCoord] = useState<[number, number] | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [labelLanguage, setLabelLanguage] = useState<MapLabelLanguage>('en');
  const systemColorScheme = useColorScheme();
  const [mapThemePreference, setMapThemePreference] = useState<MobileMapThemePreference>('system');
  const resolvedMapTheme = resolveMobileMapTheme(mapThemePreference, systemColorScheme);
  const [queuedCount, setQueuedCount] = useState(0);
  const [localPmtilesUri, setLocalPmtilesUri] = useState<string | null>(null);
  const [mapRegions, setMapRegions] = useState<MapRegion[]>([]);
  const [mapRegionsLoaded, setMapRegionsLoaded] = useState(false);
  const [activeMapJob, setActiveMapJob] = useState<MapDownloadJob | null>(null);
  const [dismissedUncoveredKey, setDismissedUncoveredKey] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [permissionInfo, setPermissionInfo] = useState<LocationPermissionResult | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const cameraRef = useRef<CameraRef | null>(null);
  const chatScrollRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null);
  const offlineAbortRef = useRef<AbortController | null>(null);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  );

  const selectedMember = useMemo(
    () => (selectedMemberId ? locations.find((l) => l.userId === selectedMemberId) ?? null : null),
    [locations, selectedMemberId],
  );

  const handleSelectMember = useCallback((loc: LocationBroadcast) => {
    setSelectedMemberId(loc.userId);
    cameraRef.current?.flyTo({
      center: [loc.longitude, loc.latitude],
      zoom: 14.5,
      duration: 550,
    });
  }, []);

  const handleOpenInDefaultMaps = useCallback(async (loc: LocationBroadcast) => {
    const label = loc.isFuzzed ? `${loc.username} (~1km)` : loc.username;
    const urls = buildExternalMapsUrls({
      latitude: loc.latitude,
      longitude: loc.longitude,
      label,
      platformOs: Platform.OS,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      isNativeApp: true,
    });
    try {
      const canOpenPrimary = await Linking.canOpenURL(urls.primaryUrl);
      await Linking.openURL(canOpenPrimary ? urls.primaryUrl : urls.fallbackUrl);
    } catch {
      try {
        await Linking.openURL(urls.fallbackUrl);
      } catch (err) {
        setStatusBanner(formatUserError(err, 'Could not open external Maps app'));
      }
    }
  }, []);

  const refreshShareLinks = useCallback(async () => {
    if (!serverUrl || !accessToken) return;
    try {
      const list = await listMobileShareLinks(serverUrl, accessToken);
      setShareLinks(list);
    } catch {
      // ignore background refresh error
    }
  }, [serverUrl, accessToken]);

  const handleOpenShareLinksModal = useCallback(() => {
    setMenuModalOpen(false);
    setShareError(null);
    setShareModalOpen(true);
    void refreshShareLinks();
  }, [refreshShareLinks]);

  const handleCreateMobileShareLink = useCallback(async () => {
    if (!serverUrl || !accessToken || !activeGroup) return;
    setShareError(null);
    setShareBusy(true);
    try {
      const created = await createMobileShareLink(serverUrl, accessToken, {
        groupId: activeGroup.id,
        durationMinutes: shareDurationMinutes,
        label: shareLabelInput.trim() || undefined,
        allowGuestSharing: shareAllowMutual,
      });
      setShareLinks((prev) => [created, ...prev]);
      setShareLabelInput('');
    } catch (err) {
      setShareError(formatUserError(err, 'Failed to create share link'));
    } finally {
      setShareBusy(false);
    }
  }, [serverUrl, accessToken, activeGroup, shareDurationMinutes, shareLabelInput, shareAllowMutual]);

  const handleShareNativeLink = useCallback(
    async (item: LocationShareLinkItem) => {
      const url = resolveMobileShareUrl(serverUrl, item);
      try {
        await Share.share({
          message: item.label ? `${item.label}: ${url}` : url,
          url,
        });
      } catch (err) {
        setShareError(formatUserError(err, 'Unable to open share sheet'));
      }
    },
    [serverUrl],
  );

  const handleRevokeMobileShareLink = useCallback(
    async (token: string) => {
      if (!serverUrl || !accessToken) return;
      setShareError(null);
      setShareBusy(true);
      try {
        await revokeMobileShareLink(serverUrl, accessToken, token);
        setShareLinks((prev) => prev.filter((l) => l.token !== token));
      } catch (err) {
        setShareError(formatUserError(err, 'Failed to revoke share link'));
      } finally {
        setShareBusy(false);
      }
    },
    [serverUrl, accessToken],
  );

  const useCompositeServerTiles = useMemo(() => {
    const operational = mapRegions.filter((r) => !r.isStub);
    return operational.length > 1 || operational.some((r) => !r.isPrimary);
  }, [mapRegions]);

  const mapStyle = useMemo(
    () =>
      buildMobileMapStyle(
        serverUrl,
        localPmtilesUri,
        labelLanguage,
        useCompositeServerTiles,
        resolvedMapTheme,
      ),
    [serverUrl, localPmtilesUri, labelLanguage, useCompositeServerTiles, resolvedMapTheme],
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
    void getCachedRegionPmtilesInfo()
      .then((info) => {
        setCacheInfo(info);
        setLocalPmtilesUri(info.exists ? info.uri : null);
      })
      .catch(() => {
        void getCachedRegionPmtilesUri().then(setLocalPmtilesUri).catch(() => {});
      });
    void refreshQueueCount().catch(() => {});
    void getMapThemePreference().then(setMapThemePreference).catch(() => {});
  }, [refreshQueueCount]);

  useEffect(() => {
    if (!statusBanner) return;
    const timer = setTimeout(() => {
      setStatusBanner(null);
    }, 4200);
    return () => clearTimeout(timer);
  }, [statusBanner]);

  useEffect(() => {
    if (!chatOpen) return;
    const timer = setTimeout(() => {
      chatScrollRef.current?.scrollToEnd({ animated: true });
    }, 80);
    return () => clearTimeout(timer);
  }, [chatOpen, messages.length]);

  const chatDisplayItems = useMemo(
    () => groupChatMessagesForDisplay(messages, userProfile?.id),
    [messages, userProfile?.id],
  );

  const checkServerAppVersion = useCallback(
    async (manual = false) => {
      if (!serverUrl) return;
      const platform = Platform.OS === 'ios' ? 'ios' : 'android';
      const info = await checkMobileAppVersion(
        serverUrl,
        INSTALLED_APP_VERSION,
        platform,
      ).catch(() => null);
      if (!info) {
        if (manual) setStatusBanner('Unable to check app updates right now');
        return;
      }
      setAppVersionInfo(info);
      if (info.updateAvailable) {
        if (alertedUpdateVersionRef.current !== info.latestMobileVersion || manual) {
          alertedUpdateVersionRef.current = info.latestMobileVersion;
          const notice = formatAppUpdateNotice(info, INSTALLED_APP_VERSION);
          Alert.alert(notice.title, notice.body, [
            ...(info.updateRequired ? [] : [{ text: 'Later', style: 'cancel' as const }]),
            ...(info.downloadUrl
              ? [
                  {
                    text: 'Download Update',
                    onPress: () => {
                      void Linking.openURL(info.downloadUrl!).catch(() => {});
                    },
                  },
                ]
              : []),
          ]);
        }
      } else if (manual) {
        setStatusBanner(`App is up to date (v${INSTALLED_APP_VERSION})`);
      }
    },
    [serverUrl],
  );

  useEffect(() => {
    void checkServerAppVersion(false);
    void authedFetch('/api/auth/me').catch(() => {});
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void checkServerAppVersion(false);
        void authedFetch('/api/auth/me').catch(() => {});
      }
    });
    return () => sub.remove();
  }, [checkServerAppVersion]);

  async function handleRequestPermissions() {
    try {
      const perm = await requestLocationPermissionsOnLaunch();
      setPermissionInfo(perm);
      setStatusBanner(perm.label);
    } catch (err) {
      setStatusBanner(formatUserError(err, 'Unable to request location permission'));
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
        setEditHaloColor(data.user.haloColor ?? null);
        setEditFuzzCircleColor(data.user.fuzzCircleColor ?? null);
        void saveStoredConfig({ user: data.user });
      })
      .catch(() => {});

    void fetchGroups().catch(() => {});
    void fetch(`${serverUrl}/api/maps/regions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { regions?: MapRegion[]; jobs?: MapDownloadJob[] } | null) => {
        if (!data) return;
        if (data.regions) {
          setMapRegions(data.regions);
          setMapRegionsLoaded(true);
        }
        const running = data.jobs?.find(
          (j) => j.status === 'queued' || j.status === 'resolving' || j.status === 'downloading',
        );
        if (running) setActiveMapJob(running);
      })
      .catch(() => {});
  }, [serverUrl, accessToken, fetchGroups]);

  useEffect(() => {
    if (!serverUrl || !accessToken || !activeMapJob) return;
    if (activeMapJob.status === 'completed' || activeMapJob.status === 'failed') return;
    const timer = setInterval(() => {
      void fetch(`${serverUrl}/api/maps/jobs/${activeMapJob.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { job?: MapDownloadJob } | null) => {
          if (!data?.job) return;
          setActiveMapJob(data.job);
          if (data.job.status === 'completed') {
            setStatusBanner(`Map ready: ${data.job.cityName}`);
            setActiveMapJob(null);
            void fetch(`${serverUrl}/api/maps/regions`)
              .then((rr) => (rr.ok ? rr.json() : null))
              .then((rdata: { regions?: MapRegion[] } | null) => {
                if (rdata?.regions) setMapRegions(rdata.regions);
              })
              .catch(() => {});
          } else if (data.job.status === 'failed') {
            setStatusBanner(data.job.error ?? 'City map download failed');
            setActiveMapJob(null);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [serverUrl, accessToken, activeMapJob]);

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

    const handleRemoteAccountRemoval = async (
      reason = 'Your account was removed from the server by an administrator.',
    ) => {
      await stopBackgroundTracking().catch(() => {});
      await clearSessionConfig();
      Vibration.vibrate(180);
      void sendLocalNotification('Account Removed', reason);
      onSignedOut(reason);
    };

    socket.on('connect', () => {
      void checkServerAppVersion(false);
    });

    socket.on('connect_error', (err) => {
      if (err instanceof Error && err.message === 'ACCOUNT_REMOVED') {
        void handleRemoteAccountRemoval();
      }
    });

    socket.on('account:removed', (evt: { reason?: string }) => {
      void handleRemoteAccountRemoval(evt?.reason);
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
      (evt: {
        userId: string;
        username: string;
        avatarUrl: string | null;
        haloColor?: string | null;
        fuzzCircleColor?: string | null;
      }) => {
        setLocations((prev) =>
          prev.map((loc) =>
            loc.userId === evt.userId
              ? {
                  ...loc,
                  username: evt.username,
                  avatarUrl: evt.avatarUrl,
                  haloColor: evt.haloColor ?? null,
                  fuzzCircleColor: evt.fuzzCircleColor ?? null,
                }
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
      setStatusBanner(formatUserError(err, 'Unable to toggle location tracking'));
    }
  }

  async function handlePingAndSync() {
    if (syncingBusy) return;
    setSyncingBusy(true);
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        setStatusBanner('Location permission required');
        return;
      }
      const result = await withMinDelay(captureFocusAndSyncPosition(), 450);
      if (result) {
        setStatusBanner(`Synced ${result.flushed} points (${result.remaining} queued)`);
      }
    } catch (err) {
      await refreshQueueCount();
      setStatusBanner(formatUserError(err, 'Saved offline — unable to reach server right now.'));
    } finally {
      setSyncingBusy(false);
    }
  }

  async function handlePrivacyChange(mode: PrivacyMode) {
    if (!activeGroup || privacySavingMode) return;
    setPrivacySavingMode(mode);
    try {
      await withMinDelay(async () => {
        const res = await authedFetch(`/api/auth/groups/${activeGroup.id}/privacy`, {
          method: 'PATCH',
          body: JSON.stringify({ privacy: mode }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      });
      setGroups((prev) =>
        prev.map((g) => (g.id === activeGroup.id ? { ...g, myPrivacy: mode } : g)),
      );
      setPrivacySheetOpen(false);
      setStatusBanner(`Sharing mode: ${mode}`);
    } catch (err) {
      setStatusBanner(formatUserError(err, 'Failed to switch sharing mode'));
    } finally {
      setPrivacySavingMode(null);
    }
  }

  const targetCacheRegion = useMemo(() => {
    const targetLat = selfCoord?.[1] ?? locations[0]?.latitude;
    const targetLon = selfCoord?.[0] ?? locations[0]?.longitude;
    if (targetLat !== undefined && targetLon !== undefined) {
      const match = findCoveringRegions(targetLat, targetLon, mapRegions)[0];
      if (match) return match;
    }
    return mapRegions.find((r) => !r.isStub) ?? mapRegions[0] ?? null;
  }, [selfCoord, locations, mapRegions]);

  async function openOfflineCacheModal() {
    setOfflineModalOpen(true);
    const info = await getCachedRegionPmtilesInfo().catch(() => null);
    if (info) {
      setCacheInfo(info);
      setLocalPmtilesUri(info.exists ? info.uri : null);
    }
    if (!serverUrl) return;
    setEstimatingSize(true);
    try {
      const estimated = await estimateOfflineRegionSize(
        serverUrl,
        targetCacheRegion?.url ?? '/tiles/region.pmtiles',
        targetCacheRegion?.sizeBytes ?? null,
      );
      setEstimatedRegionBytes(estimated);
    } finally {
      setEstimatingSize(false);
    }
  }

  async function handleCacheOfflineMap() {
    if (cachingOffline || !serverUrl) return;
    const controller = new AbortController();
    offlineAbortRef.current = controller;
    setCachingOffline(true);
    setDownloadProgress({
      bytesWritten: 0,
      totalBytes: estimatedRegionBytes ?? targetCacheRegion?.sizeBytes ?? 0,
      percent: 0,
    });
    try {
      const result = await withMinDelay(
        downloadOfflineRegionPmtilesWithProgress({
          serverUrl,
          regionUrl: targetCacheRegion?.url ?? '/tiles/region.pmtiles',
          expectedBytes: estimatedRegionBytes ?? targetCacheRegion?.sizeBytes ?? null,
          signal: controller.signal,
          onProgress: (progress) => setDownloadProgress(progress),
        }),
      );
      setLocalPmtilesUri(result.uri);
      const refreshed = await getCachedRegionPmtilesInfo().catch(() => null);
      setCacheInfo(
        refreshed ?? {
          exists: true,
          uri: result.uri,
          sizeBytes: result.sizeBytes,
          lastModified: Date.now(),
        },
      );
      setStatusBanner(
        `Cached ${targetCacheRegion?.displayName ?? targetCacheRegion?.name ?? 'regional'} map (${formatCacheBytes(result.sizeBytes)})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/cancelled/i.test(msg)) {
        setStatusBanner('Offline map download cancelled');
      } else {
        setStatusBanner(formatUserError(err, 'Unable to download offline map right now.'));
      }
    } finally {
      offlineAbortRef.current = null;
      setCachingOffline(false);
      setDownloadProgress(null);
    }
  }

  function handleCancelOfflineDownload() {
    offlineAbortRef.current?.abort();
  }

  async function handleDeleteCachedMap() {
    try {
      await deleteCachedRegionPmtiles();
      setLocalPmtilesUri(null);
      setCacheInfo({ exists: false, uri: null, sizeBytes: 0, lastModified: null });
      setStatusBanner('Removed cached offline map');
    } catch (err) {
      setStatusBanner(formatUserError(err, 'Unable to remove cached offline map.'));
    }
  }

  const uncoveredMobileTarget = useMemo(() => {
    if (!mapRegionsLoaded) return null;
    if (selfCoord && !isPointCoveredByRegions(selfCoord[1], selfCoord[0], mapRegions)) {
      return {
        latitude: selfCoord[1],
        longitude: selfCoord[0],
        key: `${selfCoord[1].toFixed(1)},${selfCoord[0].toFixed(1)}`,
      };
    }
    const firstMember = locations[0];
    if (firstMember && !isPointCoveredByRegions(firstMember.latitude, firstMember.longitude, mapRegions)) {
      return {
        latitude: firstMember.latitude,
        longitude: firstMember.longitude,
        key: `${firstMember.latitude.toFixed(1)},${firstMember.longitude.toFixed(1)}`,
      };
    }
    return null;
  }, [mapRegionsLoaded, mapRegions, selfCoord, locations]);

  async function handleRequestServerCityMap(latitude: number, longitude: number) {
    if (!serverUrl || !accessToken) return;
    try {
      const res = await fetch(`${serverUrl}/api/maps/download`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ latitude, longitude }),
      });
      const data = (await res.json()) as {
        alreadyCovered?: boolean;
        job?: MapDownloadJob;
        regions?: MapRegion[];
        error?: string;
      };
      if (!res.ok) {
        setStatusBanner(data.error ?? 'Failed to request city map');
        return;
      }
      if (data.alreadyCovered && data.regions) {
        setMapRegions(data.regions);
        setStatusBanner('City map is already cached on the server');
        return;
      }
      if (data.job) {
        setActiveMapJob(data.job);
      }
    } catch (err) {
      setStatusBanner(formatUserError(err, 'Failed to request city map'));
    }
  }

  async function handleCheckOta() {
    try {
      const res = await checkForOtaUpdate();
      setStatusBanner(res.message);
      await checkServerAppVersion(!res.updated);
    } catch {
      await checkServerAppVersion(true);
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
      const data = await withMinDelay(async () => {
        const res = await fetch(
          `${targetServer}/api/auth/invites/${encodeURIComponent(parsed.inviteToken)}`,
        );
        const body = (await res.json()) as {
          error?: string;
          token?: string;
          groupId?: string;
          groupName?: string;
          assignedRole?: GroupRole;
          valid?: boolean;
        };
        if (!res.ok || !body.token || !body.groupName) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body;
      });
      setQrPreview({
        token: data.token!,
        groupId: data.groupId ?? '',
        groupName: data.groupName!,
        assignedRole: data.assignedRole ?? 'MEMBER',
        valid: Boolean(data.valid),
      });
    } catch (err) {
      setQrPreview(null);
      setQrError(
        formatUserError(err, 'Invalid invite code or QR format. Please scan a valid LovedOnes invite.'),
      );
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
      const data = await withMinDelay(async () => {
        const res = await authedFetch('/api/auth/join', {
          method: 'POST',
          body: JSON.stringify({ inviteToken: qrPreview.token }),
        });
        const body = (await res.json()) as { error?: string; groupId?: string; groupName?: string };
        if (!res.ok || !body.groupId) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return { groupId: body.groupId, groupName: body.groupName };
      });
      setInvitePromptDismissed(true);
      await fetchGroups();
      setActiveGroupId(data.groupId);
      await saveStoredConfig({ activeGroupId: data.groupId });
      socketRef.current?.emit('group:join', data.groupId);
      setStatusBanner(`Joined ${data.groupName ?? qrPreview.groupName}`);
      setJoinQrOpen(false);
      setJoinIsPrompt(false);
    } catch (err) {
      setQrError(formatUserError(err, 'Failed to join group'));
    } finally {
      setQrLoading(false);
    }
  }

  function openAccountModal() {
    setEditUsername(userProfile?.username ?? '');
    setEditEmail(userProfile?.email ?? '');
    setEditAvatarUrl(userProfile?.avatarUrl ?? '');
    setEditHaloColor(userProfile?.haloColor ?? null);
    setEditFuzzCircleColor(userProfile?.fuzzCircleColor ?? null);
    setAccountError(null);
    setAccountMessage(null);
    setPasswordError(null);
    setPasswordMessage(null);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setRecoveryEmailInput(userProfile?.recoveryEmail ?? '');
    setRecoveryCodeInput('');
    setRecoveryCodeSentTo(null);
    setRecoveryError(null);
    setRecoveryMessage(null);
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
    if (res.status === 401) {
      const cloned = (await res.clone().json().catch(() => null)) as {
        code?: string;
        error?: string;
      } | null;
      if (cloned?.code === 'ACCOUNT_REMOVED') {
        await stopBackgroundTracking().catch(() => {});
        await clearSessionConfig();
        const reason =
          cloned.error ?? 'Your account was removed from the server by an administrator.';
        Vibration.vibrate(180);
        void sendLocalNotification('Account Removed', reason);
        onSignedOut(reason);
        return res;
      }
    }
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
        const refreshErr = (await refreshRes.clone().json().catch(() => null)) as {
          code?: string;
          error?: string;
        } | null;
        await stopBackgroundTracking().catch(() => {});
        await clearSessionConfig();
        if (refreshErr?.code === 'ACCOUNT_REMOVED') {
          const reason =
            refreshErr.error ?? 'Your account was removed from the server by an administrator.';
          Vibration.vibrate(180);
          void sendLocalNotification('Account Removed', reason);
          onSignedOut(reason);
        } else {
          onSignedOut();
        }
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
      const data = await withMinDelay(async () => {
        const res = await authedFetch('/api/auth/me', {
          method: 'PATCH',
          body: JSON.stringify({
            username: editUsername.trim(),
            email: editEmail.trim(),
            avatarUrl: trimmedAvatar || null,
            haloColor: editHaloColor,
            fuzzCircleColor: editFuzzCircleColor,
          }),
        });
        const body = (await res.json()) as {
          error?: string;
          accessToken?: string;
          refreshToken?: string;
          user?: MobileStoredConfig['user'];
        };
        if (!res.ok || !body.user) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body;
      });
      setUserProfile(data.user!);
      if (data.accessToken) setAccessToken(data.accessToken);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      await saveStoredConfig({
        accessToken: data.accessToken ?? accessToken,
        refreshToken: data.refreshToken ?? refreshToken,
        user: data.user!,
      });
      setLocations((prev) =>
        prev.map((loc) =>
          loc.userId === data.user!.id
            ? {
                ...loc,
                username: data.user!.username,
                avatarUrl: data.user!.avatarUrl ?? null,
                haloColor: data.user!.haloColor ?? null,
                fuzzCircleColor: data.user!.fuzzCircleColor ?? null,
              }
            : loc,
        ),
      );
      setAccountMessage('Profile saved');
    } catch (err) {
      setAccountError(formatUserError(err, 'Unable to save profile'));
    } finally {
      setAccountBusy(false);
    }
  }

  async function handleSendRecoveryCode() {
    if (!serverUrl || !accessToken) return;
    const target = recoveryEmailInput.trim();
    if (!target) {
      setRecoveryError('Enter an email address to verify.');
      return;
    }
    setRecoveryError(null);
    setRecoveryMessage(null);
    setRecoveryAction('send');
    try {
      const data = await withMinDelay(async () => {
        const res = await authedFetch('/api/auth/recovery-email/send-code', {
          method: 'POST',
          body: JSON.stringify({ recoveryEmail: target }),
        });
        const body = (await res.json()) as {
          error?: string;
          recoveryEmail?: string;
          user?: MobileStoredConfig['user'];
        };
        if (!res.ok || !body.user) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body;
      });
      setUserProfile(data.user!);
      await saveStoredConfig({ user: data.user! });
      const sentEmail = data.recoveryEmail ?? target;
      setRecoveryEmailInput(sentEmail);
      setRecoveryCodeSentTo(sentEmail);
      setRecoveryMessage(`6-digit code sent to ${sentEmail}`);
    } catch (err) {
      setRecoveryError(formatUserError(err, 'Failed to send code'));
    } finally {
      setRecoveryAction(null);
    }
  }

  async function handleVerifyRecoveryEmail() {
    if (!serverUrl || !accessToken) return;
    const target = (recoveryCodeSentTo ?? recoveryEmailInput).trim();
    if (!target || !recoveryCodeInput.trim()) return;
    setRecoveryError(null);
    setRecoveryMessage(null);
    setRecoveryAction('verify');
    try {
      const data = await withMinDelay(async () => {
        const res = await authedFetch('/api/auth/recovery-email/verify', {
          method: 'POST',
          body: JSON.stringify({
            recoveryEmail: target,
            code: recoveryCodeInput.trim(),
          }),
        });
        const body = (await res.json()) as {
          error?: string;
          user?: MobileStoredConfig['user'];
        };
        if (!res.ok || !body.user) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body;
      });
      setUserProfile(data.user!);
      await saveStoredConfig({ user: data.user! });
      setRecoveryCodeInput('');
      setRecoveryCodeSentTo(null);
      setRecoveryMessage('Backup email verified!');
    } catch (err) {
      setRecoveryError(formatUserError(err, 'Failed to verify code'));
    } finally {
      setRecoveryAction(null);
    }
  }

  async function handleClearRecoveryEmail() {
    if (!serverUrl || !accessToken) return;
    setRecoveryError(null);
    setRecoveryMessage(null);
    setRecoveryAction('clear');
    try {
      const data = await withMinDelay(async () => {
        const res = await authedFetch('/api/auth/recovery-email', {
          method: 'DELETE',
        });
        const body = (await res.json()) as {
          error?: string;
          user?: MobileStoredConfig['user'];
        };
        if (!res.ok || !body.user) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body;
      });
      setUserProfile(data.user!);
      await saveStoredConfig({ user: data.user! });
      setRecoveryEmailInput('');
      setRecoveryCodeInput('');
      setRecoveryCodeSentTo(null);
      setRecoveryMessage('Backup email removed');
    } catch (err) {
      setRecoveryError(formatUserError(err, 'Unable to remove backup email'));
    } finally {
      setRecoveryAction(null);
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
      await withMinDelay(async () => {
        const res = await authedFetch('/api/auth/password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const body = (await res.json()) as { error?: string; updated?: boolean };
        if (!res.ok) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage('Password updated');
    } catch (err) {
      setPasswordError(formatUserError(err, 'Unable to change password'));
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
  const selfHaloColor = isSafeHexColor(userProfile?.haloColor)
    ? userProfile!.haloColor!
    : DEFAULT_EXACT_HALO_COLOR;

  const fuzzedZonesGeoJson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: locations
        .filter((loc) => loc.isFuzzed)
        .map((loc) => {
          const rawFuzz =
            loc.fuzzCircleColor ??
            (loc.userId === myUserId ? userProfile?.fuzzCircleColor : null) ??
            null;
          const color = isSafeHexColor(rawFuzz) ? rawFuzz : DEFAULT_FUZZ_CIRCLE_COLOR;
          return {
            type: 'Feature' as const,
            geometry: {
              type: 'Polygon' as const,
              coordinates: [
                buildGeodesicCircleRing(loc.longitude, loc.latitude, FUZZED_AREA_RADIUS_METERS),
              ],
            },
            properties: { userId: loc.userId, color },
          };
        }),
    }),
    [locations, myUserId, userProfile?.fuzzCircleColor],
  );

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: resolvedMapTheme === 'dark' ? '#0c141d' : '#cfe3ee' },
      ]}
    >
      <Map style={styles.map} mapStyle={mapStyle}>
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: centerCoord,
            zoom: 11,
          }}
        />
        <GeoJSONSource id="fuzzed-zones-src" data={fuzzedZonesGeoJson}>
          <Layer
            id="fuzzed-zones-fill"
            type="fill"
            paint={{
              'fill-color': ['get', 'color'],
              'fill-opacity': 0.14,
            }}
          />
          <Layer
            id="fuzzed-zones-outline"
            type="line"
            paint={{
              'line-color': ['get', 'color'],
              'line-width': 1.75,
              'line-opacity': 0.65,
              'line-dasharray': [3, 2],
            }}
          />
        </GeoJSONSource>
        {showSelfMarker && selfCoord && (
          <Marker id="self-live" lngLat={selfCoord}>
            <View style={styles.marker}>
              <Text style={styles.selfMarkerLabel}>You</Text>
              {selfAvatarUrl ? (
                <View style={[styles.avatarRingSelf, { borderColor: selfHaloColor }]}>
                  <Image source={{ uri: selfAvatarUrl }} style={styles.markerAvatarImg} />
                </View>
              ) : (
                <View
                  style={[
                    styles.selfMarkerHalo,
                    { backgroundColor: hexToRgba(selfHaloColor, 0.25) },
                  ]}
                >
                  <View style={[styles.selfMarkerDot, { backgroundColor: selfHaloColor }]} />
                </View>
              )}
            </View>
          </Marker>
        )}
        {locations.map((loc) => {
          const pinAvatar =
            loc.avatarUrl ?? (loc.userId === myUserId ? userProfile?.avatarUrl : null) ?? null;
          const safePinAvatar = isSafeAvatarUrl(pinAvatar) ? pinAvatar : null;
          const rawHalo =
            loc.haloColor ?? (loc.userId === myUserId ? userProfile?.haloColor : null) ?? null;
          const resolvedHalo = isSafeHexColor(rawHalo)
            ? rawHalo
            : loc.isFuzzed
              ? DEFAULT_FUZZED_HALO_COLOR
              : DEFAULT_EXACT_HALO_COLOR;
          return (
            <Marker key={loc.userId} id={loc.userId} lngLat={[loc.longitude, loc.latitude]}>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => handleSelectMember(loc)}
                style={styles.marker}
              >
                <Text style={styles.markerLabel}>
                  {loc.username}
                  {loc.isFuzzed ? ' (~1km)' : ''}
                </Text>
                {safePinAvatar ? (
                  <View style={[styles.avatarRing, { borderColor: resolvedHalo }]}>
                    <Image source={{ uri: safePinAvatar }} style={styles.markerAvatarImg} />
                  </View>
                ) : (
                  <View
                    style={[styles.markerHalo, { backgroundColor: hexToRgba(resolvedHalo, 0.24) }]}
                  >
                    <View style={[styles.markerDot, { backgroundColor: resolvedHalo }]} />
                  </View>
                )}
              </TouchableOpacity>
            </Marker>
          );
        })}
      </Map>

      {/* Decluttered Top Floating Capsule, Contextual Permission Banner & Unified Toast Slot */}
      <View
        style={[styles.topOverlay, { top: Math.max(insets.top + 8, 44) }]}
        pointerEvents="box-none"
      >
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
              {locations.length} {locations.length === 1 ? 'member' : 'members'} visible
            </Text>
          </View>
          {activeGroup && (
            <TouchableOpacity
              style={styles.privacyBadge}
              onPress={() => setPrivacySheetOpen(true)}
            >
              <View
                style={[
                  styles.privacyBadgeDot,
                  activeGroup.myPrivacy === 'EXACT'
                    ? styles.privacyDotExact
                    : activeGroup.myPrivacy === 'FUZZED'
                      ? styles.privacyDotFuzzed
                      : styles.privacyDotGhost,
                ]}
              />
              <Text style={styles.privacyBadgeText}>{activeGroup.myPrivacy}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.menuIconBtn}
            accessibilityLabel="Open quick menu"
            onPress={() => setMenuModalOpen(true)}
          >
            <View style={styles.menuIconBar} />
            <View style={styles.menuIconBar} />
            <View style={styles.menuIconBar} />
          </TouchableOpacity>
        </View>

        {permissionInfo?.level === 'denied' && (
          <TouchableOpacity
            onPress={() => void handleRequestPermissions()}
            style={[styles.chipPill, { alignSelf: 'flex-start', borderColor: '#fecdd3', backgroundColor: '#fff1f2' }]}
          >
            <Text style={[styles.chipPermText, { color: '#be123c' }]}>
              Location access needed · Tap to grant
            </Text>
          </TouchableOpacity>
        )}

        {/* Single Unified Non-Overlapping Toast Slot */}
        {(() => {
          const showAppUpdate = Boolean(
            appVersionInfo?.updateAvailable &&
              (appVersionInfo.updateRequired ||
                dismissedAppUpdateVersion !== appVersionInfo.latestMobileVersion),
          );
          if (showAppUpdate && appVersionInfo) {
            return (
              <View style={styles.chatToastBanner}>
                <View style={styles.chatToastTextWrap}>
                  <Text style={styles.chatToastSender} numberOfLines={1}>
                    {formatAppUpdateNotice(appVersionInfo, INSTALLED_APP_VERSION).title}
                  </Text>
                  <Text style={styles.chatToastBody} numberOfLines={1}>
                    {formatAppUpdateNotice(appVersionInfo, INSTALLED_APP_VERSION).body}
                  </Text>
                </View>
                {appVersionInfo.downloadUrl && (
                  <TouchableOpacity
                    onPress={() => {
                      void Linking.openURL(appVersionInfo.downloadUrl!).catch(() => {});
                    }}
                  >
                    <Text style={styles.chatToastAction}>Download</Text>
                  </TouchableOpacity>
                )}
                {!appVersionInfo.updateRequired && (
                  <TouchableOpacity
                    onPress={() =>
                      setDismissedAppUpdateVersion(appVersionInfo.latestMobileVersion)
                    }
                  >
                    <Text style={[styles.chatToastAction, { color: '#a1a1aa' }]}>Later</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          }

          if (chatBanner && !chatOpen) {
            return (
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
            );
          }

          if (activeMapJob) {
            return (
              <View style={styles.chatToastBanner}>
                <View style={styles.chatToastTextWrap}>
                  <Text style={styles.chatToastSender} numberOfLines={1}>
                    Downloading city map · {activeMapJob.progressPct}%
                  </Text>
                  <Text style={styles.chatToastBody} numberOfLines={1}>
                    {activeMapJob.message ?? activeMapJob.cityName}
                  </Text>
                </View>
              </View>
            );
          }

          if (uncoveredMobileTarget && dismissedUncoveredKey !== uncoveredMobileTarget.key) {
            return (
              <View style={styles.chatToastBanner}>
                <TouchableOpacity
                  activeOpacity={0.9}
                  style={styles.chatToastTextWrap}
                  onPress={() =>
                    void handleRequestServerCityMap(
                      uncoveredMobileTarget.latitude,
                      uncoveredMobileTarget.longitude,
                    )
                  }
                >
                  <Text style={styles.chatToastSender} numberOfLines={1}>
                    No map behind coordinates
                  </Text>
                  <Text style={styles.chatToastBody} numberOfLines={1}>
                    Tap to download city tiles on server
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setDismissedUncoveredKey(uncoveredMobileTarget.key)}
                >
                  <Text style={styles.chatToastAction}>Dismiss</Text>
                </TouchableOpacity>
              </View>
            );
          }

          if (statusBanner) {
            return (
              <View style={styles.statusToast}>
                <Text style={styles.statusToastText} numberOfLines={1}>
                  {statusBanner}
                </Text>
              </View>
            );
          }

          return null;
        })()}
      </View>

      {/* Bottom Floating Controls & Safe-Area Bottom Sheet */}
      <View style={styles.bottomWrap} pointerEvents="box-none">
        {selectedMember && (
          <View style={styles.selectedMemberCard}>
            <View style={styles.selectedMemberInfo}>
              <View style={styles.selectedMemberHeader}>
                <Text style={styles.selectedMemberName} numberOfLines={1}>
                  {selectedMember.username}
                </Text>
                <View
                  style={[
                    styles.selectedMemberBadge,
                    selectedMember.isFuzzed
                      ? styles.selectedMemberBadgeFuzzed
                      : styles.selectedMemberBadgeExact,
                  ]}
                >
                  <Text
                    style={[
                      styles.selectedMemberBadgeText,
                      selectedMember.isFuzzed && styles.selectedMemberBadgeTextFuzzed,
                    ]}
                  >
                    {selectedMember.isFuzzed ? 'FUZZED · ~1km' : selectedMember.privacyMode}
                  </Text>
                </View>
              </View>
              <Text style={styles.selectedMemberCoords}>
                {selectedMember.latitude.toFixed(4)}, {selectedMember.longitude.toFixed(4)}
              </Text>
            </View>
            <View style={styles.selectedMemberActions}>
              <TouchableOpacity
                style={styles.openMapsBtn}
                onPress={() => void handleOpenInDefaultMaps(selectedMember)}
              >
                <Text style={styles.openMapsBtnText}>Open in Maps</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.dismissMemberBtn}
                accessibilityLabel="Close member actions"
                onPress={() => setSelectedMemberId(null)}
              >
                <Text style={styles.dismissMemberText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.floatingCtaRow} pointerEvents="box-none">
          <TouchableOpacity
            style={styles.floatingCircleBtn}
            disabled={syncingBusy}
            accessibilityLabel="Sync and center location"
            onPress={() => void handlePingAndSync()}
          >
            {syncingBusy ? (
              <ActivityIndicator size="small" color="#18181b" />
            ) : (
              <Text style={styles.floatingCircleIcon}>◎</Text>
            )}
            {queuedCount > 0 && (
              <View style={styles.floatingBadge}>
                <Text style={styles.floatingBadgeText}>
                  {queuedCount > 99 ? '99+' : queuedCount}
                </Text>
              </View>
            )}
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
            style={[styles.floatingCircleBtn, localPmtilesUri && styles.floatingCircleBtnActive]}
            accessibilityLabel="Offline map cache"
            onPress={() => void openOfflineCacheModal()}
          >
            {cachingOffline ? (
              <ActivityIndicator size="small" color="#18181b" />
            ) : (
              <Text style={styles.floatingCircleIcon}>{localPmtilesUri ? '✓' : '↓'}</Text>
            )}
          </TouchableOpacity>
        </View>

        <View
          style={[
            styles.bottomSheet,
            { paddingBottom: 14 },
          ]}
        >
          <View style={styles.sheetHandle} />

          {locations.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.memberStrip}
            >
              {locations.map((loc) => {
                const chipAvatar = isSafeAvatarUrl(loc.avatarUrl) ? loc.avatarUrl : null;
                const isSelected = selectedMemberId === loc.userId;
                return (
                  <TouchableOpacity
                    key={loc.userId}
                    activeOpacity={0.8}
                    onPress={() => handleSelectMember(loc)}
                    style={[styles.memberChip, isSelected && styles.memberChipSelected]}
                  >
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
                    <Text
                      style={[styles.memberChipText, isSelected && styles.memberChipTextSelected]}
                    >
                      {loc.username}
                      {loc.isFuzzed ? ' ~1km' : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          <View style={styles.tabBar}>
            <TouchableOpacity style={[styles.tabItem, styles.tabItemActive]}>
              <Text style={[styles.tabLabel, styles.tabLabelActive]}>⌖ Map</Text>
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
                <Text style={styles.tabLabel}>
                  💬 Chat{messages.length > 0 ? ` (${messages.length})` : ''}
                </Text>
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

      {/* Redesigned Group Chat Sheet Modal (Desktop Web Dashboard Parity) */}
      <Modal visible={chatOpen} animationType="slide" onRequestClose={() => setChatOpen(false)}>
        <View pointerEvents="box-none" style={styles.flexOne}>
        <View style={[styles.modalWrap, { paddingTop: Math.max(insets.top + 8, 48), marginBottom: insets.bottom }]}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>{activeGroup?.name ?? 'Group'} Chat</Text>
              <Text style={styles.modalSubtitle}>{messages.length} messages</Text>
            </View>
            <TouchableOpacity style={styles.closePill} onPress={() => setChatOpen(false)}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </View>

          <KeyboardAvoidingView
            style={styles.flexOne}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <ScrollView
              ref={chatScrollRef}
              style={styles.chatList}
              contentContainerStyle={styles.chatListContent}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => chatScrollRef.current?.scrollToEnd({ animated: true })}
            >
              {chatDisplayItems.length === 0 ? (
                <View style={styles.chatEmptyWrap}>
                  <Text style={styles.chatEmptyText}>
                    No messages yet. Say hello to {activeGroup?.name ?? 'your group'}!
                  </Text>
                </View>
              ) : (
                chatDisplayItems.map((item) => {
                  const avatarUri = isSafeAvatarUrl(item.message.senderAvatarUrl)
                    ? item.message.senderAvatarUrl
                    : null;
                  return (
                    <View key={item.message.id}>
                      {item.showDateSeparator && (
                        <View style={styles.dateSeparator}>
                          <Text style={styles.dateSeparatorText}>{item.dateLabel}</Text>
                        </View>
                      )}
                      <View
                        style={[
                          styles.chatMessageRow,
                          item.isMine ? styles.chatRowMine : styles.chatRowOther,
                        ]}
                      >
                        {!item.isMine && (
                          <View style={styles.chatAvatarSlot}>
                            {item.showSenderHeader ? (
                              avatarUri ? (
                                <Image source={{ uri: avatarUri }} style={styles.chatAvatarImg} />
                              ) : (
                                <View style={styles.chatAvatarFallback}>
                                  <Text style={styles.chatAvatarInitials}>
                                    {item.senderInitials}
                                  </Text>
                                </View>
                              )
                            ) : null}
                          </View>
                        )}

                        <View
                          style={[
                            styles.chatColumn,
                            item.isMine ? styles.chatColumnMine : styles.chatColumnOther,
                          ]}
                        >
                          {item.showSenderHeader && (
                            <Text style={styles.chatMetaHeader}>
                              {item.message.senderUsername} · {item.compactTime}
                            </Text>
                          )}
                          <View
                            style={[
                              styles.chatBubble,
                              item.isMine ? styles.chatBubbleMine : styles.chatBubbleOther,
                            ]}
                          >
                            <Text
                              style={[
                                styles.chatBody,
                                item.isMine ? styles.chatBodyMine : styles.chatBodyOther,
                              ]}
                            >
                              {item.message.content}
                            </Text>
                          </View>
                          {(item.isMine || !item.showSenderHeader) && item.compactTime ? (
                            <Text
                              style={[
                                styles.chatTimeFooter,
                                item.isMine && styles.chatTimeFooterMine,
                              ]}
                            >
                              {item.isMine ? `${item.compactTime} · Sent` : item.compactTime}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>

            <View
              style={[
                styles.chatComposer,
                { paddingBottom: 14 },
              ]}
            >
              <TextInput
                style={styles.chatInput}
                value={chatText}
                onChangeText={setChatText}
                placeholder={activeGroup ? 'Message group...' : 'Select a group'}
                placeholderTextColor="#71717a"
                returnKeyType="send"
                onSubmitEditing={handleSendChat}
              />
              <TouchableOpacity
                style={[
                  styles.sendIconBtn,
                  (!activeGroup || !chatText.trim()) && styles.sendIconBtnDisabled,
                ]}
                disabled={!activeGroup || !chatText.trim()}
                accessibilityLabel="Send message"
                onPress={handleSendChat}
              >
                <Text style={styles.sendBtnText}>↑</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </View>
        </View>
      </Modal>

      {/* Account Settings Modal */}
      <Modal
        visible={accountOpen}
        animationType="slide"
        onRequestClose={() => setAccountOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
        <View style={[styles.modalWrap, { paddingTop: Math.max(insets.top + 8, 48), marginBottom: insets.bottom }]}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>Account Settings</Text>
              <Text style={styles.modalSubtitle}>Profile photo, name, email & password</Text>
            </View>
            <TouchableOpacity style={styles.closePill} onPress={() => setAccountOpen(false)}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={[
              styles.settingsScroll,
              { paddingBottom: 24 },
            ]}
          >
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

              <Text style={styles.fieldLabel}>User Halo Color</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {MOBILE_COLOR_PRESETS.map((hex) => (
                  <TouchableOpacity
                    key={`mob-halo-${hex}`}
                    onPress={() => setEditHaloColor(hex)}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 999,
                      backgroundColor: hex,
                      borderWidth: editHaloColor?.toLowerCase() === hex ? 3 : 1.5,
                      borderColor: editHaloColor?.toLowerCase() === hex ? '#18181b' : '#ffffff',
                    }}
                  />
                ))}
                {editHaloColor && (
                  <TouchableOpacity onPress={() => setEditHaloColor(null)}>
                    <Text style={styles.removePhotoText}>Reset</Text>
                  </TouchableOpacity>
                )}
              </View>

              <Text style={styles.fieldLabel}>Fuzzed Circle Color</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {MOBILE_COLOR_PRESETS.map((hex) => (
                  <TouchableOpacity
                    key={`mob-fuzz-${hex}`}
                    onPress={() => setEditFuzzCircleColor(hex)}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 999,
                      backgroundColor: hex,
                      borderWidth: editFuzzCircleColor?.toLowerCase() === hex ? 3 : 1.5,
                      borderColor: editFuzzCircleColor?.toLowerCase() === hex ? '#18181b' : '#ffffff',
                    }}
                  />
                ))}
                {editFuzzCircleColor && (
                  <TouchableOpacity onPress={() => setEditFuzzCircleColor(null)}>
                    <Text style={styles.removePhotoText}>Reset</Text>
                  </TouchableOpacity>
                )}
              </View>

              {accountError && <Text style={styles.errorText}>{accountError}</Text>}
              {accountMessage && <Text style={styles.successText}>{accountMessage}</Text>}

              <TouchableOpacity
                style={[styles.primaryBlackBtn, accountBusy && styles.btnBusy]}
                disabled={accountBusy}
                onPress={() => void handleSaveProfile()}
              >
                {accountBusy && <ActivityIndicator size="small" color="#ffffff" />}
                <Text style={styles.primaryBlackText}>
                  {accountBusy ? 'Saving Profile...' : 'Save Profile'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.settingsCard}>
              <Text style={styles.settingsSectionTitle}>
                Backup Email ·{' '}
                {userProfile?.recoveryEmail && userProfile?.recoveryEmailVerified
                  ? 'Verified'
                  : userProfile?.recoveryEmail
                    ? 'Unverified'
                    : 'Not Set'}
              </Text>
              <Text style={styles.settingsHint}>
                Verify a backup email with a 6-digit code to enable Forgot Password recovery.
              </Text>

              <Text style={styles.fieldLabel}>Backup Email Address</Text>
              <TextInput
                style={styles.fieldInput}
                value={recoveryEmailInput}
                onChangeText={setRecoveryEmailInput}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder={userProfile?.email ?? 'backup@example.com'}
                placeholderTextColor="#94a3b8"
              />

              <TouchableOpacity
                style={[styles.primaryBlackBtn, recoveryBusy && styles.btnBusy]}
                disabled={recoveryBusy}
                onPress={() => void handleSendRecoveryCode()}
              >
                {recoveryAction === 'send' && <ActivityIndicator size="small" color="#ffffff" />}
                <Text style={styles.primaryBlackText}>
                  {recoveryAction === 'send' ? 'Sending...' : 'Send Verification Code'}
                </Text>
              </TouchableOpacity>

              {(recoveryCodeSentTo ||
                (userProfile?.recoveryEmail && !userProfile?.recoveryEmailVerified)) && (
                <>
                  <Text style={styles.fieldLabel}>6-Digit Code</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={recoveryCodeInput}
                    onChangeText={(t) => setRecoveryCodeInput(t.replace(/\D/g, '').slice(0, 6))}
                    keyboardType="number-pad"
                    maxLength={6}
                    placeholder="123456"
                    placeholderTextColor="#94a3b8"
                  />
                  <TouchableOpacity
                    style={[styles.outlineBlackBtn, recoveryBusy && styles.btnBusy]}
                    disabled={recoveryBusy || recoveryCodeInput.trim().length !== 6}
                    onPress={() => void handleVerifyRecoveryEmail()}
                  >
                    {recoveryAction === 'verify' && (
                      <ActivityIndicator size="small" color="#18181b" />
                    )}
                    <Text style={styles.outlineBlackText}>
                      {recoveryAction === 'verify' ? 'Verifying...' : 'Verify Email'}
                    </Text>
                  </TouchableOpacity>
                </>
              )}

              {Boolean(userProfile?.recoveryEmail) && (
                <TouchableOpacity
                  style={[styles.removePhotoBtn, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}
                  disabled={recoveryBusy}
                  onPress={() => void handleClearRecoveryEmail()}
                >
                  {recoveryAction === 'clear' && (
                    <ActivityIndicator size="small" color="#18181b" />
                  )}
                  <Text style={styles.removePhotoText}>
                    {recoveryAction === 'clear' ? 'Removing...' : 'Remove Backup Email'}
                  </Text>
                </TouchableOpacity>
              )}

              {recoveryError && <Text style={styles.errorText}>{recoveryError}</Text>}
              {recoveryMessage && <Text style={styles.successText}>{recoveryMessage}</Text>}
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
                style={[styles.outlineBlackBtn, passwordBusy && styles.btnBusy]}
                disabled={passwordBusy}
                onPress={() => void handleChangePassword()}
              >
                {passwordBusy && <ActivityIndicator size="small" color="#18181b" />}
                <Text style={styles.outlineBlackText}>
                  {passwordBusy ? 'Updating Password...' : 'Update Password'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.settingsCard}>
              <Text style={styles.settingsSectionTitle}>App Version</Text>
              <Text style={styles.settingsHint}>
                Installed build: v{INSTALLED_APP_VERSION}
                {appVersionInfo?.latestMobileVersion
                  ? ` · Server latest: v${appVersionInfo.latestMobileVersion}`
                  : ''}
              </Text>
              <TouchableOpacity
                style={styles.outlineBlackBtn}
                onPress={() => void checkServerAppVersion(true)}
              >
                <Text style={styles.outlineBlackText}>Check for App Update</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.signOutFullBtn}
              onPress={async () => {
                setAccountOpen(false);
                await stopBackgroundTracking().catch(() => {});
                await clearSessionConfig();
                onSignedOut();
              }}
            >
              <Text style={styles.signOutFullText}>Sign Out</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
        </View>
      </Modal>

      {/* Privacy Mode Popover Sheet Modal */}
      <Modal
        visible={privacySheetOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPrivacySheetOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
        <View style={[styles.sheetBackdrop, { marginBottom: insets.bottom }]}>
          <View
            style={[
              styles.sheetCard,
              { paddingBottom: 20 },
            ]}
          >
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.modalTitle}>Sharing Privacy</Text>
              <TouchableOpacity style={styles.closePill} onPress={() => setPrivacySheetOpen(false)}>
                <Text style={styles.closeText}>Done</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.settingsHint}>
              Choose how {activeGroup?.name ?? 'your group'} sees your live coordinates.
            </Text>

            {(
              [
                {
                  mode: 'EXACT' as PrivacyMode,
                  title: 'EXACT · Live pin',
                  desc: 'Shares your precise coordinates in this group.',
                },
                {
                  mode: 'FUZZED' as PrivacyMode,
                  title: 'FUZZED · ~1 km area',
                  desc: 'Shows an approximate ~1 km zone ring instead of exact coordinates.',
                },
                {
                  mode: 'GHOST' as PrivacyMode,
                  title: 'GHOST · Hidden',
                  desc: 'Hides your location pin and trails from this group.',
                },
              ] as const
            ).map((opt) => {
              const savingThis = privacySavingMode === opt.mode;
              const selected = activeGroup?.myPrivacy === opt.mode;
              return (
                <TouchableOpacity
                  key={opt.mode}
                  disabled={Boolean(privacySavingMode)}
                  style={[styles.sheetOptionBtn, selected && styles.sheetOptionSelected]}
                  onPress={() => void handlePrivacyChange(opt.mode)}
                >
                  <View style={styles.flexOne}>
                    <Text style={[styles.settingsSectionTitle, selected && { color: '#ffffff' }]}>
                      {opt.title}
                    </Text>
                    <Text style={[styles.settingsHint, selected && { color: '#d4d4d8' }]}>
                      {opt.desc}
                    </Text>
                  </View>
                  {savingThis && (
                    <ActivityIndicator size="small" color={selected ? '#ffffff' : '#18181b'} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        </View>
      </Modal>

      {/* Progressive Disclosure Quick Menu Sheet */}
      <Modal
        visible={menuModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuModalOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
        <View style={[styles.sheetBackdrop, { marginBottom: insets.bottom }]}>
          <View
            style={[
              styles.sheetCard,
              { paddingBottom: 20 },
            ]}
          >
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.modalTitle}>Quick Menu</Text>
              <TouchableOpacity style={styles.closePill} onPress={() => setMenuModalOpen(false)}>
                <Text style={styles.closeText}>Done</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={handleOpenShareLinksModal}
            >
              <View style={styles.flexOne}>
                <Text style={styles.settingsSectionTitle}>Guest Share Links</Text>
                <Text style={styles.settingsHint}>
                  Temporary meetup links (isolated from your group)
                </Text>
              </View>
              <Text style={styles.menuRowAction}>
                {shareLinks.length > 0 ? `${shareLinks.length} active →` : 'Create →'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuModalOpen(false);
                void openOfflineCacheModal();
              }}
            >
              <View style={styles.flexOne}>
                <Text style={styles.settingsSectionTitle}>Offline Map Cache</Text>
                <Text style={styles.settingsHint}>
                  {cacheInfo?.exists
                    ? `Cached (${formatCacheBytes(cacheInfo.sizeBytes)})`
                    : 'Download regional map tiles for offline use'}
                </Text>
              </View>
              <Text style={styles.menuRowAction}>Manage →</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuModalOpen(false);
                openJoinQrModal(false);
              }}
            >
              <View style={styles.flexOne}>
                <Text style={styles.settingsSectionTitle}>Join Group via QR</Text>
                <Text style={styles.settingsHint}>Scan or paste an invite token</Text>
              </View>
              <Text style={styles.menuRowAction}>Open →</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuModalOpen(false);
                openAccountModal();
              }}
            >
              <View style={styles.flexOne}>
                <Text style={styles.settingsSectionTitle}>Account & Appearance</Text>
                <Text style={styles.settingsHint}>Profile, halo colors, backup email & password</Text>
              </View>
              <Text style={styles.menuRowAction}>Open →</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setLabelLanguage((prev) => (prev === 'en' ? 'local' : 'en'));
              }}
            >
              <View style={styles.flexOne}>
                <Text style={styles.settingsSectionTitle}>Map Label Language</Text>
                <Text style={styles.settingsHint}>
                  Currently: {labelLanguage === 'en' ? 'English' : 'Local names'}
                </Text>
              </View>
              <Text style={styles.menuRowAction}>{labelLanguage === 'en' ? 'EN' : 'Local'}</Text>
            </TouchableOpacity>

            <View style={styles.menuRow}>
              <View style={styles.flexOne}>
                <Text style={styles.settingsSectionTitle}>Map Theme</Text>
                <Text style={styles.settingsHint}>
                  {mapThemePreference === 'system'
                    ? `Auto (${resolvedMapTheme === 'dark' ? 'Night' : 'Light'})`
                    : mapThemePreference === 'dark'
                      ? 'Night mode'
                      : 'Light mode'}
                </Text>
              </View>
              <View style={styles.themeSegmentGroup}>
                {(
                  [
                    ['system', 'Auto'],
                    ['light', 'Light'],
                    ['dark', 'Dark'],
                  ] as const
                ).map(([pref, label]) => {
                  const active = mapThemePreference === pref;
                  return (
                    <TouchableOpacity
                      key={pref}
                      style={[styles.themeSegmentBtn, active && styles.themeSegmentBtnActive]}
                      onPress={() => {
                        setMapThemePreference(pref);
                        void saveMapThemePreference(pref).catch(() => {});
                      }}
                    >
                      <Text
                        style={[
                          styles.themeSegmentText,
                          active && styles.themeSegmentTextActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuModalOpen(false);
                void handleCheckOta();
              }}
            >
              <View style={styles.flexOne}>
                <Text style={styles.settingsSectionTitle}>App & OTA Updates</Text>
                <Text style={styles.settingsHint}>Installed v{INSTALLED_APP_VERSION}</Text>
              </View>
              <Text style={styles.menuRowAction}>Check →</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuModalOpen(false);
                void handleRequestPermissions();
              }}
            >
              <View style={styles.flexOne}>
                <Text style={styles.settingsSectionTitle}>Location Permission</Text>
                <Text style={styles.settingsHint}>
                  {permissionInfo?.label ?? 'Tap to check location permissions'}
                </Text>
              </View>
              <Text style={styles.menuRowAction}>Verify →</Text>
            </TouchableOpacity>
          </View>
        </View>
        </View>
      </Modal>

      {/* Guest Share Links Modal */}
      <Modal
        visible={shareModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setShareModalOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
          <View style={[styles.sheetBackdrop, { marginBottom: insets.bottom }]}>
            <View style={[styles.sheetCard, { paddingBottom: 20 }]}>
              <View style={styles.sheetHeaderRow}>
                <Text style={styles.modalTitle}>Guest Share Links</Text>
                <TouchableOpacity style={styles.closePill} onPress={() => setShareModalOpen(false)}>
                  <Text style={styles.closeText}>Done</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.settingsHint}>
                People on the same link see only each other—never other group members.
              </Text>

              <TextInput
                style={styles.shareInput}
                value={shareLabelInput}
                onChangeText={setShareLabelInput}
                maxLength={80}
                placeholder="Label (optional, e.g. Meetup)"
                placeholderTextColor="#a1a1aa"
              />

              <View style={styles.themeSegmentGroup}>
                {(
                  [
                    [15, '15m'],
                    [60, '1h'],
                    [240, '4h'],
                    [1440, '24h'],
                  ] as const
                ).map(([mins, label]) => {
                  const active = shareDurationMinutes === mins;
                  return (
                    <TouchableOpacity
                      key={mins}
                      style={[
                        styles.themeSegmentBtn,
                        styles.flexOne,
                        { alignItems: 'center' },
                        active && styles.themeSegmentBtnActive,
                      ]}
                      onPress={() => setShareDurationMinutes(mins)}
                    >
                      <Text
                        style={[
                          styles.themeSegmentText,
                          active && styles.themeSegmentTextActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <TouchableOpacity
                style={styles.menuRow}
                onPress={() => setShareAllowMutual((v) => !v)}
              >
                <View style={styles.flexOne}>
                  <Text style={styles.settingsSectionTitle}>Mutual guest sharing</Text>
                  <Text style={styles.settingsHint}>
                    {shareAllowMutual
                      ? 'Guests can share their pins back on this link'
                      : 'View-only (only your pin is shown)'}
                  </Text>
                </View>
                <Text style={styles.menuRowAction}>{shareAllowMutual ? 'On' : 'Off'}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.openMapsBtn, { alignItems: 'center', paddingVertical: 11 }]}
                disabled={shareBusy || !activeGroup}
                onPress={() => void handleCreateMobileShareLink()}
              >
                <Text style={[styles.openMapsBtnText, { fontSize: 13 }]}>
                  {shareBusy ? 'Creating...' : 'Create Share Link'}
                </Text>
              </TouchableOpacity>

              {shareError && <Text style={styles.errorText}>{shareError}</Text>}

              <ScrollView style={{ maxHeight: 200 }} contentContainerStyle={{ gap: 8 }}>
                {shareLinks.map((item) => {
                  const shareUrl = resolveMobileShareUrl(serverUrl, item);
                  return (
                    <View key={item.token} style={styles.shareLinkCard}>
                      <View style={styles.flexOne}>
                        <Text style={styles.settingsSectionTitle} numberOfLines={1}>
                          {item.label ?? `${item.groupName} Share`}
                        </Text>
                        <Text style={styles.settingsHint} numberOfLines={1}>
                          {item.allowGuestSharing
                            ? `${item.activeGuestCount} guest${item.activeGuestCount === 1 ? '' : 's'} · ${new Date(item.expiresAt).toLocaleTimeString()}`
                            : `View-only · ends ${new Date(item.expiresAt).toLocaleTimeString()}`}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.openMapsBtn}
                        onPress={() => void handleShareNativeLink(item)}
                      >
                        <Text style={styles.openMapsBtnText}>Share</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.shareOpenBtn}
                        onPress={() => void Linking.openURL(shareUrl)}
                      >
                        <Text style={styles.shareOpenBtnText}>Open</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.shareRevokeBtn}
                        disabled={shareBusy}
                        onPress={() => void handleRevokeMobileShareLink(item.token)}
                      >
                        <Text style={styles.shareRevokeBtnText}>✕</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </View>
      </Modal>

      {/* Offline Map Cache Modal with Size Preview & Live Progress */}
      <Modal
        visible={offlineModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOfflineModalOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
        <View style={[styles.sheetBackdrop, { marginBottom: insets.bottom }]}>
          <View
            style={[
              styles.sheetCard,
              { paddingBottom: 20 },
            ]}
          >
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.modalTitle}>Offline Map Cache</Text>
              <TouchableOpacity
                style={styles.closePill}
                onPress={() => setOfflineModalOpen(false)}
              >
                <Text style={styles.closeText}>Done</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.settingsCard}>
              <Text style={styles.fieldLabel}>Target Region</Text>
              <Text style={styles.settingsSectionTitle}>
                {targetCacheRegion?.displayName ?? targetCacheRegion?.name ?? 'Primary Map Region'}
              </Text>
              <Text style={styles.settingsHint}>
                Estimated download size:{' '}
                {estimatingSize
                  ? 'Checking server...'
                  : estimatedRegionBytes
                    ? `~${formatCacheBytes(estimatedRegionBytes)}`
                    : 'Size reported on download start'}
              </Text>
            </View>

            {cachingOffline && downloadProgress && (
              <View style={styles.settingsCard}>
                <View style={styles.sheetHeaderRow}>
                  <Text style={styles.settingsSectionTitle}>
                    Downloading · {downloadProgress.percent}%
                  </Text>
                  <Text style={styles.settingsHint}>
                    {formatCacheBytes(downloadProgress.bytesWritten)}
                    {downloadProgress.totalBytes > 0
                      ? ` / ${formatCacheBytes(downloadProgress.totalBytes)}`
                      : ''}
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${Math.min(100, Math.max(4, downloadProgress.percent))}%` },
                    ]}
                  />
                </View>
                <TouchableOpacity
                  style={styles.signOutFullBtn}
                  onPress={handleCancelOfflineDownload}
                >
                  <Text style={styles.signOutFullText}>Cancel Download</Text>
                </TouchableOpacity>
              </View>
            )}

            {cacheInfo?.exists && !cachingOffline && (
              <View style={styles.settingsCard}>
                <Text style={styles.fieldLabel}>Stored On Device</Text>
                <Text style={styles.settingsSectionTitle}>
                  {formatCacheBytes(cacheInfo.sizeBytes)} cached offline
                </Text>
                {cacheInfo.lastModified ? (
                  <Text style={styles.settingsHint}>
                    Updated {new Date(cacheInfo.lastModified).toLocaleString()}
                  </Text>
                ) : null}
              </View>
            )}

            {!cachingOffline && (
              <>
                <TouchableOpacity
                  style={styles.primaryBlackBtn}
                  onPress={() => void handleCacheOfflineMap()}
                >
                  <Text style={styles.primaryBlackText}>
                    {cacheInfo?.exists ? 'Update Cached Map' : 'Download Map for Offline Use'}
                  </Text>
                </TouchableOpacity>

                {cacheInfo?.exists && (
                  <TouchableOpacity
                    style={styles.signOutFullBtn}
                    onPress={() => void handleDeleteCachedMap()}
                  >
                    <Text style={styles.signOutFullText}>Delete Cached Map</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>
        </View>
      </Modal>

      {/* Join Group via QR Modal */}
      <Modal visible={joinQrOpen} animationType="slide" onRequestClose={closeJoinQrModal}>
        <View pointerEvents="box-none" style={styles.flexOne}>
        <View style={[styles.modalWrap, { paddingTop: Math.max(insets.top + 8, 48), marginBottom: insets.bottom }]}>
          {qrScanning ? (
            <View style={styles.scannerFull}>
              <CameraView
                style={StyleSheet.absoluteFill}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={(res) => void handleMobileQrScanned(res)}
              />
              <View
                style={[
                  styles.scannerOverlayBar,
                  { bottom: 24 },
                ]}
              >
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
                      style={[styles.primaryBlackBtn, qrLoading && styles.btnBusy]}
                      disabled={!qrPreview.valid || qrLoading}
                      onPress={() => void handleConfirmJoinInvite()}
                    >
                      {qrLoading && <ActivityIndicator size="small" color="#ffffff" />}
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
                        style={[styles.outlineBlackBtn, qrLoading && styles.btnBusy]}
                        disabled={qrLoading || !qrPasteInput.trim()}
                        onPress={() => void resolveMobileInvite(qrPasteInput)}
                      >
                        {qrLoading && <ActivityIndicator size="small" color="#18181b" />}
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
  memberChipSelected: {
    backgroundColor: '#18181b',
    borderColor: '#18181b',
  },
  memberChipTextSelected: {
    color: '#ffffff',
  },
  selectedMemberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e4e4e7',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    shadowColor: '#09090b',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  selectedMemberInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  selectedMemberHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  selectedMemberName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#18181b',
    flexShrink: 1,
  },
  selectedMemberBadge: {
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  selectedMemberBadgeExact: {
    backgroundColor: '#18181b',
  },
  selectedMemberBadgeFuzzed: {
    backgroundColor: '#fef3c7',
  },
  selectedMemberBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#ffffff',
  },
  selectedMemberBadgeTextFuzzed: {
    color: '#92400e',
  },
  selectedMemberCoords: {
    fontSize: 11,
    color: '#71717a',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  selectedMemberActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  openMapsBtn: {
    backgroundColor: '#18181b',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  openMapsBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  dismissMemberBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#f4f4f5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissMemberText: {
    color: '#52525b',
    fontSize: 12,
    fontWeight: '700',
  },
  shareInput: {
    borderWidth: 1,
    borderColor: '#e4e4e7',
    backgroundColor: '#fafafa',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    color: '#18181b',
  },
  shareLinkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e4e4e7',
    backgroundColor: '#fafafa',
    padding: 10,
  },
  shareOpenBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e4e4e7',
    backgroundColor: '#ffffff',
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  shareOpenBtnText: {
    color: '#18181b',
    fontSize: 11,
    fontWeight: '700',
  },
  shareRevokeBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecdd3',
    backgroundColor: '#fff1f2',
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  shareRevokeBtnText: {
    color: '#be123c',
    fontSize: 11,
    fontWeight: '700',
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
  chatList: { flex: 1, backgroundColor: '#fafafa' },
  chatListContent: { padding: 16, gap: 10 },
  chatEmptyWrap: { paddingVertical: 40, alignItems: 'center' },
  chatEmptyText: { color: '#71717a', fontSize: 13, textAlign: 'center' },
  dateSeparator: { alignItems: 'center', marginVertical: 8 },
  dateSeparatorText: {
    backgroundColor: '#e4e4e7',
    color: '#52525b',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
  },
  chatMessageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 4 },
  chatRowMine: { justifyContent: 'flex-end' },
  chatRowOther: { justifyContent: 'flex-start' },
  chatAvatarSlot: { width: 28, height: 28 },
  chatAvatarImg: { width: 28, height: 28, borderRadius: 999 },
  chatAvatarFallback: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: '#18181b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatAvatarInitials: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  chatColumn: { maxWidth: '78%' },
  chatColumnMine: { alignItems: 'flex-end' },
  chatColumnOther: { alignItems: 'flex-start' },
  chatMetaHeader: {
    color: '#71717a',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 3,
    paddingHorizontal: 2,
  },
  chatBubble: {
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  chatBubbleMine: {
    backgroundColor: '#18181b',
    borderBottomRightRadius: 4,
  },
  chatBubbleOther: {
    backgroundColor: '#ffffff',
    borderColor: '#e4e4e7',
    borderWidth: 1,
    borderBottomLeftRadius: 4,
  },
  chatBody: { fontSize: 14, lineHeight: 19 },
  chatBodyMine: { color: '#ffffff' },
  chatBodyOther: { color: '#18181b' },
  chatTimeFooter: {
    color: '#a1a1aa',
    fontSize: 10,
    marginTop: 2,
    paddingHorizontal: 2,
  },
  chatTimeFooterMine: { color: '#71717a' },
  chatSender: { color: '#18181b', fontSize: 11, fontWeight: '700', marginBottom: 3 },
  chatComposer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 24,
    gap: 8,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e4e4e7',
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#f4f4f5',
    borderColor: '#e4e4e7',
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
  sendIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: '#18181b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendIconBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: '#ffffff', fontWeight: '700', fontSize: 16 },
  flexOne: { flex: 1 },
  privacyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#f4f4f5',
    borderColor: '#e4e4e7',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  privacyBadgeDot: { width: 7, height: 7, borderRadius: 999 },
  privacyDotExact: { backgroundColor: '#10b981' },
  privacyDotFuzzed: { backgroundColor: '#f59e0b' },
  privacyDotGhost: { backgroundColor: '#71717a' },
  privacyBadgeText: { color: '#18181b', fontSize: 11, fontWeight: '700' },
  menuIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: '#f4f4f5',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3.5,
  },
  menuIconBar: { width: 14, height: 1.8, borderRadius: 999, backgroundColor: '#18181b' },
  floatingCircleBtn: {
    width: 46,
    height: 46,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  floatingCircleBtnActive: { borderColor: '#18181b' },
  floatingCircleIcon: { color: '#18181b', fontSize: 18, fontWeight: '700' },
  floatingBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#18181b',
    borderRadius: 999,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingBadgeText: { color: '#ffffff', fontSize: 10, fontWeight: '700' },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(9, 9, 11, 0.45)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 12,
  },
  sheetHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e4e4e7',
    backgroundColor: '#fafafa',
    padding: 14,
  },
  sheetOptionSelected: {
    backgroundColor: '#18181b',
    borderColor: '#18181b',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e4e4e7',
    backgroundColor: '#fafafa',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  menuRowAction: { color: '#18181b', fontSize: 12, fontWeight: '700' },
  themeSegmentGroup: {
    flexDirection: 'row',
    backgroundColor: '#e4e4e7',
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  themeSegmentBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  themeSegmentBtnActive: {
    backgroundColor: '#18181b',
  },
  themeSegmentText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#52525b',
  },
  themeSegmentTextActive: {
    color: '#ffffff',
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: '#e4e4e7',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#18181b',
  },
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
    flexDirection: 'row',
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  primaryBlackText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  outlineBlackBtn: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderColor: '#18181b',
    borderWidth: 1.5,
    borderRadius: 999,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  outlineBlackText: { color: '#18181b', fontSize: 13, fontWeight: '700' },
  btnBusy: { opacity: 0.72 },
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
