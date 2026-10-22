// The tables as 1.69 and earlier defined them, frozen for the test that a database holding them is renamed, not dropped, by the tables of today.
import { defineTable } from '@kaynooo/pg-orm'

export const LegacyUsers = defineTable('auth_user', t => ({
  id: t.text().primaryKey(),
  email: t.text().nullable().unique(),
  email_verified_at: t.timestamptz().nullable(),
  username: t.text().nullable(),
  // The username lowercased, so two names differing in case only cannot both exist.
  username_key: t.text().nullable().unique(),
  password_hash: t.text().nullable(),
  totp_secret: t.text().nullable(),
  totp_enabled_at: t.timestamptz().nullable(),
  totp_last_step: t.int4().notNull().default(0),
  roles: t.array(t.text()).notNull().default([]),
  session_version: t.int4().notNull().default(0),
  last_sign_in: t.text().nullable(),
  locale: t.text().nullable(),
  guest: t.bool().notNull().default(false),
  banned_at: t.timestamptz().nullable(),
  banned_until: t.timestamptz().nullable(),
  ban_reason: t.text().nullable(),
  // The app's own data on the user, from the `user` option.
  data: t.jsonb<Record<string, unknown>>().notNull().default({}),
  created_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['created_at'] }, { columns: ['guest', 'created_at'] }])

const userId = () => LegacyUsers

