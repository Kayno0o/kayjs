import { Database } from '@kaynooo/pg-orm'
import { afterAll, expect, test } from 'bun:test'
import { authTables } from '../src/pg'

const opened: Database[] = []

afterAll(async () => {
  await Promise.all(opened.map(async db => db.close()))
})

// What the hourly prune and `audit.forget` filter on, so none of them reads a whole table.
const FILTERS: Record<string, string> = {
  'tokens by expiry': 'SELECT 1 FROM "kay_tokens" WHERE "expires_at" <= 1',
  'invitations by expiry': 'SELECT 1 FROM "kay_invitations" WHERE "expires_at" <= 1',
  'bearer tokens by expiry': 'SELECT 1 FROM "kay_bearer_tokens" WHERE "expires_at" < 1',
  'attempts by reset': 'SELECT 1 FROM "kay_attempts" WHERE "reset_at" <= 1',
  'sessions by last seen': 'SELECT 1 FROM "kay_auth_sessions" WHERE "last_seen_at" < 1',
  'sessions by creation': 'SELECT 1 FROM "kay_auth_sessions" WHERE "created_at" < 1',
  'audit by age': 'SELECT 1 FROM "kay_audits" WHERE "at" < 1',
  'audit by user': 'SELECT 1 FROM "kay_audits" WHERE "user_id" = \'a\'',
  'oauth codes by expiry': 'SELECT 1 FROM "kay_oauth_codes" WHERE "expires_at" <= 1',
  'oauth refresh tokens by expiry': 'SELECT 1 FROM "kay_oauth_refresh_tokens" WHERE "expires_at" <= 1',
  'oauth clients by age': 'SELECT 1 FROM "kay_oauth_clients" WHERE "created_at" < 1',
  'guests by creation': 'SELECT 1 FROM "kay_users" WHERE "guest" = 1 AND "created_at" < 1',
  'audit by actor': 'SELECT 1 FROM "kay_audits" WHERE "actor_id" = \'a\'',
}

test.each(Object.entries(FILTERS))('%s reads through an index', async (_name, sql) => {
  const db = new Database({ url: 'sqlite://:memory:', tables: [...authTables] })

  opened.push(db)
  await db.sync({ allowDestructive: true })

  const plan = await db.raw<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [])

  expect(plan.map(row => row.detail).join('\n')).toMatch(/USING (COVERING )?INDEX/)
})

test('the guest prune filter reads through an index leading with guest', async () => {
  const db = new Database({ url: 'sqlite://:memory:', tables: [...authTables] })

  opened.push(db)
  await db.sync({ allowDestructive: true })

  const plan = await db.raw<{ detail: string }>('EXPLAIN QUERY PLAN SELECT 1 FROM "kay_users" WHERE "guest" = 1 AND "created_at" < 1', [])

  expect(plan.map(row => row.detail).join('\n')).toMatch(/USING (COVERING )?INDEX \S*guest\S*/)
})
