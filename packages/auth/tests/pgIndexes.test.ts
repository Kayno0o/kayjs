import { Database } from '@kaynooo/pg-orm'
import { afterAll, expect, test } from 'bun:test'
import { authTables } from '../src/pg'

const opened: Database[] = []

afterAll(async () => {
  await Promise.all(opened.map(async db => db.close()))
})

// What the hourly prune and `audit.forget` filter on, so none of them reads a whole table.
const FILTERS: Record<string, string> = {
  'tokens by expiry': 'SELECT 1 FROM "auth_token" WHERE "expires_at" <= 1',
  'invitations by expiry': 'SELECT 1 FROM "auth_invitation" WHERE "expires_at" <= 1',
  'bearer tokens by expiry': 'SELECT 1 FROM "auth_bearer_token" WHERE "expires_at" < 1',
  'attempts by reset': 'SELECT 1 FROM "auth_attempt" WHERE "reset_at" <= 1',
  'sessions by last seen': 'SELECT 1 FROM "auth_session" WHERE "last_seen_at" < 1',
  'sessions by creation': 'SELECT 1 FROM "auth_session" WHERE "created_at" < 1',
  'audit by age': 'SELECT 1 FROM "auth_audit" WHERE "at" < 1',
  'audit by user': 'SELECT 1 FROM "auth_audit" WHERE "user_id" = \'a\'',
  'audit by actor': 'SELECT 1 FROM "auth_audit" WHERE "actor_id" = \'a\'',
}

test.each(Object.entries(FILTERS))('%s reads through an index', async (_name, sql) => {
  const db = new Database({ url: 'sqlite://:memory:', tables: [...authTables] })

  opened.push(db)
  await db.sync({ allowDestructive: true })

  const plan = await db.raw<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [])

  expect(plan.map(row => row.detail).join('\n')).toMatch(/USING (COVERING )?INDEX/)
})
