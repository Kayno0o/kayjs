import type { KvStore } from '../src/server/kv'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
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

describe('the process memory fallback and a closed store', () => {
  it('drops the oldest keys of a capped memory store, expired ones first', async () => {
    const store = memoryKv(3)

    await store.set('a', '1')
    await store.set('b', '2', 1)
    await store.set('c', '3')
    await Bun.sleep(5)
    await store.set('d', '4')
    expect([await store.get('a'), await store.get('b'), await store.get('c'), await store.get('d')]).toEqual(['1', undefined, '3', '4'])
    await store.set('e', '5')
    expect([await store.get('a'), await store.get('c'), await store.get('d'), await store.get('e')]).toEqual([undefined, '3', '4', '5'])
  })

  it('holds 500 keys when no store is set up', async () => {
    setupStore(undefined)

    const flags = kv('cap')

    for (let index = 0; index < 600; index++)
      await flags.set(String(index), 'v')

    expect(await flags.get('0')).toBeUndefined()
    expect(await flags.get('99')).toBeUndefined()
    expect(await flags.get('100')).toBe('v')
    expect(await flags.get('599')).toBe('v')
  })

  it('warns once per process, whatever the namespaces, when the app names stores but no kv, and not when it names one or none', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const told = () => warn.mock.calls.filter(([message]) => String(message).includes('has no kv')).length

    try {
      setupStore({ rates: undefined })
      await kv('warned').set('a', '1')
      await kv('warned').get('a')
      expect(told()).toBe(1)
      await kv('other').get('a')
      expect(told()).toBe(1)

      setupStore({ kv: memoryKv() })
      await kv('warned').get('a')
      setupStore(undefined)
      await kv('warned').get('a')
      expect(told()).toBe(1)
    }
    finally {
      warn.mockRestore()
    }
  })

  it('throws a kay error from a sqlite store used after it was closed', async () => {
    const store = sqliteKv(await sqlitePath())

    await store.set('a', '1')
    await store.close?.()
    expect(async () => store.get('a')).toThrow('kay: the kv store was closed')
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
