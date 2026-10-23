import type { CacheStore } from '../src/runtime/cache'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { invalidate } from '../src/runtime/cache'
import { sqliteCache } from '../src/runtime/cache.server'
import { live, liveSlot, setLiveStore, watchSlot } from '../src/runtime/live-value'
import { delayAfter, MAX_IDLE_MS, pollClock, QUIET_POLLS } from '../src/runtime/poll-backoff'
import { setupStore } from '../src/server/app-store'
import { pgCache } from '../src/server/pg-cache'
import { dataTables, pgHandle } from '../src/server/pg-data'
import { pgLive } from '../src/server/pg-live'
import { NOW } from '../src/server/pg-sql'
import { disposeOwned } from '../src/server/reload'
import { sqliteLive } from '../src/server/sqlite-live'
import { cleanUpAfterFile, pgDescribe, pgIt, postgres, replicas } from './job-stores'

cleanUpAfterFile()

const declare = live as unknown as (initial: number, id: string, name: string) => { (): number, set: (next: number) => void }
const real = { ...pollClock }
const dirs: string[] = []

// A clock the test moves: a minute of polling takes no time, and every timer that fires is counted.
function virtualClock() {
  let now = 1_000_000
  let next = 0
  let fired = 0

  const timers = new Map<number, { at: number, run: () => void }>()

  // Waits for the poll that just fired to end and arm the next, as a database answers in its own time.
  const rearmed = async (expected: number) => {
    for (let waited = 0; timers.size < expected && waited < 2000; waited += 5)
      await Bun.sleep(5)
  }

  pollClock.now = () => now
  pollClock.setTimeout = (run, ms) => {
    timers.set(++next, { at: now + ms, run })

    return next
  }
  pollClock.clearTimeout = (timer) => {
    timers.delete(timer as number)
  }

  return {
    fired: () => fired,
    reset() {
      fired = 0
    },
    pending: () => timers.size,
    // Fires the timers due within `ms`, in order; with `slow`, waits after each (up to two seconds) for the poll to end and arm the next, as a database answers in its own time.
    async advance(ms: number, slow = false) {
      const end = now + ms

      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]

        if (due === undefined)
          break

        const expected = timers.size

        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        fired++
        due[1].run()

        if (slow)
          await rearmed(expected)
      }

      now = end
    },
  }
}

let clock: ReturnType<typeof virtualClock>

beforeEach(() => {
  clock = virtualClock()
  const kept = Reflect.get(globalThis, Symbol.for('kay.live.state')) as { watchers: number } | undefined

  if (kept !== undefined)
    kept.watchers = 0

  // The declarations of the other cases would count as the app's own.
  ;(Reflect.get(globalThis, Symbol.for('kay.live')) as Map<string, unknown> | undefined)?.clear()
})

afterEach(() => {
  Object.assign(pollClock, real)
  setLiveStore(undefined)
  setupStore(undefined)
})

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kay-idle-poll-'))

  dirs.push(dir)

  return join(dir, 'store.sqlite')
}

// What another process does to a SQLite store: the stores of one process share its origin, which they never hear.
function otherProcess(path: string) {
  const db = new Database(path)

  return {
    publish: (message: string) => void db.run('INSERT INTO kay_events (origin, message, at) VALUES (?, ?, ?)', ['other', message, Date.now()]),
    remove(id: string, key: string) {
      db.run('DELETE FROM kay_live WHERE id = ? AND key = ?', [id, key])
      db.run('INSERT INTO kay_live_events (origin, id, key, at) VALUES (?, ?, ?, ?)', ['other', id, key, Date.now()])
    },
    set(id: string, key: string, text: string) {
      db.run('INSERT INTO kay_live (id, key, value) VALUES (?, ?, ?) ON CONFLICT (id, key) DO UPDATE SET value = excluded.value', [id, key, text])
      db.run('INSERT INTO kay_live_events (origin, id, key, at) VALUES (?, ?, ?, ?)', ['other', id, key, Date.now()])
    },
  }
}

function heardBy(store: CacheStore): string[] {
  const heard: string[] = []

  store.subscribe?.(message => heard.push(message))

  return heard
}

describe('the poll backoff schedule', () => {
  it('keeps the base rate while the polls hear something, then doubles up to the cap', () => {
    expect(delayAfter(500, 0)).toBe(500)
    expect(delayAfter(500, QUIET_POLLS - 1)).toBe(500)
    expect([0, 1, 2, 3, 4].map(extra => delayAfter(500, QUIET_POLLS + extra))).toEqual([1000, 2000, 4000, MAX_IDLE_MS, MAX_IDLE_MS])
  })

  it('polls about 20 times over an idle minute, not 120', async () => {
    const path = await storePath()
    const store = sqliteCache(path)

    store.subscribe?.(() => undefined)
    store.set('a', '[1]', Date.now() + 60_000)
    await clock.advance(60_000)
    expect(clock.fired()).toBe(20)
  })
})

