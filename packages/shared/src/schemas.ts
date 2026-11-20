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

export const RegisterSchema = z.object({
  email: z.string().email().max(255),
  username: z.string().min(2).max(64).trim(),
  password: z.string().min(8).max(128),
  inviteToken: z.string().min(4).max(128).optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const UpdateProfileSchema = z
  .object({
    username: z.string().min(2).max(64).trim().optional(),
    email: z.string().email().max(255).trim().optional(),
    avatarUrl: AvatarUrlSchema.nullable().optional(),
  })
  .refine(
    (data) =>
      data.username !== undefined || data.email !== undefined || data.avatarUrl !== undefined,
    { message: 'Provide username, email, or avatarUrl to update' },
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
  groupIds: z.array(z.string().uuid()),
});
export type MemberProfileUpdatedEvent = z.infer<typeof MemberProfileUpdatedSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

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

export const LocationPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().nullable().optional(),
  accuracy: z.number().min(0).nullable().optional(),
  speed: z.number().min(0).nullable().optional(),
  batteryLevel: z.number().int().min(0).max(100).nullable().optional(),
  recordedAt: z.string().datetime(),
});
export type LocationPoint = z.infer<typeof LocationPointSchema>;

export const LocationBatchSchema = z.object({
  points: z.array(LocationPointSchema).min(1).max(500),
});
export type LocationBatch = z.infer<typeof LocationBatchSchema>;

export const LocationBroadcastSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  avatarUrl: z.string().nullable().optional(),
  groupId: z.string().uuid(),
  latitude: z.number(),
  longitude: z.number(),
  altitude: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),
  batteryLevel: z.number().nullable().optional(),
  recordedAt: z.string(),
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
});
export type CreateGroupPlaceInput = z.infer<typeof CreateGroupPlaceSchema>;

export const GroupPlaceSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
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
  cpuMsTotal: z.number(),
  cpuMsPerMin: z.number(),
  eventsCount: z.number(),
  pingsPerMin: z.number(),
  activeSockets: z.number(),
  redisMemoryBytes: z.number(),
});
export type UserTelemetry = z.infer<typeof UserTelemetrySchema>;

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
});
export type SystemTelemetry = z.infer<typeof SystemTelemetrySchema>;

export const LogEntrySchema = z.object({
  level: z.number().optional(),
  time: z.number().optional(),
  service: z.string().optional(),
  msg: z.string().optional(),
}).passthrough();
export type LogEntry = z.infer<typeof LogEntrySchema>;

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
