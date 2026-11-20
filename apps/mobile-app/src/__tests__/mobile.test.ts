import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryQueueStorage,
  enqueueLocationPoints,
  flushOfflineLocations,
  getPendingLocationCount,
} from '../services/offlineQueue';
import { buildMobileMapStyle, buildPmtilesSourceUrl } from '../services/pmtilesStyle';
import {
  createMemoryKeyValueStore,
  getStoredConfig,
  parseAndBindQrInvite,
} from '../services/secureConfig';
import { requestLocationPermissionsOnLaunch } from '../services/locationPermissions';

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
    expect(style.glyphs).toBe(
      'https://track.example.com/tiles/fonts/{fontstack}/{range}.pbf',
    );
    expect(style.layers.some((l) => l.id === 'road-labels' && l.type === 'symbol')).toBe(true);
    expect(style.sources.openmaptiles).toEqual({
      type: 'vector',
      url: 'pmtiles://https://track.example.com/tiles/region.pmtiles',
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
});
