import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetchForgotPasswordStatus,
  apiUpdateProfile,
  formatBytes,
  getLogsWsUrl,
  getServiceBaseUrls,
} from '../lib/api';

describe('@loved-ones/web-dashboard helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formats byte counts cleanly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.00 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });

  it('builds relative gateway paths and log WebSocket URL when unconfigured', () => {
    const urls = getServiceBaseUrls();
    expect(urls).toEqual({ authBase: '', realtimeBase: '', tilesBase: '' });
    expect(getLogsWsUrl('abc')).toBe('/api/admin/logs/stream?token=abc');
  });

  it('refreshes expired accessToken automatically on 401 and retries profile update', async () => {
    const storage = new Map<string, string>();
    const storedSession = {
      accessToken: 'expired-access',
      refreshToken: 'valid-refresh',
      user: { id: 'u1', email: 'a@b.com', username: 'KB', role: 'HOST_ADMIN' },
    };
    storage.set('lovedones_session_v1', JSON.stringify(storedSession));

    const fakeWindow = {
      location: { port: '8080', protocol: 'http:', hostname: 'localhost', host: 'localhost:8080' },
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => {
          storage.set(k, v);
        },
        removeItem: (k: string) => {
          storage.delete(k);
        },
      },
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('CustomEvent', class CustomEvent {
      detail: unknown;
      type: string;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });

    const updatedSession = {
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      user: { id: 'u1', email: 'a@b.com', username: 'KB2', role: 'HOST_ADMIN', avatarUrl: null },
    };

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/me' && init?.method === 'PATCH') {
        const auth = new Headers(init.headers).get('Authorization');
        if (auth === 'Bearer expired-access') {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
        return new Response(JSON.stringify(updatedSession), { status: 200 });
      }
      if (url === '/api/auth/refresh') {
        return new Response(
          JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiUpdateProfile('expired-access', { username: 'KB2' });
    expect(res.user.username).toBe('KB2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fetches forgot-password SMTP availability from the auth endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/forgot-password/status') {
        return new Response(JSON.stringify({ emailRecoveryAvailable: false }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const status = await apiFetchForgotPasswordStatus();
    expect(status).toEqual({ emailRecoveryAvailable: false });
  });

  it('holds coarse startup geolocation fixes until accuracy improves or warmup completes', async () => {
    const { createGeoWarmupGate } = await import('../lib/geoWarmup');
    const gate = createGeoWarmupGate({
      maxWarmupSamples: 3,
      maxWarmupWindowMs: 12_000,
      acceptableAccuracyMeters: 120,
    });

    const t0 = 1_700_000_000_000;
    // Fix 1 is coarse (450m Wi-Fi/IP) -> held locally while refining
    const r1 = gate.evaluate(
      { latitude: 52.51, longitude: 13.5, accuracy: 450, recordedAt: '2026-11-22T10:00:00.000Z' },
      t0,
    );
    expect(r1.shouldUpload).toBe(false);
    expect(r1.warmingUp).toBe(true);

    // Fix 2 is crisp (14m GPS) -> uploads immediately and completes warmup
    const r2 = gate.evaluate(
      { latitude: 52.52, longitude: 13.51, accuracy: 14, recordedAt: '2026-11-22T10:00:03.000Z' },
      t0 + 3_000,
    );
    expect(r2.shouldUpload).toBe(true);
    expect(r2.warmingUp).toBe(false);
    expect(r2.pointToUpload?.accuracy).toBe(14);

    // Desktop with only coarse fixes falls back to best accuracy after 3 samples
    gate.reset();
    expect(
      gate.evaluate(
        { latitude: 52.5, longitude: 13.4, accuracy: 500, recordedAt: '2026-11-22T10:01:00.000Z' },
        t0,
      ).shouldUpload,
    ).toBe(false);
    expect(
      gate.evaluate(
        { latitude: 52.501, longitude: 13.401, accuracy: 250, recordedAt: '2026-11-22T10:01:04.000Z' },
        t0 + 4_000,
      ).shouldUpload,
    ).toBe(false);
    const fallback = gate.evaluate(
      { latitude: 52.502, longitude: 13.402, accuracy: 380, recordedAt: '2026-11-22T10:01:08.000Z' },
      t0 + 8_000,
    );
    expect(fallback.shouldUpload).toBe(true);
    expect(fallback.pointToUpload?.accuracy).toBe(250);
  });
});
