import { Database } from '@kaynooo/pg-orm'
import { afterAll } from 'bun:test'
import { authTables, pgStore } from '../src/pg'
import { storeContract } from './helpers/storeContract'

// The database `docker compose up -d` starts; another with KAY_AUTH_TEST_DATABASE_URL.
const URL = process.env.KAY_AUTH_TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:8533/kay_auth_test'
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
}
else {
  console.warn(`pgStore: skipped, no Postgres at ${URL}; start one with \`docker compose up -d\``)
}
