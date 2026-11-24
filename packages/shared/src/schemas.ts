import { z } from 'zod';

export const SystemRoleSchema = z.enum(['HOST_ADMIN', 'USER']);
export type SystemRole = z.infer<typeof SystemRoleSchema>;

export const GroupRoleSchema = z.enum(['ADMIN', 'MEMBER', 'SPECTATOR']);
export type GroupRole = z.infer<typeof GroupRoleSchema>;

export const PrivacyModeSchema = z.enum(['EXACT', 'FUZZED', 'GHOST']);
export type PrivacyMode = z.infer<typeof PrivacyModeSchema>;

export const RawPrivacyModeSchema = z.enum([
  'EXACT',
  'FUZZED',
  'GHOST',
  'ACTIVE',
  'FUZZED_1KM',
]);
export type RawPrivacyMode = z.infer<typeof RawPrivacyModeSchema>;

export function normalizePrivacyMode(mode: RawPrivacyMode): PrivacyMode {
  if (mode === 'ACTIVE') return 'EXACT';
  if (mode === 'FUZZED_1KM') return 'FUZZED';
  return mode;
}

const SAFE_DATA_IMAGE_REGEX =
  /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
export const MAX_AVATAR_URL_LENGTH = 262_144;

/**
 * Validates that an avatar URL is either an explicit raster image base64 data URI
 * (PNG/JPEG/WebP/GIF, bounded to 256 KB) or an HTTP(S) image URL, rejecting SVGs
 * and non-HTTP schemes to prevent stored XSS.
 */
export function isSafeAvatarUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AVATAR_URL_LENGTH) return false;
  if (SAFE_DATA_IMAGE_REGEX.test(trimmed)) return true;
  if (trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const AvatarUrlSchema = z
  .string()
  .trim()
  .max(MAX_AVATAR_URL_LENGTH)
  .refine((value) => isSafeAvatarUrl(value), {
    message: 'Avatar must be a PNG, JPEG, WebP, or GIF image under 256 KB or an HTTP(S) URL',
  });

export const MAX_LOGIN_BACKGROUND_URL_LENGTH = 1_572_864;

/**
 * Validates that a login background image URL is either an explicit raster image
 * base64 data URI (PNG/JPEG/WebP/GIF, bounded to ~1.5 MB) or an HTTP(S) URL,
 * rejecting SVGs and non-HTTP schemes to prevent stored XSS.
 */
export function isSafeLoginBackgroundUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOGIN_BACKGROUND_URL_LENGTH) return false;
  if (SAFE_DATA_IMAGE_REGEX.test(trimmed)) return true;
  if (trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const LoginBackgroundUrlSchema = z
  .string()
  .trim()
  .max(MAX_LOGIN_BACKGROUND_URL_LENGTH)
  .refine((value) => isSafeLoginBackgroundUrl(value), {
    message:
      'Login background must be a PNG, JPEG, WebP, or GIF image under 1.5 MB or an HTTP(S) URL',
  });

export const PublicLoginConfigSchema = z.object({
  bootstrapRequired: z.boolean(),
  requireAdminApproval: z.boolean(),
  loginBackgroundUrl: z.string().nullable(),
});
export type PublicLoginConfig = z.infer<typeof PublicLoginConfigSchema>;

export const UpdateLoginAppearanceSchema = z.object({
  loginBackgroundUrl: LoginBackgroundUrlSchema.nullable(),
});
export type UpdateLoginAppearanceInput = z.infer<typeof UpdateLoginAppearanceSchema>;

export const LoginAppearanceResponseSchema = z.object({
  loginBackgroundUrl: z.string().nullable(),
});
export type LoginAppearanceResponse = z.infer<typeof LoginAppearanceResponseSchema>;

const SAFE_HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_FUZZ_CIRCLE_COLOR = '#f59e0b';
export const DEFAULT_FUZZED_HALO_COLOR = '#f59e0b';
export const DEFAULT_EXACT_HALO_COLOR = '#18181b';
/** Max diagonal distance from real coords to the ~1 km fuzzed grid snap (sqrt(1000^2 + 1000^2) ≈ 1414m). */
export const FUZZED_AREA_RADIUS_METERS = 1420;

export function isSafeHexColor(raw: unknown): raw is string {
  return typeof raw === 'string' && SAFE_HEX_COLOR_REGEX.test(raw.trim());
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `rgba(24, 24, 27, ${alpha})`;
  }
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Generates a closed [lon, lat][] polygon ring approximating a geodesic circle
 * of radiusMeters around (lon, lat) for MapLibre GeoJSON Fill/Line layers.
 */
export function buildGeodesicCircleRing(
  longitude: number,
  latitude: number,
  radiusMeters = FUZZED_AREA_RADIUS_METERS,
  steps = 64,
): [number, number][] {
  const earthRadius = 6_371_000;
  const latRad = (latitude * Math.PI) / 180;
  const dLat = (radiusMeters / earthRadius) * (180 / Math.PI);
  const cosLat = Math.max(0.15, Math.cos(latRad));
  const dLon = dLat / cosLat;
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const theta = (i / steps) * 2 * Math.PI;
    coords.push([
      longitude + dLon * Math.cos(theta),
      Math.max(-85, Math.min(85, latitude + dLat * Math.sin(theta))),
    ]);
  }
  return coords;
}