export const LegacyIdentities = defineTable('auth_identity', t => ({
  id: t.serial().primaryKey(),
  provider: t.text().notNull(),
  provider_id: t.text().notNull(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  access_token: t.text().nullable(),
  refresh_token: t.text().nullable(),
  token_expires_at: t.timestamptz().nullable(),
  created_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['provider', 'provider_id'], unique: true }, { columns: ['user_id'] }])

export const LegacyTokens = defineTable('auth_token', t => ({
  digest: t.text().primaryKey(),
  type: t.text().notNull(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  email: t.text().notNull(),
  redirect: t.text().nullable(),
  expires_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['user_id', 'type'] }, { columns: ['expires_at'] }])

export const LegacyRecoveryCodes = defineTable('auth_recovery_code', t => ({
  id: t.serial().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  digest: t.text().notNull(),
})).withIndexes([{ columns: ['user_id', 'digest'], unique: true }])

export const LegacyBearerTokens = defineTable('auth_bearer_token', t => ({
  id: t.text().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  label: t.text().notNull(),
  digest: t.text().notNull().unique(),
  scopes: t.array(t.text()).nullable(),
  created_at: t.timestamptz().notNull(),
  last_used_at: t.timestamptz().nullable(),
  expires_at: t.timestamptz().nullable(),
  // Set on a token an OAuth client was given.
  oauth_client: t.text().nullable(),
  oauth_family: t.text().nullable(),
  // The resource (RFC 8707) the token is bound to; null for none, and for tokens stored before this column.
  oauth_resource: t.text().nullable(),
})).withIndexes([{ columns: ['user_id'] }, { columns: ['expires_at'] }, { columns: ['user_id', 'oauth_client'] }, { columns: ['user_id', 'oauth_family'] }])

export const LegacySessions = defineTable('auth_session', t => ({
  id: t.text().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  version: t.int4().notNull(),
  user_agent: t.text().notNull(),
  ip: t.text().notNull(),
  created_at: t.timestamptz().notNull(),
  last_seen_at: t.timestamptz().notNull(),
  max_age: t.int4().nullable(),
})).withIndexes([{ columns: ['user_id'] }, { columns: ['last_seen_at'] }, { columns: ['created_at'] }])

export const LegacyPasskeys = defineTable('auth_passkey', t => ({
  id: t.text().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  name: t.text().notNull(),
  public_key: t.text().notNull(),
  // A uint32, past what int4 holds.
  counter: t.int8().notNull(),
  transports: t.array(t.text()).notNull(),
  multi_device: t.bool().notNull(),
  backed_up: t.bool().notNull(),
  // Passkeys stored before this column are unproven until one sign-in with user verification.
  user_verified: t.bool().notNull().default(false),
  created_at: t.timestamptz().notNull(),
  last_used_at: t.timestamptz().nullable(),
})).withIndexes([{ columns: ['user_id'] }])

// No reference to the user: the log outlives them.
export const LegacyAudit = defineTable('auth_audit', t => ({
  id: t.text().primaryKey(),
  user_id: t.text().notNull(),
  event: t.text().notNull(),
  detail: t.text().nullable(),
  ip: t.text().notNull(),
  user_agent: t.text().notNull(),
  actor_id: t.text().nullable(),
  at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['user_id', 'at'] }, { columns: ['at'] }, { columns: ['actor_id'] }])

export const LegacyOrganizations = defineTable('auth_organization', t => ({
  id: t.text().primaryKey(),
  name: t.text().notNull(),
  slug: t.text().nullable().unique(),
  created_at: t.timestamptz().notNull(),
}))

const organizationId = () => LegacyOrganizations

export const LegacyMembers = defineTable('auth_member', t => ({
  id: t.serial().primaryKey(),
  organization_id: t.text().notNull().references(organizationId, 'id', { onDelete: 'cascade' }),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  roles: t.array(t.text()).notNull(),
  created_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['organization_id', 'user_id'], unique: true }, { columns: ['user_id'] }])

export const LegacyInvitations = defineTable('auth_invitation', t => ({
  id: t.text().primaryKey(),
  organization_id: t.text().notNull().references(organizationId, 'id', { onDelete: 'cascade' }),
  email: t.text().notNull(),
  roles: t.array(t.text()).notNull(),
  invited_by: t.text().nullable().references(userId, 'id', { onDelete: 'set null' }),
  created_at: t.timestamptz().notNull(),
  expires_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['organization_id'] }, { columns: ['email'] }, { columns: ['expires_at'] }])

export const LegacyOAuthClients = defineTable('auth_oauth_client', t => ({
  id: t.text().primaryKey(),
  name: t.text().notNull(),
  redirect_uris: t.array(t.text()).notNull(),
  created_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['created_at'] }])

export const LegacyOAuthGrants = defineTable('auth_oauth_grant', t => ({
  id: t.serial().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  client_id: t.text().notNull(),
  client_name: t.text().notNull(),
  scopes: t.array(t.text()).nullable(),
  created_at: t.timestamptz().notNull(),
  last_used_at: t.timestamptz().nullable(),
})).withIndexes([{ columns: ['user_id', 'client_id'], unique: true }, { columns: ['client_id'] }])

export const LegacyOAuthCodes = defineTable('auth_oauth_code', t => ({
  digest: t.text().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  client_id: t.text().notNull(),
  redirect_uri: t.text().notNull(),
  challenge: t.text().notNull(),
  scopes: t.array(t.text()).nullable(),
  family: t.text().notNull(),
  // The resource (RFC 8707) asked at authorize; null for none, and for codes stored before this column.
  resource: t.text().nullable(),
  created_at: t.timestamptz().notNull(),
  expires_at: t.timestamptz().notNull(),
  used_at: t.timestamptz().nullable(),
})).withIndexes([{ columns: ['expires_at'] }, { columns: ['user_id'] }])

export const LegacyOAuthRefresh = defineTable('auth_oauth_refresh', t => ({
  digest: t.text().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  client_id: t.text().notNull(),
  scopes: t.array(t.text()).nullable(),
  family: t.text().notNull(),
  // The resource (RFC 8707) the family is bound to; null for none, and for tokens stored before this column.
  resource: t.text().nullable(),
  created_at: t.timestamptz().notNull(),
  expires_at: t.timestamptz().notNull(),
  used_at: t.timestamptz().nullable(),
})).withIndexes([{ columns: ['user_id', 'family'] }, { columns: ['user_id', 'client_id'] }, { columns: ['expires_at'] }])

export const LegacyAttempts = defineTable('auth_attempt', t => ({
  key: t.text().primaryKey(),
  count: t.int4().notNull(),
  reset_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['reset_at'] }])

export const legacyTables = [LegacyUsers, LegacyIdentities, LegacyTokens, LegacyRecoveryCodes, LegacyBearerTokens, LegacySessions, LegacyPasskeys, LegacyAudit, LegacyOrganizations, LegacyMembers, LegacyInvitations, LegacyAttempts, LegacyOAuthClients, LegacyOAuthGrants, LegacyOAuthCodes, LegacyOAuthRefresh] as const
