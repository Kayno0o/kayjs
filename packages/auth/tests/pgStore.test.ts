import { Database } from '@kaynooo/pg-orm'
import { afterAll, expect, test } from 'bun:test'
import { authTables, pgStore } from '../src/pg'
import { userRecord } from './helpers/app'
import { storeContract } from './helpers/storeContract'

// The database `docker compose up -d` starts; another with KAYJS_AUTH_TEST_DATABASE_URL.
const URL = process.env.KAYJS_AUTH_TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:8533/kayjs_auth_test'
const db = new Database({ url: URL, tables: [...authTables] })
const reachable = await db.ping()

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

if (reachable) {
  await db.sync({ allowDestructive: true })

  storeContract('pgStore', async () => {
    await db.raw(`TRUNCATE ${authTables.map(table => `"${table.name}"`).join(', ')} CASCADE`, [])

    return pgStore(db)
  })

  // Rows written before the resource columns existed have them null, and read back as unbound.
  test('pgStore reads rows stored before the resource columns as unbound', async () => {
    await db.raw(`TRUNCATE ${authTables.map(table => `"${table.name}"`).join(', ')} CASCADE`, [])

    const store = pgStore(db)

    await store.users.create(userRecord({ id: 'u1' }))
    await db.raw(`INSERT INTO "auth_oauth_code" ("digest", "user_id", "client_id", "redirect_uri", "challenge", "family", "created_at", "expires_at") VALUES ('legacy-code', 'u1', 'c1', 'http://127.0.0.1/cb', 'x', 'f1', now(), now() + interval '1 hour')`, [])
    await db.raw(`INSERT INTO "auth_oauth_refresh" ("digest", "user_id", "client_id", "family", "created_at", "expires_at") VALUES ('legacy-refresh', 'u1', 'c1', 'f1', now(), now() + interval '1 hour')`, [])
    await db.raw(`INSERT INTO "auth_bearer_token" ("id", "user_id", "label", "digest", "created_at", "oauth_client", "oauth_family") VALUES ('b1', 'u1', 'Agent', 'legacy-bearer', now(), 'c1', 'f1')`, [])

    expect((await store.oauth!.codes.use('legacy-code', new Date()))?.code.resource).toBeNull()
    expect((await store.oauth!.refresh.use('legacy-refresh', new Date()))?.token.resource).toBeNull()
    expect((await store.bearerTokens.findByDigest('legacy-bearer'))?.oauth).toEqual({ clientId: 'c1', family: 'f1', resource: null })
  })

  // An app whose migrations predate the OAuth server: its sign-in, magic-link and reset flows revoke bearer tokens and prune, and must not fail on the missing tables.
  test('pgStore skips the OAuth tables an older schema lacks', async () => {
    await db.raw('DROP TABLE IF EXISTS "auth_oauth_refresh", "auth_oauth_code", "auth_oauth_grant", "auth_oauth_client" CASCADE', [])

    try {
      const store = pgStore(db)

      await store.oauth!.refresh.deleteForUser('u1')
      await store.prune!({ now: new Date(), bearerExpiredBefore: new Date(), sessionMaxAge: 60, sessionAbsoluteMaxAge: 60 })
    }
    finally {
      await db.sync({ allowDestructive: true })
    }
  })
}
else if (process.env.KAYJS_AUTH_REQUIRE_DATABASE !== undefined && process.env.KAYJS_AUTH_REQUIRE_DATABASE !== '') {
  throw new Error(`pgStore: no Postgres at ${URL}, and KAYJS_AUTH_REQUIRE_DATABASE forbids skipping its tests`)
}
else {
  console.warn(`pgStore: skipped, no Postgres at ${URL}; start one with \`docker compose up -d\``)
}