export const HexColorSchema = z
  .string()
  .trim()
  .regex(SAFE_HEX_COLOR_REGEX, 'Color must be a #RRGGBB hex value')
  .transform((v) => v.toLowerCase());

export const UsernameSchema = z
  .string()
  .trim()
  .min(2, 'Username must be at least 2 characters')
  .max(64, 'Username must be at most 64 characters')
  .refine((value) => !value.includes('@'), {
    message: 'Username cannot contain "@"',
  });

export const RegisterSchema = z.object({
  email: z.string().trim().email().max(255),
  username: UsernameSchema,
  password: z.string().min(8).max(128),
  inviteToken: z.string().min(4).max(128).optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const UpdateProfileSchema = z
  .object({
    username: UsernameSchema.optional(),
    email: z.string().email().max(255).trim().optional(),
    avatarUrl: AvatarUrlSchema.nullable().optional(),
    haloColor: HexColorSchema.nullable().optional(),
    fuzzCircleColor: HexColorSchema.nullable().optional(),
  })
  .refine(
    (data) =>
      data.username !== undefined ||
      data.email !== undefined ||
      data.avatarUrl !== undefined ||
      data.haloColor !== undefined ||
      data.fuzzCircleColor !== undefined,
    { message: 'Provide username, email, avatarUrl, haloColor, or fuzzCircleColor to update' },
  );
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must differ from current password',
  });
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

export const RecoveryEmailSendCodeSchema = z.object({
  recoveryEmail: z.string().trim().email().max(255),
});
export type RecoveryEmailSendCodeInput = z.infer<typeof RecoveryEmailSendCodeSchema>;

export const RecoveryEmailVerifySchema = z.object({
  recoveryEmail: z.string().trim().email().max(255),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit verification code'),
});
export type RecoveryEmailVerifyInput = z.infer<typeof RecoveryEmailVerifySchema>;

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().trim().email().max(255),
});
export type ForgotPasswordRequestInput = z.infer<typeof ForgotPasswordRequestSchema>;

export const ForgotPasswordResetSchema = z.object({
  email: z.string().trim().email().max(255),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit reset code'),
  newPassword: z.string().min(8).max(128),
});
export type ForgotPasswordResetInput = z.infer<typeof ForgotPasswordResetSchema>;

export const MemberProfileUpdatedSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  haloColor: z.string().nullable().optional(),
  fuzzCircleColor: z.string().nullable().optional(),
  groupIds: z.array(z.string().uuid()),
});
export type MemberProfileUpdatedEvent = z.infer<typeof MemberProfileUpdatedSchema>;

export const MemberPrivacyUpdatedSchema = z.object({
  userId: z.string().uuid(),
  groupId: z.string().uuid(),
  privacy: PrivacyModeSchema,
});
export type MemberPrivacyUpdatedEvent = z.infer<typeof MemberPrivacyUpdatedSchema>;

export const LoginSchema = z
  .object({
    identifier: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().min(1).max(255).optional(),
    password: z.string().min(1),
  })
  .refine((data) => Boolean((data.identifier ?? data.email)?.trim()), {
    message: 'Enter your email or username',
    path: ['identifier'],
  })
  .transform((data) => ({
    identifier: (data.identifier ?? data.email)!.trim(),
    password: data.password,
  }));
export type LoginInput = z.input<typeof LoginSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(10),
});
export type RefreshInput = z.infer<typeof RefreshSchema>;

export const JoinInviteSchema = z.object({
  inviteToken: z.string().min(4).max(128),
});
export type JoinInviteInput = z.infer<typeof JoinInviteSchema>;

export const JwtUserPayloadSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string(),
  role: SystemRoleSchema,
  type: z.enum(['access', 'refresh', 'tracker']).optional(),
  jti: z.string().optional(),
});
export type JwtUserPayload = z.infer<typeof JwtUserPayloadSchema>;

export const CreateTrackerTokenSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).default(30),
});
export type CreateTrackerTokenInput = z.infer<typeof CreateTrackerTokenSchema>;

export const CreateGroupSchema = z.object({
  name: z.string().min(2).max(100).trim(),
});
export type CreateGroupInput = z.infer<typeof CreateGroupSchema>;

export const UpdatePrivacySchema = z.object({
  privacy: RawPrivacyModeSchema,
});
export type UpdatePrivacyInput = z.infer<typeof UpdatePrivacySchema>;

export const UpdateMemberRoleSchema = z.object({
  role: GroupRoleSchema,
});
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;

export const CreateInviteSchema = z.object({
  groupId: z.string().uuid(),
  assignedRole: GroupRoleSchema.default('MEMBER'),
  maxUses: z.number().int().min(1).max(1000).default(1),
  expiresInHours: z.number().min(1).max(24 * 365).default(24),
});
export type CreateInviteInput = z.infer<typeof CreateInviteSchema>;

