import type {
  AppVersionInfo,
  ChatMessage,
  GroupPlace,
  GroupRole,
  LocationBroadcast,
  LocationPoint,
  LocationRequestItem,
  MapDownloadJob,
  MapRegion,
  PlaceTransitionEvent,
  PrivacyMode,
  QrInvitePayload,
  SystemRole,
  SystemTelemetry,
  SystemUpdateStatus,
} from '@loved-ones/shared';

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: SystemRole;
  avatarUrl?: string | null;
  haloColor?: string | null;
  fuzzCircleColor?: string | null;
  recoveryEmail?: string | null;
  recoveryEmailVerified?: boolean;
  createdAt?: string;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface GroupMember {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  haloColor?: string | null;
  fuzzCircleColor?: string | null;
  role: GroupRole;
  privacy: PrivacyMode;
  joinedAt: string;
}

export interface GroupItem {
  id: string;
  name: string;
  createdAt: string;
  myRole: GroupRole;
  myPrivacy: PrivacyMode;
  members: GroupMember[];
}

export interface InvitePreview {
  token: string;
  groupId: string;
  groupName: string;
  assignedRole: GroupRole;
  maxUses: number;
  uses: number;
  expiresAt: string;
  valid: boolean;
}

export interface CreatedInviteResponse extends QrInvitePayload {
  joinUrl: string;
  assignedRole: GroupRole;
  maxUses: number;
  expiresAt: string;
}

export interface TrackerTokenResponse {
  token: string;
  expiresInDays: number;
  expiresAt: string;
  serverUrl: string;
  owntracksUrl: string;
  overlandUrl: string;
}

export interface TrackerTokenStatusResponse {
  active: boolean;
  ttlSeconds: number;
}

const SESSION_STORAGE_KEY = 'lovedones_session_v1';
export const SESSION_UPDATED_EVENT = 'lovedones:session-updated';

export function getServiceBaseUrls(): {
  authBase: string;
  realtimeBase: string;
  tilesBase: string;
} {
  const configured = process.env.NEXT_PUBLIC_GATEWAY_URL;
  if (configured && configured.trim().length > 0) {
    const clean = configured.replace(/\/$/, '');
    return { authBase: clean, realtimeBase: clean, tilesBase: clean };
  }

  if (typeof window !== 'undefined' && window.location.port === '3000') {
    const proto = window.location.protocol;
    const host = window.location.hostname;
    return {
      authBase: `${proto}//${host}:4001`,
      realtimeBase: `${proto}//${host}:4002`,
      tilesBase: `${proto}//${host}:8080`,
    };
  }

  return { authBase: '', realtimeBase: '', tilesBase: '' };
}

export function getLogsWsUrl(token: string): string {
  const { authBase } = getServiceBaseUrls();
  if (authBase.startsWith('http://') || authBase.startsWith('https://')) {
    const wsBase = authBase.replace(/^http/, 'ws');
    return `${wsBase}/api/admin/logs/stream?token=${encodeURIComponent(token)}`;
  }
  if (typeof window !== 'undefined') {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${window.location.host}/api/admin/logs/stream?token=${encodeURIComponent(token)}`;
  }
  return `/api/admin/logs/stream?token=${encodeURIComponent(token)}`;
}

export function loadSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession | null): void {
  if (typeof window === 'undefined') return;
  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } else {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }
  window.dispatchEvent(
    new CustomEvent<StoredSession | null>(SESSION_UPDATED_EVENT, { detail: session }),
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

let inFlightRefresh: Promise<StoredSession | null> | null = null;

/**
 * Exchanges the stored 7-day refreshToken for a new token pair, deduplicating
 * concurrent 401 refreshes. Clears the stored session if refresh is rejected.
 */
export async function refreshStoredSession(): Promise<StoredSession | null> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    const current = loadSession();
    if (!current?.refreshToken) {
      saveSession(null);
      return null;
    }
    const { authBase } = getServiceBaseUrls();
    try {
      const res = await fetch(`${authBase}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
          saveSession(null);
        }
        return null;
      }
      const tokens = (await res.json()) as { accessToken?: string; refreshToken?: string };
      if (!tokens.accessToken || !tokens.refreshToken) {
        saveSession(null);
        return null;
      }
      const next: StoredSession = {
        ...current,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
      saveSession(next);
      return next;
    } catch {
      return null;
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

async function parseErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `HTTP ${res.status}`;
  try {
    const data = JSON.parse(text) as unknown;
    if (typeof data === 'object' && data && 'error' in data) {
      return String((data as { error: unknown }).error);
    }
  } catch {
    // plain text fallback
  }
  return `HTTP ${res.status}`;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const errMsg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}

