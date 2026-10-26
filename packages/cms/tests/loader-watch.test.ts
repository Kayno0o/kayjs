import type { CacheStore } from '../../../src/runtime/cache'
import { SQL } from 'bun'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection, contentKey } from 'kay/content'
import { onKeysInvalidated, refreshLocally, trackStore, untrackStore } from '../../../src/runtime/cache'
import { pgLoader } from '../src/loaders/pg'
import { watcher } from '../src/loaders/shared'
import { until } from './until'

const schema = s.Object({ title: s.String() })
const EVERY = 20
let count = 0
const stops: (() => void)[] = []

// A fresh collection name each test, as a watcher is told apart by it.
function fresh(): string {
  return `watched-${++count}`
}

// Counts the times a collection's own entries were dropped in this process.
function drops(name: string): { count: () => number } {
  let seen = 0

  stops.push(onKeysInvalidated((_, dropped) => {
    if (dropped(contentKey(name)))
      seen++

    return []
  }))

  return { count: () => seen }
}

// A store that records what is published to the other processes and lets a test play one of them.
function sharedStore(): { published: string[], hear: (message: string) => void } {
  const published: string[] = []
  let hear: (message: string) => void = () => undefined
  const store: CacheStore = { get: () => undefined, set: () => undefined, delete: () => undefined, keys: () => [], publish: message => void published.push(message), subscribe: (listener) => {
    hear = listener
  } }

  trackStore(store)
  stops.push(() => untrackStore(store))

  return { published, hear: message => hear(message) }
}

// Waits for the drops to reach `wanted`, then a few looks of the watcher more for it to drop no further, a deliberate wait for nothing to happen.
async function dropsStopAt(seen: { count: () => number }, wanted: number): Promise<void> {
  await until(() => seen.count() >= wanted)
  await Bun.sleep(EVERY * 3)
}

afterEach(() => {
  for (const stop of stops.splice(0))
    stop()
})

describe('a loader\'s watcher', () => {
  test('drops the entries for a change it finds, and tells no other process', async () => {
    const name = fresh()
    const others = sharedStore()
    const seen = drops(name)
    let signature = 'a'
    const watching = watcher(name, 'scope', `${EVERY}ms`, '1s', () => signature)

    await watching.start()
    signature = 'b'
    await dropsStopAt(seen, 1)
    expect(seen.count()).toBe(1)
    expect(others.published).toEqual([])
  })

  test('takes a drop another process broadcast as known, so it does not find the same change again', async () => {
    const name = fresh()
    const others = sharedStore()
    const seen = drops(name)
    let signature = 'a'
    const watching = watcher(name, 'scope', `${EVERY}ms`, '1s', () => signature)

    await watching.start()
    signature = 'b'
    others.hear(JSON.stringify({ keys: [contentKey(name)] }))
    await dropsStopAt(seen, 1)
    expect(seen.count()).toBe(1)
  })

  test('replaces the timer of the watcher a reloaded module left', async () => {
    const name = fresh()
    let first = 0
    let second = 0
    const old = watcher(name, 'scope', `${EVERY}ms`, '1s', () => {
      first++

      return 'x'
    })
    const replacement = watcher(name, 'scope', `${EVERY}ms`, '1s', () => {
      second++

      return 'x'
    })

    await old.start()
    await replacement.start()

    const before = first

    await until(() => second > 2)
    expect(first).toBe(before)
  })

  test('starts again after a start that failed, and a second start does nothing', async () => {
    const name = fresh()
    let calls = 0
    let failing = true
    const watching = watcher(name, 'scope', `${EVERY}ms`, '1s', () => {
      calls++

      if (failing)
        throw new Error('database down')

      return 'a'
    })

    await expect(watching.start()).rejects.toThrow('database down')
    // A deliberate wait for nothing to happen: a failed start schedules no look.
    await Bun.sleep(EVERY * 3)
    expect(calls).toBe(1)
    failing = false
    await watching.start()
    await watching.start()

    const before = calls
    const started = Date.now()

    await until(() => calls - before > 1)
    await Bun.sleep(EVERY * 3)
    // One timer looks once an interval, two would look twice as often: the bound follows the time that really passed.
    expect(calls - before).toBeGreaterThan(1)
    expect(calls - before).toBeLessThanOrEqual((Date.now() - started) / EVERY + 2)
  })

  test('keeps looking after the entries were refreshed without being dropped, as a publishAt date passing does', async () => {
    const name = fresh()
    const seen = drops(name)
    let signature = 'a'
    const watching = watcher(name, 'scope', `${EVERY}ms`, '1s', () => signature)

    await watching.start()
    signature = 'b'
    refreshLocally(contentKey(name))
    await dropsStopAt(seen, 1)
    expect(seen.count()).toBe(1)
  })

  test('does not report a change a look read before a save settled', async () => {
    const name = fresh()
    const seen = drops(name)
    let release: (value: string) => void = () => undefined
    const calls: string[] = []
    const watching = watcher(name, 'scope', `${EVERY}ms`, '1s', async (force) => {
      calls.push(force ? 'forced' : 'look')

      if (force)
        return calls.length === 1 ? 'a' : 'c'

      return new Promise<string>((resolve) => {
        release = resolve
      })
    })

    await watching.start()
    await until(() => calls.length >= 2)
    expect(calls).toEqual(['forced', 'look'])
    await watching.settle()
    release('b')
    // A deliberate wait for nothing to happen: the look that read before the save is dropped, not reported.
    await Bun.sleep(EVERY * 2)
    expect(seen.count()).toBe(0)
  })
})

const url = process.env.TEST_DATABASE_URL ?? ''
const postgresTest = url === '' ? test.skip : test
const database = `kay_cms_watch_${process.pid}`
let sql: SQL | undefined
let admin: SQL | undefined

afterAll(async () => {
  await sql?.close()
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin?.close()
})

describe('the postgres loader\'s watch', () => {
  postgresTest('a rewrite of the rows that changed nothing, as a vacuum freeze or an update to the same value, is not a change', async () => {
    admin = new SQL(Object.assign(new URL(url), { pathname: '/postgres' }).href)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE ${database}`)
    sql = new SQL(Object.assign(new URL(url), { pathname: `/${database}` }).href, { max: 2 })

    const loader = pgLoader({ name: 'frozen', sql, table: 'frozen', watch: '40ms', seed: [{ slug: 'a', data: { title: 'A' } }] })
    let reads = 0
    const posts = collection({ ...loader, load: async (context) => {
      reads++

      return loader.load(context)
    } }, { schema })

    await posts.all()
    await sql.unsafe('UPDATE frozen SET data = data')
    await sql.unsafe('VACUUM FREEZE frozen')
    // A deliberate wait for nothing to happen: the watch looks several times in it and finds no change.
    await Bun.sleep(300)
    await posts.all()
    expect(reads).toBe(1)
    await sql.unsafe(`UPDATE frozen SET data = '{"title":"Edited"}'`)
    await until(async () => (await posts.all())[0]?.data.title === 'Edited')
    expect((await posts.all()).map(post => post.data.title)).toEqual(['Edited'])
    expect(reads).toBe(2)
  })
})