export const QrInvitePayloadSchema = z.object({
  v: z.literal(1),
  serverUrl: z.string().url(),
  inviteToken: z.string().min(4).max(128),
  groupName: z.string().min(1).max(100),
});
export type QrInvitePayload = z.infer<typeof QrInvitePayloadSchema>;

export interface ParsedInviteInput {
  inviteToken: string;
  serverUrl?: string;
  groupName?: string;
}

/**
 * Accepts any of:
 * 1. QrInvitePayload JSON string (`{"v":1,"serverUrl":...,"inviteToken":...,"groupName":...}`)
 * 2. Invite join URL (`https://.../join?token=inv_...`)
 * 3. Raw invite token (`inv_...`, 4..128 non-whitespace chars)
 */
export function parseInviteInput(rawData: string): ParsedInviteInput {
  const trimmed = rawData.trim();
  if (!trimmed) {
    throw new Error('Enter or scan an invite QR code, URL, or token');
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const parsedUrl = new URL(trimmed);
    const token = parsedUrl.searchParams.get('token')?.trim();
    if (!token || token.length < 4 || token.length > 128 || /\s/.test(token)) {
      throw new Error('Invite URL does not contain a valid token parameter');
    }
    const groupName = parsedUrl.searchParams.get('groupName')?.trim() || undefined;
    return {
      inviteToken: token,
      serverUrl: parsedUrl.origin,
      groupName,
    };
  }

  if (trimmed.startsWith('{')) {
    const candidate = JSON.parse(trimmed) as unknown;
    const payload = QrInvitePayloadSchema.parse(candidate);
    return {
      inviteToken: payload.inviteToken,
      serverUrl: payload.serverUrl.replace(/\/$/, ''),
      groupName: payload.groupName,
    };
  }

  if (trimmed.length < 4 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new Error('Invalid invite token format');
  }
  return { inviteToken: trimmed };
}

function parseNonNegativeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export const AccountRemovedEventSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().optional(),
  reason: z.string(),
  removedAt: z.string(),
});
export type AccountRemovedEvent = z.infer<typeof AccountRemovedEventSchema>;

export const LocationPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().nullable().optional(),
  accuracy: z.number().min(0).nullable().optional(),
  speed: z.number().min(0).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  batteryLevel: z.number().int().min(0).max(100).nullable().optional(),
  recordedAt: z.string().datetime(),
});
export type LocationPoint = z.infer<typeof LocationPointSchema>;

export const LocationBatchSchema = z.object({
  points: z.array(LocationPointSchema).min(1).max(500),
});
export type LocationBatch = z.infer<typeof LocationBatchSchema>;

export const TrackingStateSchema = z.enum([
  'active',
  'idle',
  'paused',
  'permission_denied',
  'gps_off',
  'interrupted',
]);
export type TrackingState = z.infer<typeof TrackingStateSchema>;

export const HeartbeatInputSchema = z.object({
  trackingState: TrackingStateSchema.default('idle'),
  batteryLevel: z.number().int().min(0).max(100).nullable().optional(),
  recordedAt: z.string().datetime().optional(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInputSchema>;

export const MemberPresenceUpdateSchema = z.object({
  userId: z.string().uuid(),
  groupId: z.string().uuid(),
  lastHeartbeatAt: z.string(),
  trackingState: TrackingStateSchema,
  batteryLevel: z.number().int().min(0).max(100).nullable().optional(),
});
export type MemberPresenceUpdate = z.infer<typeof MemberPresenceUpdateSchema>;

export interface UserPresenceRecord {
  lastHeartbeatAt: string;
  trackingState: TrackingState;
  batteryLevel: number | null;
}

export const LocationBroadcastSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  avatarUrl: z.string().nullable().optional(),
  haloColor: z.string().nullable().optional(),
  fuzzCircleColor: z.string().nullable().optional(),
  groupId: z.string().uuid(),
  latitude: z.number(),
  longitude: z.number(),
  altitude: z.number().nullable().optional(),
  accuracy: z.number().min(0).nullable().optional(),
  speed: z.number().nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  batteryLevel: z.number().nullable().optional(),
  recordedAt: z.string(),
  lastHeartbeatAt: z.string().nullable().optional(),
  trackingState: TrackingStateSchema.nullable().optional(),
  privacyMode: PrivacyModeSchema,
  isFuzzed: z.boolean(),
});
export type LocationBroadcast = z.infer<typeof LocationBroadcastSchema>;

export interface BoundingBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/**
 * Parses a "minLon,minLat,maxLon,maxLat" query parameter string into validated
 * WGS84 bounds, returning null if malformed or inverted.
 */
export function parseBoundingBox(raw: string): BoundingBox | null {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 4 || parts.some((s) => s.length === 0)) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = nums as [number, number, number, number];
  if (
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLon >= maxLon ||
    minLat >= maxLat
  ) {
    return null;
  }
  return { minLon, minLat, maxLon, maxLat };
}

export const LocationSnapshotQuerySchema = z.object({
  since: z.string().datetime().optional(),
});
export type LocationSnapshotQuery = z.infer<typeof LocationSnapshotQuerySchema>;

