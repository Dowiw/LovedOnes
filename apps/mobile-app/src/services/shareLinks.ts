import type { LocationShareLinkItem } from '@loved-ones/shared';
import { formatUserError } from './errorFormatter';

async function requestShareApi<T>(
  serverUrl: string,
  path: string,
  accessToken: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const cleanServer = serverUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${cleanServer}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let rawMessage = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) rawMessage = data.error;
    } catch {
      // ignore non-JSON body
    }
    throw new Error(formatUserError(new Error(rawMessage)));
  }
  return (await res.json()) as T;
}

export async function listMobileShareLinks(
  serverUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LocationShareLinkItem[]> {
  const res = await requestShareApi<{ links: LocationShareLinkItem[] }>(
    serverUrl,
    '/api/realtime/share-links',
    accessToken,
    {},
    fetchImpl,
  );
  return res.links;
}

export async function createMobileShareLink(
  serverUrl: string,
  accessToken: string,
  payload: {
    groupId: string;
    durationMinutes: number;
    label?: string;
    allowGuestSharing: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<LocationShareLinkItem> {
  const res = await requestShareApi<{ link: LocationShareLinkItem }>(
    serverUrl,
    '/api/realtime/share-links',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    fetchImpl,
  );
  return res.link;
}

export async function revokeMobileShareLink(
  serverUrl: string,
  accessToken: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await requestShareApi<{ revoked: boolean }>(
    serverUrl,
    `/api/realtime/share-links/${encodeURIComponent(token)}`,
    accessToken,
    { method: 'DELETE' },
    fetchImpl,
  );
  return res.revoked;
}

export function resolveMobileShareUrl(serverUrl: string, item: LocationShareLinkItem): string {
  const cleanServer = serverUrl.replace(/\/$/, '');
  return cleanServer ? `${cleanServer}/share/${item.token}` : item.shareUrl;
}
