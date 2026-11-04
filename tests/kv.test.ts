import type { KvStore } from '../src/server/kv'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { setupStore } from '../src/server/app-store'
import { kv, memoryKv, sqliteKv } from '../src/server/kv'
import { pgData } from '../src/server/pg-data'
import { cleanUpAfterFile, freshPg, pgIt, sqlitePath } from './job-stores'

cleanUpAfterFile()

afterEach(() => {
  setSystemTime()
  setupStore(undefined)
})

const kinds: [string, () => Promise<KvStore>][] = [
  ['memory', async () => memoryKv()],
  ['sqlite', async () => sqliteKv(await sqlitePath())],
]

describe.each(kinds)('the %s kv store', (_name, open) => {
  it('keeps a value until it is deleted, and says whether there was one', async () => {
    const store = await open()

    expect(await store.get('a')).toBeUndefined()
    expect(await store.delete('a')).toBe(false)

    await store.set('a', 'one')
    await store.set('a', 'two')
    expect(await store.get('a')).toBe('two')
    expect(await store.delete('a')).toBe(true)
    expect(await store.get('a')).toBeUndefined()
    expect(await store.delete('a')).toBe(false)
  })

  it('drops a value once its ttl has passed', async () => {
    const store = await open()

    await store.set('a', 'one', 1000)
    expect(await store.get('a')).toBe('one')
    setSystemTime(Date.now() + 1001)
    expect(await store.get('a')).toBeUndefined()
    expect(await store.delete('a')).toBe(false)
  })

  it('takes a key once until its ttl passes, however many ask together', async () => {
    const store = await open()
    const taken = await Promise.all(Array.from({ length: 5 }, async () => store.once('ticket', 1000)))

    expect(taken.filter(Boolean)).toHaveLength(1)
    expect(await store.once('ticket', 1000)).toBe(false)
    setSystemTime(Date.now() + 1001)
    expect(await store.once('ticket', 1000)).toBe(true)
  })

  it('takes a key a value is kept under only after it ended, and lets a deleted one be taken', async () => {
    const store = await open()

    await store.set('a', 'one')
    expect(await store.once('a', 1000)).toBe(false)
    await store.delete('a')
    expect(await store.once('a', 1000)).toBe(true)
  })
})

describe('kv(namespace)', () => {
  it('keeps two namespaces apart over the same store', async () => {
    const store = memoryKv()
    const first = kv('first', store)
    const second = kv('second', store)

    await first.set('a', 'one')
    expect(await second.get('a')).toBeUndefined()
    expect(await first.get('a')).toBe('one')
    expect(await second.once('a', 1000)).toBe(true)
    expect(await first.delete('a')).toBe(true)
  })

  it('uses the app store\'s kv, else this process\'s memory', async () => {
    const kept = memoryKv()

    setupStore({ kv: kept })
    await kv('ns').set('a', 'one')
    expect(await kept.get('ns\na')).toBe('one')

    setupStore(undefined)
    await kv('ns').set('b', 'two')
    expect(await kv('ns').get('b')).toBe('two')
    expect(await kept.get('ns\nb')).toBeUndefined()
  })
})

describe('the Postgres kv store', () => {
  pgIt('shares a value between connections, takes a key once and drops what ended', async () => {
    const sql = await freshPg()
    const first = pgData(sql).kv
    const second = pgData(sql).kv

    await first.set('pg:a', 'one')
    expect(await second.get('pg:a')).toBe('one')
    expect(await second.delete('pg:a')).toBe(true)
    expect(await first.delete('pg:a')).toBe(false)

    const taken = await Promise.all([first, second, first, second].map(async store => store.once('pg:ticket', 60_000)))

    expect(taken.filter(Boolean)).toHaveLength(1)

    await first.set('pg:short', 'x', 50)
    await Bun.sleep(120)
    expect(await second.get('pg:short')).toBeUndefined()
    expect(await second.once('pg:short', 60_000)).toBe(true)
  })
})
