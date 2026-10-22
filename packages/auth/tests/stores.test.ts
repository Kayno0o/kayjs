import { Database } from '@kaynooo/pg-orm'
import { afterAll, expect, test } from 'bun:test'
import { memoryAuthStore } from '../src/memoryStore'
import { authTables, pgStore } from '../src/pg'
import { signInAsContract } from './helpers/signInAsContract'
import { storeContract } from './helpers/storeContract'

const opened: Database[] = []

afterAll(async () => {
  await Promise.all(opened.map(async db => db.close()))
})

storeContract('memoryAuthStore', async () => memoryAuthStore())

storeContract('pgStore on SQLite', async () => {
  const db = new Database({ url: 'sqlite://:memory:', tables: [...authTables] })

  opened.push(db)
  await db.sync({ allowDestructive: true })

  return pgStore(db)
})

signInAsContract('memoryAuthStore', async () => memoryAuthStore())

signInAsContract('pgStore on SQLite', async () => {
  const db = new Database({ url: 'sqlite://:memory:', tables: [...authTables] })

  opened.push(db)
  await db.sync({ allowDestructive: true })

  return pgStore(db)
})

test('memoryAuthStore lists audit entries of one millisecond newest added first', async () => {
  const store = memoryAuthStore()
  const at = new Date('2026-01-01T00:00:00Z')

  for (const id of ['a1', 'a2', 'a3'])
    await store.audit!.add({ id, userId: 'u1', event: 'signed-in', detail: 'password', ip: '10.0.0.1', userAgent: 'Firefox', actorId: null, at })

  expect((await store.audit!.list({ limit: 10 })).map(found => found.id)).toEqual(['a3', 'a2', 'a1'])
  // Twice, as listing must not reorder what the store holds.
  expect((await store.audit!.list({ limit: 10 })).map(found => found.id)).toEqual(['a3', 'a2', 'a1'])
})