async function requestAuthedJson<T>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const sendWithToken = async (token: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...init, headers });
  };

  const latestStoredToken = loadSession()?.accessToken;
  let res = await sendWithToken(latestStoredToken || accessToken);

  if (res.status === 401) {
    const refreshed = await refreshStoredSession();
    if (refreshed?.accessToken) {
      res = await sendWithToken(refreshed.accessToken);
    } else {
      throw new Error('Session expired — please sign in again.');
    }
  }

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export async function apiLogin(email: string, password: string): Promise<StoredSession> {
  const { authBase } = getServiceBaseUrls();
  return requestJson<StoredSession>(`${authBase}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function apiRegister(input: {
  email: string;
  username: string;
  password: string;
  inviteToken?: string;
}): Promise<StoredSession> {
  const { authBase } = getServiceBaseUrls();
  return requestJson<StoredSession>(`${authBase}/api/auth/register`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function apiGetMe(accessToken: string): Promise<{ user: AuthUser }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<{ user: AuthUser }>(`${authBase}/api/auth/me`, accessToken);
}

export async function apiUpdateProfile(
  accessToken: string,
  input: {
    username?: string;
    email?: string;
    avatarUrl?: string | null;
    haloColor?: string | null;
    fuzzCircleColor?: string | null;
  },
): Promise<StoredSession> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<StoredSession>(`${authBase}/api/auth/me`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function apiChangePassword(
  accessToken: string,
  input: { currentPassword: string; newPassword: string },
): Promise<{ updated: boolean }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<{ updated: boolean }>(`${authBase}/api/auth/password`, accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function apiSendRecoveryCode(
  accessToken: string,
  recoveryEmail: string,
): Promise<{ sent: boolean; recoveryEmail: string; expiresInSeconds: number; user: AuthUser }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson(`${authBase}/api/auth/recovery-email/send-code`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ recoveryEmail }),
  });
}

export async function apiVerifyRecoveryEmail(
  accessToken: string,
  input: { recoveryEmail: string; code: string },
): Promise<{ verified: boolean; user: AuthUser }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson(`${authBase}/api/auth/recovery-email/verify`, accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function apiClearRecoveryEmail(
  accessToken: string,
): Promise<{ cleared: boolean; user: AuthUser }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson(`${authBase}/api/auth/recovery-email`, accessToken, {
    method: 'DELETE',
  });
}

export async function apiRequestPasswordReset(
  email: string,
): Promise<{ ok: boolean; message: string }> {
  const { authBase } = getServiceBaseUrls();
  return requestJson(`${authBase}/api/auth/forgot-password/request`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function apiResetPasswordWithCode(input: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<{ reset: boolean }> {
  const { authBase } = getServiceBaseUrls();
  return requestJson(`${authBase}/api/auth/forgot-password/reset`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function apiFetchGroups(token: string): Promise<GroupItem[]> {
  const { authBase } = getServiceBaseUrls();
  const res = await requestAuthedJson<{ groups: GroupItem[] }>(
    `${authBase}/api/auth/groups`,
    token,
  );
  return res.groups;
}

export async function apiCreateGroup(token: string, name: string): Promise<GroupItem> {
  const { authBase } = getServiceBaseUrls();
  const created = await requestAuthedJson<Omit<GroupItem, 'members'>>(
    `${authBase}/api/auth/groups`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ name }),
    },
  );
  return { ...created, members: [] };
}

export async function apiUpdatePrivacy(
  token: string,
  groupId: string,
  privacy: PrivacyMode,
): Promise<{ groupId: string; privacy: PrivacyMode }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson(`${authBase}/api/auth/groups/${groupId}/privacy`, token, {
    method: 'PATCH',
    body: JSON.stringify({ privacy }),
  });
}

export async function apiPreviewInvite(token: string): Promise<InvitePreview> {
  const { authBase } = getServiceBaseUrls();
  return requestJson<InvitePreview>(`${authBase}/api/auth/invites/${encodeURIComponent(token)}`);
}

export async function apiJoinInvite(
  accessToken: string,
  inviteToken: string,
): Promise<{ groupId: string; groupName: string; role: GroupRole; privacy: PrivacyMode }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson(`${authBase}/api/auth/join`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ inviteToken }),
  });
}

export async function apiCreateInvite(
  accessToken: string,
  input: { groupId: string; assignedRole: GroupRole; maxUses: number; expiresInHours: number },
): Promise<CreatedInviteResponse> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<CreatedInviteResponse>(`${authBase}/api/admin/invites`, accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function apiListInvites(accessToken: string): Promise<
  Array<{
    token: string;
    groupId: string;
    groupName: string;
    assignedRole: GroupRole;
    maxUses: number;
    uses: number;
    expiresAt: string;
  }>
> {
  const { authBase } = getServiceBaseUrls();
  const res = await requestAuthedJson<{
    invites: Array<{
      token: string;
      groupId: string;
      groupName: string;
      assignedRole: GroupRole;
      maxUses: number;
      uses: number;
      expiresAt: string;
    }>;
  }>(`${authBase}/api/admin/invites`, accessToken);
  return res.invites;
}

export async function apiDeleteInvite(
  accessToken: string,
  token: string,
): Promise<{ deleted: boolean; token: string }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<{ deleted: boolean; token: string }>(
    `${authBase}/api/admin/invites/${encodeURIComponent(token)}`,
    accessToken,
    { method: 'DELETE' },
  );
}

export async function apiFetchTelemetry(accessToken: string): Promise<SystemTelemetry> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<SystemTelemetry>(`${authBase}/api/admin/telemetry`, accessToken);
}

export async function apiFetchRecentLogs(accessToken: string): Promise<string[]> {
  const { authBase } = getServiceBaseUrls();
  const res = await requestAuthedJson<{ logs: string[] }>(
    `${authBase}/api/admin/logs/recent`,
    accessToken,
  );
  return res.logs;
}

export async function apiFetchGroupLocations(
  accessToken: string,
  groupId: string,
): Promise<LocationBroadcast[]> {
  const { realtimeBase } = getServiceBaseUrls();
  const res = await requestAuthedJson<{ locations: LocationBroadcast[] }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/locations`,
    accessToken,
  );
  return res.locations;
}