export const TrailQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    bbox: z.string().optional(),
    userId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .superRefine((val, ctx) => {
    if (val.from && val.to && Date.parse(val.from) > Date.parse(val.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must be earlier than or equal to to',
      });
    }
    if (val.bbox !== undefined && !parseBoundingBox(val.bbox)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bbox'],
        message: 'bbox must be minLon,minLat,maxLon,maxLat within valid WGS84 bounds',
      });
    }
  });
export type TrailQuery = z.infer<typeof TrailQuerySchema>;

export const SendMessageSchema = z.object({
  groupId: z.string().uuid(),
  content: z.string().min(1).max(4000).trim(),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  senderId: z.string().uuid(),
  senderUsername: z.string(),
  senderAvatarUrl: z.string().nullable().optional(),
  content: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ---- Location Check-In Requests & Geofenced Group Places ----

export const LocationRequestStatusSchema = z.enum([
  'pending',
  'accepted',
  'declined',
  'expired',
]);
export type LocationRequestStatus = z.infer<typeof LocationRequestStatusSchema>;

export const CreateLocationRequestSchema = z.object({
  targetUserId: z.string().uuid(),
  suggestedDurationMinutes: z.number().int().min(1).max(240).default(15),
  expiresInMinutes: z.number().int().min(1).max(60).default(15),
  message: z.string().trim().max(240).optional(),
});
export type CreateLocationRequestInput = z.infer<typeof CreateLocationRequestSchema>;

export const RespondLocationRequestSchema = z.object({
  action: z.enum(['accept', 'decline']),
  durationMinutes: z.number().int().min(1).max(240).optional(),
});
export type RespondLocationRequestInput = z.infer<typeof RespondLocationRequestSchema>;

export const LocationRequestItemSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  requesterId: z.string().uuid(),
  requesterUsername: z.string(),
  targetUserId: z.string().uuid(),
  targetUsername: z.string(),
  status: LocationRequestStatusSchema,
  suggestedDurationMinutes: z.number().int(),
  message: z.string().nullable(),
  expiresAt: z.string(),
  respondedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type LocationRequestItem = z.infer<typeof LocationRequestItemSchema>;

export const CreateGroupPlaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().min(25).max(10000).default(150),
  isPrivate: z.boolean().default(false),
  groupId: z.string().uuid().nullable().optional(),
});
export type CreateGroupPlaceInput = z.infer<typeof CreateGroupPlaceSchema>;

export const GroupPlaceSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid().nullable(),
  groupName: z.string().nullable().optional(),
  isPrivate: z.boolean().default(false),
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  radiusMeters: z.number(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type GroupPlace = z.infer<typeof GroupPlaceSchema>;

export const PlaceTransitionTypeSchema = z.enum(['enter', 'exit']);
export type PlaceTransitionType = z.infer<typeof PlaceTransitionTypeSchema>;

export const PlaceTransitionEventSchema = z.object({
  id: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  placeId: z.string().uuid(),
  placeName: z.string(),
  userId: z.string().uuid(),
  username: z.string(),
  transition: PlaceTransitionTypeSchema,
  recordedAt: z.string(),
});
export type PlaceTransitionEvent = z.infer<typeof PlaceTransitionEventSchema>;

export const UserTelemetrySchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  email: z.string().email(),
  role: SystemRoleSchema,
  locationBytes: z.number(),
  locationPoints: z.number(),
  estimatedIndexBytes: z.number().default(0),
  messageBytes: z.number().default(0),
  messageCount: z.number().default(0),
  avatarBytes: z.number().default(0),
  placeEventCount: z.number().default(0),
  totalDbBytes: z.number().default(0),
  cpuMsTotal: z.number(),
  cpuMsPerMin: z.number(),
  eventsCount: z.number(),
  pingsPerMin: z.number(),
  activeSockets: z.number(),
  redisMemoryBytes: z.number(),
});
export type UserTelemetry = z.infer<typeof UserTelemetrySchema>;

export const DiskMountTelemetrySchema = z.object({
  mountLabel: z.enum(['logs', 'tiles', 'data']),
  path: z.string(),
  fsId: z.string(),
  totalBytes: z.number(),
  freeBytes: z.number(),
  availableBytes: z.number(),
  usedBytes: z.number(),
  pathSizeBytes: z.number(),
});
export type DiskMountTelemetry = z.infer<typeof DiskMountTelemetrySchema>;

export const ServiceNodeTelemetrySchema = z.object({
  nodeKey: z.string(),
  service: z.string(),
  instanceId: z.string(),
  hostname: z.string(),
  pid: z.number(),
  version: z.string().nullable(),
  uptimeSeconds: z.number(),
  cpuPercent: z.number(),
  cpuCores: z.number(),
  loadAvg1m: z.number(),
  rssBytes: z.number(),
  heapUsedBytes: z.number(),
  heapTotalBytes: z.number(),
  systemMemTotalBytes: z.number(),
  systemMemUsedBytes: z.number(),
  cgroupMemLimitBytes: z.number().nullable(),
  cgroupMemUsedBytes: z.number().nullable(),
  disks: z.array(DiskMountTelemetrySchema),
  updatedAt: z.string(),
});
export type ServiceNodeTelemetry = z.infer<typeof ServiceNodeTelemetrySchema>;

