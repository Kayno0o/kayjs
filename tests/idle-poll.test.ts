import type { CacheStore } from '../src/runtime/cache'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
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
    pending: () => timers.size,
    // Fires the timers due within `ms`, in order, and waits `settle` after each for the database to answer.
    async advance(ms: number, settle = 0) {
      const end = now + ms

      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]

        if (due === undefined)
          break

        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        fired++
        due[1].run()
        await Bun.sleep(settle)
      }

      now = end
    },
  }
}

let clock: ReturnType<typeof virtualClock>

beforeEach(() => {
  clock = virtualClock()
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

  it('polls about 25 times over an idle minute, not 120', async () => {
    const path = await storePath()
    const store = sqliteCache(path)

    store.subscribe?.(() => undefined)
    store.set('a', '[1]', Date.now() + 60_000)
    await clock.advance(60_000)
    expect(clock.fired()).toBeGreaterThanOrEqual(20)
    expect(clock.fired()).toBeLessThanOrEqual(26)
  })
})

describe('an idle sqliteCache', () => {
  it('backs off even when the store is never used, as a prerendered page may be marked stale by it', async () => {
    sqliteCache(await storePath())
    await clock.advance(60_000)
    expect(clock.fired()).toBeLessThanOrEqual(26)
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
  pgIt('reach the database about 25 times over an idle minute, and never while unused', async () => {
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
    await clock.advance(60_000, 25)
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
    await clock.advance(30_000, 25)
    await publishedByOther(two!, '{"keys":["x"]}')
    await secondLive.set('app:idle', '', '[1]')
    await clock.advance(MAX_IDLE_MS, 40)
    expect(heard).toEqual(['{"keys":["x"]}'])
    expect(changes).toEqual(['app:idle:[1]'])

    await clock.advance(30_000, 25)
    await publishedByOther(two!, '{"keys":["y"]}')
    await secondLive.set('app:idle', '', '[2]')
    await first.get('x')
    firstLive.wake?.()
    await clock.advance(500, 80)
    expect(heard).toEqual(['{"keys":["x"]}', '{"keys":["y"]}'])
    expect(changes).toEqual(['app:idle:[1]', 'app:idle:[2]'])
    firstLive.stop?.()
    secondLive.stop?.()
  })

  pgIt('end their polling when closed while backed off', async () => {
    await freshTables()

    const saved = process.env.KAY_DEV_CODE

    process.env.KAY_DEV_CODE = '1'

    try {
      const [sql] = replicas(1)
      const store = pgCache(pgHandle(sql!))
      const values = pgLive(pgHandle(sql!))

      store.subscribe?.(() => undefined)
      values.subscribe(() => undefined)
      await store.get('x')
      await clock.advance(30_000, 25)
      expect(clock.pending()).toBeGreaterThan(0)
      values.stop?.()
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