describe('an idle sqliteCache', () => {
  it('backs off even when the store is never used, as a prerendered page may be marked stale by it', async () => {
    sqliteCache(await storePath())
    await clock.advance(60_000)
    expect(clock.fired()).toBeLessThanOrEqual(21)
  })

  it('hears an invalidation another store published after idling, within the idle cap', async () => {
    const path = await storePath()
    const first = sqliteCache(path)
    const heard = heardBy(first)

    first.set('a', '[1]', Date.now() + 60_000)

    const other = otherProcess(path)

    await clock.advance(30_000)
    other.publish('{"keys":["a"]}')
    await clock.advance(MAX_IDLE_MS)
    expect(heard).toEqual(['{"keys":["a"]}'])
  })

  it('goes back to the base rate on a use of the store', async () => {
    const path = await storePath()
    const first = sqliteCache(path)
    const heard = heardBy(first)

    first.set('a', '[1]', Date.now() + 60_000)

    const other = otherProcess(path)

    await clock.advance(30_000)
    other.publish('{"keys":["a"]}')
    first.get('a')
    await clock.advance(500)
    expect(heard).toEqual(['{"keys":["a"]}'])
  })

  it('ends its polling when it is closed while backed off', async () => {
    const saved = process.env.KAY_DEV_CODE

    process.env.KAY_DEV_CODE = '1'

    try {
      const store = sqliteCache(await storePath())

      store.subscribe?.(() => undefined)
      store.set('a', '[1]', Date.now() + 60_000)
      await clock.advance(30_000)
      expect(clock.pending()).toBe(1)
      await disposeOwned(new Set([import.meta.path]))
      expect(clock.pending()).toBe(0)
    }
    finally {
      if (saved === undefined)
        delete process.env.KAY_DEV_CODE
      else
        process.env.KAY_DEV_CODE = saved
    }
  })
})

describe('an idle sqliteLive', () => {
  it('hears a set made after idling, and a watcher brings the base rate back', async () => {
    const path = await storePath()
    const first = sqliteLive(path)
    const heard: string[] = []

    await first.set('test:idle', '', '[0]')

    const other = otherProcess(path)

    first.subscribe((id, _key, text) => heard.push(`${id}:${text}`))
    await clock.advance(30_000)
    other.set('test:idle', '', '[1]')
    await clock.advance(MAX_IDLE_MS)
    expect(heard).toEqual(['test:idle:[1]'])

    await clock.advance(30_000)
    other.set('test:idle', '', '[2]')
    setLiveStore(first)
    declare(0, 'test:idle', 'idle')
    watchSlot(liveSlot('test:idle')!, '', () => undefined)
    await clock.advance(500)
    expect(heard).toEqual(['test:idle:[1]', 'test:idle:[2]'])
  })

  it('keeps the base rate while a page watches a value, and backs off again once none does', async () => {
    const store = sqliteLive(await storePath())

    setLiveStore(store)
    declare(0, 'test:held', 'held')

    const stop = watchSlot(liveSlot('test:held')!, '', () => undefined)

    await clock.advance(30_000)
    expect(clock.fired()).toBe(60)
    stop()
    clock.reset()
    await clock.advance(60_000)
    expect(clock.fired()).toBeLessThanOrEqual(21)
  })

  it('stops while backed off', async () => {
    const store = sqliteLive(await storePath())

    store.subscribe(() => undefined)
    await clock.advance(30_000)
    expect(clock.pending()).toBe(1)
    store.stop?.()
    expect(clock.pending()).toBe(0)
  })

  it('is not followed while no value of the app is declared, and is read again by the first declaration', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const seed = sqliteLive(path)

    await seed.set('test:later', '', '[4]')

    const other = otherProcess(path)

    setLiveStore(store)
    await clock.advance(60_000)
    expect(clock.fired()).toBe(0)
    other.set('test:later', '', '[5]')

    const later = declare(0, 'test:later', 'later')

    expect(later()).toBe(5)
    other.set('test:later', '', '[6]')
    await clock.advance(500)
    expect(later()).toBe(6)
  })

  it('does not show a value another process deleted while the store was not followed', async () => {
    const path = await storePath()
    const seed = sqliteLive(path)

    await seed.set('test:gone', '', '[4]')
    setLiveStore(sqliteLive(path))

    const other = otherProcess(path)

    other.remove('test:gone', '')
    await clock.advance(60_000)
    expect(declare(0, 'test:gone', 'gone')()).toBe(0)
  })

  it('does not follow a store for the ids kay keeps for itself', async () => {
    setLiveStore(sqliteLive(await storePath()))
    declare(0, 'kay:idle-own', 'own')
    await clock.advance(60_000)
    expect(clock.fired()).toBe(0)
  })
})