export const DatabaseTableBreakdownSchema = z.object({
  tableName: z.string(),
  label: z.string(),
  category: z.enum(['system', 'manageable']),
  deletable: z.boolean(),
  rowBytes: z.number(),
  indexBytes: z.number(),
  toastBytes: z.number(),
  totalBytes: z.number(),
  liveRows: z.number(),
  deadRows: z.number(),
});
export type DatabaseTableBreakdown = z.infer<typeof DatabaseTableBreakdownSchema>;

export const DatabaseBreakdownSchema = z.object({
  systemBytes: z.number(),
  manageableBytes: z.number(),
  deadTupleBytesEstimate: z.number(),
  tables: z.array(DatabaseTableBreakdownSchema),
});
export type DatabaseBreakdown = z.infer<typeof DatabaseBreakdownSchema>;

export const MapStorageSummarySchema = z.object({
  totalBytes: z.number(),
  primaryBytes: z.number(),
  regionsBytes: z.number(),
  maxMapStorageBytes: z.number(),
  regionCount: z.number(),
});
export type MapStorageSummary = z.infer<typeof MapStorageSummarySchema>;

export const RedisTelemetrySchema = z.object({
  available: z.boolean(),
  usedMemoryBytes: z.number(),
  usedMemoryRssBytes: z.number(),
  maxMemoryBytes: z.number().nullable(),
  memFragmentationRatio: z.number().nullable(),
  connectedClients: z.number().nullable(),
  opsPerSec: z.number().nullable(),
  evictedKeys: z.number().nullable(),
  error: z.string().nullable().optional(),
});
export type RedisTelemetry = z.infer<typeof RedisTelemetrySchema>;

export const ResourceLimitsSettingsSchema = z.object({
  maxDatabaseMb: z.number().min(0).max(1_000_000),
  perUserMaxLocationMb: z.number().min(0).max(100_000),
  perUserMaxPoints: z.number().int().min(0).max(50_000_000),
  locationRetentionDays: z.number().int().min(0).max(3650),
  messageRetentionDays: z.number().int().min(0).max(3650),
  placeEventRetentionDays: z.number().int().min(0).max(3650),
  resolvedRequestRetentionDays: z.number().int().min(0).max(365),
  maxMapStorageMb: z.number().min(0).max(1_000_000),
  autoTrimOnQuota: z.boolean().default(true),
  updatedAt: z.string().nullable().optional(),
});
export type ResourceLimitsSettings = z.infer<typeof ResourceLimitsSettingsSchema>;

export const UpdateResourceLimitsSchema = z.object({
  maxDatabaseMb: z.number().min(0).max(1_000_000).optional(),
  perUserMaxLocationMb: z.number().min(0).max(100_000).optional(),
  perUserMaxPoints: z.number().int().min(0).max(50_000_000).optional(),
  locationRetentionDays: z.number().int().min(0).max(3650).optional(),
  messageRetentionDays: z.number().int().min(0).max(3650).optional(),
  placeEventRetentionDays: z.number().int().min(0).max(3650).optional(),
  resolvedRequestRetentionDays: z.number().int().min(0).max(365).optional(),
  maxMapStorageMb: z.number().min(0).max(1_000_000).optional(),
  autoTrimOnQuota: z.boolean().optional(),
});
export type UpdateResourceLimitsInput = z.infer<typeof UpdateResourceLimitsSchema>;

export const AdminNoticeScopeSchema = z.enum([
  'user_points',
  'user_storage',
  'global_database',
  'retention',
]);
export type AdminNoticeScope = z.infer<typeof AdminNoticeScopeSchema>;

export const AdminNoticeSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['quota_trim', 'storage_warning', 'system']),
  severity: z.enum(['info', 'warning', 'error']),
  title: z.string(),
  message: z.string(),
  userId: z.string().uuid().nullable(),
  username: z.string().nullable(),
  deletedPoints: z.number().int().nonnegative().nullable(),
  rangeStart: z.string().nullable(),
  rangeEnd: z.string().nullable(),
  scope: AdminNoticeScopeSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminNotice = z.infer<typeof AdminNoticeSchema>;

export const ResourcePruneResultSchema = z.object({
  settings: ResourceLimitsSettingsSchema,
  deletedLocations: z.number().int().nonnegative(),
  deletedMessages: z.number().int().nonnegative(),
  deletedPlaceEvents: z.number().int().nonnegative(),
  deletedLocationRequests: z.number().int().nonnegative(),
  deletedRegistrationRequests: z.number().int().nonnegative(),
  vacuumed: z.boolean(),
});
export type ResourcePruneResult = z.infer<typeof ResourcePruneResultSchema>;

export const SystemTelemetrySchema = z.object({
  timestamp: z.string(),
  logDir: z.string(),
  logStorageBytes: z.number(),
  maxLogStorageBytes: z.number(),
  logStoragePercent: z.number(),
  logStorageAlert: z.boolean(),
  databaseBytes: z.number(),
  totalLocationPoints: z.number(),
  totalActiveSockets: z.number(),
  users: z.array(UserTelemetrySchema),
  databaseBreakdown: DatabaseBreakdownSchema.optional(),
  mapStorage: MapStorageSummarySchema.optional(),
  redis: RedisTelemetrySchema.optional(),
  nodes: z.array(ServiceNodeTelemetrySchema).optional(),
  resourceLimits: ResourceLimitsSettingsSchema.optional(),
  notices: z.array(AdminNoticeSchema).optional(),
});
export type SystemTelemetry = z.infer<typeof SystemTelemetrySchema>;

