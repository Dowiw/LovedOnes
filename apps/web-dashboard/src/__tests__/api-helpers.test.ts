import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUpdateProfile, formatBytes, getLogsWsUrl, getServiceBaseUrls } from '../lib/api';

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
});
