import { describe, expect, it, vi } from 'vitest';
import appConfig from '../../app.json';
import {
  createInMemoryQueueStorage,
  enqueueLocationPoints,
  flushOfflineLocations,
  getPendingLocationCount,
  postBackgroundAuthedJson,
} from '../services/offlineQueue';
import {
  BACKGROUND_WATCHDOG_TASK,
  evaluateAdaptiveTrackingTransition,
  runWatchdogCheck,
  type WatchdogAdapter,
} from '../services/adaptiveTracking';
import {
  buildMobileMapStyle,
  buildPmtilesSourceUrl,
  estimateOfflineRegionSize,
  formatCacheBytes,
  resolveMobileMapTheme,
} from '../services/pmtilesStyle';
import {
  BACKGROUND_GEOFENCE_RECOVERY_TASK,
  BACKGROUND_LOCATION_TASK,
  buildRecoveryGeofenceRegion,
  GEOFENCING_EVENT_EXIT,
  type GeofenceRecoveryAdapter,
  handleGeofenceRecoveryEvent,
  RECOVERY_GEOFENCE_IDENTIFIER,
  shouldRefreshRecoveryAnchor,
  syncRecoveryGeofenceAnchor,
} from '../services/geofenceRecovery';
import {
  clearPendingRegistration,
  clearSessionConfig,
  createMemoryKeyValueStore,
  extractInviteCandidateFromUrl,
  getBackgroundTrackingEnabled,
  getMapThemePreference,
  getPendingRegistration,
  getPingedServers,
  getRecoveryGeofenceAnchor,
  getStoredConfig,
  isPendingRecordActive,
  parseAndBindQrInvite,
  saveMapThemePreference,
  savePendingRegistration,
  saveRecoveryGeofenceAnchor,
  saveStoredConfig,
  setBackgroundTrackingEnabled,
} from '../services/secureConfig';
import {
  createMobileShareLink,
  listMobileShareLinks,
  resolveMobileShareUrl,
  revokeMobileShareLink,
} from '../services/shareLinks';
import {
  formatServerHostLabel,
  getDefaultServerUrl,
  getGeometricFonts,
  getOnboardingPalette,
  hexToHsv,
  hsvToHex,
  validateAuthForm,
} from '../services/onboardingTheme';
import {
  checkMobileAppVersion,
  formatAppUpdateNotice,
  INSTALLED_APP_VERSION,
} from '../services/appVersion';
import { groupChatMessagesForDisplay } from '../services/chatFormatting';
import { formatUserError } from '../services/errorFormatter';
import {
  getLocationPermissionStatus,
  requestLocationPermissionsOnLaunch,
} from '../services/locationPermissions';
import {
  describeLastNearPlace,
  describeMemberStatus,
  findNearestPlace,
  formatLastSeenRelative,
  normalizeBearingDegrees,
} from '../services/memberDetails';
import { computeSafeAreaInsets } from '../services/safeAreaMath';