export const LogEntrySchema = z.object({
  level: z.number().optional(),
  time: z.number().optional(),
  service: z.string().optional(),
  msg: z.string().optional(),
}).passthrough();
export type LogEntry = z.infer<typeof LogEntrySchema>;

// ---- Remote System Update Schemas ----

export const SystemUpdatePhaseSchema = z.enum([
  'idle',
  'checking',
  'pulling',
  'building',
  'restarting',
  'completed',
  'failed',
]);
export type SystemUpdatePhase = z.infer<typeof SystemUpdatePhaseSchema>;

export const SystemUpdateCommitSchema = z.object({
  sha: z.string(),
  message: z.string(),
  author: z.string().optional(),
  date: z.string().optional(),
});
export type SystemUpdateCommit = z.infer<typeof SystemUpdateCommitSchema>;

export const SystemUpdateStatusSchema = z.object({
  enabled: z.boolean(),
  disabledReason: z.string().nullable().optional(),
  phase: SystemUpdatePhaseSchema,
  running: z.boolean(),
  branch: z.string().nullable(),
  currentCommit: z.string().nullable(),
  currentCommitMessage: z.string().nullable(),
  upstreamBranch: z.string().nullable(),
  remoteCommit: z.string().nullable(),
  commitsBehind: z.number().int().nonnegative(),
  pendingCommits: z.array(SystemUpdateCommitSchema),
  updateAvailable: z.boolean(),
  workingTreeDirty: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  targetCommit: z.string().nullable(),
  error: z.string().nullable(),
  logs: z.array(z.string()),
});
export type SystemUpdateStatus = z.infer<typeof SystemUpdateStatusSchema>;

export const TriggerSystemUpdateSchema = z.object({
  rebuildEvenIfCurrent: z.boolean().default(false),
});
export type TriggerSystemUpdateInput = z.infer<typeof TriggerSystemUpdateSchema>;

// ---- Log Retention Policy Schemas ----

export const LogRetentionSettingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(365),
  maxFilesPerService: z.number().int().min(1).max(100),
  maxRecentEntries: z.number().int().min(50).max(10000),
  maxStorageMb: z.number().min(10).max(50000),
  autoPruneDiskLogs: z.boolean().default(true),
  updatedAt: z.string().nullable().optional(),
});
export type LogRetentionSettings = z.infer<typeof LogRetentionSettingsSchema>;

export const UpdateLogRetentionSchema = z.object({
  retentionDays: z.number().int().min(1).max(365).optional(),
  maxFilesPerService: z.number().int().min(1).max(100).optional(),
  maxRecentEntries: z.number().int().min(50).max(10000).optional(),
  maxStorageMb: z.number().min(10).max(50000).optional(),
  autoPruneDiskLogs: z.boolean().optional(),
});
export type UpdateLogRetentionInput = z.infer<typeof UpdateLogRetentionSchema>;

export const LogPruneResultSchema = z.object({
  settings: LogRetentionSettingsSchema,
  deletedFiles: z.number().int().nonnegative(),
  freedBytes: z.number().nonnegative(),
  trimmedRedisEntries: z.number().int().nonnegative(),
  remainingRedisEntries: z.number().int().nonnegative(),
});
export type LogPruneResult = z.infer<typeof LogPruneResultSchema>;

// ---- Third-Party Tracker Schemas (OwnTracks & Overland) ----

export const OwnTracksLocationItemSchema = z
  .object({
    _type: z.string(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    tst: z.number().optional(),
    alt: z.number().nullable().optional(),
    acc: z.number().nullable().optional(),
    vel: z.number().nullable().optional(),
    batt: z.number().nullable().optional(),
  })
  .passthrough();

export const OwnTracksPayloadSchema = z.union([
  OwnTracksLocationItemSchema,
  z.array(OwnTracksLocationItemSchema).max(500),
]);

/**
 * Normalizes OwnTracks HTTP payloads into LocationPoint[].
 * Non-location OwnTracks events (_type !== 'location', such as 'lwt', 'status',
 * 'transition', 'waypoints') return an empty array so OwnTracks clears its queue.
 * Throws a ZodError if a '_type: location' item is missing valid coordinates.
 */
export function normalizeOwnTracksToPoints(
  rawInput: unknown,
  nowMs = Date.now(),
): LocationPoint[] {
  const parsed = OwnTracksPayloadSchema.parse(rawInput);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const points: LocationPoint[] = [];

  for (const item of items) {
    if (item._type !== 'location') {
      continue;
    }
    if (typeof item.lat !== 'number' || typeof item.lon !== 'number') {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['lat', 'lon'],
          message: 'OwnTracks location payload requires numeric lat and lon',
        },
      ]);
    }

    const recordedDate =
      typeof item.tst === 'number' && Number.isFinite(item.tst) && item.tst > 0
        ? new Date(item.tst * 1000)
        : new Date(nowMs);
    const recordedAt = Number.isNaN(recordedDate.getTime())
      ? new Date(nowMs).toISOString()
      : recordedDate.toISOString();

    // OwnTracks vel is reported in km/h; convert to m/s
    const speed =
      typeof item.vel === 'number' && Number.isFinite(item.vel) && item.vel >= 0
        ? Number((item.vel / 3.6).toFixed(2))
        : null;

    const batteryLevel =
      typeof item.batt === 'number' && Number.isFinite(item.batt) && item.batt >= 0
        ? Math.min(100, Math.max(0, Math.round(item.batt)))
        : null;

    const altitude =
      typeof item.alt === 'number' && Number.isFinite(item.alt) ? item.alt : null;
    const accuracy = parseNonNegativeFinite(item.acc);

    points.push({
      latitude: item.lat,
      longitude: item.lon,
      altitude,
      accuracy,
      speed,
      batteryLevel,
      recordedAt,
    });
  }

  return points;
}

