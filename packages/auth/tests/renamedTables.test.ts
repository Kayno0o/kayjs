import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '@kaynooo/pg-orm'
import { afterAll, expect, test } from 'bun:test'
import { authTables } from '../src/pg'
import { LegacySessions, legacyTables, LegacyUsers } from './legacyTables'

const folder = await mkdtemp(join(tmpdir(), 'kayjs-auth-rename-'))
const opened: Database[] = []

afterAll(async () => {
  await Promise.all(opened.map(async db => db.close()))
  await rm(folder, { recursive: true, force: true })
})

async function tablesOf(db: Database): Promise<string[]> {
  return (await db.raw<{ name: string }>('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name', [])).map(row => row.name).filter(name => !name.startsWith('_pgorm'))
}

test('a database holding the auth_* tables is renamed to the kay_* ones by sync(), the rows kept', async () => {
  const url = `sqlite://${join(folder, 'auth.db')}`
  const before = new Database({ url, tables: [...legacyTables] })

  opened.push(before)
  await before.sync({ allowDestructive: true })
  await before.repo(LegacyUsers).write.insertOne({ id: 'u1', email: 'a@example.com', created_at: new Date() })
  await before.repo(LegacySessions).write.insertOne({ id: 's1', user_id: 'u1', version: 0, user_agent: 'ua', ip: '127.0.0.1', created_at: new Date(), last_seen_at: new Date(), max_age: 60 })
  await before.close()

  const after = new Database({ url, tables: [...authTables] })

  opened.push(after)
  await after.sync()

  expect(await tablesOf(after)).toEqual(authTables.map(table => table.name).sort())
  expect((await after.raw<{ id: string }>('SELECT "id" FROM "kay_users"', [])).map(row => row.id)).toEqual(['u1'])
  expect((await after.raw<{ id: string }>('SELECT "id" FROM "kay_auth_sessions"', [])).map(row => row.id)).toEqual(['s1'])
})

test('every table renames the one it had, and none shares a name with kay\'s own session table', () => {
  expect(authTables.map(table => table.name)).toHaveLength(16)
  expect(authTables.every(table => table.name.startsWith('kay_'))).toBe(true)
  expect(authTables.map(table => table.name)).not.toContain('kay_sessions')
})
