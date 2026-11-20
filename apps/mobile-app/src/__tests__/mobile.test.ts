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
} from '../services/pmtilesStyle';
import {
  createMemoryKeyValueStore,
  getStoredConfig,
  parseAndBindQrInvite,
} from '../services/secureConfig';
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
    expect(android3Btn.bottom).toBe(48);

    const androidGesture = computeSafeAreaInsets('android', 28, 844, 816);
    expect(androidGesture.bottom).toBe(28);

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
});
