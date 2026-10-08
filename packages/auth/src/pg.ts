import type { Database, InferEntity } from '@kaynooo/pg-orm'
import type { AuthStore, BearerTokenRecord, IdentityRecord, TokenRecord, TokenType, UserRecord } from './store'
import { defineTable } from '@kaynooo/pg-orm'

// Expired attempt windows are deleted once every so many hits.
const SWEEP_EVERY = 1000

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
  created_at: t.timestamptz().notNull(),
}))

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
})).withIndexes([{ columns: ['user_id', 'type'] }])

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
  created_at: t.timestamptz().notNull(),
  last_used_at: t.timestamptz().nullable(),
})).withIndexes([{ columns: ['user_id'] }])

export const AuthAttempts = defineTable('auth_attempt', t => ({
  key: t.text().primaryKey(),
  count: t.int4().notNull(),
  reset_at: t.timestamptz().notNull(),
}))

// The tables to list in the app's `new Database({ tables })`, so `db.sync()` creates them.
export const authTables = [AuthUsers, AuthIdentities, AuthTokens, AuthRecoveryCodes, AuthBearerTokens, AuthAttempts] as const

type UserRow = InferEntity<typeof AuthUsers>

// kayjs-auth's data in the app's Postgres database, through pg-orm: list `authTables` in the database's tables.
export function pgStore(db: Database): AuthStore {
  const users = db.repo(AuthUsers)
  const identities = db.repo(AuthIdentities)
  const tokens = db.repo(AuthTokens)
  const recoveryCodes = db.repo(AuthRecoveryCodes)
  const bearerTokens = db.repo(AuthBearerTokens)
  const attempts = db.repo(AuthAttempts)
  let hits = 0

  return {
    users: {
      get: async id => toUser(await users.read.findById(id)),
      findByEmail: async email => toUser(await users.read.findOne({ email })),
      findByUsername: async username => toUser(await users.read.findOne({ username_key: username.toLowerCase() })),
      async create(user) {
        await users.write.insertOne(fromUser(user))
      },
      async update(id, patch) {
        return toUser(await users.write.updateById(id, fromUser(patch)))
      },
      async delete(id) {
        await users.write.deleteById(id)
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
    bearerTokens: {
      async create(token) {
        await bearerTokens.write.insertOne({ id: token.id, user_id: token.userId, label: token.label, digest: token.digest, created_at: token.createdAt, last_used_at: token.lastUsedAt })
      },
      findByDigest: async digest => toBearerToken(await bearerTokens.read.findOne({ digest })),
      listByUser: async userId => (await bearerTokens.read.findMany(q => q.where({ user_id: userId }).orderBy('created_at', 'asc'))).map(row => toBearerToken(row)!),
      async touch(id, at) {
        await bearerTokens.write.updateById(id, { last_used_at: at })
      },
      delete: async (userId, id) => await bearerTokens.write.deleteOne({ id, user_id: userId }) !== null,
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
      count: userId => recoveryCodes.read.count({ user_id: userId }),
    },
    attempts: {
      async count(key) {
        const row = await attempts.read.findById(key)

        return row && row.reset_at.getTime() > Date.now() ? row.count : 0
      },
      async hit(key, window) {
        const now = new Date()

        if (++hits % SWEEP_EVERY === 0)
          await attempts.write.deleteMany({ reset_at: { lte: now } })

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
  }
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
  return row ? { id: row.id, userId: row.user_id, label: row.label, digest: row.digest, createdAt: row.created_at, lastUsedAt: row.last_used_at } : undefined
}

// pg-orm refuses an `undefined` value, so a patch names only the fields it changes.
function withoutUndefined<T extends object>(row: T): { [Key in keyof T]: Exclude<T[Key], undefined> } {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as { [Key in keyof T]: Exclude<T[Key], undefined> }
}
