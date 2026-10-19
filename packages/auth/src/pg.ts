import type { Database, InferEntity } from '@kaynooo/pg-orm'
import type { AuditRecord, AuthStore, BearerTokenRecord, IdentityRecord, InvitationRecord, MemberRecord, OAuthClientRecord, OAuthCodeRecord, OAuthGrantRecord, OAuthRefreshRecord, OrganizationRecord, PasskeyRecord, PruneLimits, SessionRecord, TokenRecord, TokenType, UserRecord } from './store'
import { defineTable } from '@kaynooo/pg-orm'
import { log } from './log'

export const AuthUsers = defineTable('auth_user', t => ({
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
  created_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['created_at'] }, { columns: ['guest', 'created_at'] }])

const userId = () => AuthUsers

export const AuthIdentities = defineTable('auth_identity', t => ({
  id: t.serial().primaryKey(),
  provider: t.text().notNull(),
  provider_id: t.text().notNull(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  access_token: t.text().nullable(),
  refresh_token: t.text().nullable(),
  token_expires_at: t.timestamptz().nullable(),
  created_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['provider', 'provider_id'], unique: true }, { columns: ['user_id'] }])

export const AuthTokens = defineTable('auth_token', t => ({
  digest: t.text().primaryKey(),
  type: t.text().notNull(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  email: t.text().notNull(),
  redirect: t.text().nullable(),
  expires_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['user_id', 'type'] }, { columns: ['expires_at'] }])

export const AuthRecoveryCodes = defineTable('auth_recovery_code', t => ({
  id: t.serial().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  digest: t.text().notNull(),
})).withIndexes([{ columns: ['user_id', 'digest'], unique: true }])

export const AuthBearerTokens = defineTable('auth_bearer_token', t => ({
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

export const AuthSessions = defineTable('auth_session', t => ({
  id: t.text().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  version: t.int4().notNull(),
  user_agent: t.text().notNull(),
  ip: t.text().notNull(),
  created_at: t.timestamptz().notNull(),
  last_seen_at: t.timestamptz().notNull(),
  max_age: t.int4().nullable(),
})).withIndexes([{ columns: ['user_id'] }, { columns: ['last_seen_at'] }, { columns: ['created_at'] }])

export const AuthPasskeys = defineTable('auth_passkey', t => ({
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
export const AuthAudit = defineTable('auth_audit', t => ({
  id: t.text().primaryKey(),
  user_id: t.text().notNull(),
  event: t.text().notNull(),
  detail: t.text().nullable(),
  ip: t.text().notNull(),
  user_agent: t.text().notNull(),
  actor_id: t.text().nullable(),
  at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['user_id', 'at'] }, { columns: ['at'] }, { columns: ['actor_id'] }])

export const AuthOrganizations = defineTable('auth_organization', t => ({
  id: t.text().primaryKey(),
  name: t.text().notNull(),
  slug: t.text().nullable().unique(),
  created_at: t.timestamptz().notNull(),
}))

const organizationId = () => AuthOrganizations

export const AuthMembers = defineTable('auth_member', t => ({
  id: t.serial().primaryKey(),
  organization_id: t.text().notNull().references(organizationId, 'id', { onDelete: 'cascade' }),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  roles: t.array(t.text()).notNull(),
  created_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['organization_id', 'user_id'], unique: true }, { columns: ['user_id'] }])

export const AuthInvitations = defineTable('auth_invitation', t => ({
  id: t.text().primaryKey(),
  organization_id: t.text().notNull().references(organizationId, 'id', { onDelete: 'cascade' }),
  email: t.text().notNull(),
  roles: t.array(t.text()).notNull(),
  invited_by: t.text().nullable().references(userId, 'id', { onDelete: 'set null' }),
  created_at: t.timestamptz().notNull(),
  expires_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['organization_id'] }, { columns: ['email'] }, { columns: ['expires_at'] }])

export const AuthOAuthClients = defineTable('auth_oauth_client', t => ({
  id: t.text().primaryKey(),
  name: t.text().notNull(),
  redirect_uris: t.array(t.text()).notNull(),
  created_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['created_at'] }])

export const AuthOAuthGrants = defineTable('auth_oauth_grant', t => ({
  id: t.serial().primaryKey(),
  user_id: t.text().notNull().references(userId, 'id', { onDelete: 'cascade' }),
  client_id: t.text().notNull(),
  client_name: t.text().notNull(),
  scopes: t.array(t.text()).nullable(),
  created_at: t.timestamptz().notNull(),
  last_used_at: t.timestamptz().nullable(),
})).withIndexes([{ columns: ['user_id', 'client_id'], unique: true }, { columns: ['client_id'] }])

export const AuthOAuthCodes = defineTable('auth_oauth_code', t => ({
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

export const AuthOAuthRefresh = defineTable('auth_oauth_refresh', t => ({
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

export const AuthAttempts = defineTable('auth_attempt', t => ({
  key: t.text().primaryKey(),
  count: t.int4().notNull(),
  reset_at: t.timestamptz().notNull(),
})).withIndexes([{ columns: ['reset_at'] }])

// The tables to list in the app's `new Database({ tables })`, so `db.sync()` creates them.
export const authTables = [AuthUsers, AuthIdentities, AuthTokens, AuthRecoveryCodes, AuthBearerTokens, AuthSessions, AuthPasskeys, AuthAudit, AuthOrganizations, AuthMembers, AuthInvitations, AuthAttempts, AuthOAuthClients, AuthOAuthGrants, AuthOAuthCodes, AuthOAuthRefresh] as const

type UserRow = InferEntity<typeof AuthUsers>

// A client that registered itself and that nobody approved is dropped after this long.
const UNUSED_CLIENT_MS = 24 * 60 * 60 * 1000

// kayjs-auth's data in the app's Postgres or SQLite database, through pg-orm: list `authTables` in the database's tables.
export function pgStore(db: Database): AuthStore {
  const users = db.repo(AuthUsers)
  const identities = db.repo(AuthIdentities)
  const tokens = db.repo(AuthTokens)
  const recoveryCodes = db.repo(AuthRecoveryCodes)
  const bearerTokens = db.repo(AuthBearerTokens)
  const sessions = db.repo(AuthSessions)
  const passkeys = db.repo(AuthPasskeys)
  const audit = db.repo(AuthAudit)
  const organizations = db.repo(AuthOrganizations)
  const members = db.repo(AuthMembers)
  const invitations = db.repo(AuthInvitations)
  const attempts = db.repo(AuthAttempts)
  const oauthClients = db.repo(AuthOAuthClients)
  const oauthGrants = db.repo(AuthOAuthGrants)
  const oauthCodes = db.repo(AuthOAuthCodes)
  const oauthRefresh = db.repo(AuthOAuthRefresh)

  return {
    users: {
      get: async id => toUser(await users.read.findById(id)),
      getMany: async ids => (await users.read.findMany({ id: { in: ids } })).map(row => toUser(row)!),
      findByEmail: async email => toUser(await users.read.findOne({ email })),
      findByUsername: async username => toUser(await users.read.findOne({ username_key: username.toLowerCase() })),
      async create(user) {
        await users.write.insertOne(fromUser(user))
      },
      async update(id, patch) {
        return toUser(await users.write.updateById(id, fromUser(patch)))
      },
      async staleGuests(createdBefore, limit) {
        const rows = await db.raw<{ id: string }>`
          SELECT "id" FROM "auth_user"
          WHERE "guest" = ${true} AND "created_at" < ${createdBefore} AND NOT EXISTS (SELECT 1 FROM "auth_session" WHERE "auth_session"."user_id" = "auth_user"."id")
          ORDER BY "created_at" LIMIT ${limit}`

        return rows.length === 0 ? [] : (await users.read.findMany(q => q.where({ id: { in: rows.map(row => row.id) } }).orderBy('created_at', 'asc'))).map(row => toUser(row)!)
      },
      async staleUnverified(createdBefore, limit) {
        const rows = await db.raw<{ id: string }>`
          SELECT "id" FROM "auth_user"
          WHERE "guest" = ${false} AND "email" IS NOT NULL AND "email_verified_at" IS NULL AND "created_at" < ${createdBefore}
            AND NOT EXISTS (SELECT 1 FROM "auth_session" WHERE "auth_session"."user_id" = "auth_user"."id")
            AND NOT EXISTS (SELECT 1 FROM "auth_identity" WHERE "auth_identity"."user_id" = "auth_user"."id")
          ORDER BY "created_at" LIMIT ${limit}`

        return rows.length === 0 ? [] : (await users.read.findMany(q => q.where({ id: { in: rows.map(row => row.id) } }).orderBy('created_at', 'asc'))).map(row => toUser(row)!)
      },
      async delete(id) {
        await users.write.deleteById(id)
      },
      async list({ search, offset, limit, total: counted = true }) {
        const [rows, total] = await Promise.all([
          users.read.findMany(q => q.andWhere(search !== undefined && (e => e.or(e.eq('id', search), e.iContains('email', search), e.iContains('username', search)))).orderBy('created_at', 'desc').orderBy('id', 'desc').offset(offset).limit(limit)),
          counted ? users.read.count(search !== undefined && (e => e.or(e.eq('id', search), e.iContains('email', search), e.iContains('username', search)))) : 0,
        ])

        return { users: rows.map(row => toUser(row)!), total }
      },
      // updateMany on the key, as updateOne's LIMIT 1 subquery is not rechecked against a concurrent step: two codes for one step would both pass.
      advanceTotpStep: async (id, step) => (await users.write.updateMany({ totp_last_step: step }, e => e.and(e.eq('id', id), e.lt('totp_last_step', step)), { pk: true })).length > 0,
    },
    identities: {
      find: async (provider, providerId) => toIdentity(await identities.read.findOne({ provider, provider_id: providerId })),
      listByUser: async userId => (await identities.read.findMany({ user_id: userId })).map(row => toIdentity(row)!),
      async create(identity) {
        await identities.write.insertOne({ provider: identity.provider, provider_id: identity.providerId, user_id: identity.userId, access_token: identity.accessToken, refresh_token: identity.refreshToken, token_expires_at: identity.tokenExpiresAt, created_at: identity.createdAt })
      },
      async update(provider, providerId, patch) {
        await identities.write.updateOne(withoutUndefined({ access_token: patch.accessToken, refresh_token: patch.refreshToken, token_expires_at: patch.tokenExpiresAt }), { provider, provider_id: providerId })
      },
      async delete(provider, providerId) {
        await identities.write.deleteMany({ provider, provider_id: providerId })
      },
      async deleteForUser(userId) {
        await identities.write.deleteMany({ user_id: userId })
      },
    },
    tokens: {
      async create(token) {
        await tokens.write.insertOne({ digest: token.digest, type: token.type, user_id: token.userId, email: token.email, redirect: token.redirect, expires_at: token.expiresAt })
      },
      async consume(digest, type) {
        // One DELETE ... RETURNING, so of two requests spending the token only one gets it back.
        const row = await tokens.write.deleteOne({ digest, type })

        return row && row.expires_at.getTime() > Date.now() ? toToken(row) : undefined
      },
      async deleteForUser(userId, type) {
        await tokens.write.deleteMany(type === undefined ? { user_id: userId } : { user_id: userId, type })
      },
    },
    sessions: {
      async create(session) {
        await sessions.write.insertOne({ id: session.id, user_id: session.userId, version: session.version, user_agent: session.userAgent, ip: session.ip, created_at: session.createdAt, last_seen_at: session.lastSeenAt, max_age: session.maxAge })
      },
      get: async id => toSession(await sessions.read.findById(id)),
      listByUser: async userId => (await sessions.read.findMany(q => q.where({ user_id: userId }).orderBy('created_at', 'asc'))).map(row => toSession(row)!),
      async update(id, patch) {
        await sessions.write.updateById(id, withoutUndefined({ version: patch.version, ip: patch.ip, last_seen_at: patch.lastSeenAt }))
      },
      delete: async (userId, id) => await sessions.write.deleteOne({ id, user_id: userId }) !== null,
    },
    passkeys: {
      async create(passkey) {
        await passkeys.write.insertOne({ id: passkey.id, user_id: passkey.userId, name: passkey.name, public_key: passkey.publicKey, counter: BigInt(passkey.counter), transports: passkey.transports, multi_device: passkey.multiDevice, backed_up: passkey.backedUp, user_verified: passkey.userVerified, created_at: passkey.createdAt, last_used_at: passkey.lastUsedAt })
      },
      get: async id => toPasskey(await passkeys.read.findById(id)),
      listByUser: async userId => (await passkeys.read.findMany(q => q.where({ user_id: userId }).orderBy('created_at', 'asc'))).map(row => toPasskey(row)!),
      async update(id, patch) {
        await passkeys.write.updateById(id, withoutUndefined({ name: patch.name, counter: patch.counter === undefined ? undefined : BigInt(patch.counter), backed_up: patch.backedUp, user_verified: patch.userVerified, last_used_at: patch.lastUsedAt }))
      },
      delete: async (userId, id) => await passkeys.write.deleteOne({ id, user_id: userId }) !== null,
    },
    audit: {
      async add(entry) {
        await audit.write.insertOne({ id: entry.id, user_id: entry.userId, event: entry.event, detail: entry.detail, ip: entry.ip, user_agent: entry.userAgent, actor_id: entry.actorId, at: entry.at })
      },
      list: async ({ userId, before, limit }) => (await audit.read.findMany(q => q.andWhere(userId !== undefined && { user_id: userId }).andWhere(before !== undefined && (e => before instanceof Date ? e.lt('at', before) : e.or(e.lt('at', before.at), e.and(e.eq('at', before.at), e.lt('id', before.id))))).orderBy('at', 'desc').orderBy('id', 'desc').limit(limit))).map(row => toAudit(row)),
      async prune(before) {
        await audit.write.deleteMany({ at: { lt: before } })
      },
      async forget(userId, pseudonym) {
        await audit.write.updateMany({ user_id: pseudonym, detail: null, ip: '', user_agent: '' }, { user_id: userId }, { pk: true })
        await audit.write.updateMany({ actor_id: pseudonym, ip: '', user_agent: '' }, { actor_id: userId }, { pk: true })
      },
    },
    organizations: {
      async create(organization) {
        await organizations.write.insertOne({ id: organization.id, name: organization.name, slug: organization.slug, created_at: organization.createdAt })
      },
      get: async id => toOrganization(await organizations.read.findById(id)),
      getMany: async ids => (await organizations.read.findMany({ id: { in: ids } })).map(row => toOrganization(row)!),
      findBySlug: async slug => toOrganization(await organizations.read.findOne({ slug })),
      update: async (id, patch) => toOrganization(await organizations.write.updateById(id, withoutUndefined({ name: patch.name, slug: patch.slug }))),
      delete: async id => await organizations.write.deleteById(id) !== null,
    },
    members: {
      async add(member) {
        await members.write.insertOne({ organization_id: member.organizationId, user_id: member.userId, roles: member.roles, created_at: member.createdAt })
      },
      get: async (organizationId, userId) => toMember(await members.read.findOne({ organization_id: organizationId, user_id: userId })),
      listByOrganization: async organizationId => (await members.read.findMany(q => q.where({ organization_id: organizationId }).orderBy('created_at', 'asc').orderBy('id', 'asc'))).map(row => toMember(row)!),
      listByUser: async userId => (await members.read.findMany(q => q.where({ user_id: userId }).orderBy('created_at', 'asc').orderBy('id', 'asc'))).map(row => toMember(row)!),
      update: async (organizationId, userId, patch) => toMember(await members.write.updateOne({ roles: patch.roles }, { organization_id: organizationId, user_id: userId })),
      delete: async (organizationId, userId) => await members.write.deleteOne({ organization_id: organizationId, user_id: userId }) !== null,
    },
    invitations: {
      async create(invitation) {
        await invitations.write.insertOne({ id: invitation.id, organization_id: invitation.organizationId, email: invitation.email, roles: invitation.roles, invited_by: invitation.invitedBy, created_at: invitation.createdAt, expires_at: invitation.expiresAt })
      },
      get: async id => toInvitation(await invitations.read.findById(id)),
      listByOrganization: async organizationId => (await invitations.read.findMany(q => q.where({ organization_id: organizationId }).orderBy('created_at', 'asc'))).map(row => toInvitation(row)!),
      listByEmail: async email => (await invitations.read.findMany(q => q.where({ email }).orderBy('created_at', 'asc'))).map(row => toInvitation(row)!),
      delete: async id => await invitations.write.deleteById(id) !== null,
    },
    bearerTokens: {
      async create(token) {
        await bearerTokens.write.insertOne({ id: token.id, user_id: token.userId, label: token.label, digest: token.digest, scopes: token.scopes, created_at: token.createdAt, last_used_at: token.lastUsedAt, expires_at: token.expiresAt, oauth_client: token.oauth?.clientId ?? null, oauth_family: token.oauth?.family ?? null, oauth_resource: token.oauth?.resource ?? null })
      },
      findByDigest: async digest => toBearerToken(await bearerTokens.read.findOne({ digest })),
      async findByDigestWithUser(digest) {
        // eslint-disable-next-line ts/no-unsafe-call, ts/no-unsafe-member-access, ts/no-unsafe-return -- joinedUser's query is untyped, as it says
        const [row] = await bearerTokens.read.findMany(q => joinedUser(q).where({ digest }).limit(1)) as unknown as (InferEntity<typeof AuthBearerTokens> & Record<string, unknown>)[]

        return row && { token: toBearerToken(row)!, user: toUser(userOf(row))! }
      },
      listByUser: async userId => (await bearerTokens.read.findMany(q => q.where({ user_id: userId }).orderBy('created_at', 'asc'))).map(row => toBearerToken(row)!),
      async touch(id, at) {
        await bearerTokens.write.updateById(id, { last_used_at: at })
      },
      delete: async (userId, id) => await bearerTokens.write.deleteOne({ id, user_id: userId }) !== null,
      async deleteForUser(userId) {
        await bearerTokens.write.deleteMany({ user_id: userId })
      },
    },
    oauth: {
      clients: {
        async create(client) {
          await oauthClients.write.insertOne({ id: client.id, name: client.name, redirect_uris: client.redirectUris, created_at: client.createdAt })
        },
        get: async id => toOAuthClient(await oauthClients.read.findById(id)),
      },
      grants: {
        get: async (userId, clientId) => toOAuthGrant(await oauthGrants.read.findOne({ user_id: userId, client_id: clientId })),
        async upsert(grant) {
          await oauthGrants.write.upsertOne({ user_id: grant.userId, client_id: grant.clientId, client_name: grant.clientName, scopes: grant.scopes, created_at: grant.createdAt, last_used_at: grant.lastUsedAt }, ['user_id', 'client_id'], ['client_name', 'scopes', 'last_used_at'])
        },
        async touch(userId, clientId, at) {
          await oauthGrants.write.updateMany({ last_used_at: at }, { user_id: userId, client_id: clientId }, { pk: true })
        },
        listByUser: async userId => (await oauthGrants.read.findMany(q => q.where({ user_id: userId }).orderBy('created_at', 'asc').orderBy('id', 'asc'))).map(row => toOAuthGrant(row)!),
        async revoke(userId, clientId) {
          return db.transaction(async (tx) => {
            await oauthRefresh.using(tx).write.deleteMany({ user_id: userId, client_id: clientId })
            await bearerTokens.using(tx).write.deleteMany({ user_id: userId, oauth_client: clientId })

            return await oauthGrants.using(tx).write.deleteOne({ user_id: userId, client_id: clientId }) !== null
          })
        },
      },
      codes: {
        async create(code) {
          await oauthCodes.write.insertOne({ digest: code.digest, user_id: code.userId, client_id: code.clientId, redirect_uri: code.redirectUri, challenge: code.challenge, scopes: code.scopes, family: code.family, resource: code.resource ?? null, created_at: code.createdAt, expires_at: code.expiresAt, used_at: code.usedAt })
        },
        async use(digest, at) {
          // One UPDATE on the unspent row, so of two requests spending the code only one finds it unspent.
          const [spent] = await oauthCodes.write.updateMany({ used_at: at }, e => e.and(e.eq('digest', digest), e.isNull('used_at')))

          if (spent)
            return { code: toOAuthCode(spent), reused: false }

          const row = await oauthCodes.read.findById(digest)

          return row ? { code: toOAuthCode(row), reused: true } : undefined
        },
      },
      refresh: {
        async create(token) {
          await oauthRefresh.write.insertOne({ digest: token.digest, user_id: token.userId, client_id: token.clientId, scopes: token.scopes, family: token.family, resource: token.resource ?? null, created_at: token.createdAt, expires_at: token.expiresAt, used_at: token.usedAt })
        },
        async use(digest, at) {
          const [spent] = await oauthRefresh.write.updateMany({ used_at: at }, e => e.and(e.eq('digest', digest), e.isNull('used_at')))

          if (spent)
            return { token: toOAuthRefresh(spent), reused: false }

          const row = await oauthRefresh.read.findById(digest)

          return row ? { token: toOAuthRefresh(row), reused: true } : undefined
        },
        async revokeFamily(userId, family) {
          await db.transaction(async (tx) => {
            await oauthRefresh.using(tx).write.deleteMany({ user_id: userId, family })
            await bearerTokens.using(tx).write.deleteMany({ user_id: userId, oauth_family: family })
          })
        },
        async deleteForUser(userId) {
          await withoutMissingOAuthTables(async () => oauthRefresh.write.deleteMany({ user_id: userId }))
        },
      },
    },
    recoveryCodes: {
      async replace(userId, digests) {
        await db.transaction(async (tx) => {
          const codes = recoveryCodes.using(tx)

          await codes.write.deleteMany({ user_id: userId })

          if (digests.length > 0)
            await codes.write.insertMany(digests.map(digest => ({ user_id: userId, digest })))
        })
      },
      consume: async (userId, digest) => await recoveryCodes.write.deleteOne({ user_id: userId, digest }) !== null,
      count: async userId => recoveryCodes.read.count({ user_id: userId }),
    },
    attempts: {
      async count(key) {
        const row = await attempts.read.findById(key)

        return row && row.reset_at.getTime() > Date.now() ? row.count : 0
      },
      async hit(key, window) {
        const now = new Date()

        // One statement, so two attempts at once both count: a window still open is raised, an ended one starts over.
        const [row] = await db.raw<{ count: number }>`
          INSERT INTO "auth_attempt" ("key", "count", "reset_at") VALUES (${key}, 1, ${new Date(now.getTime() + window * 1000)})
          ON CONFLICT ("key") DO UPDATE SET
            "count" = CASE WHEN "auth_attempt"."reset_at" > ${now} THEN "auth_attempt"."count" + 1 ELSE 1 END,
            "reset_at" = CASE WHEN "auth_attempt"."reset_at" > ${now} THEN "auth_attempt"."reset_at" ELSE EXCLUDED."reset_at" END
          RETURNING "count"`

        return row!.count
      },
      async reset(key) {
        await attempts.write.deleteMany({ key })
      },
    },
    async prune({ now, bearerExpiredBefore, sessionMaxAge, sessionAbsoluteMaxAge }: PruneLimits) {
      await Promise.all([
        withoutMissingOAuthTables(async () => Promise.all([
          oauthCodes.write.deleteMany({ expires_at: { lte: now } }),
          oauthRefresh.write.deleteMany({ expires_at: { lte: now } }),
          // A client that registered itself and that nobody approved within a month.
          db.raw`DELETE FROM "auth_oauth_client" WHERE "created_at" < ${new Date(now.getTime() - UNUSED_CLIENT_MS)} AND NOT EXISTS (SELECT 1 FROM "auth_oauth_grant" WHERE "auth_oauth_grant"."client_id" = "auth_oauth_client"."id")`,
        ])),
        tokens.write.deleteMany({ expires_at: { lte: now } }),
        invitations.write.deleteMany({ expires_at: { lte: now } }),
        bearerTokens.write.deleteMany({ expires_at: { lt: bearerExpiredBefore } }),
        attempts.write.deleteMany({ reset_at: { lte: now } }),
        sessions.write.deleteMany({ last_seen_at: { lt: new Date(now.getTime() - sessionMaxAge * 1000) } }),
        sessions.write.deleteMany({ created_at: { lt: new Date(now.getTime() - sessionAbsoluteMaxAge * 1000) } }),
        // A session the user's version moved past is already refused, so its row goes too.
        db.raw`DELETE FROM "auth_session" WHERE "version" < (SELECT "session_version" FROM "auth_user" WHERE "auth_user"."id" = "auth_session"."user_id")`,
      ])
    },
  }
}

// Postgres code 42P01 on pg-orm's error, on its Postgres cause or on a raw query's error; SQLite words it as `no such table`.
function isMissingTable(error: unknown): boolean {
  const { code, errno, cause, message } = (error ?? {}) as { code?: unknown, errno?: unknown, cause?: unknown, message?: unknown }

  return code === '42P01' || errno === '42P01' || (cause !== undefined && cause !== error && isMissingTable(cause)) || (typeof message === 'string' && message.includes('no such table'))
}

let warnedMissingOAuthTables = false

// An app whose migrations predate the OAuth server has no OAuth tables yet: what only the OAuth server needs is skipped with one warning, so sign-in, magic links and password resets still work. Any other failure is thrown.
async function withoutMissingOAuthTables(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  }
  catch (error) {
    if (!isMissingTable(error))
      throw error

    if (!warnedMissingOAuthTables) {
      warnedMissingOAuthTables = true
      log.warn('the auth_oauth_* tables are missing, so the OAuth server is skipped: generate a migration with `bunx pg-orm generate` (or run db.sync())')
    }
  }
}

// A bearer token's query with its user's columns joined on as `u.<column>`.
const JOINED_COLUMNS = [...Object.keys(AuthBearerTokens.columns), ...Object.keys(AuthUsers.columns).map(column => `u.${column}`)]

/* eslint-disable ts/no-explicit-any, ts/no-unsafe-call, ts/no-unsafe-member-access, ts/no-unsafe-return -- untyped because pg-orm types a `pick` by its column names, which these are built from at run time */
function joinedUser(q: any) {
  return q.join(AuthUsers, 'u', (e: any) => e.eq('user_id', e.ref('u.id'))).pick(...JOINED_COLUMNS)
}
/* eslint-enable ts/no-explicit-any, ts/no-unsafe-call, ts/no-unsafe-member-access, ts/no-unsafe-return */

// The user columns holding a date.
const DATE_COLUMNS = new Set(['email_verified_at', 'totp_enabled_at', 'banned_at', 'banned_until', 'created_at'])

// One user column's value as the user alone gives it: anything but null or what is typed already is converted as pg-orm converts it for SQLite.
function decoded(column: string, value: unknown): unknown {
  if (value === null || value === undefined)
    return value

  if (column === 'roles' && typeof value === 'string') {
    try {
      return JSON.parse(value)
    }
    catch {
      return value
    }
  }

  if (column === 'guest' && typeof value !== 'boolean')
    return Boolean(value)

  return DATE_COLUMNS.has(column) && !(value instanceof Date) ? new Date(value as string | number) : value
}

// The user a joined row holds, its columns typed as a read of the user alone gives them: Postgres types them as it reads, SQLite hands a date as text, an array as JSON text and a boolean as 0 or 1.
function userOf(row: Record<string, unknown>): UserRow {
  const user: Record<string, unknown> = {}

  for (const column of Object.keys(AuthUsers.columns)) {
    const value = row[`u.${column}`]

    user[column] = decoded(column, value)
  }

  return user as UserRow
}

function toUser(row: UserRow | null): UserRecord | undefined {
  return row
    ? {
      id: row.id,
      email: row.email,
      emailVerifiedAt: row.email_verified_at,
      username: row.username,
      passwordHash: row.password_hash,
      totpSecret: row.totp_secret,
      totpEnabledAt: row.totp_enabled_at,
      totpLastStep: row.totp_last_step,
      roles: row.roles,
      sessionVersion: row.session_version,
      lastSignIn: row.last_sign_in,
      locale: row.locale,
      guest: row.guest,
      bannedAt: row.banned_at,
      bannedUntil: row.banned_until,
      banReason: row.ban_reason,
      createdAt: row.created_at,
    }
    : undefined
}

function fromUser(user: Partial<UserRecord>) {
  return withoutUndefined({
    id: user.id,
    email: user.email,
    email_verified_at: user.emailVerifiedAt,
    username: user.username,
    username_key: user.username === undefined ? undefined : user.username?.toLowerCase() ?? null,
    password_hash: user.passwordHash,
    totp_secret: user.totpSecret,
    totp_enabled_at: user.totpEnabledAt,
    totp_last_step: user.totpLastStep,
    roles: user.roles,
    session_version: user.sessionVersion,
    last_sign_in: user.lastSignIn,
    locale: user.locale,
    guest: user.guest,
    banned_at: user.bannedAt,
    banned_until: user.bannedUntil,
    ban_reason: user.banReason,
    created_at: user.createdAt,
  })
}

function toIdentity(row: InferEntity<typeof AuthIdentities> | null): IdentityRecord | undefined {
  return row ? { provider: row.provider, providerId: row.provider_id, userId: row.user_id, accessToken: row.access_token, refreshToken: row.refresh_token, tokenExpiresAt: row.token_expires_at, createdAt: row.created_at } : undefined
}

function toToken(row: InferEntity<typeof AuthTokens>): TokenRecord {
  return { digest: row.digest, type: row.type as TokenType, userId: row.user_id, email: row.email, redirect: row.redirect, expiresAt: row.expires_at }
}

function toBearerToken(row: InferEntity<typeof AuthBearerTokens> | null): BearerTokenRecord | undefined {
  return row ? { id: row.id, userId: row.user_id, label: row.label, digest: row.digest, scopes: row.scopes, createdAt: row.created_at, lastUsedAt: row.last_used_at, expiresAt: row.expires_at, ...row.oauth_client != null && row.oauth_family != null && { oauth: { clientId: row.oauth_client, family: row.oauth_family, resource: row.oauth_resource } } } : undefined
}

function toOAuthClient(row: InferEntity<typeof AuthOAuthClients> | null): OAuthClientRecord | undefined {
  return row ? { id: row.id, name: row.name, redirectUris: row.redirect_uris, createdAt: row.created_at } : undefined
}

function toOAuthGrant(row: InferEntity<typeof AuthOAuthGrants> | null): OAuthGrantRecord | undefined {
  return row ? { userId: row.user_id, clientId: row.client_id, clientName: row.client_name, scopes: row.scopes, createdAt: row.created_at, lastUsedAt: row.last_used_at } : undefined
}

function toOAuthCode(row: InferEntity<typeof AuthOAuthCodes>): OAuthCodeRecord {
  return { digest: row.digest, userId: row.user_id, clientId: row.client_id, redirectUri: row.redirect_uri, challenge: row.challenge, scopes: row.scopes, family: row.family, resource: row.resource, createdAt: row.created_at, expiresAt: row.expires_at, usedAt: row.used_at }
}

function toOAuthRefresh(row: InferEntity<typeof AuthOAuthRefresh>): OAuthRefreshRecord {
  return { digest: row.digest, userId: row.user_id, clientId: row.client_id, scopes: row.scopes, family: row.family, resource: row.resource, createdAt: row.created_at, expiresAt: row.expires_at, usedAt: row.used_at }
}

function toSession(row: InferEntity<typeof AuthSessions> | null): SessionRecord | undefined {
  return row ? { id: row.id, userId: row.user_id, version: row.version, userAgent: row.user_agent, ip: row.ip, createdAt: row.created_at, lastSeenAt: row.last_seen_at, maxAge: row.max_age } : undefined
}

function toOrganization(row: InferEntity<typeof AuthOrganizations> | null): OrganizationRecord | undefined {
  return row ? { id: row.id, name: row.name, slug: row.slug, createdAt: row.created_at } : undefined
}

function toMember(row: InferEntity<typeof AuthMembers> | number | null): MemberRecord | undefined {
  return row !== null && typeof row === 'object' ? { organizationId: row.organization_id, userId: row.user_id, roles: row.roles, createdAt: row.created_at } : undefined
}

function toInvitation(row: InferEntity<typeof AuthInvitations> | null): InvitationRecord | undefined {
  return row ? { id: row.id, organizationId: row.organization_id, email: row.email, roles: row.roles, invitedBy: row.invited_by, createdAt: row.created_at, expiresAt: row.expires_at } : undefined
}

function toAudit(row: InferEntity<typeof AuthAudit>): AuditRecord {
  return { id: row.id, userId: row.user_id, event: row.event, detail: row.detail, ip: row.ip, userAgent: row.user_agent, actorId: row.actor_id, at: row.at }
}

function toPasskey(row: InferEntity<typeof AuthPasskeys> | null): PasskeyRecord | undefined {
  return row ? { id: row.id, userId: row.user_id, name: row.name, publicKey: row.public_key, counter: Number(row.counter), transports: row.transports, multiDevice: row.multi_device, backedUp: row.backed_up, userVerified: row.user_verified, createdAt: row.created_at, lastUsedAt: row.last_used_at } : undefined
}

// pg-orm refuses an `undefined` value, so a patch names only the fields it changes.
function withoutUndefined<T extends object>(row: T): { [Key in keyof T]: Exclude<T[Key], undefined> } {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as { [Key in keyof T]: Exclude<T[Key], undefined> }
}
