import {
  bigserial,
  customType,
  doublePrecision,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const systemRoleEnum = pgEnum('system_role', ['HOST_ADMIN', 'USER']);
export const groupRoleEnum = pgEnum('group_role', ['ADMIN', 'MEMBER', 'SPECTATOR']);
export const privacyModeEnum = pgEnum('privacy_mode', ['EXACT', 'FUZZED', 'GHOST']);

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

export const locationHistory = pgTable('location_history', {
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
});

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