export async function apiFetchGroupMessages(
  accessToken: string,
  groupId: string,
): Promise<ChatMessage[]> {
  const { realtimeBase } = getServiceBaseUrls();
  const res = await requestAuthedJson<{ messages: ChatMessage[] }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/messages`,
    accessToken,
  );
  return res.messages;
}

export async function apiSendLocationBatch(
  accessToken: string,
  points: LocationPoint[],
): Promise<{ inserted: number }> {
  const { realtimeBase } = getServiceBaseUrls();
  return requestAuthedJson<{ inserted: number }>(
    `${realtimeBase}/api/realtime/locations`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ points }),
    },
  );
}

export async function apiGetTrackerTokenStatus(
  accessToken: string,
): Promise<TrackerTokenStatusResponse> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<TrackerTokenStatusResponse>(
    `${authBase}/api/auth/tracker-token`,
    accessToken,
  );
}

export async function apiCreateTrackerToken(
  accessToken: string,
  expiresInDays: number,
): Promise<TrackerTokenResponse> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<TrackerTokenResponse>(`${authBase}/api/auth/tracker-token`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ expiresInDays }),
  });
}

export async function apiRevokeTrackerToken(
  accessToken: string,
): Promise<{ revoked: boolean }> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<{ revoked: boolean }>(
    `${authBase}/api/auth/tracker-token`,
    accessToken,
    { method: 'DELETE' },
  );
}

export async function apiFetchLocationRequests(
  accessToken: string,
  groupId: string,
): Promise<{ requests: LocationRequestItem[]; myPrivacyOverrideUntil: string | null }> {
  const { realtimeBase } = getServiceBaseUrls();
  return requestAuthedJson<{ requests: LocationRequestItem[]; myPrivacyOverrideUntil: string | null }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/location-requests`,
    accessToken,
  );
}

export async function apiCreateLocationRequest(
  accessToken: string,
  groupId: string,
  payload: { targetUserId: string; suggestedDurationMinutes?: number; message?: string },
): Promise<LocationRequestItem> {
  const { realtimeBase } = getServiceBaseUrls();
  const res = await requestAuthedJson<{ request: LocationRequestItem }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/location-requests`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  return res.request;
}

export async function apiRespondLocationRequest(
  accessToken: string,
  groupId: string,
  requestId: string,
  action: 'accept' | 'decline',
  durationMinutes?: number,
): Promise<{ request: LocationRequestItem; privacyOverrideUntil: string | null }> {
  const { realtimeBase } = getServiceBaseUrls();
  return requestAuthedJson<{ request: LocationRequestItem; privacyOverrideUntil: string | null }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/location-requests/${requestId}/respond`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ action, durationMinutes }),
    },
  );
}

