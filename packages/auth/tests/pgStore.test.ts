import { Database } from '@kaynooo/pg-orm'
import { afterAll, test } from 'bun:test'
import { authTables, pgStore } from '../src/pg'
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
