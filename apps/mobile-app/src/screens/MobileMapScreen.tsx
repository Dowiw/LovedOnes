import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  useWindowDimensions,
  Vibration,
  View,
} from 'react-native';
import { Camera, type CameraRef, GeoJSONSource, Layer, Map, Marker } from '@maplibre/maplibre-react-native';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { io, Socket } from 'socket.io-client';
import {
  averageNearbyTrailPings,
  buildExternalMapsUrls,
  buildGeodesicCircleRing,
  buildSolarTerminatorGeoJson,
  buildTimelapseTimeline,
  buildTrailGeoJsonFeatures,
  buildTrailTrips,
  DEFAULT_EXACT_HALO_COLOR,
  DEFAULT_FUZZ_CIRCLE_COLOR,
  DEFAULT_FUZZED_HALO_COLOR,
  findCoveringRegions,
  FUZZED_AREA_RADIUS_METERS,
  GroupSnapshotCache,
  hexToRgba,
  isPointCoveredByRegions,
  isSafeAvatarUrl,
  isSafeHexColor,
  parseInviteInput,
  resolveTrailPointDetails,
  sampleTimelapseFrame,
  sortTrailTrips,
  TRAIL_ACTIVITY_META,
  virtualToRealMs,
  withMinDelay,
  WORLD_LAND_GEOJSON,
  type AppVersionInfo,
  type ChatMessage,
  type GroupPlace,
  type GroupRole,
  type LocationBroadcast,
  type LocationShareLinkItem,
  type MapDownloadJob,
  type MapRegion,
  type MatchedUserTrail,
  type TrailActivityMode,
  type MemberPresenceUpdate,
  type PlaceTransitionEvent,
  type PrivacyMode,
  type TimelapseSpeedOption,
  type TrailDisplayMode,
  type TrailPointDetails,
  type TrailsResponseMeta,
  type TrailTripSort,
  type TrailTripSummary,
} from '@loved-ones/shared';
import { ColorPickerSheet } from '../components/ColorPickerSheet';
import {
  ChatTabIcon,
  CompassNeedleIcon,
  FitAllIcon,
  LocationPinIcon,
  MapOptionsIcon,
  PlacesTabIcon,
  TrailsTabIcon,
} from '../components/MapControlsIcons';
import {
  formatDateAndClock,
  MobileTimelapseBar,
  MobileTrailsTabContent,
  type MobileTrailsTimeRange,
} from '../components/MobileTrailsControls';
import {
  checkMobileAppVersion,
  formatAppUpdateNotice,
  INSTALLED_APP_VERSION,
} from '../services/appVersion';
import { pickAndCropSquareAvatar } from '../services/avatarPicker';
import {
  isBackgroundTrackingActive,
  sendPresenceHeartbeat,
  startBackgroundTracking,
  stopBackgroundTracking,
  syncAdaptiveTrackingForPosition,
  syncRecoveryGeofenceForPosition,
} from '../services/backgroundLocation';
import { groupChatMessagesForDisplay } from '../services/chatFormatting';
import { formatUserError } from '../services/errorFormatter';
import {
  getLocationPermissionStatus,
  LocationPermissionResult,
  requestLocationPermissionsOnLaunch,
} from '../services/locationPermissions';
import {
  describeLastNearPlace,
  describeMemberStatus,
  formatLastSeenRelative,
  normalizeBearingDegrees,
} from '../services/memberDetails';
import { sendLocalNotification } from '../services/notifications';
import {
  enqueueLocationPoints,
  flushOfflineLocations,
  getPendingLocationCount,
} from '../services/offlineQueue';
import {
  formatServerHostLabel,
  getGeometricFonts,
  getOnboardingPalette,
  type OnboardingPalette,
} from '../services/onboardingTheme';
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
  type ResolvedMobileMapTheme,
  resolveMobileMapTheme,
} from '../services/pmtilesStyle';
import { useSafeAreaInsets } from '../services/safeArea';
import {
  clearSessionConfig,
  getBackgroundTrackingEnabled,
  getMapThemePreference,
  getSavedMapViewport,
  getShowTerminatorPreference,
  type MobileMapThemePreference,
  MobileStoredConfig,
  saveMapThemePreference,
  saveSavedMapViewport,
  saveShowTerminatorPreference,
  saveStoredConfig,
} from '../services/secureConfig';
import {
  createMobileShareLink,
  listMobileShareLinks,
  resolveMobileShareUrl,
  revokeMobileShareLink,
} from '../services/shareLinks';

const MOBILE_COLOR_PRESETS = ['#f59e0b', '#0ea5e9', '#10b981', '#8b5cf6', '#f43f5e', '#18181b'];
const PLACE_RADIUS_PRESETS = [100, 150, 300, 500, 1000];

interface GroupSummary {
  id: string;
  name: string;
  myRole?: GroupRole;
  myPrivacy: PrivacyMode;
}

type DrawerSnap = 'peek' | 'mid' | 'expanded';
type DrawerMode = 'people' | 'trails' | 'places';

interface MobileMapScreenProps {
  config: MobileStoredConfig;
  initialThemePreference?: MobileMapThemePreference;
  onThemePreferenceChange?: (pref: MobileMapThemePreference) => void;
  onSignedOut: (removedMessage?: string) => void;
}