export async function apiFetchGroupPlaces(
  accessToken: string,
  groupId: string,
): Promise<{ places: GroupPlace[]; recentTransitions: PlaceTransitionEvent[] }> {
  const { realtimeBase } = getServiceBaseUrls();
  return requestAuthedJson<{ places: GroupPlace[]; recentTransitions: PlaceTransitionEvent[] }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/places`,
    accessToken,
  );
}

export async function apiCreateGroupPlace(
  accessToken: string,
  groupId: string,
  payload: { name: string; latitude: number; longitude: number; radiusMeters: number },
): Promise<GroupPlace> {
  const { realtimeBase } = getServiceBaseUrls();
  const res = await requestAuthedJson<{ place: GroupPlace }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/places`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  return res.place;
}

export async function apiDeleteGroupPlace(
  accessToken: string,
  groupId: string,
  placeId: string,
): Promise<void> {
  const { realtimeBase } = getServiceBaseUrls();
  await requestAuthedJson<{ ok: boolean }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/places/${placeId}`,
    accessToken,
    { method: 'DELETE' },
  );
}

export async function apiFetchGroupTrails(
  accessToken: string,
  groupId: string,
  options: { from?: string; to?: string; limit?: number } = {},
): Promise<LocationBroadcast[]> {
  const { realtimeBase } = getServiceBaseUrls();
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  const res = await requestAuthedJson<{ trails: LocationBroadcast[] }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/trails${qs ? `?${qs}` : ''}`,
    accessToken,
  );
  return res.trails;
}

export async function apiFetchMapRegions(): Promise<{
  regions: MapRegion[];
  jobs: MapDownloadJob[];
  allowMemberDownloads: boolean;
}> {
  const { authBase } = getServiceBaseUrls();
  const res = await fetch(`${authBase}/api/maps/regions`);
  if (!res.ok) {
    throw new Error(`Failed to fetch map regions (${res.status})`);
  }
  return (await res.json()) as {
    regions: MapRegion[];
    jobs: MapDownloadJob[];
    allowMemberDownloads: boolean;
  };
}

export async function apiRequestMapDownload(
  accessToken: string,
  payload: { latitude: number; longitude: number; cityName?: string; radiusKm?: number },
): Promise<{
  alreadyCovered: boolean;
  region?: MapRegion;
  regions?: MapRegion[];
  job?: MapDownloadJob;
}> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<{
    alreadyCovered: boolean;
    region?: MapRegion;
    regions?: MapRegion[];
    job?: MapDownloadJob;
  }>(`${authBase}/api/maps/download`, accessToken, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function apiFetchMapJobs(accessToken: string): Promise<MapDownloadJob[]> {
  const { authBase } = getServiceBaseUrls();
  const res = await requestAuthedJson<{ jobs: MapDownloadJob[] }>(
    `${authBase}/api/maps/jobs`,
    accessToken,
  );
  return res.jobs;
}

export async function apiDeleteMapRegion(accessToken: string, regionId: string): Promise<void> {
  const { authBase } = getServiceBaseUrls();
  await requestAuthedJson<{ deleted: boolean; id: string }>(
    `${authBase}/api/maps/regions/${encodeURIComponent(regionId)}`,
    accessToken,
    { method: 'DELETE' },
  );
}

export async function apiFetchSystemUpdateStatus(
  accessToken: string,
  refresh = false,
): Promise<SystemUpdateStatus> {
  const { authBase } = getServiceBaseUrls();
  const qs = refresh ? '?refresh=1' : '';
  return requestAuthedJson<SystemUpdateStatus>(
    `${authBase}/api/admin/system/update${qs}`,
    accessToken,
  );
}

export async function apiTriggerSystemUpdate(
  accessToken: string,
  options: { rebuildEvenIfCurrent?: boolean } = {},
): Promise<SystemUpdateStatus> {
  const { authBase } = getServiceBaseUrls();
  return requestAuthedJson<SystemUpdateStatus>(`${authBase}/api/admin/system/update`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ rebuildEvenIfCurrent: Boolean(options.rebuildEvenIfCurrent) }),
  });
}

export async function apiFetchAppVersion(
  clientVersion: string,
  platform: 'web' | 'android' | 'ios' = 'web',
): Promise<AppVersionInfo> {
  const { authBase } = getServiceBaseUrls();
  const qs = `platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(clientVersion)}`;
  const res = await fetch(`${authBase}/api/auth/app-version?${qs}`);
  if (!res.ok) {
    throw new Error(`Version check failed (${res.status})`);
  }
  return (await res.json()) as AppVersionInfo;
}