export const OverlandFeatureSchema = z
  .object({
    type: z.literal('Feature').optional(),
    geometry: z.object({
      type: z.literal('Point'),
      coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).rest(z.number()),
    }),
    properties: z
      .object({
        timestamp: z.union([z.string(), z.number()]).optional(),
        altitude: z.number().nullable().optional(),
        horizontal_accuracy: z.number().nullable().optional(),
        speed: z.number().nullable().optional(),
        battery_level: z.number().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const OverlandPayloadSchema = z
  .object({
    locations: z.array(OverlandFeatureSchema).max(500),
  })
  .passthrough();

/**
 * Normalizes Overland GeoJSON batch payloads into LocationPoint[].
 * Overland coordinates use GeoJSON [longitude, latitude] order and report
 * battery_level as a 0.0-1.0 float (or negative when unknown).
 */
export function normalizeOverlandToPoints(
  rawInput: unknown,
  nowMs = Date.now(),
): LocationPoint[] {
  const parsed = OverlandPayloadSchema.parse(rawInput);
  const points: LocationPoint[] = [];

  for (const loc of parsed.locations) {
    const [longitude, latitude, coordAlt] = loc.geometry.coordinates;
    const props = loc.properties;

    let recordedAt = new Date(nowMs).toISOString();
    if (props?.timestamp !== undefined) {
      const tsDate =
        typeof props.timestamp === 'number'
          ? new Date(props.timestamp * 1000)
          : new Date(props.timestamp);
      if (!Number.isNaN(tsDate.getTime())) {
        recordedAt = tsDate.toISOString();
      }
    }

    const rawBatt = props?.battery_level;
    let batteryLevel: number | null = null;
    if (typeof rawBatt === 'number' && Number.isFinite(rawBatt) && rawBatt >= 0) {
      const scaled = rawBatt <= 1 ? rawBatt * 100 : rawBatt;
      batteryLevel = Math.min(100, Math.max(0, Math.round(scaled)));
    }

    const speed =
      typeof props?.speed === 'number' && Number.isFinite(props.speed) && props.speed >= 0
        ? props.speed
        : null;

    const altitude =
      typeof props?.altitude === 'number' && Number.isFinite(props.altitude)
        ? props.altitude
        : typeof coordAlt === 'number' && Number.isFinite(coordAlt)
          ? coordAlt
          : null;
    const accuracy = parseNonNegativeFinite(props?.horizontal_accuracy);

    points.push({
      latitude,
      longitude,
      altitude,
      accuracy,
      speed,
      batteryLevel,
      recordedAt,
    });
  }

  return points;
}

// ---- Onboarding Handshake & Admin-Approved Account Requests ----

export const REGISTRATION_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export const RegistrationRequestStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'DENIED',
  'EXPIRED',
]);
export type RegistrationRequestStatus = z.infer<typeof RegistrationRequestStatusSchema>;

export const OnboardingHandshakeSchema = z.object({
  inviteToken: z.string().trim().min(4).max(128).optional(),
});
export type OnboardingHandshakeInput = z.infer<typeof OnboardingHandshakeSchema>;

export const CreateRegistrationRequestSchema = z.object({
  email: z.string().trim().email().max(255),
  username: UsernameSchema,
  password: z.string().min(8).max(128),
  avatarUrl: AvatarUrlSchema.nullable().optional(),
  haloColor: z
    .string()
    .trim()
    .refine((v) => isSafeHexColor(v), { message: 'Color must be a #RRGGBB hex value' })
    .transform((v) => v.toLowerCase())
    .nullable()
    .optional(),
  fuzzCircleColor: z
    .string()
    .trim()
    .refine((v) => isSafeHexColor(v), { message: 'Color must be a #RRGGBB hex value' })
    .transform((v) => v.toLowerCase())
    .nullable()
    .optional(),
  inviteToken: z.string().trim().min(4).max(128).optional(),
});
export type CreateRegistrationRequestInput = z.infer<typeof CreateRegistrationRequestSchema>;

export const RegistrationRequestItemSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  haloColor: z.string().nullable(),
  fuzzCircleColor: z.string().nullable(),
  inviteToken: z.string().nullable(),
  groupName: z.string().nullable(),
  requesterIp: z.string(),
  status: RegistrationRequestStatusSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
});
export type RegistrationRequestItem = z.infer<typeof RegistrationRequestItemSchema>;