export function MobileMapScreen({
  config,
  initialThemePreference = 'system',
  onThemePreferenceChange,
  onSignedOut,
}: MobileMapScreenProps) {
  const insets = useSafeAreaInsets();
  const systemColorScheme = useColorScheme();
  const [mapThemePreference, setMapThemePreference] = useState<MobileMapThemePreference>(
    initialThemePreference,
  );
  useEffect(() => {
    setMapThemePreference(initialThemePreference);
  }, [initialThemePreference]);
  const resolvedMapTheme = resolveMobileMapTheme(mapThemePreference, systemColorScheme);
  const ui = useMemo(() => getOnboardingPalette(resolvedMapTheme), [resolvedMapTheme]);
  const styles = useMemo(() => createMobileStyles(resolvedMapTheme, ui), [resolvedMapTheme, ui]);
  const fonts = getGeometricFonts(Platform.OS);
  const { height: windowHeight } = useWindowDimensions();

  const serverUrl = (config.serverUrl ?? '').replace(/\/$/, '');
  const [accessToken, setAccessToken] = useState(config.accessToken ?? '');
  const [refreshToken, setRefreshToken] = useState(config.refreshToken ?? '');

  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string>(config.activeGroupId ?? '');
  const [locations, setLocations] = useState<LocationBroadcast[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [chatText, setChatText] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [chatBanner, setChatBanner] = useState<ChatMessage | null>(null);
  const chatOpenRef = useRef(false);
  const chatBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifiedMsgIdsRef = useRef<Set<string>>(new Set());
  chatOpenRef.current = chatOpen;

  // Drawer snap geometry
  const peekHeight = 166;
  const midHeight = Math.min(356, Math.max(280, Math.round(windowHeight * 0.44)));
  const expandedHeight = Math.min(540, Math.max(380, Math.round(windowHeight * 0.66)));
  const drawerBoundsRef = useRef({ peek: peekHeight, mid: midHeight, expanded: expandedHeight });
  drawerBoundsRef.current = { peek: peekHeight, mid: midHeight, expanded: expandedHeight };

  const drawerHeightAnim = useRef(new Animated.Value(peekHeight)).current;
  const drawerHeightValueRef = useRef(peekHeight);
  const drawerSnapRef = useRef<DrawerSnap>('peek');
  const dragStartHeightRef = useRef(peekHeight);
  const [drawerSnap, setDrawerSnap] = useState<DrawerSnap>('peek');
  const [drawerMode, setDrawerMode] = useState<DrawerMode>('people');

  // Member inspection & Trails / Timelapse
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [activeTrailUserId, setActiveTrailUserId] = useState<string | null>(null);
  const [memberTrailPoints, setMemberTrailPoints] = useState<LocationBroadcast[]>([]);
  const [memberMatchedTrails, setMemberMatchedTrails] = useState<MatchedUserTrail[]>([]);
  const [trailsMeta, setTrailsMeta] = useState<TrailsResponseMeta | null>(null);
  const [trailTimeRange, setTrailTimeRange] = useState<MobileTrailsTimeRange>(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      preset: '24h',
      customMode: 'day',
      customDay: today,
      customFrom: today,
      customTo: today,
    };
  });
  const [trailSortBy, setTrailSortBy] = useState<TrailTripSort>('newest');
  const [trailIncludeStays, setTrailIncludeStays] = useState(false);
  const [focusedTrip, setFocusedTrip] = useState<TrailTripSummary | null>(null);
  const [timelapsePlaying, setTimelapsePlaying] = useState(false);
  const [timelapseSpeed, setTimelapseSpeed] = useState<TimelapseSpeedOption>(10);
  const [timelapseLoop, setTimelapseLoop] = useState(false);
  const [timelapseCompactIdle, setTimelapseCompactIdle] = useState(true);
  const [timelapseVirtualMs, setTimelapseVirtualMs] = useState(0);
  const [timelapseEngaged, setTimelapseEngaged] = useState(false);
  const [timelapseFocusMode, setTimelapseFocusMode] = useState(false);
  const [timelapseFollowUserId, setTimelapseFollowUserId] = useState<string | null>(null);
  const programmaticCameraMoveUntilRef = useRef(0);
  const [trailDisplayMode, setTrailDisplayMode] = useState<TrailDisplayMode>('roads');
  const [colorTrailsByActivity, setColorTrailsByActivity] = useState(true);
  const [trailBusy, setTrailBusy] = useState(false);
  const trailFetchSeqRef = useRef(0);
  const [trailMessage, setTrailMessage] = useState<string | null>(null);
  const [selectedTrailPoint, setSelectedTrailPoint] = useState<
    (TrailPointDetails & { latitude: number; longitude: number }) | null
  >(null);

  // Places (Private + Group-Shared)
  const [places, setPlaces] = useState<GroupPlace[]>([]);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [placeTransitions, setPlaceTransitions] = useState<PlaceTransitionEvent[]>([]);
  const groupCacheRef = useRef(
    new GroupSnapshotCache<{
      locations?: LocationBroadcast[];
      messages?: ChatMessage[];
      places?: GroupPlace[];
      placeTransitions?: PlaceTransitionEvent[];
    }>(),
  );
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [placeFormOpen, setPlaceFormOpen] = useState(false);
  const [placeName, setPlaceName] = useState('');
  const [placeRadius, setPlaceRadius] = useState<number>(150);
  const [placeScopeGroupId, setPlaceScopeGroupId] = useState<string>('private');
  const [placeDraftCoord, setPlaceDraftCoord] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );
  const [pickingPlaceCoords, setPickingPlaceCoords] = useState(false);
  const [placeBusy, setPlaceBusy] = useState(false);
  const [deletingPlaceId, setDeletingPlaceId] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [placeSuccess, setPlaceSuccess] = useState<string | null>(null);

  // Camera & Compass bearing
  const [mapBearing, setMapBearing] = useState(0);
  const mapBearingRef = useRef(0);
  const cameraViewRef = useRef<{ center: [number, number]; zoom: number; bearing: number }>({
    center: [13.4448, 52.5069],
    zoom: 11,
    bearing: 0,
  });
  const [viewportHydrated, setViewportHydrated] = useState(false);
  const hasSavedViewportRef = useRef(false);
  const hasAutoFramedRef = useRef(false);
  const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedMemberIdRef = useRef<string | null>(selectedMemberId);
  selectedMemberIdRef.current = selectedMemberId;
  const activeGroupIdRef = useRef<string>(activeGroupId);
  activeGroupIdRef.current = activeGroupId;

  // Google Maps-style Profile Hub, Group Switcher, Permissions Prompt
  const [profileHubOpen, setProfileHubOpen] = useState(false);
  const [hubStatusMsg, setHubStatusMsg] = useState<string | null>(null);
  const [groupSwitcherOpen, setGroupSwitcherOpen] = useState(false);
  const [locationPromptOpen, setLocationPromptOpen] = useState(false);
  const [locationPromptBusy, setLocationPromptBusy] = useState<'always' | 'once' | null>(null);
  const [locationPromptMsg, setLocationPromptMsg] = useState<string | null>(null);
  const promptedFirstTimeRef = useRef(false);

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
  const [editHaloColor, setEditHaloColor] = useState<string | null>(config.user?.haloColor ?? null);
  const [editFuzzCircleColor, setEditFuzzCircleColor] = useState<string | null>(
    config.user?.fuzzCircleColor ?? null,
  );
  const [colorPickerTarget, setColorPickerTarget] = useState<'halo' | 'fuzz' | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const [recoveryEmailInput, setRecoveryEmailInput] = useState(config.user?.recoveryEmail ?? '');
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
  const [offlineMessage, setOfflineMessage] = useState<string | null>(null);
  const [estimatedRegionBytes, setEstimatedRegionBytes] = useState<number | null>(null);
  const [estimatingSize, setEstimatingSize] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<OfflineDownloadProgress | null>(null);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareLinks, setShareLinks] = useState<LocationShareLinkItem[]>([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [shareLinksLoaded, setShareLinksLoaded] = useState(false);
  const [shareDurationMinutes, setShareDurationMinutes] = useState(60);
  const [shareLabelInput, setShareLabelInput] = useState('');
  const [shareAllowMutual, setShareAllowMutual] = useState(true);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  const [tracking, setTracking] = useState(false);
  const [selfCoord, setSelfCoord] = useState<[number, number] | null>(null);
  const [presenceNowMs, setPresenceNowMs] = useState(() => Date.now());
  const [labelLanguage, setLabelLanguage] = useState<MapLabelLanguage>('en');
  const [showTerminator, setShowTerminator] = useState(true);
  const [terminatorTick, setTerminatorTick] = useState(0);
  const [mapOptionsOpen, setMapOptionsOpen] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [localPmtilesUri, setLocalPmtilesUri] = useState<string | null>(null);
  const [mapRegions, setMapRegions] = useState<MapRegion[]>([]);
  const [mapRegionsLoaded, setMapRegionsLoaded] = useState(false);
  const [activeMapJob, setActiveMapJob] = useState<MapDownloadJob | null>(null);
  const [dismissedUncoveredKey, setDismissedUncoveredKey] = useState<string | null>(null);
  const [permissionInfo, setPermissionInfo] = useState<LocationPermissionResult | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const cameraRef = useRef<CameraRef | null>(null);
  const chatScrollRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null);
  const offlineAbortRef = useRef<AbortController | null>(null);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  );

  const adminGroups = useMemo(
    () => groups.filter((g) => g.myRole === 'ADMIN'),
    [groups],
  );

  const handleOpenCoordsInDefaultMaps = useCallback(
    async (latitude: number, longitude: number, label: string) => {
      const urls = buildExternalMapsUrls({
        latitude,
        longitude,
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
          Alert.alert('Unable to Open Maps', formatUserError(err, 'Could not open external Maps app'));
        }
      }
    },
    [],
  );

  const handleOpenInDefaultMaps = useCallback(
    (loc: LocationBroadcast) => {
      const label = loc.isFuzzed ? `${loc.username} (~1km)` : loc.username;
      return handleOpenCoordsInDefaultMaps(loc.latitude, loc.longitude, label);
    },
    [handleOpenCoordsInDefaultMaps],
  );

  const refreshShareLinks = useCallback(async () => {
    if (!serverUrl || !accessToken) return;
    if (!shareLinksLoaded) {
      setShareLinksLoading(true);
    }
    try {
      const list = await listMobileShareLinks(serverUrl, accessToken);
      setShareLinks(list);
      setShareLinksLoaded(true);
    } catch {
      // ignore background refresh error
    } finally {
      setShareLinksLoading(false);
    }
  }, [serverUrl, accessToken, shareLinksLoaded]);

  const handleOpenShareLinksModal = useCallback(() => {
    setProfileHubOpen(false);
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

  useEffect(() => {
    const id = drawerHeightAnim.addListener(({ value }) => {
      drawerHeightValueRef.current = value;
    });
    return () => {
      drawerHeightAnim.removeListener(id);
    };
  }, [drawerHeightAnim]);

  const snapDrawer = useCallback(
    (target: DrawerSnap) => {
      drawerSnapRef.current = target;
      setDrawerSnap(target);
      const { peek, mid, expanded } = drawerBoundsRef.current;
      const toValue = target === 'peek' ? peek : target === 'mid' ? mid : expanded;
      Animated.spring(drawerHeightAnim, {
        toValue,
        tension: 68,
        friction: 11,
        useNativeDriver: false,
      }).start();
    },
    [drawerHeightAnim],
  );

  const drawerPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          drawerHeightAnim.stopAnimation((val) => {
            drawerHeightValueRef.current = val;
            dragStartHeightRef.current = val;
          });
        },
        onPanResponderMove: (_, gesture) => {
          const { peek, expanded } = drawerBoundsRef.current;
          const clamped = Math.min(expanded, Math.max(peek, dragStartHeightRef.current - gesture.dy));
          drawerHeightAnim.setValue(clamped);
        },
        onPanResponderRelease: (_, gesture) => {
          const { peek, mid, expanded } = drawerBoundsRef.current;
          const current = drawerHeightValueRef.current;
          if (Math.abs(gesture.dy) < 6 && Math.abs(gesture.dx) < 6) {
            snapDrawer(drawerSnapRef.current === 'peek' ? 'mid' : 'peek');
            return;
          }
          if (gesture.vy < -0.45) {
            snapDrawer(current < mid - 12 ? 'mid' : 'expanded');
            return;
          }
          if (gesture.vy > 0.45) {
            snapDrawer(current > mid + 12 ? 'mid' : 'peek');
            return;
          }
          const distances: Array<{ snap: DrawerSnap; d: number }> = [
            { snap: 'peek', d: Math.abs(current - peek) },
            { snap: 'mid', d: Math.abs(current - mid) },
            { snap: 'expanded', d: Math.abs(current - expanded) },
          ];
          distances.sort((a, b) => a.d - b.d);
          snapDrawer(distances[0].snap);
        },
      }),
    [drawerHeightAnim, snapDrawer],
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
    void Promise.all([
      getLocationPermissionStatus(),
      getBackgroundTrackingEnabled().catch(() => false),
      isBackgroundTrackingActive().catch(() => false),
    ])
      .then(async ([perm, trackingEnabled, active]) => {
        setPermissionInfo(perm);
        if (perm.level === 'denied' && !promptedFirstTimeRef.current) {
          promptedFirstTimeRef.current = true;
          setLocationPromptOpen(true);
        }
        if (perm.level === 'always' && trackingEnabled) {
          const started = await startBackgroundTracking().catch(() => null);
          if (started) {
            setPermissionInfo(started.permission);
            setTracking(true);
            return;
          }
        }
        setTracking(active);
      })
      .catch(() => {});
    void getCachedRegionPmtilesInfo()
      .then((info) => {
        setCacheInfo(info);
        setLocalPmtilesUri(info.exists ? info.uri : null);
      })
      .catch(() => {
        void getCachedRegionPmtilesUri().then(setLocalPmtilesUri).catch(() => {});
      });
    void refreshQueueCount().catch(() => {});
    void getMapThemePreference()
      .then((pref) => {
        setMapThemePreference(pref);
        onThemePreferenceChange?.(pref);
      })
      .catch(() => {});
    void getShowTerminatorPreference()
      .then((enabled) => setShowTerminator(enabled))
      .catch(() => {});
  }, [onThemePreferenceChange, refreshQueueCount]);

  useEffect(() => {
    if (!showTerminator) return;
    const timer = setInterval(() => {
      setTerminatorTick((t) => t + 1);
    }, 60_000);
    return () => clearInterval(timer);
  }, [showTerminator]);

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
        if (manual) setHubStatusMsg('Unable to check app updates right now.');
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
        setHubStatusMsg(`App is up to date (v${INSTALLED_APP_VERSION})`);
      }
    },
    [serverUrl],
  );

  const fetchPlacesSnapshot = useCallback(
    async (groupId?: string, shouldApply?: () => boolean) => {
      if (!serverUrl || !accessToken) return;
      const qs = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
      const res = await fetch(`${serverUrl}/api/realtime/places${qs}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        places?: GroupPlace[];
        recentTransitions?: PlaceTransitionEvent[];
      };
      if (shouldApply && !shouldApply()) return;
      const nextPlaces = data.places ?? [];
      setPlaces(nextPlaces);
      if (data.recentTransitions) {
        setPlaceTransitions(data.recentTransitions);
      }
      if (groupId) {
        groupCacheRef.current.patch(groupId, {
          places: nextPlaces,
          placeTransitions: data.recentTransitions,
        });
      }
    },
    [serverUrl, accessToken],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setPresenceNowMs(Date.now());
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  const persistCurrentViewport = useCallback(() => {
    const uid = userProfile?.id ?? config.user?.id ?? null;
    if (!uid) return;
    const cam = cameraViewRef.current;
    void saveSavedMapViewport(
      {
        center: cam.center,
        zoom: cam.zoom,
        bearing: cam.bearing,
        focusedUserId: selectedMemberIdRef.current,
        activeGroupId: activeGroupIdRef.current || null,
      },
      uid,
    ).catch(() => {});
  }, [userProfile?.id, config.user?.id]);

  const schedulePersistViewport = useCallback(() => {
    if (viewportSaveTimerRef.current) {
      clearTimeout(viewportSaveTimerRef.current);
    }
    viewportSaveTimerRef.current = setTimeout(() => {
      viewportSaveTimerRef.current = null;
      persistCurrentViewport();
    }, 350);
  }, [persistCurrentViewport]);

  useEffect(() => {
    let active = true;
    const uid = userProfile?.id ?? config.user?.id ?? null;
    void getSavedMapViewport(uid)
      .then((saved) => {
        if (!active) return;
        if (saved) {
          hasSavedViewportRef.current = true;
          hasAutoFramedRef.current = true;
          cameraViewRef.current = {
            center: saved.center,
            zoom: saved.zoom,
            bearing: saved.bearing,
          };
          const norm = normalizeBearingDegrees(saved.bearing);
          mapBearingRef.current = norm;
          setMapBearing(norm);
          if (saved.focusedUserId) {
            setSelectedMemberId(saved.focusedUserId);
          }
          if (saved.activeGroupId && !activeGroupIdRef.current) {
            setActiveGroupId(saved.activeGroupId);
          }
          cameraRef.current?.jumpTo({
            center: saved.center,
            zoom: saved.zoom,
            bearing: saved.bearing,
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setViewportHydrated(true);
      });
    return () => {
      active = false;
    };
  }, [userProfile?.id, config.user?.id]);

  useEffect(() => {
    if (!viewportHydrated) return;
    persistCurrentViewport();
  }, [viewportHydrated, selectedMemberId, activeGroupId, persistCurrentViewport]);

  useEffect(() => {
    return () => {
      if (viewportSaveTimerRef.current) {
        clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = null;
      }
      persistCurrentViewport();
    };
  }, [persistCurrentViewport]);

  const handleFitAllMembers = useCallback(() => {
    hasAutoFramedRef.current = true;
    if (locations.length >= 2) {
      let minLon = Infinity;
      let maxLon = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;
      for (const loc of locations) {
        if (loc.longitude < minLon) minLon = loc.longitude;
        if (loc.longitude > maxLon) maxLon = loc.longitude;
        if (loc.latitude < minLat) minLat = loc.latitude;
        if (loc.latitude > maxLat) maxLat = loc.latitude;
      }
      if (Number.isFinite(minLon) && Number.isFinite(minLat)) {
        const lonSpan = Math.max(0.002, maxLon - minLon);
        const latSpan = Math.max(0.002, maxLat - minLat);
        cameraRef.current?.fitBounds(
          [
            minLon - lonSpan * 0.08,
            minLat - latSpan * 0.08,
            maxLon + lonSpan * 0.08,
            maxLat + latSpan * 0.08,
          ],
          {
            padding: { top: 96, right: 64, bottom: 220, left: 64 },
            duration: 650,
          },
        );
      }
    } else if (locations.length === 1) {
      cameraRef.current?.flyTo({
        center: [locations[0].longitude, locations[0].latitude],
        zoom: 13.5,
        duration: 650,
      });
    } else if (selfCoord) {
      cameraRef.current?.flyTo({
        center: selfCoord,
        zoom: 14.5,
        duration: 650,
      });
    }
  }, [locations, selfCoord]);

  useEffect(() => {
    if (!viewportHydrated || hasSavedViewportRef.current || hasAutoFramedRef.current) return;
    if (locations.length > 0 || selfCoord) {
      handleFitAllMembers();
    }
  }, [viewportHydrated, locations, selfCoord, handleFitAllMembers]);

  useEffect(() => {
    void checkServerAppVersion(false);
    void authedFetch('/api/auth/me').catch(() => {});
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        persistCurrentViewport();
      } else if (nextState === 'active') {
        void checkServerAppVersion(false);
        void authedFetch('/api/auth/me').catch(() => {});
        void getLocationPermissionStatus().then(setPermissionInfo).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [checkServerAppVersion, persistCurrentViewport]);

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
            setHubStatusMsg(`Map ready: ${data.job.cityName}`);
            setActiveMapJob(null);
            void fetch(`${serverUrl}/api/maps/regions`)
              .then((rr) => (rr.ok ? rr.json() : null))
              .then((rdata: { regions?: MapRegion[] } | null) => {
                if (rdata?.regions) setMapRegions(rdata.regions);
              })
              .catch(() => {});
          } else if (data.job.status === 'failed') {
            setHubStatusMsg(data.job.error ?? 'City map download failed');
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

    socket.on('location:removed', (evt: { groupId: string; userId: string }) => {
      setLocations((prev) => {
        if (activeGroup && evt.groupId !== activeGroup.id) return prev;
        return prev.filter((p) => p.userId !== evt.userId);
      });
    });

    socket.on('presence:update', (evt: MemberPresenceUpdate) => {
      setLocations((prev) => {
        if (activeGroup && evt.groupId !== activeGroup.id) return prev;
        return prev.map((loc) =>
          loc.userId === evt.userId
            ? {
                ...loc,
                lastHeartbeatAt: evt.lastHeartbeatAt,
                trackingState: evt.trackingState,
                batteryLevel:
                  evt.batteryLevel !== undefined ? evt.batteryLevel : loc.batteryLevel,
              }
            : loc,
        );
      });
    });

    socket.on(
      'member:privacy:updated',
      (evt: { userId: string; groupId: string; privacy: PrivacyMode }) => {
        if (evt.userId === userProfile?.id) {
          setGroups((prev) =>
            prev.map((g) => (g.id === evt.groupId ? { ...g, myPrivacy: evt.privacy } : g)),
          );
        }
      },
    );

    socket.on('place:transition', (evt: PlaceTransitionEvent) => {
      setPlaceTransitions((prev) => {
        if (activeGroup && evt.groupId !== activeGroup.id) return prev;
        if (evt.id && prev.some((e) => e.id === evt.id)) return prev;
        return [evt, ...prev].slice(0, 30);
      });
    });

    socket.on('place:updated', (payload: { groupId: string; places: GroupPlace[] }) => {
      if (activeGroup && payload.groupId !== activeGroup.id) return;
      setPlaces((prev) => [...prev.filter((p) => p.isPrivate), ...payload.places]);
    });

    socket.on('place:private:updated', (payload: { places: GroupPlace[] }) => {
      setPlaces((prev) => [...payload.places, ...prev.filter((p) => !p.isPrivate)]);
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
          const updated = {
            ...userProfile,
            username: evt.username,
            avatarUrl: evt.avatarUrl,
            haloColor: evt.haloColor ?? null,
            fuzzCircleColor: evt.fuzzCircleColor ?? null,
          };
          setUserProfile(updated);
          void saveStoredConfig({ user: updated });
        }
      },
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [serverUrl, accessToken, activeGroup, userProfile, checkServerAppVersion, onSignedOut]);

  useEffect(() => {
    setUnreadChatCount(0);
    setChatBanner(null);
    setSelectedMemberId(null);
    setActiveTrailUserId(null);
    setMemberTrailPoints([]);
    setMemberMatchedTrails([]);
    setTrailsMeta(null);
    setFocusedTrip(null);
    setTrailMessage(null);
    trailFetchSeqRef.current += 1;
    setTrailBusy(false);

    if (!serverUrl || !accessToken) return;
    if (!activeGroup) {
      setLocations([]);
      setLocationsLoading(false);
      setMessages([]);
      setMessagesLoading(false);
      setPlaceTransitions([]);
      setPlacesLoading(true);
      let cancelledNoGroup = false;
      void fetchPlacesSnapshot(undefined, () => !cancelledNoGroup)
        .catch(() => {})
        .finally(() => {
          if (!cancelledNoGroup) setPlacesLoading(false);
        });
      return () => {
        cancelledNoGroup = true;
      };
    }

    const groupId = activeGroup.id;
    socketRef.current?.emit('group:join', groupId);
    setPlaceScopeGroupId(activeGroup.myRole === 'ADMIN' ? groupId : 'private');

    const cached = groupCacheRef.current.get(groupId);
    if (cached?.locations !== undefined) {
      setLocations(cached.locations);
      setLocationsLoading(false);
    } else {
      setLocations([]);
      setLocationsLoading(true);
    }

    if (cached?.messages !== undefined) {
      setMessages(cached.messages);
      setMessagesLoading(false);
    } else {
      setMessages([]);
      setMessagesLoading(true);
    }

    if (cached?.places !== undefined) {
      setPlaces(cached.places);
      setPlaceTransitions(cached.placeTransitions ?? []);
      setPlacesLoading(false);
    } else {
      setPlaces([]);
      setPlaceTransitions([]);
      setPlacesLoading(true);
    }

    let cancelled = false;

    void fetch(`${serverUrl}/api/realtime/groups/${groupId}/locations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((d: { locations?: LocationBroadcast[] }) => {
        if (cancelled) return;
        const locs = d.locations ?? [];
        groupCacheRef.current.patch(groupId, { locations: locs });
        setLocations(locs);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLocationsLoading(false);
      });

    void fetch(`${serverUrl}/api/realtime/groups/${groupId}/messages`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((d: { messages?: ChatMessage[] }) => {
        if (cancelled) return;
        const msgs = d.messages ?? [];
        groupCacheRef.current.patch(groupId, { messages: msgs });
        setMessages(msgs);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });

    void fetchPlacesSnapshot(groupId, () => !cancelled)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPlacesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serverUrl, accessToken, activeGroup, fetchPlacesSnapshot]);

  async function captureFocusAndSyncPosition(): Promise<{ flushed: number; remaining: number } | null> {
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    }).catch(() => Location.getLastKnownPositionAsync().catch(() => null));
    if (!pos) return null;

    const coord: [number, number] = [pos.coords.longitude, pos.coords.latitude];
    setSelfCoord(coord);
    cameraRef.current?.flyTo({ center: coord, zoom: 15, duration: 700 });

    const rawHeading = pos.coords.heading;
    await enqueueLocationPoints([
      {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        altitude: pos.coords.altitude ?? null,
        accuracy:
          typeof pos.coords.accuracy === 'number' && pos.coords.accuracy >= 0
            ? pos.coords.accuracy
            : null,
        speed: pos.coords.speed !== null && pos.coords.speed >= 0 ? pos.coords.speed : null,
        heading:
          typeof rawHeading === 'number' &&
          Number.isFinite(rawHeading) &&
          rawHeading >= 0 &&
          rawHeading <= 360
            ? rawHeading
            : null,
        batteryLevel: null,
        recordedAt: new Date(pos.timestamp || Date.now()).toISOString(),
      },
    ]);
    const result = await flushOfflineLocations(serverUrl, accessToken);
    void syncAdaptiveTrackingForPosition(pos.coords.latitude, pos.coords.longitude);
    void syncRecoveryGeofenceForPosition(pos.coords.latitude, pos.coords.longitude);
    await refreshQueueCount();
    return result;
  }

  async function handlePinLocationPress() {
    if (syncingBusy) return;
    const perm = await getLocationPermissionStatus().catch(() => permissionInfo);
    if (perm) setPermissionInfo(perm);

    if (!perm || perm.level !== 'always') {
      setLocationPromptMsg(null);
      setLocationPromptOpen(true);
      return;
    }

    setSyncingBusy(true);
    try {
      if (!tracking) {
        const started = await startBackgroundTracking().catch(() => null);
        if (started) {
          setPermissionInfo(started.permission);
          setTracking(true);
        }
      }
      await withMinDelay(captureFocusAndSyncPosition(), 420);
    } catch {
      await refreshQueueCount();
    } finally {
      setSyncingBusy(false);
    }
  }

  async function handleGrantAlwaysLocation() {
    setLocationPromptBusy('always');
    setLocationPromptMsg(null);
    try {
      const perm = await requestLocationPermissionsOnLaunch();
      setPermissionInfo(perm);
      if (perm.level === 'always') {
        const started = await startBackgroundTracking();
        setTracking(true);
        setPermissionInfo(started.permission);
        setLocationPromptOpen(false);
        await captureFocusAndSyncPosition().catch(() => null);
      } else if (perm.level === 'foreground') {
        setLocationPromptMsg(
          'Your phone granted "While Using App". For continuous background sharing, choose "Allow all the time" in Settings.',
        );
        await captureFocusAndSyncPosition().catch(() => null);
      } else {
        setLocationPromptMsg('Location permission is required to find your pin.');
      }
    } catch (err) {
      setLocationPromptMsg(formatUserError(err, 'Unable to update location permission'));
    } finally {
      setLocationPromptBusy(null);
    }
  }

  async function handleGrantOneTimeLocation() {
    setLocationPromptBusy('once');
    setLocationPromptMsg(null);
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      const updatedPerm = await getLocationPermissionStatus().catch(() => ({
        level: fg.status === 'granted' ? ('foreground' as const) : ('denied' as const),
        canAskAgain: Boolean(fg.canAskAgain ?? true),
        label:
          fg.status === 'granted'
            ? 'Location Permission: While Using App (Test)'
            : 'Location Permission: Not Granted',
      }));
      setPermissionInfo(updatedPerm);
      if (fg.status !== 'granted') {
        setLocationPromptMsg('Foreground permission was denied. Please allow location to test.');
        return;
      }
      setLocationPromptOpen(false);
      await captureFocusAndSyncPosition().catch(() => null);
    } catch (err) {
      setLocationPromptMsg(formatUserError(err, 'Unable to capture test location'));
    } finally {
      setLocationPromptBusy(null);
    }
  }

  async function handleToggleTracking() {
    try {
      if (tracking) {
        await stopBackgroundTracking();
        setTracking(false);
        setHubStatusMsg('Live GPS sharing paused');
      } else {
        const started = await startBackgroundTracking();
        setPermissionInfo(started.permission);
        setTracking(true);
        setHubStatusMsg(
          started.mode === 'background'
            ? 'Background GPS sharing active (Allow All the Time)'
            : 'Foreground GPS sharing active (While Using App)',
        );
        const synced = await captureFocusAndSyncPosition().catch(() => null);
        if (!synced) {
          void sendPresenceHeartbeat('active');
        }
      }
    } catch (err) {
      setHubStatusMsg(formatUserError(err, 'Unable to toggle GPS sharing'));
    }
  }

  async function handlePrivacyChange(mode: PrivacyMode) {
    if (!activeGroup || privacySavingMode) return;
    setPrivacySavingMode(mode);
    setHubStatusMsg(null);
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
      setHubStatusMsg(`Sharing mode updated to ${mode} across devices.`);
    } catch (err) {
      setHubStatusMsg(formatUserError(err, 'Failed to switch sharing mode'));
    } finally {
      setPrivacySavingMode(null);
    }
  }

  const fetchGroupTrails = useCallback(
    async (
      range: MobileTrailsTimeRange,
      memberUserId: string | null,
      options: { fitOnLoad?: boolean } = {},
    ) => {
      if (!activeGroup || !serverUrl || !accessToken) return;
      const reqSeq = ++trailFetchSeqRef.current;
      const targetGroupId = activeGroup.id;
      setMemberTrailPoints([]);
      setMemberMatchedTrails([]);
      setTrailsMeta(null);
      setTrailBusy(true);
      setTrailMessage(null);
      setSelectedTrailPoint(null);
      try {
        const now = Date.now();
        let fromMs: number;
        let toMs: number;
        let limit = 2500;
        if (range.preset === 'custom') {
          if (range.customMode === 'day') {
            const s = new Date(`${range.customDay}T00:00:00`);
            const e = new Date(`${range.customDay}T23:59:59.999`);
            fromMs = Number.isNaN(s.getTime()) ? now - 86_400_000 : s.getTime();
            toMs = Number.isNaN(e.getTime()) ? now : e.getTime();
          } else {
            const s = new Date(`${range.customFrom}T00:00:00`);
            const e = new Date(`${range.customTo}T23:59:59.999`);
            fromMs = Number.isNaN(s.getTime()) ? now - 86_400_000 : s.getTime();
            toMs = Number.isNaN(e.getTime()) ? now : e.getTime();
          }
          if (fromMs > toMs) {
            [fromMs, toMs] = [toMs - 86_400_000, toMs];
          }
          limit = 8000;
        } else {
          const hours =
            range.preset === '30d'
              ? 24 * 30
              : range.preset === '7d'
                ? 24 * 7
                : range.preset === '3d'
                  ? 24 * 3
                  : 24;
          toMs = now;
          fromMs = now - hours * 3_600_000;
          limit = range.preset === '30d' ? 8000 : range.preset === '7d' || range.preset === '3d' ? 5000 : 2500;
        }

        const params = new URLSearchParams({
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          limit: String(limit),
        });
        if (memberUserId) params.set('userId', memberUserId);

        const res = await withMinDelay(
          fetch(`${serverUrl}/api/realtime/groups/${targetGroupId}/trails?${params.toString()}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          240,
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          trails?: LocationBroadcast[];
          matchedTrails?: MatchedUserTrail[];
          meta?: TrailsResponseMeta;
        };
        if (trailFetchSeqRef.current !== reqSeq) return;
        const points = data.trails ?? [];
        setMemberTrailPoints(points);
        setMemberMatchedTrails(data.matchedTrails ?? []);
        setTrailsMeta(data.meta ?? null);
        if (points.length === 0) {
          setTrailMessage('No recorded trail pings in this time window.');
        } else if (options.fitOnLoad) {
          let minLon = Infinity;
          let minLat = Infinity;
          let maxLon = -Infinity;
          let maxLat = -Infinity;
          for (const p of points) {
            if (p.longitude < minLon) minLon = p.longitude;
            if (p.longitude > maxLon) maxLon = p.longitude;
            if (p.latitude < minLat) minLat = p.latitude;
            if (p.latitude > maxLat) maxLat = p.latitude;
          }
          if (Number.isFinite(minLon)) {
            programmaticCameraMoveUntilRef.current = Date.now() + 800;
            if (Math.abs(maxLon - minLon) < 0.001 && Math.abs(maxLat - minLat) < 0.001) {
              cameraRef.current?.flyTo({
                center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
                zoom: 14,
                duration: 550,
              });
            } else {
              cameraRef.current?.fitBounds([minLon, minLat, maxLon, maxLat], {
                padding: { top: 80, right: 40, bottom: 260, left: 40 },
                duration: 550,
              });
            }
          }
        }
      } catch (err) {
        if (trailFetchSeqRef.current !== reqSeq) return;
        setMemberTrailPoints([]);
        setMemberMatchedTrails([]);
        setTrailsMeta(null);
        setTrailMessage(formatUserError(err, 'Unable to load trail right now.'));
      } finally {
        if (trailFetchSeqRef.current === reqSeq) {
          setTrailBusy(false);
        }
      }
    },
    [activeGroup, serverUrl, accessToken],
  );

  async function handleToggleMemberTrail(member: LocationBroadcast) {
    if (!activeGroup || !serverUrl || !accessToken) return;
    setActiveTrailUserId(member.userId);
    setFocusedTrip(null);
    setDrawerMode('trails');
    if (drawerSnapRef.current === 'peek') {
      snapDrawer('mid');
    }
    await fetchGroupTrails(trailTimeRange, member.userId, { fitOnLoad: true });
  }

  function handleSelectMember(loc: LocationBroadcast) {
    setSelectedMemberId(loc.userId);
    setDrawerMode('people');
    if (drawerSnapRef.current === 'peek') {
      snapDrawer('mid');
    }
    if (activeTrailUserId && activeTrailUserId !== loc.userId) {
      setActiveTrailUserId(null);
      setMemberTrailPoints([]);
      setMemberMatchedTrails([]);
      setTrailMessage(null);
      setSelectedTrailPoint(null);
    }
    cameraRef.current?.flyTo({
      center: [loc.longitude, loc.latitude],
      zoom: Math.max(cameraViewRef.current.zoom, 14.5),
      duration: 600,
    });
  }

  async function handleCreatePlace() {
    if (!placeName.trim()) {
      setPlaceError('Enter a name for this place.');
      return;
    }
    if (!placeDraftCoord) {
      setPlaceError('Tap "Pick on Map" or "Use My GPS" to set place coordinates.');
      return;
    }
    const isPrivate = placeScopeGroupId === 'private' || !placeScopeGroupId;
    const targetGroupId = isPrivate ? null : placeScopeGroupId;

    setPlaceBusy(true);
    setPlaceError(null);
    setPlaceSuccess(null);
    try {
      const created = await withMinDelay(async () => {
        const res = await authedFetch('/api/realtime/places', {
          method: 'POST',
          body: JSON.stringify({
            name: placeName.trim(),
            latitude: placeDraftCoord.latitude,
            longitude: placeDraftCoord.longitude,
            radiusMeters: placeRadius,
            isPrivate,
            groupId: targetGroupId,
          }),
        });
        const body = (await res.json()) as { place?: GroupPlace; error?: string };
        if (!res.ok || !body.place) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body.place;
      }, 400);

      setPlaceName('');
      setPlaceDraftCoord(null);
      setPlaceFormOpen(false);
      setPickingPlaceCoords(false);
      if (created.isPrivate || created.groupId === activeGroup?.id) {
        setPlaces((prev) => (prev.some((p) => p.id === created.id) ? prev : [...prev, created]));
        setSelectedPlaceId(created.id);
      }
      setPlaceSuccess(
        `Saved "${created.name}" (${created.isPrivate ? 'Private' : 'Shared with group'})`,
      );
      cameraRef.current?.flyTo({
        center: [created.longitude, created.latitude],
        zoom: 14.8,
        duration: 600,
      });
    } catch (err) {
      setPlaceError(formatUserError(err, 'Failed to save place'));
    } finally {
      setPlaceBusy(false);
    }
  }

  async function handleDeletePlace(placeId: string) {
    setDeletingPlaceId(placeId);
    setPlaceError(null);
    setPlaceSuccess(null);
    try {
      await withMinDelay(async () => {
        const res = await authedFetch(`/api/realtime/places/${placeId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
      }, 380);
      setPlaces((prev) => prev.filter((p) => p.id !== placeId));
      if (selectedPlaceId === placeId) setSelectedPlaceId(null);
      setPlaceSuccess('Place removed');
    } catch (err) {
      setPlaceError(formatUserError(err, 'Unable to delete place'));
    } finally {
      setDeletingPlaceId(null);
    }
  }

  async function handleUseGpsForPlace() {
    setPlaceError(null);
    if (selfCoord) {
      setPlaceDraftCoord({ latitude: selfCoord[1], longitude: selfCoord[0] });
      return;
    }
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        setPlaceError('Grant location permission or use "Pick on Map".');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      setSelfCoord([pos.coords.longitude, pos.coords.latitude]);
      setPlaceDraftCoord({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      cameraRef.current?.flyTo({
        center: [pos.coords.longitude, pos.coords.latitude],
        zoom: 15,
        duration: 550,
      });
    } catch (err) {
      setPlaceError(formatUserError(err, 'Unable to read GPS coordinates'));
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
    setOfflineMessage(null);
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
    setOfflineMessage(null);
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
      setOfflineMessage(
        `Cached ${targetCacheRegion?.displayName ?? targetCacheRegion?.name ?? 'regional'} map (${formatCacheBytes(result.sizeBytes)})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/cancelled/i.test(msg)) {
        setOfflineMessage('Offline map download cancelled.');
      } else {
        setOfflineMessage(formatUserError(err, 'Unable to download offline map right now.'));
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
      setOfflineMessage('Removed cached offline map.');
    } catch (err) {
      setOfflineMessage(formatUserError(err, 'Unable to remove cached offline map.'));
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
        setHubStatusMsg(data.error ?? 'Failed to request city map');
        return;
      }
      if (data.alreadyCovered && data.regions) {
        setMapRegions(data.regions);
        return;
      }
      if (data.job) {
        setActiveMapJob(data.job);
      }
    } catch (err) {
      setHubStatusMsg(formatUserError(err, 'Failed to request city map'));
    }
  }

  async function handleCheckOta() {
    try {
      const res = await checkForOtaUpdate();
      setHubStatusMsg(res.message);
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

  async function handlePickSquareAvatar() {
    setAccountError(null);
    const result = await pickAndCropSquareAvatar();
    if (result.status === 'ok') {
      setEditAvatarUrl(result.dataUri);
    } else if (result.status === 'denied' || result.status === 'error') {
      setAccountError(result.message);
    }
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

  const selectedMember = useMemo(
    () => (selectedMemberId ? locations.find((l) => l.userId === selectedMemberId) ?? null : null),
    [locations, selectedMemberId],
  );

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

  const placesGeoJson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: places.map((place) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            buildGeodesicCircleRing(place.longitude, place.latitude, place.radiusMeters),
          ],
        },
        properties: {
          placeId: place.id,
          name: place.name,
          isPrivate: place.isPrivate ? 1 : 0,
          color: place.isPrivate ? '#4f46e5' : '#0d9488',
        },
      })),
    }),
    [places],
  );

  const compactedTrail = useMemo(() => {
    if (!activeTrailUserId || memberTrailPoints.length === 0) return null;
    const filtered = memberTrailPoints.filter((t) => t.userId === activeTrailUserId);
    const compacted = averageNearbyTrailPings(filtered);
    return compacted[0] ?? null;
  }, [activeTrailUserId, memberTrailPoints]);

  const trailMemberOptions = useMemo(() => {
    const byId = new globalThis.Map<string, string>();
    for (const loc of locations) byId.set(loc.userId, loc.username);
    for (const pt of memberTrailPoints) {
      if (!byId.has(pt.userId)) byId.set(pt.userId, pt.username);
    }
    return Array.from(byId.entries())
      .map(([userId, username]) => ({ userId, username }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }, [locations, memberTrailPoints]);

  const mobileTrailTrips = useMemo(() => {
    if (drawerMode !== 'trails') return [];
    const built = buildTrailTrips({
      trails: memberTrailPoints,
      matchedTrails: memberMatchedTrails,
      mode: trailDisplayMode,
      filterUserId: activeTrailUserId,
      places,
      includeStays: trailIncludeStays,
    });
    return sortTrailTrips(built, trailSortBy);
  }, [
    drawerMode,
    memberTrailPoints,
    memberMatchedTrails,
    trailDisplayMode,
    activeTrailUserId,
    places,
    trailIncludeStays,
    trailSortBy,
  ]);

  const mobileTimelapseTimeline = useMemo(
    () =>
      drawerMode !== 'trails'
        ? buildTimelapseTimeline({ trails: [] })
        : buildTimelapseTimeline({
            trails: memberTrailPoints,
            matchedTrails: memberMatchedTrails,
            mode: trailDisplayMode,
            filterUserId: activeTrailUserId,
            focusTrip: focusedTrip
              ? {
                  userId: focusedTrip.userId,
                  startedAt: focusedTrip.startedAt,
                  endedAt: focusedTrip.endedAt,
                }
              : null,
            compactIdle: timelapseCompactIdle,
          }),
    [
      drawerMode,
      memberTrailPoints,
      memberMatchedTrails,
      trailDisplayMode,
      activeTrailUserId,
      focusedTrip,
      timelapseCompactIdle,
    ],
  );

  const prevMobileTimelineSigRef = useRef('');
  useEffect(() => {
    const sig = `${mobileTimelapseTimeline.realStartMs}:${mobileTimelapseTimeline.realEndMs}:${mobileTimelapseTimeline.tracks.length}:${focusedTrip?.id ?? 'all'}`;
    if (sig !== prevMobileTimelineSigRef.current) {
      prevMobileTimelineSigRef.current = sig;
      setTimelapsePlaying(false);
      setTimelapseVirtualMs(mobileTimelapseTimeline.virtualDurationMs);
      if (!focusedTrip) {
        setTimelapseEngaged(false);
        setTimelapseFocusMode(false);
      }
    }
  }, [mobileTimelapseTimeline, focusedTrip]);

  const mobileCurrentRealMs = useMemo(
    () => virtualToRealMs(mobileTimelapseTimeline, timelapseVirtualMs),
    [mobileTimelapseTimeline, timelapseVirtualMs],
  );

  const mobileTimelapseFrame = useMemo(() => {
    if (
      drawerMode !== 'trails' ||
      mobileTimelapseTimeline.isEmpty ||
      (!timelapseEngaged && !timelapsePlaying && !timelapseFocusMode)
    ) {
      return null;
    }
    return sampleTimelapseFrame(mobileTimelapseTimeline, mobileCurrentRealMs, { places });
  }, [
    drawerMode,
    mobileTimelapseTimeline,
    mobileCurrentRealMs,
    timelapseEngaged,
    timelapsePlaying,
    timelapseFocusMode,
    places,
  ]);

  const mobileVirtualRef = useRef(timelapseVirtualMs);
  mobileVirtualRef.current = timelapseVirtualMs;
  const mobilePlayingRef = useRef(timelapsePlaying);
  mobilePlayingRef.current = timelapsePlaying;

  useEffect(() => {
    if (
      !timelapsePlaying ||
      drawerMode !== 'trails' ||
      mobileTimelapseTimeline.isEmpty ||
      mobileTimelapseTimeline.virtualDurationMs <= 0
    ) {
      return;
    }
    let rafId: number | null = null;
    let lastAt = performance.now();
    const tick = (now: number) => {
      if (!mobilePlayingRef.current) return;
      const dtMs = Math.min(100, Math.max(0, now - lastAt));
      lastAt = now;
      const nextV = mobileVirtualRef.current + dtMs * timelapseSpeed;
      if (nextV >= mobileTimelapseTimeline.virtualDurationMs) {
        if (timelapseLoop) {
          mobileVirtualRef.current = 0;
          setTimelapseVirtualMs(0);
        } else {
          mobileVirtualRef.current = mobileTimelapseTimeline.virtualDurationMs;
          setTimelapseVirtualMs(mobileTimelapseTimeline.virtualDurationMs);
          setTimelapsePlaying(false);
          return;
        }
      } else {
        mobileVirtualRef.current = nextV;
        setTimelapseVirtualMs(nextV);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [timelapsePlaying, timelapseSpeed, timelapseLoop, drawerMode, mobileTimelapseTimeline]);

  useEffect(() => {
    if (drawerMode !== 'trails' || !timelapseFollowUserId || !mobileTimelapseFrame) return;
    const target = mobileTimelapseFrame.markers.find((m) => m.userId === timelapseFollowUserId);
    if (!target) return;
    programmaticCameraMoveUntilRef.current = Date.now() + 260;
    cameraRef.current?.jumpTo({
      center: [target.longitude, target.latitude],
    });
  }, [drawerMode, timelapseFollowUserId, mobileTimelapseFrame]);

  const memberTrailGeoJson = useMemo(() => {
    const showTrailsOnMap = drawerMode === 'trails' || Boolean(activeTrailUserId);
    if (!showTrailsOnMap || memberTrailPoints.length === 0) {
      return {
        type: 'FeatureCollection' as const,
        features: [],
      };
    }
    if (mobileTimelapseFrame) {
      return {
        type: 'FeatureCollection' as const,
        features: mobileTimelapseFrame.features,
      };
    }
    if (focusedTrip && focusedTrip.segments.length > 0) {
      const { features } = buildTrailGeoJsonFeatures({
        trails: [],
        matchedTrails: [
          {
            userId: focusedTrip.userId,
            username: focusedTrip.username,
            stops: [],
            visits: focusedTrip.visits,
            segments: focusedTrip.segments,
            hasRoadMatches: focusedTrip.segments.some((s) => s.kind === 'road'),
          },
        ],
        mode: trailDisplayMode,
        places,
      });
      return {
        type: 'FeatureCollection' as const,
        features,
      };
    }
    const { features } = buildTrailGeoJsonFeatures({
      trails: memberTrailPoints,
      matchedTrails: memberMatchedTrails,
      mode: trailDisplayMode,
      filterUserId: activeTrailUserId,
      places,
    });
    return {
      type: 'FeatureCollection' as const,
      features,
    };
  }, [
    drawerMode,
    activeTrailUserId,
    memberTrailPoints,
    memberMatchedTrails,
    trailDisplayMode,
    places,
    mobileTimelapseFrame,
    focusedTrip,
  ]);

  const terminatorGeoJson = useMemo(() => {
    void terminatorTick;
    return buildSolarTerminatorGeoJson(new Date(), { polarCapLat: 85.0 });
  }, [terminatorTick]);

  const showCompassBtn = Math.abs(mapBearing) > 2;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: resolvedMapTheme === 'dark' ? '#0c141d' : '#cfe3ee' },
      ]}
    >
      <Map
        style={styles.map}
        mapStyle={mapStyle}
        compass={false}
        logo={false}
        attribution={false}
        onRegionIsChanging={(ev) => {
          const vs = ev.nativeEvent;
          if (timelapseFollowUserId && Date.now() > programmaticCameraMoveUntilRef.current) {
            setTimelapseFollowUserId(null);
          }
          cameraViewRef.current = {
            center: [vs.center[0], vs.center[1]],
            zoom: vs.zoom,
            bearing: vs.bearing,
          };
          const norm = normalizeBearingDegrees(vs.bearing);
          const wasVisible = Math.abs(mapBearingRef.current) > 2;
          const isVisible = Math.abs(norm) > 2;
          if (Math.abs(norm - mapBearingRef.current) >= 1.2 || wasVisible !== isVisible) {
            mapBearingRef.current = norm;
            setMapBearing(norm);
          }
        }}
        onRegionDidChange={(ev) => {
          const vs = ev.nativeEvent;
          cameraViewRef.current = {
            center: [vs.center[0], vs.center[1]],
            zoom: vs.zoom,
            bearing: vs.bearing,
          };
          const norm = normalizeBearingDegrees(vs.bearing);
          mapBearingRef.current = norm;
          setMapBearing(norm);
          hasSavedViewportRef.current = true;
          hasAutoFramedRef.current = true;
          schedulePersistViewport();
        }}
        onPress={(ev) => {
          if (mapOptionsOpen) {
            setMapOptionsOpen(false);
          }
          if (!pickingPlaceCoords) {
            if (selectedTrailPoint) setSelectedTrailPoint(null);
            return;
          }
          const [lng, lat] = ev.nativeEvent.lngLat;
          setPlaceDraftCoord({ latitude: lat, longitude: lng });
          setPickingPlaceCoords(false);
          setDrawerMode('places');
          setPlaceFormOpen(true);
          snapDrawer('expanded');
        }}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: centerCoord,
            zoom: 11,
          }}
        />
        <GeoJSONSource
          id="world-land-src"
          data={WORLD_LAND_GEOJSON as unknown as GeoJSON.FeatureCollection}
        >
          <Layer
            id="world-land-fill"
            type="fill"
            beforeId="earth"
            maxzoom={8}
            paint={{
              'fill-color': resolvedMapTheme === 'dark' ? '#161b24' : '#efeee9',
              'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.96, 7.5, 0],
            }}
          />
          <Layer
            id="world-land-border"
            type="line"
            beforeId="earth"
            maxzoom={8}
            paint={{
              'line-color': resolvedMapTheme === 'dark' ? '#2c3647' : '#c6cbd4',
              'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 5, 1.0],
              'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.85, 6, 0.7, 7.5, 0],
            }}
          />
        </GeoJSONSource>
        {showTerminator && (
          <GeoJSONSource id="solar-terminator-src" data={terminatorGeoJson}>
            <Layer
              id="solar-terminator-night"
              type="fill"
              beforeId="buildings-housenumbers"
              filter={['==', ['get', 'band'], 'night']}
              paint={{
                'fill-color': resolvedMapTheme === 'dark' ? '#020612' : '#0a162c',
                'fill-opacity': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  0,
                  resolvedMapTheme === 'dark' ? 0.44 : 0.34,
                  6,
                  resolvedMapTheme === 'dark' ? 0.4 : 0.31,
                  9,
                  resolvedMapTheme === 'dark' ? 0.24 : 0.19,
                  12,
                  resolvedMapTheme === 'dark' ? 0.13 : 0.1,
                ],
              }}
            />
            <Layer
              id="solar-terminator-astronomical"
              type="fill"
              beforeId="buildings-housenumbers"
              filter={['==', ['get', 'band'], 'astronomical']}
              paint={{
                'fill-color': resolvedMapTheme === 'dark' ? '#0d1736' : '#1e2b54',
                'fill-opacity': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  0,
                  resolvedMapTheme === 'dark' ? 0.34 : 0.27,
                  6,
                  resolvedMapTheme === 'dark' ? 0.3 : 0.24,
                  9,
                  resolvedMapTheme === 'dark' ? 0.18 : 0.15,
                  12,
                  resolvedMapTheme === 'dark' ? 0.09 : 0.07,
                ],
              }}
            />
            <Layer
              id="solar-terminator-nautical"
              type="fill"
              beforeId="buildings-housenumbers"
              filter={['==', ['get', 'band'], 'nautical']}
              paint={{
                'fill-color': resolvedMapTheme === 'dark' ? '#43306b' : '#5e4082',
                'fill-opacity': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  0,
                  resolvedMapTheme === 'dark' ? 0.25 : 0.21,
                  6,
                  resolvedMapTheme === 'dark' ? 0.22 : 0.19,
                  9,
                  resolvedMapTheme === 'dark' ? 0.14 : 0.12,
                  12,
                  resolvedMapTheme === 'dark' ? 0.06 : 0.05,
                ],
              }}
            />
            <Layer
              id="solar-terminator-civil"
              type="fill"
              beforeId="buildings-housenumbers"
              filter={['==', ['get', 'band'], 'civil']}
              paint={{
                'fill-color': resolvedMapTheme === 'dark' ? '#d96b2b' : '#eb7634',
                'fill-opacity': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  0,
                  resolvedMapTheme === 'dark' ? 0.2 : 0.18,
                  6,
                  resolvedMapTheme === 'dark' ? 0.18 : 0.16,
                  9,
                  resolvedMapTheme === 'dark' ? 0.11 : 0.1,
                  12,
                  resolvedMapTheme === 'dark' ? 0.05 : 0.04,
                ],
              }}
            />
            <Layer
              id="solar-terminator-horizon"
              type="line"
              beforeId="buildings-housenumbers"
              filter={['==', ['get', 'band'], 'horizon']}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{
                'line-color': resolvedMapTheme === 'dark' ? '#f59e0b' : '#f97316',
                'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2.2, 6, 1.7, 11, 1.0],
                'line-blur': ['interpolate', ['linear'], ['zoom'], 0, 3.0, 6, 2.4, 11, 1.5],
                'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.72, 6, 0.56, 9, 0.28, 12, 0.1],
              }}
            />
          </GeoJSONSource>
        )}
        <GeoJSONSource id="places-zones-src" data={placesGeoJson}>
          <Layer
            id="places-zones-fill"
            type="fill"
            paint={{
              'fill-color': ['get', 'color'],
              'fill-opacity': 0.11,
            }}
          />
          <Layer
            id="places-zones-outline"
            type="line"
            paint={{
              'line-color': ['get', 'color'],
              'line-width': 1.75,
              'line-opacity': 0.72,
              'line-dasharray': [3, 2],
            }}
          />
        </GeoJSONSource>
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
        <GeoJSONSource
          id="member-trail-src"
          data={memberTrailGeoJson as unknown as GeoJSON.FeatureCollection}
          onPress={(ev) => {
            const pointFeat = ev.nativeEvent.features?.find(
              (f) => f?.geometry?.type === 'Point' && f?.properties?.kind === 'stop',
            );
            if (!pointFeat || pointFeat.geometry.type !== 'Point') return;
            ev.stopPropagation();
            const [lon, lat] = pointFeat.geometry.coordinates as [number, number];
            const props = (pointFeat.properties ?? {}) as Record<string, unknown>;
            const details = resolveTrailPointDetails({
              latitude: lat,
              longitude: lon,
              username: typeof props.username === 'string' ? props.username : undefined,
              firstRecordedAt:
                typeof props.firstRecordedAt === 'string' ? props.firstRecordedAt : undefined,
              lastRecordedAt:
                typeof props.lastRecordedAt === 'string' ? props.lastRecordedAt : undefined,
              pingCount:
                typeof props.pingCount === 'number'
                  ? props.pingCount
                  : Number(props.pingCount ?? 1) || 1,
              stayDurationMs:
                typeof props.stayDurationMs === 'number'
                  ? props.stayDurationMs
                  : Number.isFinite(Number(props.stayDurationMs))
                    ? Number(props.stayDurationMs)
                    : undefined,
              durationLabel:
                typeof props.durationLabel === 'string' ? props.durationLabel : undefined,
              isDwell:
                typeof props.isDwell === 'boolean'
                  ? props.isDwell
                  : props.isDwell === 'true'
                    ? true
                    : props.isDwell === 'false'
                      ? false
                      : undefined,
              isFuzzed:
                typeof props.isFuzzed === 'boolean'
                  ? props.isFuzzed
                  : props.isFuzzed === 'true',
              activityMode:
                typeof props.activityMode === 'string' && props.activityMode in TRAIL_ACTIVITY_META
                  ? (props.activityMode as TrailActivityMode)
                  : undefined,
              matchedPlaceName:
                typeof props.matchedPlaceName === 'string'
                  ? props.matchedPlaceName
                  : props.matchedPlaceName === null
                    ? null
                    : undefined,
              matchedPlaceIsPrivate:
                typeof props.matchedPlaceIsPrivate === 'boolean'
                  ? props.matchedPlaceIsPrivate
                  : props.matchedPlaceIsPrivate === 'true',
              places,
            });
            setSelectedTrailPoint({ ...details, latitude: lat, longitude: lon });
          }}
        >
          <Layer
            id="member-trail-fuzz-fill"
            type="fill"
            filter={['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'fuzz-zone']]}
            paint={{
              'fill-color': '#f59e0b',
              'fill-opacity': 0.14,
            }}
          />
          <Layer
            id="member-trail-fuzz-line"
            type="line"
            filter={['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'kind'], 'fuzz-zone']]}
            paint={{
              'line-color': '#f59e0b',
              'line-width': 1.5,
              'line-opacity': 0.75,
              'line-dasharray': [2, 2],
            }}
          />
          <Layer
            id="member-trail-line"
            type="line"
            filter={['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'road']]}
            layout={{
              'line-cap': 'round',
              'line-join': 'round',
            }}
            paint={{
              'line-color': colorTrailsByActivity
                ? ([
                    'match',
                    ['get', 'activityMode'],
                    'walking',
                    TRAIL_ACTIVITY_META.walking.color,
                    'running',
                    TRAIL_ACTIVITY_META.running.color,
                    'cycling',
                    TRAIL_ACTIVITY_META.cycling.color,
                    'transit',
                    TRAIL_ACTIVITY_META.transit.color,
                    'driving',
                    TRAIL_ACTIVITY_META.driving.color,
                    'stationary',
                    TRAIL_ACTIVITY_META.stationary.color,
                    resolvedMapTheme === 'dark' ? '#f4f4f5' : '#18181b',
                  ] as unknown as string)
                : resolvedMapTheme === 'dark'
                  ? '#f4f4f5'
                  : '#18181b',
              'line-width': 3.5,
              'line-opacity': 0.9,
            }}
          />
          <Layer
            id="member-trail-direct-line"
            type="line"
            filter={['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'direct']]}
            layout={{
              'line-cap': 'round',
              'line-join': 'round',
            }}
            paint={{
              'line-color': colorTrailsByActivity
                ? ([
                    'match',
                    ['get', 'activityMode'],
                    'walking',
                    TRAIL_ACTIVITY_META.walking.color,
                    'running',
                    TRAIL_ACTIVITY_META.running.color,
                    'cycling',
                    TRAIL_ACTIVITY_META.cycling.color,
                    'transit',
                    TRAIL_ACTIVITY_META.transit.color,
                    'driving',
                    TRAIL_ACTIVITY_META.driving.color,
                    'stationary',
                    TRAIL_ACTIVITY_META.stationary.color,
                    resolvedMapTheme === 'dark' ? '#f4f4f5' : '#18181b',
                  ] as unknown as string)
                : resolvedMapTheme === 'dark'
                  ? '#f4f4f5'
                  : '#18181b',
              'line-width': 2.5,
              'line-opacity': 0.78,
              'line-dasharray': [2, 1.5],
            }}
          />
          <Layer
            id="member-trail-spur-line"
            type="line"
            filter={['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'kind'], 'spur']]}
            layout={{
              'line-cap': 'round',
              'line-join': 'round',
            }}
            paint={{
              'line-color': resolvedMapTheme === 'dark' ? '#a1a1aa' : '#52525b',
              'line-width': 1.75,
              'line-opacity': 0.6,
              'line-dasharray': [1.2, 1.5],
            }}
          />
          <Layer
            id="member-trail-chevrons"
            type="symbol"
            filter={['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'chevron']]}
            layout={{
              'text-field': '›',
              'text-font': ['PlusJakartaSans-SemiBold'],
              'text-size': [
                'interpolate',
                ['linear'],
                ['zoom'],
                10,
                ['case', ['boolean', ['get', 'isReturnPass'], false], 11.5, 10],
                14,
                ['case', ['boolean', ['get', 'isReturnPass'], false], 14, 12],
                17,
                ['case', ['boolean', ['get', 'isReturnPass'], false], 16, 14],
              ],
              'text-rotate': ['-', ['coalesce', ['get', 'bearingDeg'], 0], 90],
              'text-rotation-alignment': 'map',
              'text-keep-upright': false,
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            }}
            paint={{
              'text-color': resolvedMapTheme === 'dark' ? '#09090b' : '#ffffff',
              'text-halo-color': resolvedMapTheme === 'dark' ? '#f4f4f5' : '#18181b',
              'text-halo-width': 0.65,
              'text-opacity': [
                'case',
                ['boolean', ['get', 'isReturnPass'], false],
                0.98,
                ['interpolate', ['linear'], ['coalesce', ['get', 'progress'], 1], 0, 0.52, 1, 0.94],
              ],
            }}
          />
          <Layer
            id="member-trail-points"
            type="circle"
            filter={['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'stop']]}
            paint={{
              'circle-radius': [
                'case',
                ['boolean', ['get', 'isDwell'], true],
                ['case', ['>', ['coalesce', ['get', 'pingCount'], 1], 1], 5.5, 4.5],
                3,
              ],
              'circle-color': resolvedMapTheme === 'dark' ? '#09090b' : '#ffffff',
              'circle-stroke-color': resolvedMapTheme === 'dark' ? '#f4f4f5' : '#18181b',
              'circle-stroke-width': ['case', ['boolean', ['get', 'isDwell'], true], 2, 1.25],
              'circle-opacity': ['case', ['boolean', ['get', 'isDwell'], true], 1, 0.72],
            }}
          />
        </GeoJSONSource>

        {places.map((place) => (
          <Marker key={`place-${place.id}`} id={`place-${place.id}`} lngLat={[place.longitude, place.latitude]}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => {
                setSelectedPlaceId(place.id);
                setDrawerMode('places');
                snapDrawer('mid');
                cameraRef.current?.flyTo({
                  center: [place.longitude, place.latitude],
                  zoom: 14.8,
                  duration: 550,
                });
              }}
              style={styles.marker}
            >
              <Text
                style={[
                  styles.placeMarkerLabel,
                  place.isPrivate ? styles.placeMarkerPrivate : styles.placeMarkerGroup,
                ]}
              >
                {place.name}
                {place.isPrivate ? ' · Private' : ''}
              </Text>
              <View
                style={[
                  styles.placeMarkerDot,
                  { borderColor: place.isPrivate ? '#4f46e5' : '#0d9488' },
                ]}
              />
            </TouchableOpacity>
          </Marker>
        ))}

        {placeDraftCoord && (
          <Marker
            id="place-draft-pin"
            lngLat={[placeDraftCoord.longitude, placeDraftCoord.latitude]}
          >
            <View style={styles.marker}>
              <Text style={styles.selfMarkerLabel}>{placeName.trim() || 'New Place'}</Text>
              <View style={styles.draftPlacePin} />
            </View>
          </Marker>
        )}

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

        {!(drawerMode === 'trails' && mobileTimelapseFrame) &&
          locations.map((loc) => {
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
          const isSelected = selectedMemberId === loc.userId;
          return (
            <Marker key={loc.userId} id={loc.userId} lngLat={[loc.longitude, loc.latitude]}>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => handleSelectMember(loc)}
                style={styles.marker}
              >
                <Text style={[styles.markerLabel, isSelected && styles.markerLabelSelected]}>
                  {loc.username}
                  {loc.isFuzzed ? ' (~1km)' : ''}
                </Text>
                {safePinAvatar ? (
                  <View
                    style={[
                      styles.avatarRing,
                      { borderColor: resolvedHalo },
                      isSelected && styles.avatarRingSelected,
                    ]}
                  >
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

        {drawerMode === 'trails' &&
          mobileTimelapseFrame?.markers.map((m) => {
            const dotColor = m.isFuzzed
              ? '#f59e0b'
              : m.activityMode
                ? TRAIL_ACTIVITY_META[m.activityMode].color
                : '#18181b';
            return (
              <Marker key={`tl-${m.userId}`} id={`tl-${m.userId}`} lngLat={[m.longitude, m.latitude]}>
                <View style={styles.marker}>
                  <Text
                    style={[
                      styles.markerLabel,
                      m.isFuzzed && { borderColor: '#f59e0b', borderWidth: 1.5 },
                    ]}
                  >
                    {m.isFuzzed ? `${m.username} · Fuzzed` : m.username}
                  </Text>
                  <View style={[styles.markerHalo, { backgroundColor: hexToRgba(dotColor, 0.25) }]}>
                    <View style={[styles.markerDot, { backgroundColor: dotColor }]} />
                  </View>
                </View>
              </Marker>
            );
          })}
      </Map>

      {/* Focus Mode Top Simulated Clock Badge */}
      {drawerMode === 'trails' && timelapseFocusMode && !mobileTimelapseTimeline.isEmpty && (
        <View
          style={{
            position: 'absolute',
            top: Math.max(insets.top + 8, 40),
            alignSelf: 'center',
            zIndex: 25,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: ui.border,
            backgroundColor: resolvedMapTheme === 'dark' ? 'rgba(24,24,27,0.94)' : 'rgba(255,255,255,0.96)',
            paddingHorizontal: 14,
            paddingVertical: 7,
          }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              backgroundColor: timelapsePlaying ? '#10b981' : '#a1a1aa',
            }}
          />
          <Text
            style={{
              color: ui.ink,
              fontSize: 12,
              fontWeight: '700',
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            }}
          >
            {formatDateAndClock(mobileCurrentRealMs)}
          </Text>
        </View>
      )}

      {/* Clean Google Maps-Style Top Chrome (No overlapping full-width bar, no transient status text) */}
      {!timelapseFocusMode && (
      <View
        style={[styles.topOverlay, { top: Math.max(insets.top + 8, 40) }]}
        pointerEvents="box-none"
      >
        <View style={styles.topRow} pointerEvents="box-none">
          {pickingPlaceCoords ? (
            <View style={styles.pickingBanner}>
              <Text style={styles.pickingBannerText}>Tap map to set place center</Text>
              <TouchableOpacity
                onPress={() => {
                  setPickingPlaceCoords(false);
                  setDrawerMode('places');
                  snapDrawer('expanded');
                }}
              >
                <Text style={styles.pickingCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : activeGroup ? (
            <TouchableOpacity
              style={styles.groupPill}
              activeOpacity={0.85}
              onPress={() => setGroupSwitcherOpen(true)}
            >
              <Text style={styles.groupPillName} numberOfLines={1}>
                {activeGroup.name}
              </Text>
              <Text style={styles.groupPillChevron}>▾</Text>
            </TouchableOpacity>
          ) : (
            <View />
          )}

          <TouchableOpacity
            style={[styles.profileAvatarBtn, { borderColor: selfHaloColor }]}
            activeOpacity={0.88}
            accessibilityLabel="Open profile and app controls"
            onPress={() => {
              setHubStatusMsg(null);
              setProfileHubOpen(true);
            }}
          >
            {selfAvatarUrl ? (
              <Image source={{ uri: selfAvatarUrl }} style={styles.topAvatarImg} />
            ) : (
              <Text style={styles.topAvatarInitial}>
                {(userProfile?.username ?? 'U').slice(0, 1).toUpperCase()}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Actionable-only Banners (Chat notification, App update, Tile download) */}
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

          if (selectedTrailPoint) {
            const fmtClock = (iso: string | null) => {
              if (!iso) return 'Unknown time';
              const d = new Date(iso);
              return Number.isNaN(d.getTime())
                ? iso
                : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            };
            const timeLabel =
              selectedTrailPoint.firstRecordedAt &&
              selectedTrailPoint.lastRecordedAt &&
              selectedTrailPoint.stayDurationMs >= 60_000
                ? `${fmtClock(selectedTrailPoint.firstRecordedAt)} – ${fmtClock(selectedTrailPoint.lastRecordedAt)}`
                : `Recorded ${fmtClock(selectedTrailPoint.firstRecordedAt)}`;
            const stayText =
              selectedTrailPoint.stayDurationMs > 0
                ? `Stayed ${selectedTrailPoint.durationLabel}`
                : selectedTrailPoint.durationLabel;

            const activityLabel = selectedTrailPoint.activityMode
              ? TRAIL_ACTIVITY_META[selectedTrailPoint.activityMode].label
              : null;

            return (
              <View style={styles.trailPointCard}>
                <View style={styles.chatToastTextWrap}>
                  <Text style={styles.trailPointTitle} numberOfLines={1}>
                    {selectedTrailPoint.matchedPlaceName
                      ? `At ${selectedTrailPoint.matchedPlaceName}${selectedTrailPoint.matchedPlaceIsPrivate ? ' (Private)' : ''}`
                      : `${selectedTrailPoint.username} · ${selectedTrailPoint.isDwell ? 'Stop' : 'Waypoint'}`}
                  </Text>
                  <Text style={styles.trailPointMeta} numberOfLines={1}>
                    {activityLabel ? `${activityLabel} · ` : ''}
                    {timeLabel} · {stayText}
                    {selectedTrailPoint.pingCount > 1 ? ` · ${selectedTrailPoint.pingCount} pings` : ''}
                  </Text>
                </View>
                <TouchableOpacity
                  hitSlop={10}
                  onPress={() => setSelectedTrailPoint(null)}
                >
                  <Text style={styles.trailPointClose}>Dismiss</Text>
                </TouchableOpacity>
              </View>
            );
          }

          if (trailBusy && (drawerMode === 'trails' || activeTrailUserId !== null)) {
            return (
              <View pointerEvents="none" style={styles.loadingPillBanner}>
                <ActivityIndicator size="small" color={ui.ink} />
                <Text style={styles.loadingPillText} numberOfLines={1}>
                  Loading trails &amp; matching roads…
                </Text>
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

          return null;
        })()}
      </View>
      )}

      {/* Floating Timelapse Player Bar (above bottom drawer, or bottom-docked in Focus Mode) */}
      {drawerMode === 'trails' && !mobileTimelapseTimeline.isEmpty && (
        <Animated.View
          pointerEvents="box-none"
          style={[
            {
              position: 'absolute',
              left: 12,
              right: 12,
              zIndex: 24,
            },
            timelapseFocusMode
              ? { bottom: Math.max(insets.bottom + 14, 24) }
              : { bottom: Animated.add(drawerHeightAnim, 12) },
          ]}
        >
          <MobileTimelapseBar
            ui={ui}
            isDark={resolvedMapTheme === 'dark'}
            timeline={mobileTimelapseTimeline}
            currentRealMs={mobileCurrentRealMs}
            virtualMs={timelapseVirtualMs}
            playing={timelapsePlaying}
            speed={timelapseSpeed}
            loop={timelapseLoop}
            compactIdle={timelapseCompactIdle}
            focusMode={timelapseFocusMode}
            canFollow={Boolean(focusedTrip?.userId ?? activeTrailUserId)}
            following={
              Boolean(focusedTrip?.userId ?? activeTrailUserId) &&
              timelapseFollowUserId === (focusedTrip?.userId ?? activeTrailUserId)
            }
            onTogglePlay={() => {
              if (mobileTimelapseTimeline.isEmpty) return;
              if (timelapsePlaying) {
                setTimelapsePlaying(false);
                return;
              }
              setTimelapseEngaged(true);
              setTimelapseFocusMode(true);
              if (timelapseVirtualMs >= mobileTimelapseTimeline.virtualDurationMs - 50) {
                setTimelapseVirtualMs(0);
                mobileVirtualRef.current = 0;
              }
              setTimelapsePlaying(true);
            }}
            onSeekVirtualMs={(vMs) => {
              setTimelapsePlaying(false);
              setTimelapseEngaged(true);
              setTimelapseVirtualMs(vMs);
            }}
            onCycleSpeed={setTimelapseSpeed}
            onToggleLoop={() => setTimelapseLoop((v) => !v)}
            onToggleCompactIdle={() => setTimelapseCompactIdle((v) => !v)}
            onToggleFollow={() => {
              const targetId = focusedTrip?.userId ?? activeTrailUserId;
              if (!targetId) return;
              setTimelapseFollowUserId((prev) => (prev === targetId ? null : targetId));
            }}
            onFitAll={() => {
              let minLon = Infinity;
              let minLat = Infinity;
              let maxLon = -Infinity;
              let maxLat = -Infinity;
              for (const p of memberTrailPoints) {
                if (activeTrailUserId && p.userId !== activeTrailUserId) continue;
                if (p.longitude < minLon) minLon = p.longitude;
                if (p.longitude > maxLon) maxLon = p.longitude;
                if (p.latitude < minLat) minLat = p.latitude;
                if (p.latitude > maxLat) maxLat = p.latitude;
              }
              if (Number.isFinite(minLon)) {
                programmaticCameraMoveUntilRef.current = Date.now() + 800;
                cameraRef.current?.fitBounds([minLon, minLat, maxLon, maxLat], {
                  padding: { top: 80, right: 40, bottom: 260, left: 40 },
                  duration: 550,
                });
              }
            }}
            onExitFocus={() => {
              setTimelapsePlaying(false);
              setTimelapseEngaged(false);
              setTimelapseFocusMode(false);
              setTimelapseFollowUserId(null);
              setTimelapseVirtualMs(mobileTimelapseTimeline.virtualDurationMs);
            }}
          />
        </Animated.View>
      )}

      {/* Bottom-Left Floating Map Controls Above Drawer: Compass + Fit All + Map Options + Pin Location */}
      {!timelapseFocusMode && (
      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.floatingControlsWrap,
          {
            bottom:
              drawerMode === 'trails' && !mobileTimelapseTimeline.isEmpty
                ? Animated.add(drawerHeightAnim, 126)
                : Animated.add(drawerHeightAnim, 12),
          },
        ]}
      >
        {mapOptionsOpen && (
          <View style={styles.mapOptionsPopover}>
            <View style={styles.mapOptionsHeader}>
              <Text style={styles.mapOptionsTitle}>Map Options</Text>
              <TouchableOpacity
                hitSlop={8}
                onPress={() => setMapOptionsOpen(false)}
                accessibilityLabel="Close map options"
              >
                <Text style={styles.mapOptionsCloseText}>Done</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.mapOptionsRow}>
              <Text style={styles.mapOptionsLabel}>Day / Night</Text>
              <TouchableOpacity
                activeOpacity={0.85}
                style={[
                  styles.mapOptionsPillBtn,
                  showTerminator && styles.mapOptionsPillBtnActive,
                ]}
                onPress={() => {
                  const next = !showTerminator;
                  setShowTerminator(next);
                  void saveShowTerminatorPreference(next).catch(() => {});
                }}
              >
                <Text
                  style={[
                    styles.mapOptionsPillText,
                    showTerminator && styles.mapOptionsPillTextActive,
                  ]}
                >
                  {showTerminator ? 'On' : 'Off'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.mapOptionsRow}>
              <Text style={styles.mapOptionsLabel}>Theme</Text>
              <View style={styles.mapOptionsSegment}>
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
                      activeOpacity={0.85}
                      onPress={() => {
                        setMapThemePreference(pref);
                        onThemePreferenceChange?.(pref);
                        void saveMapThemePreference(pref).catch(() => {});
                      }}
                      style={[
                        styles.mapOptionsSegBtn,
                        active && styles.mapOptionsSegBtnActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.mapOptionsSegText,
                          active && styles.mapOptionsSegTextActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={styles.mapOptionsRow}>
              <Text style={styles.mapOptionsLabel}>Labels</Text>
              <View style={styles.mapOptionsSegment}>
                {(
                  [
                    ['en', 'EN'],
                    ['local', 'Local'],
                  ] as const
                ).map(([lang, label]) => {
                  const active = labelLanguage === lang;
                  return (
                    <TouchableOpacity
                      key={lang}
                      activeOpacity={0.85}
                      onPress={() => setLabelLanguage(lang)}
                      style={[
                        styles.mapOptionsSegBtn,
                        active && styles.mapOptionsSegBtnActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.mapOptionsSegText,
                          active && styles.mapOptionsSegTextActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </View>
        )}

        <View style={styles.floatingControlsRail} pointerEvents="box-none">
          {showCompassBtn && (
            <TouchableOpacity
              style={styles.mapActionBtn}
              activeOpacity={0.85}
              accessibilityLabel="Reset map orientation to North"
              onPress={() => {
                setMapBearing(0);
                mapBearingRef.current = 0;
                cameraRef.current?.easeTo({
                  center: cameraViewRef.current.center,
                  zoom: cameraViewRef.current.zoom,
                  bearing: 0,
                  duration: 320,
                });
              }}
            >
              <CompassNeedleIcon bearingDeg={mapBearing} />
            </TouchableOpacity>
          )}

          {locations.length > 0 && (
            <TouchableOpacity
              style={styles.mapActionBtn}
              activeOpacity={0.85}
              accessibilityLabel="Fit all group members on map"
              onPress={() => {
                setSelectedMemberId(null);
                handleFitAllMembers();
              }}
            >
              <FitAllIcon tintColor={ui.ink} />
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[
              styles.mapActionBtn,
              mapOptionsOpen && styles.mapActionBtnActive,
            ]}
            activeOpacity={0.85}
            accessibilityLabel="Map display options"
            onPress={() => setMapOptionsOpen((v) => !v)}
          >
            <MapOptionsIcon
              tintColor={mapOptionsOpen ? ui.ctaText : ui.ink}
              knobFill={mapOptionsOpen ? ui.ctaBg : ui.surface}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.mapActionBtn}
            activeOpacity={0.85}
            disabled={syncingBusy}
            accessibilityLabel="Center and share location"
            onPress={() => void handlePinLocationPress()}
          >
            {syncingBusy ? (
              <ActivityIndicator size="small" color={ui.ink} />
            ) : (
              <LocationPinIcon
                active={tracking}
                tintColor={ui.ink}
                holeColor={ui.surface}
              />
            )}
            {tracking && <View style={styles.pinLiveBadge} />}
            {queuedCount > 0 && (
              <View style={styles.floatingBadge}>
                <Text style={styles.floatingBadgeText}>
                  {queuedCount > 99 ? '99+' : queuedCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </Animated.View>
      )}

      {/* True Draggable Bottom Drawer (Member Details + Trails + Places + Chat) */}
      {!timelapseFocusMode && (
      <Animated.View style={[styles.bottomSheet, { height: drawerHeightAnim }]}>
        <View {...drawerPanResponder.panHandlers} style={styles.sheetDragArea}>
          <View style={styles.sheetHandle} />
          <View style={styles.drawerHeaderRow}>
            <Text style={[styles.drawerHeaderTitle, { fontFamily: fonts.display }]} numberOfLines={1}>
              {drawerMode === 'places'
                ? 'Places · Private & Shared'
                : drawerMode === 'trails'
                  ? 'Trails & Timelapse'
                  : selectedMember
                    ? selectedMember.username
                    : locationsLoading && locations.length === 0
                      ? `${activeGroup?.name ?? 'LovedOnes'} · Loading…`
                      : `${activeGroup?.name ?? 'LovedOnes'} · ${locations.length} visible`}
            </Text>
            {drawerSnap !== 'peek' && (
              <TouchableOpacity
                onPress={() => snapDrawer('peek')}
                hitSlop={{ top: 8, bottom: 8, left: 10, right: 10 }}
              >
                <Text style={styles.drawerCollapseText}>Minimize</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {locationsLoading && locations.length === 0 && (
          <View style={styles.loadingDrawerRow}>
            <ActivityIndicator size="small" color={ui.ink} />
            <Text style={styles.settingsHint}>Loading group members…</Text>
          </View>
        )}

        {locations.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.memberStripScroll}
            contentContainerStyle={styles.memberStrip}
          >
            {!(drawerMode === 'trails' && mobileTimelapseFrame) &&
          locations.map((loc) => {
              const chipAvatar = isSafeAvatarUrl(loc.avatarUrl) ? loc.avatarUrl : null;
              const isSelected = selectedMemberId === loc.userId;
              return (
                <TouchableOpacity
                  key={loc.userId}
                  activeOpacity={0.85}
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

        {drawerSnap !== 'peek' && (
          <ScrollView
            style={styles.drawerBodyScroll}
            contentContainerStyle={styles.drawerBodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {drawerMode === 'trails' ? (
              <MobileTrailsTabContent
                ui={ui}
                isDark={resolvedMapTheme === 'dark'}
                members={trailMemberOptions}
                selectedMemberFilterId={activeTrailUserId}
                onChangeMemberFilterId={(uid) => {
                  setActiveTrailUserId(uid);
                  setFocusedTrip(null);
                  setTimelapseFollowUserId(null);
                  void fetchGroupTrails(trailTimeRange, uid, { fitOnLoad: true });
                }}
                timeRange={trailTimeRange}
                onChangeTimeRange={(nextRange) => {
                  setTrailTimeRange(nextRange);
                  setFocusedTrip(null);
                  void fetchGroupTrails(nextRange, activeTrailUserId, { fitOnLoad: false });
                }}
                trailDisplayMode={trailDisplayMode}
                onChangeTrailDisplayMode={(mode) => {
                  setTrailDisplayMode(mode);
                  setSelectedTrailPoint(null);
                }}
                colorTrailsByActivity={colorTrailsByActivity}
                onToggleColorByActivity={() => setColorTrailsByActivity((prev) => !prev)}
                trips={mobileTrailTrips}
                sortBy={trailSortBy}
                onChangeSortBy={setTrailSortBy}
                includeStays={trailIncludeStays}
                onToggleIncludeStays={() => setTrailIncludeStays((v) => !v)}
                focusedTrip={focusedTrip}
                onSelectTrip={(trip) => {
                  setFocusedTrip(trip);
                  if (trip) {
                    const [minLon, minLat, maxLon, maxLat] = trip.bounds;
                    programmaticCameraMoveUntilRef.current = Date.now() + 800;
                    if (Math.abs(maxLon - minLon) < 0.0005 && Math.abs(maxLat - minLat) < 0.0005) {
                      cameraRef.current?.flyTo({
                        center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
                        zoom: 14.5,
                        duration: 550,
                      });
                    } else {
                      cameraRef.current?.fitBounds([minLon, minLat, maxLon, maxLat], {
                        padding: { top: 80, right: 40, bottom: 260, left: 40 },
                        duration: 550,
                      });
                    }
                  }
                }}
                meta={trailsMeta}
                busy={trailBusy}
                message={trailMessage}
              />
            ) : drawerMode === 'people' ? (
              selectedMember ? (
                <View style={styles.memberDetailCard}>
                  <View style={styles.memberDetailHeader}>
                    <View style={styles.memberDetailIdentity}>
                      <Text style={styles.memberDetailName}>{selectedMember.username}</Text>
                      <View
                        style={[
                          styles.privacyStatusPill,
                          selectedMember.privacyMode === 'FUZZED' && styles.privacyStatusFuzzed,
                        ]}
                      >
                        <Text style={styles.privacyStatusText}>
                          {selectedMember.privacyMode}
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      onPress={() => {
                        setSelectedMemberId(null);
                        setActiveTrailUserId(null);
                        setMemberTrailPoints([]);
                      }}
                    >
                      <Text style={styles.closeMiniText}>Clear</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.detailMetaRow}>
                    <Text style={styles.detailMetaLabel}>Last near at</Text>
                    <Text style={styles.detailMetaValue}>
                      {describeLastNearPlace({
                        userId: selectedMember.userId,
                        latitude: selectedMember.latitude,
                        longitude: selectedMember.longitude,
                        isFuzzed: selectedMember.isFuzzed,
                        places,
                        transitions: placeTransitions,
                        nowMs: presenceNowMs,
                      })}
                    </Text>
                  </View>

                  <View style={styles.detailMetaRow}>
                    <Text style={styles.detailMetaLabel}>Status</Text>
                    <Text style={styles.detailMetaValue}>
                      {describeMemberStatus({
                        latitude: selectedMember.latitude,
                        longitude: selectedMember.longitude,
                        recordedAt: selectedMember.recordedAt,
                        lastHeartbeatAt: selectedMember.lastHeartbeatAt,
                        trackingState: selectedMember.trackingState,
                        isFuzzed: selectedMember.isFuzzed,
                        places,
                        nowMs: presenceNowMs,
                      }).detailText}
                      {typeof selectedMember.speed === 'number' && selectedMember.speed > 0.5
                        ? ` · ${(selectedMember.speed * 3.6).toFixed(0)} km/h`
                        : ''}
                      {typeof selectedMember.batteryLevel === 'number'
                        ? ` · ${selectedMember.batteryLevel}% batt`
                        : ''}
                    </Text>
                  </View>

                  <View style={styles.detailMetaRow}>
                    <Text style={styles.detailMetaLabel}>Coordinates</Text>
                    <Text style={styles.detailMetaMono}>
                      {selectedMember.latitude.toFixed(5)}, {selectedMember.longitude.toFixed(5)}
                      {selectedMember.isFuzzed ? ' (~1 km)' : ''}
                    </Text>
                  </View>

                  <View style={styles.detailActionRow}>
                    <TouchableOpacity
                      style={[
                        styles.detailTrailBtn,
                        activeTrailUserId === selectedMember.userId && styles.detailTrailBtnActive,
                      ]}
                      disabled={trailBusy}
                      onPress={() => void handleToggleMemberTrail(selectedMember)}
                    >
                      {trailBusy && activeTrailUserId === selectedMember.userId ? (
                        <ActivityIndicator
                          size="small"
                          color={activeTrailUserId === selectedMember.userId ? ui.ctaText : ui.ink}
                        />
                      ) : null}
                      <Text
                        style={[
                          styles.detailTrailBtnText,
                          activeTrailUserId === selectedMember.userId &&
                            styles.detailTrailBtnTextActive,
                        ]}
                      >
                        {activeTrailUserId === selectedMember.userId
                          ? compactedTrail
                            ? `Hide Trail (${compactedTrail.stops.length} stops)`
                            : 'Hide Trail'
                          : 'View Trail (24h)'}
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.detailFocusBtn}
                      onPress={() =>
                        cameraRef.current?.flyTo({
                          center: [selectedMember.longitude, selectedMember.latitude],
                          zoom: 15.5,
                          duration: 500,
                        })
                      }
                    >
                      <Text style={styles.detailFocusBtnText}>Center</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.openMapsBtn}
                      onPress={() => void handleOpenInDefaultMaps(selectedMember)}
                    >
                      <Text style={styles.openMapsBtnText}>Maps</Text>
                    </TouchableOpacity>
                  </View>

                  {activeTrailUserId === selectedMember.userId &&
                    memberTrailPoints.length > 0 &&
                    !selectedMember.isFuzzed && (
                      <View style={{ gap: 6 }}>
                        <View style={styles.trailModePillRow}>
                          {(['roads', 'raw'] as const).map((mode) => (
                            <TouchableOpacity
                              key={mode}
                              style={[
                                styles.trailModePill,
                                trailDisplayMode === mode && styles.trailModePillActive,
                              ]}
                              onPress={() => {
                                setTrailDisplayMode(mode);
                                setSelectedTrailPoint(null);
                              }}
                            >
                              <Text
                                style={[
                                  styles.trailModePillText,
                                  trailDisplayMode === mode && styles.trailModePillTextActive,
                                ]}
                              >
                                {mode === 'roads' ? 'Clean' : 'Raw'}
                              </Text>
                            </TouchableOpacity>
                          ))}
                          <TouchableOpacity
                            style={[
                              styles.trailModePill,
                              colorTrailsByActivity && styles.trailModePillActive,
                            ]}
                            onPress={() => setColorTrailsByActivity((prev) => !prev)}
                          >
                            <Text
                              style={[
                                styles.trailModePillText,
                                colorTrailsByActivity && styles.trailModePillTextActive,
                              ]}
                            >
                              Activity
                            </Text>
                          </TouchableOpacity>
                        </View>
                        {colorTrailsByActivity && (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {(
                              ['walking', 'running', 'cycling', 'transit', 'driving', 'stationary'] as const
                            ).map((modeKey) => (
                              <View
                                key={modeKey}
                                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                              >
                                <View
                                  style={{
                                    width: 7,
                                    height: 7,
                                    borderRadius: 4,
                                    backgroundColor: TRAIL_ACTIVITY_META[modeKey].color,
                                  }}
                                />
                                <Text style={styles.settingsHint}>
                                  {TRAIL_ACTIVITY_META[modeKey].shortLabel}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    )}

                  {trailMessage && <Text style={styles.settingsHint}>{trailMessage}</Text>}
                </View>
              ) : locationsLoading && locations.length === 0 ? (
                <View style={styles.emptyDrawerBox}>
                  <View style={styles.loadingDrawerRow}>
                    <ActivityIndicator size="small" color={ui.ink} />
                    <Text style={styles.settingsHint}>Loading group members &amp; pins…</Text>
                  </View>
                </View>
              ) : (
                <View style={styles.emptyDrawerBox}>
                  <Text style={styles.settingsHint}>
                    Tap any member above or directly on the map to view Last near at, Last seen
                    at, and their 24h Trail.
                  </Text>
                </View>
              )
            ) : (
              <View style={styles.placesSection}>
                <View style={styles.placesHeaderRow}>
                  <Text style={styles.settingsSectionTitle}>Saved Places</Text>
                  <TouchableOpacity
                    style={styles.addPlacePill}
                    onPress={() => {
                      setPlaceFormOpen((prev) => !prev);
                      setPlaceError(null);
                      setPlaceSuccess(null);
                    }}
                  >
                    <Text style={styles.addPlacePillText}>
                      {placeFormOpen ? 'Close Form' : '+ New Place'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {placeFormOpen && (
                  <View style={styles.placeFormCard}>
                    <Text style={styles.fieldLabel}>Visibility / Share With</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.scopeChipRow}
                    >
                      <TouchableOpacity
                        style={[
                          styles.scopeChip,
                          placeScopeGroupId === 'private' && styles.scopeChipActive,
                        ]}
                        onPress={() => setPlaceScopeGroupId('private')}
                      >
                        <Text
                          style={[
                            styles.scopeChipText,
                            placeScopeGroupId === 'private' && styles.scopeChipTextActive,
                          ]}
                        >
                          Private (Only Me)
                        </Text>
                      </TouchableOpacity>
                      {adminGroups.map((g) => (
                        <TouchableOpacity
                          key={g.id}
                          style={[
                            styles.scopeChip,
                            placeScopeGroupId === g.id && styles.scopeChipActive,
                          ]}
                          onPress={() => setPlaceScopeGroupId(g.id)}
                        >
                          <Text
                            style={[
                              styles.scopeChipText,
                              placeScopeGroupId === g.id && styles.scopeChipTextActive,
                            ]}
                          >
                            Share: {g.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>

                    <Text style={styles.fieldLabel}>Place Name</Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={placeName}
                      onChangeText={setPlaceName}
                      placeholder="Home, School, Office..."
                      placeholderTextColor={ui.placeholder}
                    />

                    <Text style={styles.fieldLabel}>Radius</Text>
                    <View style={styles.radiusRow}>
                      {PLACE_RADIUS_PRESETS.map((r) => (
                        <TouchableOpacity
                          key={r}
                          style={[styles.radiusChip, placeRadius === r && styles.radiusChipActive]}
                          onPress={() => setPlaceRadius(r)}
                        >
                          <Text
                            style={[
                              styles.radiusChipText,
                              placeRadius === r && styles.radiusChipTextActive,
                            ]}
                          >
                            {r >= 1000 ? `${r / 1000} km` : `${r} m`}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    <Text style={styles.fieldLabel}>Location Center</Text>
                    <View style={styles.coordBtnRow}>
                      <TouchableOpacity
                        style={styles.coordActionBtn}
                        onPress={() => {
                          setPickingPlaceCoords(true);
                          snapDrawer('peek');
                        }}
                      >
                        <Text style={styles.coordActionText}>Pick on Map</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.coordActionBtn}
                        onPress={() => void handleUseGpsForPlace()}
                      >
                        <Text style={styles.coordActionText}>Use My GPS</Text>
                      </TouchableOpacity>
                    </View>

                    {placeDraftCoord && (
                      <Text style={styles.detailMetaMono}>
                        Pin: {placeDraftCoord.latitude.toFixed(5)},{' '}
                        {placeDraftCoord.longitude.toFixed(5)}
                      </Text>
                    )}

                    {placeError && <Text style={styles.errorText}>{placeError}</Text>}
                    {placeSuccess && <Text style={styles.successText}>{placeSuccess}</Text>}

                    <TouchableOpacity
                      style={[styles.primaryBlackBtn, placeBusy && styles.btnBusy]}
                      disabled={placeBusy}
                      onPress={() => void handleCreatePlace()}
                    >
                      {placeBusy && <ActivityIndicator size="small" color={ui.ctaText} />}
                      <Text style={styles.primaryBlackText}>
                        {placeBusy ? 'Saving Place...' : 'Save Place'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {!placeFormOpen && placeSuccess && (
                  <Text style={styles.successText}>{placeSuccess}</Text>
                )}
                {!placeFormOpen && placeError && <Text style={styles.errorText}>{placeError}</Text>}

                {placesLoading && places.length === 0 ? (
                  <View style={styles.loadingDrawerRow}>
                    <ActivityIndicator size="small" color={ui.ink} />
                    <Text style={styles.settingsHint}>Loading saved places…</Text>
                  </View>
                ) : places.length === 0 ? (
                  <Text style={styles.settingsHint}>
                    No saved places yet. Tap "+ New Place" to add a private spot or share one with a
                    group.
                  </Text>
                ) : (
                  places.map((p) => {
                    const canDelete = p.isPrivate
                      ? p.createdBy === myUserId
                      : activeGroup?.myRole === 'ADMIN';
                    return (
                      <View
                        key={p.id}
                        style={[
                          styles.placeListItem,
                          selectedPlaceId === p.id && styles.placeListItemActive,
                        ]}
                      >
                        <TouchableOpacity
                          style={styles.flexOne}
                          onPress={() => {
                            setSelectedPlaceId(p.id);
                            cameraRef.current?.flyTo({
                              center: [p.longitude, p.latitude],
                              zoom: 15,
                              duration: 550,
                            });
                          }}
                        >
                          <View style={styles.placeTitleRow}>
                            <Text style={styles.settingsSectionTitle} numberOfLines={1}>
                              {p.name}
                            </Text>
                            <View
                              style={[
                                styles.placeScopeTag,
                                p.isPrivate ? styles.placeTagPrivate : styles.placeTagShared,
                              ]}
                            >
                              <Text
                                style={[
                                  styles.placeScopeTagText,
                                  p.isPrivate
                                    ? styles.placeTagTextPrivate
                                    : styles.placeTagTextShared,
                                ]}
                              >
                                {p.isPrivate
                                  ? 'Private'
                                  : p.groupName ?? activeGroup?.name ?? 'Group'}
                              </Text>
                            </View>
                          </View>
                          <Text style={styles.detailMetaMono}>
                            {p.latitude.toFixed(4)}, {p.longitude.toFixed(4)} ·{' '}
                            {Math.round(p.radiusMeters)}m
                          </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.shareOpenBtn}
                          onPress={() =>
                            void handleOpenCoordsInDefaultMaps(p.latitude, p.longitude, p.name)
                          }
                        >
                          <Text style={styles.shareOpenBtnText}>Maps</Text>
                        </TouchableOpacity>

                        {canDelete && (
                          <TouchableOpacity
                            style={styles.placeDeleteBtn}
                            disabled={deletingPlaceId === p.id}
                            onPress={() => void handleDeletePlace(p.id)}
                          >
                            {deletingPlaceId === p.id ? (
                              <ActivityIndicator size="small" color={ui.errorText} />
                            ) : (
                              <Text style={styles.placeDeleteText}>Remove</Text>
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })
                )}
              </View>
            )}
          </ScrollView>
        )}

        {/* Clean 3-Tab Bottom Bar (Trails + Places + Chat) */}
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tabItem, drawerMode === 'trails' && styles.tabItemActive]}
            onPress={() => {
              if (drawerMode === 'trails') {
                setDrawerMode('people');
                snapDrawer(selectedMemberId ? 'mid' : 'peek');
              } else {
                setDrawerMode('trails');
                if (drawerSnapRef.current === 'peek') snapDrawer('mid');
                if (memberTrailPoints.length === 0) {
                  void fetchGroupTrails(trailTimeRange, activeTrailUserId, { fitOnLoad: true });
                }
              }
            }}
          >
            <View style={styles.chatTabRow}>
              <TrailsTabIcon
                active={drawerMode === 'trails'}
                activeColor={ui.ink}
                inactiveColor={ui.inkMuted}
              />
              <Text style={[styles.tabLabel, drawerMode === 'trails' && styles.tabLabelActive]}>
                Trails
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabItem, drawerMode === 'places' && styles.tabItemActive]}
            onPress={() => {
              if (drawerMode === 'places') {
                setDrawerMode('people');
                snapDrawer(selectedMemberId ? 'mid' : 'peek');
              } else {
                setDrawerMode('places');
                if (drawerSnapRef.current === 'peek') snapDrawer('mid');
              }
            }}
          >
            <View style={styles.chatTabRow}>
              <PlacesTabIcon
                active={drawerMode === 'places'}
                activeColor={ui.ink}
                inactiveColor={ui.inkMuted}
              />
              <Text style={[styles.tabLabel, drawerMode === 'places' && styles.tabLabelActive]}>
                Places{places.length > 0 ? ` (${places.length})` : ''}
              </Text>
            </View>
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
              <ChatTabIcon
                active={chatOpen}
                activeColor={ui.ink}
                inactiveColor={ui.inkMuted}
              />
              <Text style={styles.tabLabel}>
                Chat{messages.length > 0 ? ` (${messages.length})` : ''}
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
      </Animated.View>
      )}

      {/* Google Maps-Style User Profile & App Hub Modal */}
      <Modal
        visible={profileHubOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setProfileHubOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
          <View style={[styles.sheetBackdrop, { marginBottom: insets.bottom }]}>
            <View style={[styles.sheetCard, styles.profileHubCard]}>
              <View style={styles.sheetHeaderRow}>
                <View style={styles.hubIdentityRow}>
                  <View style={[styles.hubAvatarCircle, { borderColor: selfHaloColor }]}>
                    {selfAvatarUrl ? (
                      <Image source={{ uri: selfAvatarUrl }} style={styles.topAvatarImg} />
                    ) : (
                      <Text style={styles.hubAvatarInitial}>
                        {(userProfile?.username ?? 'U').slice(0, 1).toUpperCase()}
                      </Text>
                    )}
                  </View>
                  <View style={styles.flexOne}>
                    <Text style={styles.modalTitle} numberOfLines={1}>
                      {userProfile?.username ?? 'Account'}
                    </Text>
                    <Text style={styles.modalSubtitle} numberOfLines={1}>
                      {userProfile?.email ?? ''} · {formatServerHostLabel(serverUrl)}
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.closePill}
                  onPress={() => setProfileHubOpen(false)}
                >
                  <Text style={styles.closeText}>Done</Text>
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={styles.hubScroll}>
                {hubStatusMsg && (
                  <View style={styles.hubFeedbackBanner}>
                    <Text style={styles.hubFeedbackText}>{hubStatusMsg}</Text>
                  </View>
                )}

                {activeGroup && (
                  <View style={styles.hubSectionCard}>
                    <Text style={styles.fieldLabel}>
                      Sharing Mode · {activeGroup.name}
                    </Text>
                    <View style={styles.segmentedRow}>
                      {(['EXACT', 'FUZZED', 'GHOST'] as PrivacyMode[]).map((mode) => {
                        const savingThis = privacySavingMode === mode;
                        const active = activeGroup.myPrivacy === mode || savingThis;
                        return (
                          <TouchableOpacity
                            key={mode}
                            disabled={Boolean(privacySavingMode)}
                            style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                            onPress={() => void handlePrivacyChange(mode)}
                          >
                            {savingThis ? (
                              <ActivityIndicator
                                size="small"
                                color={active ? ui.ctaText : ui.ink}
                              />
                            ) : (
                              <Text
                                style={[styles.segmentText, active && styles.segmentTextActive]}
                              >
                                {mode}
                              </Text>
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <Text style={styles.settingsHint}>
                      Syncs immediately with desktop and group maps.
                    </Text>
                  </View>
                )}

                <View style={styles.hubSectionCard}>
                  <View style={styles.hubSectionHeader}>
                    <Text style={styles.fieldLabel}>Groups</Text>
                    <TouchableOpacity
                      onPress={() => {
                        setProfileHubOpen(false);
                        openJoinQrModal(false);
                      }}
                    >
                      <Text style={styles.hubInlineLink}>+ Join via QR</Text>
                    </TouchableOpacity>
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.scopeChipRow}
                  >
                    {groups.map((grp) => {
                      const active = grp.id === activeGroup?.id;
                      return (
                        <TouchableOpacity
                          key={grp.id}
                          style={[styles.scopeChip, active && styles.scopeChipActive]}
                          onPress={() => {
                            setActiveGroupId(grp.id);
                            void saveStoredConfig({ activeGroupId: grp.id });
                          }}
                        >
                          <Text
                            style={[styles.scopeChipText, active && styles.scopeChipTextActive]}
                          >
                            {grp.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>

                <TouchableOpacity
                  style={styles.menuRow}
                  onPress={() => void handleToggleTracking()}
                >
                  <View style={styles.flexOne}>
                    <Text style={styles.settingsSectionTitle}>
                      {tracking ? 'Live GPS Sharing: On' : 'Live GPS Sharing: Paused'}
                    </Text>
                    <Text style={styles.settingsHint}>
                      {queuedCount > 0
                        ? `${queuedCount} offline pings queued`
                        : 'Tap to start or pause location broadcasts'}
                    </Text>
                  </View>
                  <Text style={styles.menuRowAction}>{tracking ? 'Pause' : 'Start'}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.menuRow}
                  onPress={() => {
                    setProfileHubOpen(false);
                    setLocationPromptMsg(null);
                    setLocationPromptOpen(true);
                  }}
                >
                  <View style={styles.flexOne}>
                    <Text style={styles.settingsSectionTitle}>Location Permission</Text>
                    <Text style={styles.settingsHint}>
                      {permissionInfo?.label ?? 'Check Always Allow background access'}
                    </Text>
                  </View>
                  <Text style={styles.menuRowAction}>Manage →</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.menuRow}
                  onPress={() => {
                    setProfileHubOpen(false);
                    openAccountModal();
                  }}
                >
                  <View style={styles.flexOne}>
                    <Text style={styles.settingsSectionTitle}>Account, Photo & Colors</Text>
                    <Text style={styles.settingsHint}>
                      1:1 photo crop, halo/fuzz colors, backup email & password
                    </Text>
                  </View>
                  <Text style={styles.menuRowAction}>Edit →</Text>
                </TouchableOpacity>

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
                    setProfileHubOpen(false);
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
                            onThemePreferenceChange?.(pref);
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
                  onPress={() => void handleCheckOta()}
                >
                  <View style={styles.flexOne}>
                    <Text style={styles.settingsSectionTitle}>App & OTA Updates</Text>
                    <Text style={styles.settingsHint}>Installed v{INSTALLED_APP_VERSION}</Text>
                  </View>
                  <Text style={styles.menuRowAction}>Check →</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.signOutFullBtn}
                  onPress={async () => {
                    setProfileHubOpen(false);
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
        </View>
      </Modal>

      {/* Quick Group Switcher Modal */}
      <Modal
        visible={groupSwitcherOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setGroupSwitcherOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
          <View style={[styles.sheetBackdrop, { marginBottom: insets.bottom }]}>
            <View style={[styles.sheetCard, { paddingBottom: 20 }]}>
              <View style={styles.sheetHeaderRow}>
                <Text style={styles.modalTitle}>Switch Group</Text>
                <TouchableOpacity
                  style={styles.closePill}
                  onPress={() => setGroupSwitcherOpen(false)}
                >
                  <Text style={styles.closeText}>Done</Text>
                </TouchableOpacity>
              </View>
              {groups.map((grp) => {
                const selected = grp.id === activeGroup?.id;
                return (
                  <TouchableOpacity
                    key={grp.id}
                    style={[styles.sheetOptionBtn, selected && styles.sheetOptionSelected]}
                    onPress={() => {
                      setActiveGroupId(grp.id);
                      void saveStoredConfig({ activeGroupId: grp.id });
                      setGroupSwitcherOpen(false);
                    }}
                  >
                    <View style={styles.flexOne}>
                      <Text
                        style={[styles.settingsSectionTitle, selected && { color: ui.ctaText }]}
                      >
                        {grp.name}
                      </Text>
                      <Text
                        style={[
                          styles.settingsHint,
                          selected && {
                            color: resolvedMapTheme === 'dark' ? '#52525b' : '#d4d4d8',
                          },
                        ]}
                      >
                        Sharing mode: {grp.myPrivacy}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={styles.outlineBlackBtn}
                onPress={() => {
                  setGroupSwitcherOpen(false);
                  openJoinQrModal(false);
                }}
              >
                <Text style={styles.outlineBlackText}>Join Group via QR</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Location Permission Recommendation Prompt */}
      <Modal
        visible={locationPromptOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setLocationPromptOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
          <View style={[styles.sheetBackdrop, { marginBottom: insets.bottom }]}>
            <View style={[styles.sheetCard, { paddingBottom: 22 }]}>
              <View style={styles.sheetHeaderRow}>
                <Text style={styles.modalTitle}>Location Access</Text>
                <TouchableOpacity
                  style={styles.closePill}
                  onPress={() => setLocationPromptOpen(false)}
                >
                  <Text style={styles.closeText}>Later</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.locationPromptBody}>
                We recommend choosing <Text style={styles.boldText}>Allow all the time</Text> so
                the server can keep your group updated even when the app runs in the background. You
                can also test with one-time / while-using access instead.
              </Text>

              {locationPromptMsg && <Text style={styles.errorText}>{locationPromptMsg}</Text>}

              <TouchableOpacity
                style={[styles.primaryBlackBtn, locationPromptBusy && styles.btnBusy]}
                disabled={Boolean(locationPromptBusy)}
                onPress={() => void handleGrantAlwaysLocation()}
              >
                {locationPromptBusy === 'always' && (
                  <ActivityIndicator size="small" color={ui.ctaText} />
                )}
                <Text style={styles.primaryBlackText}>
                  Allow All the Time (Recommended)
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.outlineBlackBtn, locationPromptBusy && styles.btnBusy]}
                disabled={Boolean(locationPromptBusy)}
                onPress={() => void handleGrantOneTimeLocation()}
              >
                {locationPromptBusy === 'once' && (
                  <ActivityIndicator size="small" color={ui.ink} />
                )}
                <Text style={styles.outlineBlackText}>
                  Allow Once / While Using (Test)
                </Text>
              </TouchableOpacity>

              {permissionInfo && !permissionInfo.canAskAgain && (
                <TouchableOpacity
                  style={styles.settingsLinkBtn}
                  onPress={() => void Linking.openSettings()}
                >
                  <Text style={styles.removePhotoText}>Open Phone Location Settings</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Group Chat Sheet Modal */}
      <Modal visible={chatOpen} animationType="slide" onRequestClose={() => setChatOpen(false)}>
        <View pointerEvents="box-none" style={styles.flexOne}>
          <View
            style={[
              styles.modalWrap,
              { paddingTop: Math.max(insets.top + 8, 48), marginBottom: insets.bottom },
            ]}
          >
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>{activeGroup?.name ?? 'Group'} Chat</Text>
                <Text style={styles.modalSubtitle}>
                  {messagesLoading && messages.length === 0
                    ? 'Loading messages…'
                    : `${messages.length} messages`}
                </Text>
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
                {messagesLoading && chatDisplayItems.length === 0 ? (
                  <View style={[styles.chatEmptyWrap, { gap: 10 }]}>
                    <ActivityIndicator size="small" color={ui.ink} />
                    <Text style={styles.chatEmptyText}>
                      Loading messages for {activeGroup?.name ?? 'your group'}…
                    </Text>
                  </View>
                ) : chatDisplayItems.length === 0 ? (
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

              <View style={[styles.chatComposer, { paddingBottom: 14 }]}>
                <TextInput
                  style={styles.chatInput}
                  value={chatText}
                  onChangeText={setChatText}
                  placeholder={activeGroup ? 'Message group...' : 'Select a group'}
                  placeholderTextColor={ui.placeholder}
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

      {/* Account Settings Modal (with 1:1 Disk Photo Picker + Wheel ColorPickerSheet) */}
      <Modal
        visible={accountOpen}
        animationType="slide"
        onRequestClose={() => setAccountOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
          <View
            style={[
              styles.modalWrap,
              { paddingTop: Math.max(insets.top + 8, 48), marginBottom: insets.bottom },
            ]}
          >
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Account & Appearance</Text>
                <Text style={styles.modalSubtitle}>Profile photo, colors, email & password</Text>
              </View>
              <TouchableOpacity style={styles.closePill} onPress={() => setAccountOpen(false)}>
                <Text style={styles.closeText}>Done</Text>
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={[styles.settingsScroll, { paddingBottom: 24 }]}>
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
                    <Text style={styles.settingsSectionTitle}>Profile Photo</Text>
                    <Text style={styles.settingsHint}>
                      Attach from device (cropped 1:1) or paste a link.
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                      <TouchableOpacity
                        style={styles.removePhotoBtn}
                        onPress={() => void handlePickSquareAvatar()}
                      >
                        <Text style={styles.removePhotoText}>Choose Photo (1:1)</Text>
                      </TouchableOpacity>
                      {Boolean(editAvatarUrl.trim()) && (
                        <TouchableOpacity
                          style={styles.removePhotoBtn}
                          onPress={() => setEditAvatarUrl('')}
                        >
                          <Text style={styles.removePhotoText}>Remove</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>

                <Text style={styles.fieldLabel}>Photo URL</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={editAvatarUrl}
                  onChangeText={setEditAvatarUrl}
                  autoCapitalize="none"
                  placeholder="https://example.com/photo.jpg"
                  placeholderTextColor={ui.placeholder}
                />

                <Text style={styles.fieldLabel}>Display Name</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={editUsername}
                  onChangeText={setEditUsername}
                  placeholder="Your name"
                  placeholderTextColor={ui.placeholder}
                />

                <Text style={styles.fieldLabel}>Email Address</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={editEmail}
                  onChangeText={setEditEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  placeholder="you@example.com"
                  placeholderTextColor={ui.placeholder}
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
                        borderColor:
                          editHaloColor?.toLowerCase() === hex ? ui.ctaBg : ui.borderStrong,
                      }}
                    />
                  ))}
                  <TouchableOpacity
                    style={styles.removePhotoBtn}
                    onPress={() => setColorPickerTarget('halo')}
                  >
                    <Text style={styles.removePhotoText}>Custom</Text>
                  </TouchableOpacity>
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
                        borderColor:
                          editFuzzCircleColor?.toLowerCase() === hex ? ui.ctaBg : ui.borderStrong,
                      }}
                    />
                  ))}
                  <TouchableOpacity
                    style={styles.removePhotoBtn}
                    onPress={() => setColorPickerTarget('fuzz')}
                  >
                    <Text style={styles.removePhotoText}>Custom</Text>
                  </TouchableOpacity>
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
                  {accountBusy && <ActivityIndicator size="small" color={ui.ctaText} />}
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
                  placeholderTextColor={ui.placeholder}
                />

                <TouchableOpacity
                  style={[styles.primaryBlackBtn, recoveryBusy && styles.btnBusy]}
                  disabled={recoveryBusy}
                  onPress={() => void handleSendRecoveryCode()}
                >
                  {recoveryAction === 'send' && <ActivityIndicator size="small" color={ui.ctaText} />}
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
                      placeholderTextColor={ui.placeholder}
                    />
                    <TouchableOpacity
                      style={[styles.outlineBlackBtn, recoveryBusy && styles.btnBusy]}
                      disabled={recoveryBusy || recoveryCodeInput.trim().length !== 6}
                      onPress={() => void handleVerifyRecoveryEmail()}
                    >
                      {recoveryAction === 'verify' && (
                        <ActivityIndicator size="small" color={ui.ink} />
                      )}
                      <Text style={styles.outlineBlackText}>
                        {recoveryAction === 'verify' ? 'Verifying...' : 'Verify Email'}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}

                {Boolean(userProfile?.recoveryEmail) && (
                  <TouchableOpacity
                    style={[
                      styles.removePhotoBtn,
                      { flexDirection: 'row', alignItems: 'center', gap: 6 },
                    ]}
                    disabled={recoveryBusy}
                    onPress={() => void handleClearRecoveryEmail()}
                  >
                    {recoveryAction === 'clear' && (
                      <ActivityIndicator size="small" color={ui.ink} />
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
                  placeholderTextColor={ui.placeholder}
                />

                <Text style={styles.fieldLabel}>New Password</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  secureTextEntry
                  placeholder="Minimum 8 characters"
                  placeholderTextColor={ui.placeholder}
                />

                <Text style={styles.fieldLabel}>Confirm New Password</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry
                  placeholder="Repeat new password"
                  placeholderTextColor={ui.placeholder}
                />

                {passwordError && <Text style={styles.errorText}>{passwordError}</Text>}
                {passwordMessage && <Text style={styles.successText}>{passwordMessage}</Text>}

                <TouchableOpacity
                  style={[styles.outlineBlackBtn, passwordBusy && styles.btnBusy]}
                  disabled={passwordBusy}
                  onPress={() => void handleChangePassword()}
                >
                  {passwordBusy && <ActivityIndicator size="small" color={ui.ink} />}
                  <Text style={styles.outlineBlackText}>
                    {passwordBusy ? 'Updating Password...' : 'Update Password'}
                  </Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <ColorPickerSheet
        visible={colorPickerTarget !== null}
        initialHex={colorPickerTarget === 'fuzz' ? editFuzzCircleColor : editHaloColor}
        palette={ui}
        fonts={fonts}
        onApply={(hex) => {
          if (colorPickerTarget === 'fuzz') {
            setEditFuzzCircleColor(hex);
          } else {
            setEditHaloColor(hex);
          }
          setColorPickerTarget(null);
        }}
        onClose={() => setColorPickerTarget(null)}
      />

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
                placeholderTextColor={ui.placeholder}
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
                {shareLinksLoading && shareLinks.length === 0 ? (
                  <View style={styles.loadingDrawerRow}>
                    <ActivityIndicator size="small" color={ui.ink} />
                    <Text style={styles.settingsHint}>Loading share links…</Text>
                  </View>
                ) : shareLinks.length === 0 && shareLinksLoaded ? (
                  <Text style={styles.settingsHint}>No active share links yet.</Text>
                ) : null}
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

      {/* Offline Map Cache Modal */}
      <Modal
        visible={offlineModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOfflineModalOpen(false)}
      >
        <View pointerEvents="box-none" style={styles.flexOne}>
          <View style={[styles.sheetBackdrop, { marginBottom: insets.bottom }]}>
            <View style={[styles.sheetCard, { paddingBottom: 20 }]}>
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

              {offlineMessage && <Text style={styles.successText}>{offlineMessage}</Text>}

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
          <View
            style={[
              styles.modalWrap,
              { paddingTop: Math.max(insets.top + 8, 48), marginBottom: insets.bottom },
            ]}
          >
            {qrScanning ? (
              <View style={styles.scannerFull}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={(res) => void handleMobileQrScanned(res)}
                />
                <View style={[styles.scannerOverlayBar, { bottom: 24 }]}>
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
                        {qrLoading && <ActivityIndicator size="small" color={ui.ctaText} />}
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
                          placeholderTextColor={ui.placeholder}
                        />
                        {qrError && <Text style={styles.errorText}>{qrError}</Text>}
                        <TouchableOpacity
                          style={[styles.outlineBlackBtn, qrLoading && styles.btnBusy]}
                          disabled={qrLoading || !qrPasteInput.trim()}
                          onPress={() => void resolveMobileInvite(qrPasteInput)}
                        >
                          {qrLoading && <ActivityIndicator size="small" color={ui.ink} />}
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

export function createMobileStyles(
  resolvedTheme: ResolvedMobileMapTheme,
  ui: OnboardingPalette = getOnboardingPalette(resolvedTheme),
) {
  const isDark = resolvedTheme === 'dark';
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: isDark ? '#0c141d' : '#cfe3ee' },
    map: { flex: 1 },
    marker: { alignItems: 'center' },
    markerLabel: {
      backgroundColor: isDark ? 'rgba(24, 24, 27, 0.94)' : 'rgba(255, 255, 255, 0.96)',
      color: ui.ink,
      fontSize: 11,
      fontWeight: '700',
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      marginBottom: 4,
      borderWidth: 1,
      borderColor: ui.borderStrong,
      overflow: 'hidden',
    },
    markerLabelSelected: {
      backgroundColor: ui.ctaBg,
      color: ui.ctaText,
      borderColor: ui.ctaBg,
    },
    placeMarkerLabel: {
      fontSize: 10,
      fontWeight: '700',
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 8,
      marginBottom: 3,
      borderWidth: 1,
      overflow: 'hidden',
    },
    placeMarkerPrivate: {
      backgroundColor: isDark ? 'rgba(30, 27, 75, 0.94)' : 'rgba(238, 242, 255, 0.96)',
      color: isDark ? '#c7d2fe' : '#3730a3',
      borderColor: isDark ? '#4338ca' : '#c7d2fe',
    },
    placeMarkerGroup: {
      backgroundColor: isDark ? 'rgba(19, 78, 74, 0.94)' : 'rgba(240, 253, 250, 0.96)',
      color: isDark ? '#99f6e4' : '#115e59',
      borderColor: isDark ? '#0f766e' : '#99f6e4',
    },
    placeMarkerDot: {
      width: 14,
      height: 14,
      borderRadius: 999,
      borderWidth: 2.5,
      backgroundColor: ui.surface,
    },
    draftPlacePin: {
      width: 18,
      height: 18,
      borderRadius: 999,
      backgroundColor: ui.ctaBg,
      borderWidth: 3,
      borderColor: ui.surface,
    },
    markerHalo: {
      width: 24,
      height: 24,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#0f172a',
      shadowOpacity: 0.18,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 4,
    },
    markerDot: { width: 12, height: 12, borderRadius: 999 },
    dotExact: { backgroundColor: ui.ink },
    dotFuzzed: { backgroundColor: '#d97706' },
    selfMarkerLabel: {
      backgroundColor: ui.ctaBg,
      color: ui.ctaText,
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
      borderWidth: 2,
      borderColor: '#ffffff',
      alignItems: 'center',
      justifyContent: 'center',
    },
    selfMarkerDot: {
      width: 12,
      height: 12,
      borderRadius: 999,
      borderWidth: 2,
      borderColor: '#ffffff',
    },
    avatarRing: {
      width: 36,
      height: 36,
      borderRadius: 999,
      borderWidth: 2.5,
      backgroundColor: '#18181b',
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 6,
      elevation: 4,
    },
    avatarRingSelected: {
      width: 42,
      height: 42,
      borderWidth: 3,
    },
    avatarRingSelf: {
      width: 36,
      height: 36,
      borderRadius: 999,
      borderWidth: 2.5,
      backgroundColor: '#18181b',
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 6,
      elevation: 4,
    },
    markerAvatarImg: { width: '100%', height: '100%' },
    topOverlay: {
      position: 'absolute',
      left: 14,
      right: 14,
      gap: 10,
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    groupPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      maxWidth: '66%',
      backgroundColor: isDark ? 'rgba(24, 24, 27, 0.94)' : 'rgba(255, 255, 255, 0.94)',
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderWidth: 1,
      borderColor: ui.borderStrong,
      shadowColor: '#000000',
      shadowOpacity: isDark ? 0.35 : 0.1,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    },
    groupPillName: { color: ui.ink, fontSize: 13, fontWeight: '700', flexShrink: 1 },
    groupPillChevron: { color: ui.inkMuted, fontSize: 12, fontWeight: '700' },
    pickingBanner: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: 'rgba(24, 24, 27, 0.94)',
      borderRadius: 999,
      borderWidth: isDark ? 1 : 0,
      borderColor: ui.borderStrong,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    pickingBannerText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
    pickingCancelText: { color: '#93c5fd', fontSize: 12, fontWeight: '700' },
    profileAvatarBtn: {
      width: 44,
      height: 44,
      borderRadius: 999,
      borderWidth: 2.5,
      backgroundColor: '#18181b',
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000000',
      shadowOpacity: isDark ? 0.38 : 0.2,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 5,
    },
    topAvatarImg: { width: '100%', height: '100%' },
    topAvatarInitial: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
    floatingControlsWrap: {
      position: 'absolute',
      left: 14,
      gap: 10,
      alignItems: 'flex-start',
    },
    floatingControlsRail: {
      gap: 10,
      alignItems: 'center',
    },
    mapActionBtn: {
      width: 48,
      height: 48,
      borderRadius: 999,
      backgroundColor: isDark ? 'rgba(24, 24, 27, 0.94)' : 'rgba(255, 255, 255, 0.96)',
      borderWidth: 1,
      borderColor: ui.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000000',
      shadowOpacity: isDark ? 0.36 : 0.14,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    mapActionBtnActive: {
      backgroundColor: ui.ctaBg,
      borderColor: ui.ctaBg,
    },
    mapOptionsPopover: {
      width: 244,
      borderRadius: 14,
      padding: 12,
      gap: 10,
      backgroundColor: isDark ? 'rgba(24, 24, 27, 0.96)' : 'rgba(255, 255, 255, 0.97)',
      borderWidth: 1,
      borderColor: ui.borderStrong,
      shadowColor: '#000000',
      shadowOpacity: isDark ? 0.42 : 0.16,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
      elevation: 8,
    },
    mapOptionsHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    mapOptionsTitle: {
      color: ui.inkMuted,
      fontSize: 11,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    mapOptionsCloseText: {
      color: ui.ink,
      fontSize: 12,
      fontWeight: '700',
    },
    mapOptionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    mapOptionsLabel: {
      color: ui.ink,
      fontSize: 12,
      fontWeight: '600',
    },
    mapOptionsPillBtn: {
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 5,
      backgroundColor: ui.surfaceMuted,
      borderWidth: 1,
      borderColor: ui.border,
    },
    mapOptionsPillBtnActive: {
      backgroundColor: ui.ctaBg,
      borderColor: ui.ctaBg,
    },
    mapOptionsPillText: {
      color: ui.inkMuted,
      fontSize: 11,
      fontWeight: '700',
    },
    mapOptionsPillTextActive: {
      color: ui.ctaText,
    },
    mapOptionsSegment: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      borderRadius: 9,
      padding: 2,
      backgroundColor: ui.surfaceMuted,
    },
    mapOptionsSegBtn: {
      borderRadius: 7,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    mapOptionsSegBtnActive: {
      backgroundColor: ui.ctaBg,
    },
    mapOptionsSegText: {
      color: ui.inkMuted,
      fontSize: 11,
      fontWeight: '700',
    },
    mapOptionsSegTextActive: {
      color: ui.ctaText,
    },
    pinLiveBadge: {
      position: 'absolute',
      bottom: 6,
      right: 6,
      width: 8,
      height: 8,
      borderRadius: 999,
      backgroundColor: '#10b981',
      borderWidth: 1.5,
      borderColor: ui.surface,
    },
    floatingBadge: {
      position: 'absolute',
      top: -4,
      right: -4,
      backgroundColor: ui.ctaBg,
      borderRadius: 999,
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    floatingBadgeText: { color: ui.ctaText, fontSize: 10, fontWeight: '700' },
    chatToastBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      backgroundColor: 'rgba(24, 24, 27, 0.95)',
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.15)',
      shadowColor: '#000000',
      shadowOpacity: 0.24,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    loadingPillBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'center',
      gap: 8,
      backgroundColor: isDark ? 'rgba(24, 24, 27, 0.95)' : 'rgba(255, 255, 255, 0.96)',
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: ui.borderStrong,
      shadowColor: '#000000',
      shadowOpacity: 0.14,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 5,
    },
    loadingPillText: {
      color: ui.ink,
      fontSize: 12,
      fontWeight: '600',
    },
    loadingDrawerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 4,
    },
    chatToastTextWrap: { flex: 1 },
    chatToastSender: { color: '#e4e4e7', fontSize: 11, fontWeight: '700' },
    chatToastBody: { color: '#ffffff', fontSize: 13, fontWeight: '500', marginTop: 1 },
    chatToastAction: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
    bottomSheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: ui.surface,
      borderTopWidth: isDark ? 1 : 0,
      borderTopColor: ui.border,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: 16,
      paddingBottom: 12,
      shadowColor: '#000000',
      shadowOpacity: isDark ? 0.45 : 0.14,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: -4 },
      elevation: 12,
    },
    sheetDragArea: {
      paddingTop: 10,
      paddingBottom: 6,
      gap: 8,
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 40,
      height: 4.5,
      borderRadius: 999,
      backgroundColor: ui.borderStrong,
    },
    drawerHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    drawerHeaderTitle: {
      color: ui.ink,
      fontSize: 15,
      fontWeight: '700',
      flex: 1,
    },
    drawerCollapseText: {
      color: ui.inkMuted,
      fontSize: 12,
      fontWeight: '700',
    },
    memberStripScroll: {
      flexGrow: 0,
      marginBottom: 8,
    },
    memberStrip: {
      gap: 8,
      paddingVertical: 2,
    },
    memberChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: ui.surfaceMuted,
      borderColor: ui.border,
      borderWidth: 1,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    memberChipSelected: {
      backgroundColor: ui.ctaBg,
      borderColor: ui.ctaBg,
    },
    memberChipAvatar: { width: 18, height: 18, borderRadius: 999 },
    memberChipDot: { width: 7, height: 7, borderRadius: 999 },
    memberChipText: { color: ui.ink, fontSize: 12, fontWeight: '600' },
    memberChipTextSelected: { color: ui.ctaText },
    openMapsBtn: {
      backgroundColor: ui.ctaBg,
      borderRadius: 10,
      paddingHorizontal: 11,
      paddingVertical: 8,
      justifyContent: 'center',
    },
    openMapsBtnText: {
      color: ui.ctaText,
      fontSize: 12,
      fontWeight: '700',
    },
    shareInput: {
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      color: ui.ink,
    },
    shareLinkCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      padding: 10,
    },
    shareOpenBtn: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surface,
      paddingHorizontal: 9,
      paddingVertical: 7,
    },
    shareOpenBtnText: {
      color: ui.ink,
      fontSize: 11,
      fontWeight: '700',
    },
    shareRevokeBtn: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.errorBorder,
      backgroundColor: ui.errorBg,
      paddingHorizontal: 8,
      paddingVertical: 7,
    },
    shareRevokeBtnText: {
      color: ui.errorText,
      fontSize: 11,
      fontWeight: '700',
    },
    drawerBodyScroll: { flex: 1 },
    drawerBodyContent: { paddingBottom: 10, gap: 10 },
    memberDetailCard: {
      backgroundColor: ui.surfaceMuted,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: ui.border,
      padding: 14,
      gap: 8,
    },
    memberDetailHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    memberDetailIdentity: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    memberDetailName: { color: ui.ink, fontSize: 16, fontWeight: '700' },
    privacyStatusPill: {
      backgroundColor: ui.badgeSuccessBg,
      borderColor: ui.badgeSuccessBorder,
      borderWidth: 1,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    privacyStatusFuzzed: {
      backgroundColor: ui.badgeWarnBg,
      borderColor: ui.badgeWarnBorder,
    },
    privacyStatusText: { color: ui.ink, fontSize: 10, fontWeight: '700' },
    closeMiniText: { color: ui.inkMuted, fontSize: 12, fontWeight: '700' },
    detailMetaRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 10,
    },
    detailMetaLabel: { color: ui.inkMuted, fontSize: 12, fontWeight: '600' },
    detailMetaValue: { color: ui.ink, fontSize: 12, fontWeight: '600', flex: 1, textAlign: 'right' },
    detailMetaMono: {
      color: ui.inkMuted,
      fontSize: 11,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    detailActionRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
    detailTrailBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: ui.ctaBg,
      backgroundColor: ui.surface,
      paddingVertical: 9,
    },
    detailTrailBtnActive: {
      backgroundColor: ui.ctaBg,
    },
    detailTrailBtnText: { color: ui.ink, fontSize: 12, fontWeight: '700' },
    detailTrailBtnTextActive: { color: ui.ctaText },
    trailModePillRow: {
      flexDirection: 'row',
      alignSelf: 'flex-start',
      gap: 4,
      backgroundColor: ui.surfaceChip,
      borderRadius: 9,
      padding: 3,
    },
    trailModePill: {
      borderRadius: 7,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    trailModePillActive: {
      backgroundColor: ui.ctaBg,
    },
    trailModePillText: {
      color: ui.inkMuted,
      fontSize: 11,
      fontWeight: '700',
    },
    trailModePillTextActive: {
      color: ui.ctaText,
    },
    trailPointCard: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      backgroundColor: ui.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: ui.border,
      shadowColor: '#000000',
      shadowOpacity: 0.16,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 5,
    },
    trailPointTitle: {
      color: ui.ink,
      fontSize: 12,
      fontWeight: '700',
    },
    trailPointMeta: {
      color: ui.inkMuted,
      fontSize: 11,
      marginTop: 2,
    },
    trailPointClose: {
      color: ui.ink,
      fontSize: 11,
      fontWeight: '700',
    },
    detailFocusBtn: {
      borderRadius: 10,
      backgroundColor: ui.surfaceChip,
      paddingHorizontal: 14,
      justifyContent: 'center',
    },
    detailFocusBtnText: { color: ui.ink, fontSize: 12, fontWeight: '700' },
    emptyDrawerBox: {
      backgroundColor: ui.surfaceMuted,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      padding: 14,
    },
    placesSection: { gap: 10 },
    placesHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    addPlacePill: {
      backgroundColor: ui.ctaBg,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    addPlacePillText: { color: ui.ctaText, fontSize: 11, fontWeight: '700' },
    placeFormCard: {
      backgroundColor: ui.surfaceMuted,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: ui.border,
      padding: 12,
      gap: 8,
    },
    scopeChipRow: { gap: 6, paddingVertical: 2 },
    scopeChip: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: ui.borderStrong,
      backgroundColor: ui.surface,
      paddingHorizontal: 11,
      paddingVertical: 6,
    },
    scopeChipActive: {
      backgroundColor: ui.ctaBg,
      borderColor: ui.ctaBg,
    },
    scopeChipText: { color: ui.inkSubtle, fontSize: 11, fontWeight: '600' },
    scopeChipTextActive: { color: ui.ctaText },
    radiusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    radiusChip: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.borderStrong,
      backgroundColor: ui.surface,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    radiusChipActive: { backgroundColor: ui.ctaBg, borderColor: ui.ctaBg },
    radiusChipText: { color: ui.inkSubtle, fontSize: 11, fontWeight: '600' },
    radiusChipTextActive: { color: ui.ctaText },
    coordBtnRow: { flexDirection: 'row', gap: 8 },
    coordActionBtn: {
      flex: 1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.ctaBg,
      backgroundColor: ui.surface,
      paddingVertical: 8,
      alignItems: 'center',
    },
    coordActionText: { color: ui.ink, fontSize: 12, fontWeight: '700' },
    placeListItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    placeListItemActive: { borderColor: ui.ctaBg, backgroundColor: ui.surface },
    placeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    placeScopeTag: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
    placeTagPrivate: { backgroundColor: isDark ? 'rgba(99, 102, 241, 0.2)' : '#eef2ff' },
    placeTagShared: { backgroundColor: isDark ? 'rgba(20, 184, 166, 0.2)' : '#f0fdfa' },
    placeScopeTagText: { fontSize: 10, fontWeight: '700' },
    placeTagTextPrivate: { color: isDark ? '#a5b4fc' : '#4338ca' },
    placeTagTextShared: { color: isDark ? '#5eead4' : '#0f766e' },
    placeDeleteBtn: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: ui.errorBg,
    },
    placeDeleteText: { color: ui.errorText, fontSize: 11, fontWeight: '700' },
    tabBar: {
      flexDirection: 'row',
      gap: 8,
      paddingTop: 6,
    },
    tabItem: {
      flex: 1,
      borderRadius: 999,
      paddingVertical: 10,
      alignItems: 'center',
      backgroundColor: ui.surfaceMuted,
    },
    tabItemActive: { backgroundColor: ui.surfaceChip },
    tabLabel: { color: ui.inkSubtle, fontSize: 12, fontWeight: '700' },
    tabLabelActive: { color: ui.ink },
    chatTabRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    unreadBadge: {
      backgroundColor: ui.ctaBg,
      borderRadius: 999,
      minWidth: 18,
      height: 18,
      paddingHorizontal: 5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    unreadBadgeText: { color: ui.ctaText, fontSize: 10, fontWeight: '700' },
    profileHubCard: { maxHeight: '86%' },
    hubIdentityRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, paddingRight: 8 },
    hubAvatarCircle: {
      width: 46,
      height: 46,
      borderRadius: 999,
      borderWidth: 2,
      backgroundColor: '#18181b',
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    hubAvatarInitial: { color: '#ffffff', fontSize: 17, fontWeight: '700' },
    hubScroll: { gap: 10, paddingBottom: 16 },
    hubFeedbackBanner: {
      backgroundColor: ui.surfaceChip,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    hubFeedbackText: { color: ui.ink, fontSize: 12, fontWeight: '600' },
    hubSectionCard: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      padding: 12,
      gap: 8,
    },
    hubSectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    hubInlineLink: { color: ui.ink, fontSize: 12, fontWeight: '700' },
    segmentedRow: {
      flexDirection: 'row',
      gap: 6,
      backgroundColor: isDark ? '#3f3f46' : '#e4e4e7',
      borderRadius: 10,
      padding: 4,
    },
    segmentBtn: {
      flex: 1,
      borderRadius: 7,
      paddingVertical: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segmentBtnActive: { backgroundColor: ui.ctaBg },
    segmentText: { color: ui.inkSubtle, fontSize: 12, fontWeight: '700' },
    segmentTextActive: { color: ui.ctaText },
    locationPromptBody: { color: ui.inkSubtle, fontSize: 14, lineHeight: 20 },
    boldText: { color: ui.ink, fontWeight: '700' },
    settingsLinkBtn: { alignSelf: 'center', paddingVertical: 6 },
    modalWrap: { flex: 1, backgroundColor: ui.canvas, paddingTop: 52 },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 18,
      paddingBottom: 14,
      borderBottomWidth: 1,
      borderBottomColor: ui.border,
    },
    modalTitle: { color: ui.ink, fontSize: 18, fontWeight: '700' },
    modalSubtitle: { color: ui.inkMuted, fontSize: 12 },
    closePill: {
      backgroundColor: ui.surface,
      borderColor: ui.borderStrong,
      borderWidth: 1,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 7,
    },
    closeText: { color: ui.ink, fontSize: 13, fontWeight: '700' },
    chatList: { flex: 1, backgroundColor: ui.canvas },
    chatListContent: { padding: 16, gap: 10 },
    chatEmptyWrap: { paddingVertical: 40, alignItems: 'center' },
    chatEmptyText: { color: ui.inkMuted, fontSize: 13, textAlign: 'center' },
    dateSeparator: { alignItems: 'center', marginVertical: 8 },
    dateSeparatorText: {
      backgroundColor: ui.surfaceChip,
      color: ui.inkSubtle,
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
      backgroundColor: ui.ctaBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chatAvatarInitials: { color: ui.ctaText, fontSize: 11, fontWeight: '700' },
    chatColumn: { maxWidth: '78%' },
    chatColumnMine: { alignItems: 'flex-end' },
    chatColumnOther: { alignItems: 'flex-start' },
    chatMetaHeader: {
      color: ui.inkMuted,
      fontSize: 11,
      fontWeight: '600',
      marginBottom: 3,
      paddingHorizontal: 2,
    },
    chatBubble: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 9 },
    chatBubbleMine: { backgroundColor: ui.ctaBg, borderBottomRightRadius: 4 },
    chatBubbleOther: {
      backgroundColor: ui.surface,
      borderColor: ui.border,
      borderWidth: 1,
      borderBottomLeftRadius: 4,
    },
    chatBody: { fontSize: 14, lineHeight: 19 },
    chatBodyMine: { color: ui.ctaText },
    chatBodyOther: { color: ui.ink },
    chatTimeFooter: { color: ui.inkMuted, fontSize: 10, marginTop: 2, paddingHorizontal: 2 },
    chatTimeFooterMine: { color: ui.inkMuted },
    chatComposer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 24,
      gap: 8,
      backgroundColor: ui.surface,
      borderTopWidth: 1,
      borderTopColor: ui.border,
    },
    chatInput: {
      flex: 1,
      backgroundColor: ui.surfaceMuted,
      borderColor: ui.border,
      borderWidth: 1,
      borderRadius: 999,
      paddingHorizontal: 16,
      paddingVertical: 10,
      color: ui.ink,
      fontSize: 14,
    },
    sendIconBtn: {
      width: 40,
      height: 40,
      borderRadius: 999,
      backgroundColor: ui.ctaBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendIconBtnDisabled: { opacity: 0.4 },
    sendBtnText: { color: ui.ctaText, fontWeight: '700', fontSize: 16 },
    flexOne: { flex: 1 },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: isDark ? 'rgba(0, 0, 0, 0.72)' : 'rgba(9, 9, 11, 0.45)',
      justifyContent: 'flex-end',
    },
    sheetCard: {
      backgroundColor: ui.surface,
      borderTopWidth: isDark ? 1 : 0,
      borderTopColor: ui.border,
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
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      padding: 14,
    },
    sheetOptionSelected: { backgroundColor: ui.ctaBg, borderColor: ui.ctaBg },
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    menuRowAction: { color: ui.ink, fontSize: 12, fontWeight: '700' },
    themeSegmentGroup: {
      flexDirection: 'row',
      backgroundColor: isDark ? '#3f3f46' : '#e4e4e7',
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
      backgroundColor: ui.ctaBg,
    },
    themeSegmentText: {
      fontSize: 11,
      fontWeight: '600',
      color: ui.inkSubtle,
    },
    themeSegmentTextActive: {
      color: ui.ctaText,
    },
    progressTrack: {
      height: 8,
      borderRadius: 999,
      backgroundColor: ui.borderStrong,
      overflow: 'hidden',
    },
    progressFill: { height: '100%', borderRadius: 999, backgroundColor: ui.ctaBg },
    settingsScroll: { padding: 16, gap: 14, paddingBottom: 40 },
    settingsCard: {
      backgroundColor: ui.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
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
    settingsSectionTitle: { color: ui.ink, fontSize: 14, fontWeight: '700' },
    settingsHint: { color: ui.inkMuted, fontSize: 12 },
    removePhotoBtn: {
      alignSelf: 'flex-start',
      backgroundColor: ui.surfaceChip,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 5,
      marginTop: 2,
    },
    removePhotoText: { color: ui.ink, fontSize: 11, fontWeight: '600' },
    fieldLabel: { color: ui.inkMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
    fieldInput: {
      backgroundColor: ui.surfaceMuted,
      borderColor: ui.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: ui.ink,
      fontSize: 14,
    },
    errorText: { color: ui.errorText, fontSize: 12, fontWeight: '600' },
    successText: { color: ui.badgeSuccessText, fontSize: 12, fontWeight: '600' },
    primaryBlackBtn: {
      flexDirection: 'row',
      backgroundColor: ui.ctaBg,
      borderRadius: 999,
      paddingVertical: 12,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 4,
    },
    primaryBlackText: { color: ui.ctaText, fontSize: 13, fontWeight: '700' },
    outlineBlackBtn: {
      flexDirection: 'row',
      backgroundColor: ui.secondaryBg,
      borderColor: ui.ctaBg,
      borderWidth: 1.5,
      borderRadius: 999,
      paddingVertical: 11,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 4,
    },
    outlineBlackText: { color: ui.ink, fontSize: 13, fontWeight: '700' },
    btnBusy: { opacity: 0.72 },
    signOutFullBtn: {
      backgroundColor: ui.surface,
      borderColor: ui.errorBorder,
      borderWidth: 1,
      borderRadius: 999,
      paddingVertical: 13,
      alignItems: 'center',
    },
    signOutFullText: { color: ui.errorText, fontSize: 13, fontWeight: '700' },
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
    previewGroupName: { color: ui.ink, fontSize: 18, fontWeight: '700' },
    skipPromptText: { color: ui.ink, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  });
}