describe('@loved-ones/mobile-app', () => {
  it('parses QR invite JSON and binds serverUrl into secure store', async () => {
    const store = createMemoryKeyValueStore();
    const payload = await parseAndBindQrInvite(
      JSON.stringify({
        v: 1,
        serverUrl: 'https://track.example.com/',
        inviteToken: 'inv_9f8a7d6c5b4a3f2e1d',
        groupName: 'Family Group',
      }),
      store,
    );

    expect(payload.serverUrl).toBe('https://track.example.com');
    expect(payload.inviteToken).toBe('inv_9f8a7d6c5b4a3f2e1d');

    const stored = await getStoredConfig(store);
    expect(stored.serverUrl).toBe('https://track.example.com');
  });

  it('parses web invite URLs and binds origin as serverUrl', async () => {
    const store = createMemoryKeyValueStore();
    const payload = await parseAndBindQrInvite(
      'https://home.lovedones.local:8443/join?token=inv_abc12345',
      store,
    );
    expect(payload.serverUrl).toBe('https://home.lovedones.local:8443');
    expect(payload.inviteToken).toBe('inv_abc12345');
  });

  it('queues offline GPS points and flushes them in batches', async () => {
    const storage = createInMemoryQueueStorage();
    await enqueueLocationPoints(
      [
        {
          latitude: 37.7749,
          longitude: -122.4194,
          batteryLevel: 81,
          recordedAt: '2026-11-14T22:00:00.000Z',
        },
        {
          latitude: 37.7751,
          longitude: -122.4191,
          batteryLevel: 80,
          recordedAt: '2026-11-14T22:01:00.000Z',
        },
      ],
      storage,
    );
    expect(await getPendingLocationCount(storage)).toBe(2);

    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ inserted: 2 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await flushOfflineLocations(
      'https://track.example.com/',
      'jwt-token',
      storage,
      mockFetch,
    );

    expect(result).toEqual({ flushed: 2, remaining: 0 });
    expect(await getPendingLocationCount(storage)).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('builds remote and local cached PMTiles URLs and MapLibre style', () => {
    expect(buildPmtilesSourceUrl('https://track.example.com/')).toBe(
      'pmtiles://https://track.example.com/tiles/region.pmtiles',
    );
    expect(buildPmtilesSourceUrl('https://track.example.com', 'file:///data/user/0/region.pmtiles')).toBe(
      'pmtiles://file:///data/user/0/region.pmtiles',
    );

    const style = buildMobileMapStyle('https://track.example.com');
    expect(style.sprite).toBe('https://track.example.com/tiles/sprites/maki');
    expect(style.glyphs).toBe(
      'https://track.example.com/tiles/fonts/{fontstack}/{range}.pbf',
    );
    const roadLabels = style.layers.find((l) => l.id === 'road-labels');
    expect(roadLabels?.type).toBe('symbol');
    expect((roadLabels as { layout?: { 'text-field'?: unknown } })?.layout?.['text-field']).toEqual([
      'coalesce',
      ['get', 'name:en'],
      ['get', 'name'],
    ]);
    const healthMajor = style.layers.find((l) => l.id === 'pois-health-major');
    expect(
      (healthMajor as { layout?: { 'icon-image'?: unknown } })?.layout?.['icon-image'],
    ).toBeDefined();
    const localStyle = buildMobileMapStyle('https://track.example.com', null, 'local');
    const localRoadLabels = localStyle.layers.find((l) => l.id === 'road-labels');
    expect(
      (localRoadLabels as { layout?: { 'text-field'?: unknown } })?.layout?.['text-field'],
    ).toEqual(['coalesce', ['get', 'name'], ['get', 'name:en']]);
    expect(style.sources.openmaptiles).toEqual({
      type: 'vector',
      url: 'pmtiles://https://track.example.com/tiles/region.pmtiles',
    });

    const compositeStyle = buildMobileMapStyle('https://track.example.com', null, 'en', true);
    expect(compositeStyle.sources.openmaptiles).toEqual({
      type: 'vector',
      tiles: ['https://track.example.com/api/maps/tiles/{z}/{x}/{y}.pbf'],
      minzoom: 0,
      maxzoom: 15,
    });
  });

  it('requests foreground + background permissions on launch and falls back to foreground when Always Allow is denied', async () => {
    const always = await requestLocationPermissionsOnLaunch({
      async requestForegroundPermissionsAsync() {
        return { status: 'granted', canAskAgain: true };
      },
      async requestBackgroundPermissionsAsync() {
        return { status: 'granted', canAskAgain: true };
      },
    });
    expect(always.level).toBe('always');

    const foregroundFallback = await requestLocationPermissionsOnLaunch({
      async requestForegroundPermissionsAsync() {
        return { status: 'granted', canAskAgain: true };
      },
      async requestBackgroundPermissionsAsync() {
        return { status: 'denied', canAskAgain: false };
      },
    });
    expect(foregroundFallback.level).toBe('foreground');
    expect(foregroundFallback.label).toContain('Foreground Fallback');

    const denied = await requestLocationPermissionsOnLaunch({
      async requestForegroundPermissionsAsync() {
        return { status: 'denied', canAskAgain: true };
      },
      async requestBackgroundPermissionsAsync() {
        return { status: 'denied', canAskAgain: true };
      },
    });
    expect(denied.level).toBe('denied');
  });

  it('detects outdated APK/IPA installs when server reports a newer mobile release', async () => {
    expect(INSTALLED_APP_VERSION).toBe(appConfig.expo.version);
    expect(INSTALLED_APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const mockFetch = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/api/auth/app-version?platform=android&version=0.1.0');
      return new Response(
        JSON.stringify({
          serverVersion: '0.2.0',
          minSupportedVersion: '0.1.5',
          latestMobileVersion: '0.2.0',
          updateAvailable: true,
          updateRequired: true,
          downloadUrl: 'https://github.com/Dowiw/LovedOnes/releases/latest',
          releaseNotes: 'Trail averaging and remote updates',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const info = await checkMobileAppVersion(
      'https://track.example.com/',
      '0.1.0',
      'android',
      mockFetch,
    );
    expect(info?.updateAvailable).toBe(true);
    expect(info?.updateRequired).toBe(true);
    expect(info?.latestMobileVersion).toBe('0.2.0');

    const notice = formatAppUpdateNotice(info!, '0.1.0');
    expect(notice.title).toContain('0.2.0');
    expect(notice.body).toContain('0.1.0');
  });

  it('sanitizes raw JS/network/HTTP errors into human-readable messages', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(formatUserError(new TypeError('Network request failed'))).toBe(
        'Unable to reach the server. Check your internet connection or server URL.',
      );
      expect(formatUserError(new SyntaxError('JSON Parse error: Unexpected character: <'))).toBe(
        'Received an unexpected response from the server. Verify your server address.',
      );
      expect(
        formatUserError(
          new SyntaxError('Unexpected token'),
          'Invalid invite code or QR format. Please scan a valid LovedOnes invite.',
        ),
      ).toBe('Invalid invite code or QR format. Please scan a valid LovedOnes invite.');
      expect(formatUserError(new Error('HTTP 401'))).toBe(
        "Your session expired or you don't have permission for this action.",
      );
      expect(formatUserError(new Error('HTTP 403'))).toBe(
        "Your session expired or you don't have permission for this action.",
      );
      expect(formatUserError(new Error('Already in this group'))).toBe('Already in this group');

      const store = createMemoryKeyValueStore();
      await expect(parseAndBindQrInvite('not-json-or-url', store)).rejects.toThrow(
        'Invalid invite code or QR format. Please scan a valid LovedOnes invite.',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('computes safe-area insets for Android 3-button/gesture nav bars and iOS', () => {
    const android3Btn = computeSafeAreaInsets('android', 24, 800, 728);
    expect(android3Btn.top).toBe(28);
    expect(android3Btn.bottom).toBe(72);

    const androidEdgeToEdge = computeSafeAreaInsets('android', 33, 832, 832);
    expect(androidEdgeToEdge.top).toBe(33);
    expect(androidEdgeToEdge.bottom).toBe(48);

    const iosInsets = computeSafeAreaInsets('ios', null, 844, 844);
    expect(iosInsets.top).toBe(48);
    expect(iosInsets.bottom).toBe(34);
  });

  it('estimates offline PMTiles cache sizes and formats grouped chat messages', async () => {
    expect(formatCacheBytes(0)).toBe('0 B');
    expect(formatCacheBytes(512 * 1024)).toBe('512.0 KB');
    expect(formatCacheBytes(42.5 * 1024 * 1024)).toBe('42.5 MB');

    const headMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null, { status: 200, headers: { 'content-length': '44564480' } });
    }) as unknown as typeof fetch;
    expect(
      await estimateOfflineRegionSize('https://track.example.com', '/tiles/berlin.pmtiles', 123, headMock),
    ).toBe(44564480);

    const failingFetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(
      await estimateOfflineRegionSize('https://track.example.com', '/tiles/berlin.pmtiles', 2048, failingFetch),
    ).toBe(2048);

    const now = new Date('2026-11-20T22:00:00.000Z');
    const grouped = groupChatMessagesForDisplay(
      [
        {
          id: 'm1',
          groupId: 'g1',
          senderId: 'u-kb',
          senderUsername: 'KB',
          senderAvatarUrl: null,
          content: 'Hey',
          createdAt: '2026-11-19T21:00:00.000Z',
        },
        {
          id: 'm2',
          groupId: 'g1',
          senderId: 'u-kb',
          senderUsername: 'KB',
          senderAvatarUrl: null,
          content: 'On my way',
          createdAt: '2026-11-20T20:10:00.000Z',
        },
        {
          id: 'm3',
          groupId: 'g1',
          senderId: 'u-kb',
          senderUsername: 'KB',
          senderAvatarUrl: null,
          content: 'Almost there',
          createdAt: '2026-11-20T20:11:00.000Z',
        },
        {
          id: 'm4',
          groupId: 'g1',
          senderId: 'u-me',
          senderUsername: 'Me',
          senderAvatarUrl: null,
          content: 'Great!',
          createdAt: '2026-11-20T20:12:00.000Z',
        },
      ],
      'u-me',
      now,
    );

    expect(grouped).toHaveLength(4);
    expect(grouped[0].showDateSeparator).toBe(true);
    expect(grouped[0].dateLabel).toBe('Yesterday');
    expect(grouped[0].showSenderHeader).toBe(true);
    expect(grouped[0].senderInitials).toBe('KB');
    expect(grouped[1].showDateSeparator).toBe(true);
    expect(grouped[1].dateLabel).toBe('Today');
    expect(grouped[1].showSenderHeader).toBe(true);
    expect(grouped[2].showSenderHeader).toBe(false);
    expect(grouped[3].isMine).toBe(true);
    expect(grouped[3].showSenderHeader).toBe(false);
    expect(grouped[3].compactTime).toMatch(/^\d{2}:\d{2}$/);
  });

  it('supports lovedones:// deep links and preserves serverUrl on sign-out', async () => {
    const deepLink =
      'lovedones://join?token=inv_deep1234&serverUrl=https%3A%2F%2Ffamily.example.com%2F&groupName=HomeCircle';
    expect(extractInviteCandidateFromUrl(deepLink)).toBe(deepLink);
    expect(extractInviteCandidateFromUrl('https://family.example.com/join?token=inv_web123')).toBe(
      'https://family.example.com/join?token=inv_web123',
    );
    expect(extractInviteCandidateFromUrl('https://family.example.com/')).toBeNull();

    const store = createMemoryKeyValueStore();
    const parsed = await parseAndBindQrInvite(deepLink, store);
    expect(parsed.serverUrl).toBe('https://family.example.com');
    expect(parsed.inviteToken).toBe('inv_deep1234');
    expect(parsed.groupName).toBe('HomeCircle');

    await saveStoredConfig(
      {
        accessToken: 'acc_1',
        refreshToken: 'ref_1',
        activeGroupId: 'grp_1',
        user: { id: 'u1', email: 'a@b.com', username: 'Sam', role: 'USER' },
      },
      store,
    );
    await clearSessionConfig(store);

    const afterSignOut = await getStoredConfig(store);
    expect(afterSignOut.serverUrl).toBe('https://family.example.com');
    expect(afterSignOut.accessToken).toBeNull();
    expect(afterSignOut.refreshToken).toBeNull();
    expect(afterSignOut.user).toBeNull();
    expect(afterSignOut.activeGroupId).toBeNull();
  });

  it('provides monochrome light/dark onboarding tokens and friendly form validation', () => {
    const light = getOnboardingPalette('light');
    const dark = getOnboardingPalette('dark');
    expect(light.canvas).toBe('#f4f4f5');
    expect(light.ctaBg).toBe('#18181b');
    expect(light.statusBarStyle).toBe('dark');
    expect(dark.canvas).toBe('#09090b');
    expect(dark.ctaBg).toBe('#fafafa');
    expect(dark.statusBarStyle).toBe('light');

    expect(formatServerHostLabel('https://track.example.com/')).toBe('track.example.com');
    expect(formatServerHostLabel('http://localhost:8080/')).toBe('localhost:8080');
    expect(getDefaultServerUrl('android')).toBe('http://localhost:8080');
    expect(getDefaultServerUrl('ios')).toBe('http://localhost:8080');

    expect(
      validateAuthForm({
        mode: 'login',
        serverUrl: 'not-a-url',
        email: 'a@b.com',
        username: '',
        password: 'secret',
      }),
    ).toContain('server address');

    expect(
      validateAuthForm({
        mode: 'register',
        serverUrl: 'https://track.example.com',
        email: 'a@b.com',
        username: '   ',
        password: 'password123',
      }),
    ).toContain('display name');

    expect(
      validateAuthForm({
        mode: 'register',
        serverUrl: 'https://track.example.com',
        email: 'a@b.com',
        username: 'Sam',
        password: 'short',
      }),
    ).toContain('8 characters');

    expect(
      validateAuthForm({
        mode: 'register',
        serverUrl: 'https://track.example.com',
        email: 'a@b.com',
        username: 'Sam',
        password: 'password123',
      }),
    ).toBeNull();

    expect(getGeometricFonts('ios').display).toContain('AvenirNext');
    expect(getGeometricFonts('android').display).toBe('sans-serif-medium');
  });

  it('tracks pending registration requests and prevents re-pinging the same server within 24h', async () => {
    const store = createMemoryKeyValueStore();
    const now = Date.now();
    const activeExpires = new Date(now + 12 * 60 * 60 * 1000).toISOString();
    const expiredAt = new Date(now - 1000).toISOString();

    const record = {
      requestId: '11111111-1111-4111-8111-111111111111',
      serverUrl: 'https://home.example.com/',
      email: 'newbie@example.com',
      username: 'Alex',
      haloColor: '#0ea5e9',
      status: 'PENDING' as const,
      createdAt: new Date(now).toISOString(),
      expiresAt: activeExpires,
    };

    const mapAfterFirst = await savePendingRegistration(record, store);
    expect(Object.keys(mapAfterFirst)).toEqual(['https://home.example.com']);
    expect(isPendingRecordActive(await getPendingRegistration(store), now)).toBe(true);

    // Expired entries are automatically pruned by getPingedServers
    const mapAfterExpiry = await getPingedServers(store, new Date(activeExpires).getTime() + 1000);
    expect(Object.keys(mapAfterExpiry)).toEqual([]);
    expect(isPendingRecordActive({ ...record, expiresAt: expiredAt }, now)).toBe(false);

    // Clearing the server removes it from pingedServers
    const cleared = await clearPendingRegistration('https://home.example.com', store);
    expect(Object.keys(cleared)).toEqual([]);
    expect(await getPendingRegistration(store)).toBeNull();
  });

  it('converts between HSV and hex colors for custom accent selection', () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe('#00ff00');
    const roundtrip = hexToHsv('#0ea5e9');
    expect(hsvToHex(roundtrip)).toMatch(/^#[0-9a-f]{6}$/);
    expect(Math.round(roundtrip.h)).toBe(199);
  });

  it('resolves Auto/Light/Dark mobile map themes, persists preference, and configures Android adaptive icons', async () => {
    const store = createMemoryKeyValueStore();
    expect(await getMapThemePreference(store)).toBe('system');
    await saveMapThemePreference('dark', store);
    expect(await getMapThemePreference(store)).toBe('dark');

    expect(resolveMobileMapTheme('system', 'dark')).toBe('dark');
    expect(resolveMobileMapTheme('system', 'light')).toBe('light');
    expect(resolveMobileMapTheme('light', 'dark')).toBe('light');
    expect(resolveMobileMapTheme('dark', 'light')).toBe('dark');

    const darkStyle = buildMobileMapStyle('https://track.example.com', null, 'en', false, 'dark');
    const bgLayer = darkStyle.layers?.find((l) => l.id === 'background') as
      | { paint?: Record<string, unknown> }
      | undefined;
    const earthLayer = darkStyle.layers?.find((l) => l.id === 'earth') as
      | { paint?: Record<string, unknown> }
      | undefined;
    expect(bgLayer?.paint?.['background-color']).toBe('#0c141d');
    expect(earthLayer?.paint?.['fill-color']).toBe('#111318');

    expect(appConfig.expo.icon).toBe('./assets/icon.png');
    expect(appConfig.expo.ios.icon).toBe('./assets/icon.png');
    expect(appConfig.expo.splash.image).toBe('./assets/icon.png');
    expect(appConfig.expo.notification.icon).toBe('./assets/monochrome-icon.png');
    expect(appConfig.expo.android.adaptiveIcon.foregroundImage).toBe('./assets/adaptive-icon.png');
    expect(appConfig.expo.android.adaptiveIcon.monochromeImage).toBe('./assets/monochrome-icon.png');
  });

  it('creates, lists, resolves, and revokes mobile guest share links', async () => {
    const sampleItem = {
      token: 'shr_abcdef0123456789abcdef',
      groupId: '22222222-2222-4222-8222-222222222222',
      groupName: 'Family',
      label: 'Festival Meetup',
      allowGuestSharing: true,
      activeGuestCount: 2,
      expiresAt: '2026-11-22T00:00:00.000Z',
      createdAt: '2026-11-21T23:00:00.000Z',
      shareUrl: 'https://track.example.com/share/shr_abcdef0123456789abcdef',
    };

    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/api/realtime/share-links') && init?.method === 'POST') {
        return new Response(JSON.stringify({ link: sampleItem }), { status: 201 });
      }
      if (target.endsWith('/api/realtime/share-links')) {
        return new Response(JSON.stringify({ links: [sampleItem] }), { status: 200 });
      }
      if (target.includes('/api/realtime/share-links/shr_') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ revoked: true }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const created = await createMobileShareLink(
      'https://track.example.com/',
      'access-jwt',
      {
        groupId: sampleItem.groupId,
        durationMinutes: 60,
        label: 'Festival Meetup',
        allowGuestSharing: true,
      },
      mockFetch,
    );
    expect(created.token).toBe(sampleItem.token);
    expect(resolveMobileShareUrl('https://track.example.com/', created)).toBe(
      'https://track.example.com/share/shr_abcdef0123456789abcdef',
    );

    const list = await listMobileShareLinks('https://track.example.com', 'access-jwt', mockFetch);
    expect(list).toHaveLength(1);
    expect(list[0]?.activeGuestCount).toBe(2);

    const revoked = await revokeMobileShareLink(
      'https://track.example.com',
      'access-jwt',
      sampleItem.token,
      mockFetch,
    );
    expect(revoked).toBe(true);
  });

  it('normalizes map bearing and computes member Last Near and Last Seen summaries', () => {
    expect(normalizeBearingDegrees(360)).toBe(0);
    expect(normalizeBearingDegrees(-190)).toBe(170);
    expect(normalizeBearingDegrees(270)).toBe(-90);

    const nowMs = Date.parse('2026-11-21T16:00:00.000Z');
    expect(formatLastSeenRelative('2026-11-21T15:59:45.000Z', nowMs)).toContain('Just now');
    expect(formatLastSeenRelative('2026-11-21T15:52:00.000Z', nowMs)).toContain('8m ago');

    const places = [
      {
        id: 'p1',
        groupId: null,
        groupName: null,
        isPrivate: true,
        name: 'Home Base',
        latitude: 52.52,
        longitude: 13.405,
        radiusMeters: 200,
        createdBy: 'u1',
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ];
    const match = findNearestPlace({ latitude: 52.5205, longitude: 13.4052 }, places);
    expect(match?.inside).toBe(true);
    expect(
      describeLastNearPlace({
        userId: 'u1',
        latitude: 52.5205,
        longitude: 13.4052,
        isFuzzed: false,
        places,
        transitions: [],
        nowMs,
      }),
    ).toBe('Inside Home Base · Private');

    expect(
      describeLastNearPlace({
        userId: 'u1',
        latitude: 52.53,
        longitude: 13.41,
        isFuzzed: true,
        places,
        transitions: [],
        nowMs,
      }),
    ).toContain('FUZZED');
  });

  it('inspects current location permission level silently without prompting', async () => {
    const statusAlways = await getLocationPermissionStatus({
      async requestForegroundPermissionsAsync() {
        return { status: 'granted' };
      },
      async requestBackgroundPermissionsAsync() {
        return { status: 'granted' };
      },
      async getForegroundPermissionsAsync() {
        return { status: 'granted', canAskAgain: true };
      },
      async getBackgroundPermissionsAsync() {
        return { status: 'granted', canAskAgain: true };
      },
    });
    expect(statusAlways.level).toBe('always');

    const statusDenied = await getLocationPermissionStatus({
      async requestForegroundPermissionsAsync() {
        return { status: 'denied' };
      },
      async requestBackgroundPermissionsAsync() {
        return { status: 'denied' };
      },
      async getForegroundPermissionsAsync() {
        return { status: 'denied', canAskAgain: false };
      },
      async getBackgroundPermissionsAsync() {
        return { status: 'denied', canAskAgain: false };
      },
    });
    expect(statusDenied.level).toBe('denied');
    expect(statusDenied.canAskAgain).toBe(false);
  });

  it('resolves mobile UI dark/light palettes from explicit and system theme preferences', async () => {
    const store = createMemoryKeyValueStore();
    expect(await getMapThemePreference(store)).toBe('system');

    await saveMapThemePreference('dark', store);
    const savedPref = await getMapThemePreference(store);
    expect(savedPref).toBe('dark');

    const resolvedDark = resolveMobileMapTheme(savedPref, 'light');
    expect(resolvedDark).toBe('dark');

    const darkPalette = getOnboardingPalette(resolvedDark);
    const lightPalette = getOnboardingPalette(resolveMobileMapTheme('light', 'dark'));

    expect(darkPalette.scheme).toBe('dark');
    expect(darkPalette.statusBarStyle).toBe('light');
    expect(darkPalette.canvas).toBe('#09090b');
    expect(darkPalette.surface).toBe('#18181b');
    expect(darkPalette.ink).toBe('#fafafa');
    expect(lightPalette.scheme).toBe('light');
    expect(lightPalette.statusBarStyle).toBe('dark');
    expect(lightPalette.surface).toBe('#ffffff');
    expect(lightPalette.ink).toBe('#18181b');
  });

  it('arms, shifts, and recovers background tracking on iOS geofence-exit wake-ups', async () => {
    const store = createMemoryKeyValueStore();
    await saveStoredConfig(
      { serverUrl: 'https://track.example.com', accessToken: 'jwt-1' },
      store,
    );
    await setBackgroundTrackingEnabled(true, store);
    expect(await getBackgroundTrackingEnabled(store)).toBe(true);

    let geofenceStarted = false;
    let continuousStarted = false;
    let permissionLevel: 'always' | 'foreground' | 'denied' = 'always';
    let lastRegions: unknown[] = [];
    const ingested: Array<{ lat: number; lon: number }> = [];

    let currentPos = {
      coords: { latitude: 52.5225, longitude: 13.405, altitude: 34, accuracy: 12, speed: 1.5 },
      timestamp: Date.parse('2026-11-22T12:00:00.000Z'),
    };

    const startGeofencingSpy = vi.fn(async (_task: string, regions: unknown[]) => {
      geofenceStarted = true;
      lastRegions = regions;
    });
    const stopGeofencingSpy = vi.fn(async () => {
      geofenceStarted = false;
      lastRegions = [];
    });
    const startContinuousSpy = vi.fn(async () => {
      continuousStarted = true;
    });

    const adapter: GeofenceRecoveryAdapter = {
      hasStartedGeofencingAsync: async (t) => t === BACKGROUND_GEOFENCE_RECOVERY_TASK && geofenceStarted,
      startGeofencingAsync: startGeofencingSpy,
      stopGeofencingAsync: stopGeofencingSpy,
      hasStartedLocationUpdatesAsync: async (t) => t === BACKGROUND_LOCATION_TASK && continuousStarted,
      startContinuousLocationUpdatesAsync: startContinuousSpy,
      getCurrentPositionAsync: async () => currentPos,
      getLastKnownPositionAsync: async () => currentPos,
      getBackgroundPermissionLevel: async () => permissionLevel,
      isTrackingEnabled: () => getBackgroundTrackingEnabled(store),
      hasActiveSession: async () => {
        const cfg = await getStoredConfig(store);
        return Boolean(cfg.serverUrl && cfg.accessToken);
      },
      getAnchor: () => getRecoveryGeofenceAnchor(store),
      saveAnchor: (anchor) => saveRecoveryGeofenceAnchor(anchor, store),
      ingestPosition: async (pos) => {
        ingested.push({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
    };

    // 1. Builds exit-only anchor region with clamped bounds and hysteresis
    const region = buildRecoveryGeofenceRegion(52.52, 13.405, 80);
    expect(region.identifier).toBe(RECOVERY_GEOFENCE_IDENTIFIER);
    expect(region.radius).toBe(150);
    expect(region.notifyOnEnter).toBe(false);
    expect(region.notifyOnExit).toBe(true);
    expect(shouldRefreshRecoveryAnchor(null, 0, 0)).toBe(false);

    // 2. Arms initial anchor and ignores tiny movements (< 125m)
    expect(await syncRecoveryGeofenceAnchor(52.52, 13.405, adapter)).toBe(true);
    expect(startGeofencingSpy).toHaveBeenCalledTimes(1);
    expect(lastRegions).toHaveLength(1);
    expect(await syncRecoveryGeofenceAnchor(52.5202, 13.4051, adapter)).toBe(false);
    expect(startGeofencingSpy).toHaveBeenCalledTimes(1);

    // 3. Re-centers anchor when device moves >= 125m
    expect(await syncRecoveryGeofenceAnchor(52.5218, 13.405, adapter)).toBe(true);
    expect(startGeofencingSpy).toHaveBeenCalledTimes(2);

    // 4. Ignores non-exit or errored geofence events
    const ignored = await handleGeofenceRecoveryEvent({ eventType: 1 }, null, adapter);
    expect(ignored.recovered).toBe(false);

    // 5. Simulates OS termination where continuous updates stopped, then user exits fence
    continuousStarted = false;
    const recovered = await handleGeofenceRecoveryEvent(
      { eventType: GEOFENCING_EVENT_EXIT, region: { identifier: RECOVERY_GEOFENCE_IDENTIFIER } },
      null,
      adapter,
    );
    expect(recovered).toEqual({
      recovered: true,
      continuousRestarted: true,
      reanchored: true,
    });
    expect(continuousStarted).toBe(true);
    expect(ingested).toEqual([{ lat: 52.5225, lon: 13.405 }]);
    const savedAnchor = await getRecoveryGeofenceAnchor(store);
    expect(savedAnchor?.latitude).toBe(52.5225);

    // 6. Paused tracking or sign-out tears down geofence and refuses background re-arm
    await setBackgroundTrackingEnabled(false, store);
    const pausedOutcome = await handleGeofenceRecoveryEvent(
      { eventType: GEOFENCING_EVENT_EXIT },
      null,
      adapter,
    );
    expect(pausedOutcome.recovered).toBe(false);
    expect(stopGeofencingSpy).toHaveBeenCalled();
    expect(await getRecoveryGeofenceAnchor(store)).toBeNull();

    // 7. clearSessionConfig wipes persisted tracking state and anchor
    await setBackgroundTrackingEnabled(true, store);
    await saveRecoveryGeofenceAnchor(
      { latitude: 52.52, longitude: 13.4, radiusMeters: 250, updatedAt: '2026-11-22T12:00:00.000Z' },
      store,
    );
    permissionLevel = 'always';
    await clearSessionConfig(store);
    expect(await getBackgroundTrackingEnabled(store)).toBe(false);
    expect(await getRecoveryGeofenceAnchor(store)).toBeNull();
  });

  it('transitions adaptively between moving and stationary idle modes and runs watchdog recovery', async () => {
    // App config registers expo-background-task plugin
    expect(appConfig.expo.plugins).toContain('expo-background-task');
    expect(BACKGROUND_WATCHDOG_TASK).toBe('LOVED_ONES_BACKGROUND_WATCHDOG_TASK');

    // 1. Adaptive mode transitions: moving -> >=60s within 20m -> idle -> >=20m moved -> moving
    const t0 = 1_700_000_000_000;
    const step1 = evaluateAdaptiveTrackingTransition(null, 52.52, 13.405, t0);
    expect(step1.nextMode).toBe('moving');

    const step2 = evaluateAdaptiveTrackingTransition(step1.nextState, 52.52003, 13.40503, t0 + 30_000);
    expect(step2.nextMode).toBe('moving');
    expect(step2.modeChanged).toBe(false);

    const step3 = evaluateAdaptiveTrackingTransition(step2.nextState, 52.52004, 13.40502, t0 + 65_000);
    expect(step3.nextMode).toBe('idle');
    expect(step3.modeChanged).toBe(true);

    const step4 = evaluateAdaptiveTrackingTransition(step3.nextState, 52.5205, 13.405, t0 + 365_000);
    expect(step4.nextMode).toBe('moving');
    expect(step4.modeChanged).toBe(true);

    // 2. Watchdog checks permission_denied, gps_off, interrupted restart, queue flush, and idle heartbeat
    let perm: 'always' | 'foreground' | 'denied' = 'foreground';
    let servicesOn = true;
    let continuousActive = true;
    let restartThrows = false;
    let pendingCount = 0;
    const heartbeats: Array<{ state: string; battery: number | null }> = [];

    const adapter: WatchdogAdapter = {
      isTrackingEnabled: async () => true,
      hasActiveSession: async () => true,
      getBackgroundPermissionLevel: async () => perm,
      hasLocationServicesEnabled: async () => servicesOn,
      isContinuousLocationActive: async () => continuousActive,
      startContinuousLocationUpdates: async () => {
        if (restartThrows) throw new Error('FGS blocked');
        continuousActive = true;
      },
      getPendingLocationCount: async () => pendingCount,
      flushOfflineLocations: async () => {
        pendingCount = 0;
      },
      getBatteryLevel: async () => 16,
      sendHeartbeat: async (state, battery) => {
        heartbeats.push({ state, battery });
      },
    };

    expect((await runWatchdogCheck(adapter)).action).toBe('permission_denied');
    perm = 'always';
    servicesOn = false;
    expect((await runWatchdogCheck(adapter)).action).toBe('gps_off');

    servicesOn = true;
    continuousActive = false;
    restartThrows = true;
    expect((await runWatchdogCheck(adapter)).action).toBe('interrupted');

    restartThrows = false;
    expect((await runWatchdogCheck(adapter)).action).toBe('restarted_and_synced');

    pendingCount = 3;
    expect((await runWatchdogCheck(adapter)).action).toBe('flushed_queue');

    expect((await runWatchdogCheck(adapter)).action).toBe('heartbeat_sent');
    expect(heartbeats).toEqual([
      { state: 'permission_denied', battery: 16 },
      { state: 'gps_off', battery: 16 },
      { state: 'interrupted', battery: 16 },
      { state: 'idle', battery: 16 },
      { state: 'idle', battery: 16 },
    ]);

    // 3. Background auth POST refreshes expired accessToken via /api/auth/refresh and retries
    let callCount = 0;
    const savedTokens: Array<{ accessToken: string; refreshToken: string }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      const u = String(url);
      if (u.endsWith('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' }),
          { status: 200 },
        );
      }
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer fresh-access');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const refreshedRes = await postBackgroundAuthedJson(
      'https://track.example.com',
      '/api/realtime/heartbeat',
      'expired-access',
      { trackingState: 'idle', batteryLevel: 16 },
      mockFetch,
      {
        refreshToken: 'valid-refresh',
        onTokensRefreshed: async (t) => {
          savedTokens.push(t);
        },
      },
    );
    expect(refreshedRes.status).toBe(200);
    expect(savedTokens).toEqual([{ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' }]);

    // 4. describeMemberStatus surfaces Idle at Place for EXACT and hides Place names for FUZZED
    const nowMs = Date.parse('2026-11-22T15:43:00.000Z');
    const status = describeMemberStatus({
      latitude: 52.5205,
      longitude: 13.4052,
      recordedAt: '2026-11-22T15:06:00.000Z',
      lastHeartbeatAt: '2026-11-22T15:41:00.000Z',
      trackingState: 'idle',
      isFuzzed: false,
      places: [
        {
          id: 'p1',
          groupId: null,
          groupName: null,
          isPrivate: true,
          name: 'Dowi Home',
          latitude: 52.52,
          longitude: 13.405,
          radiusMeters: 200,
          createdBy: 'u1',
          createdAt: '2026-11-20T00:00:00.000Z',
        },
      ],
      nowMs,
    });
    expect(status.kind).toBe('idle_at_place');
    expect(status.detailText).toContain('Idle at Dowi Home');
  });
});
