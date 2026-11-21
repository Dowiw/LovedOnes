import {
  bigserial,
  boolean,
  customType,
  doublePrecision,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const systemRoleEnum = pgEnum('system_role', ['HOST_ADMIN', 'USER']);
export const groupRoleEnum = pgEnum('group_role', ['ADMIN', 'MEMBER', 'SPECTATOR']);
export const privacyModeEnum = pgEnum('privacy_mode', ['EXACT', 'FUZZED', 'GHOST']);
export const locationRequestStatusEnum = pgEnum('location_request_status', [
  'pending',
  'accepted',
  'declined',
  'expired',
]);
export const placeTransitionTypeEnum = pgEnum('place_transition_type', ['enter', 'exit']);
export const registrationRequestStatusEnum = pgEnum('registration_request_status', [
  'PENDING',
  'APPROVED',
  'DENIED',
  'EXPIRED',
]);

const geographyPoint = customType<{ data: string }>({
  dataType() {
    return 'geography(Point, 4326)';
  },
});

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  username: varchar('username', { length: 64 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  role: systemRoleEnum('role').default('USER').notNull(),
  avatarUrl: text('avatar_url'),
  haloColor: varchar('halo_color', { length: 7 }),
  fuzzCircleColor: varchar('fuzz_circle_color', { length: 7 }),
  recoveryEmail: varchar('recovery_email', { length: 255 }),
  recoveryEmailVerified: boolean('recovery_email_verified').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const groups = pgTable('groups', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const groupMemberships = pgTable(
  'group_memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    role: groupRoleEnum('role').default('MEMBER').notNull(),
    privacy: privacyModeEnum('privacy').default('EXACT').notNull(),
    privacyOverrideUntil: timestamp('privacy_override_until', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.groupId] })],
);

export const groupInvites = pgTable('group_invites', {
  token: varchar('token', { length: 128 }).primaryKey(),
  groupId: uuid('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  assignedRole: groupRoleEnum('assigned_role').default('MEMBER').notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  maxUses: integer('max_uses').default(1).notNull(),
  uses: integer('uses').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const locationHistory = pgTable(
  'location_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    coords: geographyPoint('coords').notNull(),
    altitude: doublePrecision('altitude'),
    speed: doublePrecision('speed'),
    batteryLevel: smallint('battery_level'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userRecordedUniqueIdx: uniqueIndex('idx_location_user_recorded_unique').on(
      table.userId,
      table.recordedAt,
    ),
  }),
);

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  groupId: uuid('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const locationRequests = pgTable('location_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  groupId: uuid('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  requesterId: uuid('requester_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  targetUserId: uuid('target_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: locationRequestStatusEnum('status').default('pending').notNull(),
  suggestedDurationMinutes: integer('suggested_duration_minutes').default(15).notNull(),
  message: varchar('message', { length: 240 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const groupPlaces = pgTable('group_places', {
  id: uuid('id').defaultRandom().primaryKey(),
  groupId: uuid('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  center: geographyPoint('center').notNull(),
  radiusMeters: doublePrecision('radius_meters').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const groupPlaceStates = pgTable(
  'group_place_states',
  {
    placeId: uuid('place_id')
      .notNull()
      .references(() => groupPlaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isInside: boolean('is_inside').notNull(),
    lastTransitionAt: timestamp('last_transition_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.placeId, table.userId] })],
);

export const groupPlaceEvents = pgTable('group_place_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  groupId: uuid('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  placeId: uuid('place_id')
    .notNull()
    .references(() => groupPlaces.id, { onDelete: 'cascade' }),
  placeName: varchar('place_name', { length: 100 }).notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  transition: placeTransitionTypeEnum('transition').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const registrationRequests = pgTable('registration_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  username: varchar('username', { length: 64 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  haloColor: varchar('halo_color', { length: 7 }),
  fuzzCircleColor: varchar('fuzz_circle_color', { length: 7 }),
  inviteToken: varchar('invite_token', { length: 128 }).references(() => groupInvites.token, {
    onDelete: 'set null',
  }),
  groupName: varchar('group_name', { length: 100 }),
  requesterIp: varchar('requester_ip', { length: 128 }).notNull(),
  status: registrationRequestStatusEnum('status').default('PENDING').notNull(),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const pushVapidConfig = pgTable('push_vapid_config', {
  id: smallint('id').primaryKey().default(1),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  subject: text('subject').default('mailto:admin@lovedones.local').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const locationShareLinks = pgTable('location_share_links', {
  token: varchar('token', { length: 96 }).primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  label: varchar('label', { length: 80 }),
  allowGuestSharing: boolean('allow_guest_sharing').default(true).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const locationShareGuests = pgTable('location_share_guests', {
  id: uuid('id').defaultRandom().primaryKey(),
  shareToken: varchar('share_token', { length: 96 })
    .notNull()
    .references(() => locationShareLinks.token, { onDelete: 'cascade' }),
  guestSecret: varchar('guest_secret', { length: 96 }).notNull(),
  displayName: varchar('display_name', { length: 40 }).notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  accuracy: doublePrecision('accuracy'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