export const OnboardingHandshakeResponseSchema = z.object({
  ok: z.literal(true),
  serverName: z.string(),
  requesterIp: z.string(),
  alreadyPinged: z.boolean(),
  activeRequest: RegistrationRequestItemSchema.nullable(),
  invite: z
    .object({
      groupId: z.string().uuid(),
      groupName: z.string(),
      assignedRole: GroupRoleSchema,
    })
    .nullable(),
});
export type OnboardingHandshakeResponse = z.infer<typeof OnboardingHandshakeResponseSchema>;

/**
 * Formats remaining time until an ISO expiry timestamp as `23h 59m 12s` (or `Expired`).
 */
export function formatCountdownRemaining(expiresAtIso: string, nowMs = Date.now()): string {
  const targetMs = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(targetMs)) return 'Expired';
  const remainingSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  if (remainingSec <= 0) return 'Expired';
  const hours = Math.floor(remainingSec / 3600);
  const minutes = Math.floor((remainingSec % 3600) / 60);
  const seconds = remainingSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  return `${minutes}m ${pad(seconds)}s`;
}

export const PushSubscriptionInputSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
  keys: z.object({
    p256dh: z.string().trim().min(16).max(512),
    auth: z.string().trim().min(8).max(256),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInputSchema>;

export const PushUnsubscribeInputSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
});
export type PushUnsubscribeInput = z.infer<typeof PushUnsubscribeInputSchema>;

export interface WebPushNotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  groupId?: string;
  tab?: 'people' | 'chat' | 'places' | 'requests';
}

export const CreateLocationShareLinkSchema = z.object({
  groupId: z.string().uuid(),
  durationMinutes: z.number().int().min(5).max(1440).default(60),
  label: z.string().trim().min(1).max(80).optional(),
  allowGuestSharing: z.boolean().default(true),
});
export type CreateLocationShareLinkInput = z.infer<typeof CreateLocationShareLinkSchema>;

export const GuestSharePingSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(50000).nullable().optional(),
  guestId: z.string().uuid().optional(),
  guestSecret: z.string().trim().min(16).max(128).optional(),
});
export type GuestSharePingInput = z.infer<typeof GuestSharePingSchema>;

export const GuestShareStopSchema = z.object({
  guestId: z.string().uuid(),
  guestSecret: z.string().trim().min(16).max(128),
});
export type GuestShareStopInput = z.infer<typeof GuestShareStopSchema>;

export interface LocationShareLinkItem {
  token: string;
  groupId: string;
  groupName: string;
  label: string | null;
  allowGuestSharing: boolean;
  activeGuestCount: number;
  expiresAt: string;
  createdAt: string;
  shareUrl: string;
}

export interface PublicLocationShareGuest {
  id: string;
  displayName: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  updatedAt: string;
}

export interface PublicLocationShareCreatorPin {
  userId: string;
  username: string;
  avatarUrl: string | null;
  haloColor: string | null;
  fuzzCircleColor: string | null;
  privacyMode: PrivacyMode;
  isFuzzed: boolean;
  hidden: boolean;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  speed: number | null;
  batteryLevel: number | null;
  recordedAt: string | null;
}

export const TrailSegmentKindSchema = z.enum(['road', 'direct', 'spur']);
export type TrailSegmentKindValue = z.infer<typeof TrailSegmentKindSchema>;

export const TrailPathSegmentSchema = z.object({
  kind: TrailSegmentKindSchema,
  coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  roadKind: z.string().optional(),
});

export const AveragedTrailStopSchema = z.object({
  userId: z.string(),
  username: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  pingCount: z.number().int().min(1),
  firstRecordedAt: z.string(),
  lastRecordedAt: z.string(),
  isFuzzed: z.boolean(),
});

export const TrailStopVisitSchema = z.object({
  stopIndex: z.number().int().nonnegative(),
  latitude: z.number(),
  longitude: z.number(),
  firstRecordedAt: z.string(),
  lastRecordedAt: z.string(),
  isFuzzed: z.boolean(),
  maxSpeedMps: z.number().nullable(),
  pingCount: z.number().int().min(1).optional(),
  dwellDurationMs: z.number().nonnegative().optional(),
  isDwell: z.boolean().optional(),
  accuracyMeters: z.number().nullable().optional(),
  headingDeg: z.number().nullable().optional(),
});

export const MatchedUserTrailSchema = z.object({
  userId: z.string(),
  username: z.string(),
  stops: z.array(AveragedTrailStopSchema),
  visits: z.array(TrailStopVisitSchema).optional(),
  segments: z.array(TrailPathSegmentSchema),
  hasRoadMatches: z.boolean(),
});

export interface PublicLocationShareSnapshot {
  token: string;
  label: string | null;
  allowGuestSharing: boolean;
  expiresAt: string;
  creator: PublicLocationShareCreatorPin;
  guests: PublicLocationShareGuest[];
}