describe('the memory stores', () => {
  it('start no poll: live values and cached values with no store stay in the process', async () => {
    const value = declare(0, 'test:memory-idle', 'memory')

    value.set(1)
    await clock.advance(60_000)
    expect(value()).toBe(1)
    expect(clock.fired()).toBe(0)
    expect(clock.pending()).toBe(0)
  })
})

async function freshTables() {
  const { sql } = await postgres()

  for (const table of dataTables)
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`)
}

// What another replica publishes: the caches of one process share its origin, which they never hear.
async function publishedByOther(sql: ReturnType<typeof replicas>[number], message: string) {
  await sql.unsafe(`INSERT INTO kay_events (origin, message, at) VALUES ('other', $1, ${NOW})`, [message])
}

// A handle counting the queries a store asks of the database.
function counted(sql: ReturnType<typeof replicas>[number]) {
  const inner = pgHandle(sql)
  let calls = 0

  return { handle: { db: async () => {
    calls++

    return inner.db()
  } }, calls: () => calls }
}

pgDescribe('idle Postgres stores', () => {
  pgIt('reach the database about 20 times over an idle minute, and never while unused', async () => {
    await freshTables()

    const [sql] = replicas(1)
    const unused = counted(sql!)
    const cache = counted(sql!)
    const lives = counted(sql!)

    pgCache(unused.handle)
    pgLive(unused.handle)

    const store = pgCache(cache.handle)
    const values = pgLive(lives.handle)

    store.subscribe?.(() => undefined)
    values.subscribe(() => undefined)
    await store.get('x')
    await clock.advance(60_000, true)
    expect(unused.calls()).toBe(0)
    expect(cache.calls()).toBeLessThan(30)
    expect(cache.calls()).toBeGreaterThan(10)
    expect(lives.calls()).toBeLessThan(30)
    values.stop?.()
  })

  pgIt('hear a write another replica made after idling, and a use brings the base rate back', async () => {
    await freshTables()

    const [one, two] = replicas(2)
    const first = pgCache(pgHandle(one!))
    const heard = heardBy(first)
    const firstLive = pgLive(pgHandle(one!))
    const secondLive = pgLive(pgHandle(two!))
    const changes: string[] = []

    await first.get('x')
    await firstLive.entries()
    await secondLive.entries()
    firstLive.subscribe((id, _key, text) => changes.push(`${id}:${text}`))
    await clock.advance(30_000, true)
    await publishedByOther(two!, '{"keys":["x"]}')
    await secondLive.set('app:idle', '', '[1]')
    await clock.advance(MAX_IDLE_MS, true)
    expect(heard).toEqual(['{"keys":["x"]}'])
    expect(changes).toEqual(['app:idle:[1]'])

    await clock.advance(30_000, true)
    await publishedByOther(two!, '{"keys":["y"]}')
    await secondLive.set('app:idle', '', '[2]')
    await first.get('x')
    firstLive.hold?.(true)
    await clock.advance(500, true)
    expect(heard).toEqual(['{"keys":["x"]}', '{"keys":["y"]}'])
    expect(changes).toEqual(['app:idle:[1]', 'app:idle:[2]'])
    firstLive.stop?.()
    secondLive.stop?.()
  })

  pgIt('tell a cache named only by a call of an invalidation, from its first use', async () => {
    await freshTables()

    const [sql] = replicas(1)
    const store = pgCache(pgHandle(sql!))

    const publish = spyOn(store, 'publish')

    invalidate('named-only')
    expect(publish).not.toHaveBeenCalled()
    await store.get('x')
    invalidate('named-only')
    expect(publish).toHaveBeenCalledTimes(1)
  })

  pgIt('end their polling when closed while backed off', async () => {
    await freshTables()

    const [sql] = replicas(1)
    const handle = pgHandle(sql!)
    const store = pgCache(handle)
    const values = pgLive(handle)

    store.subscribe?.(() => undefined)
    values.subscribe(() => undefined)
    await store.get('x')
    await clock.advance(30_000, true)
    expect(clock.pending()).toBeGreaterThan(0)
    await handle.close()
    expect(clock.pending()).toBe(0)
  })
})
