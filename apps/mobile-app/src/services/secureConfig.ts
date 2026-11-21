import { QrInvitePayload, QrInvitePayloadSchema, SystemRole } from '@loved-ones/shared';
import { formatUserError } from './errorFormatter';

export interface MobileUser {
  id: string;
  email: string;
  username: string;
  role: SystemRole;
  avatarUrl?: string | null;
  haloColor?: string | null;
  fuzzCircleColor?: string | null;
  recoveryEmail?: string | null;
  recoveryEmailVerified?: boolean;
}

export interface MobileStoredConfig {
  serverUrl: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  user: MobileUser | null;
  activeGroupId: string | null;
}

export interface SecureKeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const KEYS = {
  serverUrl: 'lovedones.serverUrl',
  accessToken: 'lovedones.accessToken',
  refreshToken: 'lovedones.refreshToken',
  user: 'lovedones.user',
  activeGroupId: 'lovedones.activeGroupId',
} as const;

export function createMemoryKeyValueStore(): SecureKeyValueStore {
  const map = new Map<string, string>();
  return {
    async getItemAsync(key: string) {
      return map.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
      map.set(key, value);
    },
    async deleteItemAsync(key: string) {
      map.delete(key);
    },
  };
}

async function getExpoSecureStore(): Promise<SecureKeyValueStore> {
  const SecureStore = await import('expo-secure-store');
  return {
    getItemAsync: (k) => SecureStore.getItemAsync(k),
    setItemAsync: (k, v) => SecureStore.setItemAsync(k, v),
    deleteItemAsync: (k) => SecureStore.deleteItemAsync(k),
  };
}

export async function getStoredConfig(
  store?: SecureKeyValueStore,
): Promise<MobileStoredConfig> {
  const s = store ?? (await getExpoSecureStore());
  const [serverUrl, accessToken, refreshToken, userRaw, activeGroupId] = await Promise.all([
    s.getItemAsync(KEYS.serverUrl),
    s.getItemAsync(KEYS.accessToken),
    s.getItemAsync(KEYS.refreshToken),
    s.getItemAsync(KEYS.user),
    s.getItemAsync(KEYS.activeGroupId),
  ]);

  let user: MobileUser | null = null;
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as MobileUser;
    } catch {
      user = null;
    }
  }

  return {
    serverUrl,
    accessToken,
    refreshToken,
    user,
    activeGroupId,
  };
}

export async function saveStoredConfig(
  patch: Partial<MobileStoredConfig>,
  store?: SecureKeyValueStore,
): Promise<void> {
  const s = store ?? (await getExpoSecureStore());
  if (patch.serverUrl !== undefined) {
    if (patch.serverUrl) await s.setItemAsync(KEYS.serverUrl, patch.serverUrl.replace(/\/$/, ''));
    else await s.deleteItemAsync(KEYS.serverUrl);
  }
  if (patch.accessToken !== undefined) {
    if (patch.accessToken) await s.setItemAsync(KEYS.accessToken, patch.accessToken);
    else await s.deleteItemAsync(KEYS.accessToken);
  }
  if (patch.refreshToken !== undefined) {
    if (patch.refreshToken) await s.setItemAsync(KEYS.refreshToken, patch.refreshToken);
    else await s.deleteItemAsync(KEYS.refreshToken);
  }
  if (patch.user !== undefined) {
    if (patch.user) await s.setItemAsync(KEYS.user, JSON.stringify(patch.user));
    else await s.deleteItemAsync(KEYS.user);
  }
  if (patch.activeGroupId !== undefined) {
    if (patch.activeGroupId) await s.setItemAsync(KEYS.activeGroupId, patch.activeGroupId);
    else await s.deleteItemAsync(KEYS.activeGroupId);
  }
}

export async function clearStoredConfig(store?: SecureKeyValueStore): Promise<void> {
  const s = store ?? (await getExpoSecureStore());
  await Promise.all([
    s.deleteItemAsync(KEYS.serverUrl),
    s.deleteItemAsync(KEYS.accessToken),
    s.deleteItemAsync(KEYS.refreshToken),
    s.deleteItemAsync(KEYS.user),
    s.deleteItemAsync(KEYS.activeGroupId),
  ]);
}

/**
 * Signs out the active user session while remembering serverUrl for quick re-entry.
 */
export async function clearSessionConfig(store?: SecureKeyValueStore): Promise<void> {
  const s = store ?? (await getExpoSecureStore());
  await Promise.all([
    s.deleteItemAsync(KEYS.accessToken),
    s.deleteItemAsync(KEYS.refreshToken),
    s.deleteItemAsync(KEYS.user),
    s.deleteItemAsync(KEYS.activeGroupId),
  ]);
}

/**
 * Extracts a bindable invite payload string from an incoming deep-link or web join URL.
 */
export function extractInviteCandidateFromUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      return parsed.searchParams.get('token') ? trimmed : null;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith('lovedones://')) {
    try {
      const parsed = new URL(trimmed);
      const token = parsed.searchParams.get('token');
      const serverUrl = parsed.searchParams.get('serverUrl') || parsed.searchParams.get('server');
      if (token && serverUrl) {
        return trimmed;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parses a scanned onboarding QR code payload, web join URL, or lovedones:// deep link
 * and binds serverUrl into expo-secure-store immediately.
 */
export async function parseAndBindQrInvite(
  rawData: string,
  store?: SecureKeyValueStore,
): Promise<QrInvitePayload> {
  try {
    const trimmed = rawData.trim();
    let candidate: unknown;

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parsedUrl = new URL(trimmed);
      const token = parsedUrl.searchParams.get('token');
      if (!token) {
        throw new Error('Invite URL does not include a token query parameter');
      }
      candidate = {
        v: 1,
        serverUrl: parsedUrl.origin,
        inviteToken: token,
        groupName: parsedUrl.searchParams.get('groupName') ?? 'Invited Group',
      };
    } else if (trimmed.startsWith('lovedones://')) {
      const parsedUrl = new URL(trimmed);
      const token = parsedUrl.searchParams.get('token');
      const serverParam = parsedUrl.searchParams.get('serverUrl') ?? parsedUrl.searchParams.get('server');
      if (!token || !serverParam) {
        throw new Error('Invite link does not include token and serverUrl parameters');
      }
      candidate = {
        v: 1,
        serverUrl: serverParam,
        inviteToken: token,
        groupName: parsedUrl.searchParams.get('groupName') ?? 'Invited Group',
      };
    } else {
      candidate = JSON.parse(trimmed) as unknown;
    }

    const payload = QrInvitePayloadSchema.parse(candidate);
    const cleanServerUrl = payload.serverUrl.replace(/\/$/, '');
    await saveStoredConfig({ serverUrl: cleanServerUrl }, store);
    return { ...payload, serverUrl: cleanServerUrl };
  } catch (err) {
    console.warn('[LovedOnes] QR parse error:', err);
    throw new Error(
      formatUserError(err, 'Invalid invite code or QR format. Please scan a valid LovedOnes invite.'),
    );
  }
}
