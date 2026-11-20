import type {
  ChatMessage,
  GroupPlace,
  GroupRole,
  LocationBroadcast,
  LocationPoint,
  LocationRequestItem,
  PlaceTransitionEvent,
  PrivacyMode,
  QrInvitePayload,
  SystemRole,
  SystemTelemetry,
} from '@loved-ones/shared';

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: SystemRole;
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
    return;
  }
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
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

export async function apiFetchGroups(token: string): Promise<GroupItem[]> {
  const { authBase } = getServiceBaseUrls();
  const res = await requestJson<{ groups: GroupItem[] }>(`${authBase}/api/auth/groups`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.groups;
}

export async function apiCreateGroup(token: string, name: string): Promise<GroupItem> {
  const { authBase } = getServiceBaseUrls();
  const created = await requestJson<Omit<GroupItem, 'members'>>(`${authBase}/api/auth/groups`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  return { ...created, members: [] };
}

export async function apiUpdatePrivacy(
  token: string,
  groupId: string,
  privacy: PrivacyMode,
): Promise<{ groupId: string; privacy: PrivacyMode }> {
  const { authBase } = getServiceBaseUrls();
  return requestJson(`${authBase}/api/auth/groups/${groupId}/privacy`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
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
  return requestJson(`${authBase}/api/auth/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ inviteToken }),
  });
}

export async function apiCreateInvite(
  accessToken: string,
  input: { groupId: string; assignedRole: GroupRole; maxUses: number; expiresInHours: number },
): Promise<CreatedInviteResponse> {
  const { authBase } = getServiceBaseUrls();
  return requestJson<CreatedInviteResponse>(`${authBase}/api/admin/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
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
  const res = await requestJson<{
    invites: Array<{
      token: string;
      groupId: string;
      groupName: string;
      assignedRole: GroupRole;
      maxUses: number;
      uses: number;
      expiresAt: string;
    }>;
  }>(`${authBase}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.invites;
}

export async function apiFetchTelemetry(accessToken: string): Promise<SystemTelemetry> {
  const { authBase } = getServiceBaseUrls();
  return requestJson<SystemTelemetry>(`${authBase}/api/admin/telemetry`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function apiFetchRecentLogs(accessToken: string): Promise<string[]> {
  const { authBase } = getServiceBaseUrls();
  const res = await requestJson<{ logs: string[] }>(`${authBase}/api/admin/logs/recent`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.logs;
}

export async function apiFetchGroupLocations(
  accessToken: string,
  groupId: string,
): Promise<LocationBroadcast[]> {
  const { realtimeBase } = getServiceBaseUrls();
  const res = await requestJson<{ locations: LocationBroadcast[] }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/locations`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return res.locations;
}

export async function apiFetchGroupMessages(
  accessToken: string,
  groupId: string,
): Promise<ChatMessage[]> {
  const { realtimeBase } = getServiceBaseUrls();
  const res = await requestJson<{ messages: ChatMessage[] }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/messages`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return res.messages;
}

export async function apiSendLocationBatch(
  accessToken: string,
  points: LocationPoint[],
): Promise<{ inserted: number }> {
  const { realtimeBase } = getServiceBaseUrls();
  return requestJson<{ inserted: number }>(`${realtimeBase}/api/realtime/locations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ points }),
  });
}

export async function apiGetTrackerTokenStatus(
  accessToken: string,
): Promise<TrackerTokenStatusResponse> {
  const { authBase } = getServiceBaseUrls();
  return requestJson<TrackerTokenStatusResponse>(`${authBase}/api/auth/tracker-token`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function apiCreateTrackerToken(
  accessToken: string,
  expiresInDays: number,
): Promise<TrackerTokenResponse> {
  const { authBase } = getServiceBaseUrls();
  return requestJson<TrackerTokenResponse>(`${authBase}/api/auth/tracker-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ expiresInDays }),
  });
}

export async function apiRevokeTrackerToken(
  accessToken: string,
): Promise<{ revoked: boolean }> {
  const { authBase } = getServiceBaseUrls();
  return requestJson<{ revoked: boolean }>(`${authBase}/api/auth/tracker-token`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function apiFetchLocationRequests(
  accessToken: string,
  groupId: string,
): Promise<{ requests: LocationRequestItem[]; myPrivacyOverrideUntil: string | null }> {
  const { realtimeBase } = getServiceBaseUrls();
  return requestJson<{ requests: LocationRequestItem[]; myPrivacyOverrideUntil: string | null }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/location-requests`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

export async function apiCreateLocationRequest(
  accessToken: string,
  groupId: string,
  payload: { targetUserId: string; suggestedDurationMinutes?: number; message?: string },
): Promise<LocationRequestItem> {
  const { realtimeBase } = getServiceBaseUrls();
  const res = await requestJson<{ request: LocationRequestItem }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/location-requests`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
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
  return requestJson<{ request: LocationRequestItem; privacyOverrideUntil: string | null }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/location-requests/${requestId}/respond`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action, durationMinutes }),
    },
  );
}

export async function apiFetchGroupPlaces(
  accessToken: string,
  groupId: string,
): Promise<{ places: GroupPlace[]; recentTransitions: PlaceTransitionEvent[] }> {
  const { realtimeBase } = getServiceBaseUrls();
  return requestJson<{ places: GroupPlace[]; recentTransitions: PlaceTransitionEvent[] }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/places`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

export async function apiCreateGroupPlace(
  accessToken: string,
  groupId: string,
  payload: { name: string; latitude: number; longitude: number; radiusMeters: number },
): Promise<GroupPlace> {
  const { realtimeBase } = getServiceBaseUrls();
  const res = await requestJson<{ place: GroupPlace }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/places`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
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
  await requestJson<{ ok: boolean }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/places/${placeId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
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
  const res = await requestJson<{ trails: LocationBroadcast[] }>(
    `${realtimeBase}/api/realtime/groups/${groupId}/trails${qs ? `?${qs}` : ''}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return res.trails;
}
