import { describe, expect, it, vi } from 'vitest';
import appConfig from '../../app.json';
import {
  createInMemoryQueueStorage,
  enqueueLocationPoints,
  flushOfflineLocations,
  getPendingLocationCount,
} from '../services/offlineQueue';
import {
  buildMobileMapStyle,
  buildPmtilesSourceUrl,
  estimateOfflineRegionSize,
  formatCacheBytes,
  resolveMobileMapTheme,
} from '../services/pmtilesStyle';
import {
  clearPendingRegistration,
  clearSessionConfig,
  createMemoryKeyValueStore,
  extractInviteCandidateFromUrl,
  getMapThemePreference,
  getPendingRegistration,
  getPingedServers,
  getStoredConfig,
  isPendingRecordActive,
  parseAndBindQrInvite,
  saveMapThemePreference,
  savePendingRegistration,
  saveStoredConfig,
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
import { requestLocationPermissionsOnLaunch } from '../services/locationPermissions';
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
});
