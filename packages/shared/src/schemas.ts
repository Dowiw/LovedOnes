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

export const RegisterSchema = z.object({
  email: z.string().email().max(255),
  username: z.string().min(2).max(64).trim(),
  password: z.string().min(8).max(128),
  inviteToken: z.string().min(4).max(128).optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

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
  type: z.enum(['access', 'refresh']).optional(),
});
export type JwtUserPayload = z.infer<typeof JwtUserPayloadSchema>;

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

export const LocationPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().nullable().optional(),
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
  content: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

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
