import type { SQL } from 'bun'
import type { Bundle } from '../src/server/bundle'
import type { PgHandle } from '../src/server/pg-data'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect } from 'bun:test'
import { stringify } from 'devalue'
import { cached } from '../src/runtime/cache'
import { rateLimit, rooms } from '../src/server'
import { appName } from '../src/server/app-identity'
import { appStore, setupStore } from '../src/server/app-store'
import { registerBundle } from '../src/server/bundle'
import { createDataTables, dataTables, pgData, pgHandle } from '../src/server/pg-data'
import { createMissingIndexes, indexStatement, pgJobs } from '../src/server/pg-jobs'
import { pgRooms } from '../src/server/pg-rooms'
import { pgRates, pgSessions, pgVitals } from '../src/server/pg-stores'
import { cleanUpAfterFile, pgDescribe, pgIt, postgres, replicas } from './job-stores'
import { scratchDir } from './scratch'

cleanUpAfterFile()

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 4000): Promise<void> {
  const until = Date.now() + ms

  while (Date.now() < until) {
    if (await check())
      return

    await Bun.sleep(20)
  }

  throw new Error(`timed out waiting for ${what}`)
}

// The rows a query gives, typed.
async function rows<Row = unknown>(sql: SQL, text: string): Promise<Row[]> {
  return sql.unsafe<Row[]>(text)
}

// Every table dropped first, so each case starts on an empty database.
async function fresh(): Promise<SQL> {
  const { sql } = await postgres()

  // One table per statement, as one DROP of them all holds locks on the first while it waits for the next, which a poller still reading two of them deadlocks with.
  for (const table of dataTables)
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`)

  return sql
}

// Closes the stores and waits for their last writes, which would otherwise land on the next case's tables.
async function closed(...stores: { close: () => void }[]): Promise<void> {
  for (const store of stores)
    store.close()

  await Bun.sleep(100)
}

// Handles on separate connections, as replicas of an app have.
function handles(count: number): PgHandle[] {
  return replicas(count).map(sql => pgHandle(sql))
}

afterEach(async () => setupStore(undefined))

pgDescribe('pgData', () => {
  pgIt('gives each kind the SQLite one gives', async () => {
    const data = pgData(await fresh())

    expect(Object.keys(data).sort()).toEqual(['cache', 'jobs', 'live', 'notifications', 'rates', 'rooms', 'sessions', 'vitals'])
  })

  pgIt('is the app store: what names no store of its own lands in Postgres', async () => {
    const sql = await fresh()
    const data = pgData(sql)

    setupStore(data)
    expect(appStore()?.sessions).toBe(data.sessions)
    expect(await cached('pg-app-store', '60s', () => 'kept')).toBe('kept')
    await waitFor(async () => (await rows(sql, 'SELECT key FROM kay_cache')).length === 1, 'the cached row')

    const limit = rateLimit('pg-app-store', { max: 1, window: '1m' })

    expect(await limit.hit('ada')).toBeUndefined()
    expect(await limit.hit('ada')).toBeGreaterThan(0)
    expect(await rows(sql, 'SELECT count FROM kay_rates')).toEqual([{ count: 2 }])
  })

  pgIt('creates the tables on first use, and createDataTables leaves existing ones alone', async () => {
    const sql = await fresh()
    const { url } = await postgres()

    await pgData(sql).sessions.set('a', { user: 1 }, '1h')

    const present = await rows<{ found: number }>(sql, `SELECT count(*)::int AS found FROM unnest(ARRAY[${dataTables.map(name => `'${name}'`).join(',')}]) AS name WHERE to_regclass(name) IS NOT NULL`)

    expect(present[0]!.found).toBe(dataTables.length)
    await createDataTables(url)
    await createDataTables({ sql })
    expect(await pgData(sql).sessions.get('a')).toEqual({ user: 1 })
  })

  pgIt('creates an index missing on tables that exist, while a poller reads them', async () => {
    const sql = await fresh()

    await createDataTables(sql)

    const present = async (name: string): Promise<boolean> => (await rows<{ found: boolean }>(sql, `SELECT to_regclass('${name}') IS NOT NULL AS found`))[0]!.found
    const stop = new AbortController()
    const poller = (async () => {
      while (!stop.signal.aborted)
        await rows(sql, 'SELECT count(*) FROM kay_sessions, kay_jobs, kay_live_events')
    })()

    await sql.unsafe('DROP INDEX kay_sessions_expires')
    await sql.unsafe('DROP INDEX kay_jobs_due')
    await createDataTables(sql)
    expect(await present('kay_sessions_expires')).toBe(true)
    expect(await present('kay_jobs_due')).toBe(true)

    await sql.unsafe('DROP INDEX kay_live_events_at')
    await pgHandle(sql).db()
    expect(await present('kay_live_events_at')).toBe(true)
    stop.abort()
    await poller
  })

  pgIt('builds again an index a failed concurrent build left invalid', async () => {
    const sql = await fresh()

    await createDataTables(sql)
    await sql.unsafe('UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass(\'kay_jobs_due\')')
    await createDataTables(sql)
    expect(await rows(sql, 'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(\'kay_jobs_due\')')).toEqual([{ indisvalid: true }])
  })

  pgIt('leaves alone an index another session is still building', async () => {
    const sql = await fresh()
    const [holder, first, second] = replicas(3) as [SQL, SQL, SQL]

    await createDataTables(sql)
    await sql.unsafe('DROP INDEX kay_jobs_due')

    const errors: unknown[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let snapshotTaken!: () => void
    const snapshot = new Promise<void>((resolve) => {
      snapshotTaken = resolve
    })
    const holding = holder.begin('ISOLATION LEVEL REPEATABLE READ', async (tx) => {
      // Its snapshot makes the build wait for it, so the index stays invalid while the second replica starts.
      await tx.unsafe('SELECT count(*) FROM kay_jobs')
      snapshotTaken()
      await held
    })
    const building = async (): Promise<boolean> => (await rows<{ found: boolean }>(sql, 'SELECT EXISTS (SELECT 1 FROM pg_stat_progress_create_index WHERE index_relid = to_regclass(\'kay_jobs_due\')) AS found'))[0]!.found
    const build = (async (): Promise<void> => {
      await snapshot

      try {
        await first.unsafe(indexStatement({ name: 'kay_jobs_due', on: 'kay_jobs (queue, failed, run_at)' }, true))
      }
      catch (error) {
        errors.push(error)
      }
    })()
    const startSecond = async (): Promise<string> => {
      try {
        await createDataTables(second)
      }
      catch (error) {
        errors.push(error)
      }

      return 'done'
    }
    const timeout = async (): Promise<string> => {
      await Bun.sleep(3000)

      return 'waited on the first build'
    }

    try {
      await waitFor(building, 'the first build')
      expect(await Promise.race([startSecond(), timeout()])).toBe('done')
      expect(await building()).toBe(true)
    }
    finally {
      release()
      await holding
    }

    await build
    expect(errors).toEqual([])
    expect(await rows(sql, 'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(\'kay_jobs_due\')')).toEqual([{ indisvalid: true }])
  })

  pgIt('holds a replica that lost the lock until the unique index is valid, so a keyed job is not enqueued twice meanwhile', async () => {
    const sql = await fresh()
    const [holder, first, second] = replicas(3) as [SQL, SQL, SQL]

    await createDataTables(sql)
    await sql.unsafe('DROP INDEX kay_jobs_key')

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let snapshotTaken!: () => void
    const snapshot = new Promise<void>((resolve) => {
      snapshotTaken = resolve
    })
    const holding = holder.begin('ISOLATION LEVEL REPEATABLE READ', async (tx) => {
      await tx.unsafe('SELECT count(*) FROM kay_jobs')
      snapshotTaken()
      await held
    })
    const building = async (): Promise<boolean> => (await rows<{ found: boolean }>(sql, 'SELECT EXISTS (SELECT 1 FROM pg_stat_progress_create_index WHERE index_relid = to_regclass(\'kay_jobs_key\')) AS found'))[0]!.found
    const build = (async (): Promise<void> => {
      await snapshot
      await createDataTables(first)
    })()
    const job = (id: string): Parameters<ReturnType<typeof pgJobs>['add']>[0] => ({ id, queue: 'q', payload: '{}', attempts: 0, runAt: 0, key: 'same' })
    const store = pgJobs(second)
    let added = 0
    const adds = (async (): Promise<void> => {
      await Promise.all([store.add(job('a')), store.add(job('b'))])
      added = 2
    })()

    try {
      await waitFor(building, 'the first build')
      await Bun.sleep(1500)
      expect(added).toBe(0)
    }
    finally {
      release()
      await holding
    }

    await build
    await adds
    expect(await rows(sql, 'SELECT id FROM kay_jobs WHERE job_key = \'same\'')).toHaveLength(1)
    expect(await rows(sql, 'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(\'kay_jobs_key\')')).toEqual([{ indisvalid: true }])
  })

  pgIt('takes the indexes over from a replica holding the lock that builds nothing', async () => {
    const sql = await fresh()
    const [holder, other] = replicas(2) as [SQL, SQL]

    await createDataTables(sql)
    await sql.unsafe('DROP INDEX kay_jobs_key')

    const reserved = await holder.reserve()

    await reserved.unsafe('SELECT pg_advisory_lock(hashtext(\'kay_indexes\'))')

    let done = false
    const waiting = (async (): Promise<void> => {
      await createMissingIndexes(other, [{ name: 'kay_jobs_key', on: 'kay_jobs (queue, job_key) WHERE job_key IS NOT NULL AND NOT failed', unique: true }])
      done = true
    })()

    try {
      await Bun.sleep(1000)
      expect(done).toBe(false)
    }
    finally {
      await reserved.unsafe('SELECT pg_advisory_unlock(hashtext(\'kay_indexes\'))')
      await reserved.release()
    }

    await waiting
    expect(await rows(sql, 'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(\'kay_jobs_key\')')).toEqual([{ indisvalid: true }])
  })

  pgIt('counts a build that deadlocks with another as lost, and waits for the index', async () => {
    let builds = 0
    const session = Object.assign(async () => [{ taken: true }], {
      unsafe: async (text: string) => {
        if (text.startsWith('SELECT to_regclass'))
          return [{ missing: true }]

        if (text.startsWith('CREATE')) {
          builds++

          throw Object.assign(new Error('deadlock detected'), { errno: '40P01' })
        }

        return []
      },
      release: () => undefined,
    })
    const db = {
      reserve: async () => session,
      unsafe: async () => [{ valid: builds > 0 }],
    } as unknown as SQL

    await createMissingIndexes(db, [{ name: 'kay_jobs_key', on: 'kay_jobs (queue, job_key)', unique: true }])
    expect(builds).toBe(1)
  })

  pgIt('creates a missing index once when replicas start at once, neither failing', async () => {
    const sql = await fresh()
    const [first, second] = replicas(2) as [SQL, SQL]

    await createDataTables(sql)
    await sql.unsafe('DROP INDEX kay_jobs_due')
    await sql.unsafe('DROP INDEX kay_jobs_key')
    await Promise.all([createDataTables(first), createDataTables(second)])
    expect(await rows(sql, 'SELECT indisvalid FROM pg_index WHERE indexrelid IN (to_regclass(\'kay_jobs_due\'), to_regclass(\'kay_jobs_key\'))')).toEqual([{ indisvalid: true }, { indisvalid: true }])
  })

  pgIt('creates the tables once when replicas open it at once', async () => {
    await fresh()

    const stores = handles(5).map(handle => pgSessions(handle))

    await Promise.all(stores.map(async (store, index) => store.set(`s${index}`, { index }, '1h')))
    expect(await stores[0]!.get('s4')).toEqual({ index: 4 })
  })

  pgIt('takes a Bun SQL, a pg-orm style { sql } or a URL', async () => {
    const sql = await fresh()
    const { url } = await postgres()

    await pgData(sql).sessions.set('x', { n: 1 }, '1h')
    expect(await pgData({ sql }).sessions.get('x')).toEqual({ n: 1 })

    const byUrl = pgData(url)

    expect(await byUrl.sessions.get('x')).toEqual({ n: 1 })
  })
})

pgDescribe('pgSessions', () => {
  pgIt('keeps, replaces and deletes a session, shared by every replica', async () => {
    await fresh()

    const [first, second] = handles(2).map(handle => pgSessions(handle))

    await first!.set('a', { user: 1, cart: ['x', new Date(0)] }, '1h')
    expect(await second!.get('a')).toEqual({ user: 1, cart: ['x', new Date(0)] })
    await second!.set('a', { user: 2 }, '1h')
    expect(await first!.get('a')).toEqual({ user: 2 })
    await first!.delete('a')
    expect(await second!.get('a')).toBeUndefined()
  })

  pgIt('forgets a session past its maxAge', async () => {
    const sql = await fresh()
    const store = pgSessions(pgHandle(sql))

    await store.set('old', { user: 1 }, '1h')
    await rows(sql, 'UPDATE kay_sessions SET expires = 0')
    expect(await store.get('old')).toBeUndefined()
    await store.set('new', { user: 2 }, '1s')
    expect(await store.get('new')).toEqual({ user: 2 })
  })

  pgIt('ends the sessions deleteWhere matches, and counts them', async () => {
    const sql = await fresh()
    const store = pgSessions(pgHandle(sql))

    await store.set('a', { user: 1 }, '1h')
    await store.set('b', { user: 1 }, '1h')
    await store.set('c', { user: 2 }, '1h')
    await rows(sql, 'INSERT INTO kay_sessions (id, data, expires) VALUES (\'broken\', \'not devalue\', 9999999999999)')
    expect(await store.deleteWhere((data) => {
      return data.user === 1
    })).toBe(2)
    expect(await store.get('a')).toBeUndefined()
    expect(await store.get('c')).toEqual({ user: 2 })
    expect(await store.deleteWhere(() => false)).toBe(0)
  })

  pgIt('ends the sessions an object match names in the database, leaving a row it never reads', async () => {
    const sql = await fresh()
    const store = pgSessions(pgHandle(sql))

    await store.set('a', { user: 1 }, '1h')
    await store.set('b', { user: '1' }, '1h')
    await store.set('c', { user: 'ada', note: 1 }, '1h')
    await rows(sql, 'INSERT INTO kay_sessions (id, data, expires) VALUES (\'broken\', \'not devalue\', 9999999999999)')
    await rows(sql, `INSERT INTO kay_sessions (id, data, expires) SELECT 'bulk' || n, '${stringify({ user: 2 })}', 9999999999999 FROM generate_series(1, 1300) AS n`)

    const sink = globalThis as Record<symbol, unknown>
    const key = Symbol.for('kay.log')
    const previous = sink[key]
    const logged: string[] = []

    sink[key] = (level: string, message: string) => logged.push(`${level}: ${message}`)

    try {
      expect(await store.deleteWhere({ user: 1 })).toBe(1)
      expect(await store.deleteWhere({ user: 'ada' })).toBe(1)
      expect(await store.deleteWhere({ user: 2 })).toBe(1300)

      const odd = 'a"b\\c \u{1F600}\n\uD800'

      await store.set('odd', { user: odd, ok: true }, '1h')
      await store.set('odd2', { user: odd, ok: false }, '1h')
      await store.set('zero', { n: -0 }, '1h')
      expect(await store.deleteWhere({ user: odd, ok: true })).toBe(1)
      expect(await store.deleteWhere({ user: odd })).toBe(1)
      expect(await store.deleteWhere({ n: 0 })).toBe(1)
    }
    finally {
      sink[key] = previous
    }

    // Only the match on 0, which has no text to narrow by, read the row that is not devalue.
    expect(logged).toEqual(['warn: a stored session does not parse; deleteWhere skipped it'])
    expect(await store.get('b')).toEqual({ user: '1' })
    expect(await rows(sql, 'SELECT 1 FROM kay_sessions')).toHaveLength(2)
    await expect(store.deleteWhere({})).rejects.toThrow('deleteWhere takes')
  })

  pgIt('reads the live sessions a page at a time, so more than a page of them are all matched', async () => {
    const sql = await fresh()
    const store = pgSessions(pgHandle(sql))

    await store.set('seed', { user: 0 }, '1h')

    const data = stringify({ user: 1 })

    await rows(sql, `INSERT INTO kay_sessions (id, data, expires) SELECT 'bulk' || n, '${data}', 9999999999999 FROM generate_series(1, 1300) AS n`)
    await rows(sql, `INSERT INTO kay_sessions (id, data, expires) VALUES ('gone', '${data}', 0)`)

    let seen = 0

    expect(await store.deleteWhere((session) => {
      seen++

      return session.user === 1
    })).toBe(1300)
    expect(seen).toBe(1301)
    expect(await store.get('seed')).toEqual({ user: 0 })
    expect(await rows(sql, 'SELECT 1 FROM kay_sessions')).toHaveLength(2)
  })
})

pgDescribe('pgRates', () => {
  pgIt('counts attempts in a window that reopens once it closed, with the weight of each', async () => {
    await fresh()

    const rates = pgRates(pgHandle((await postgres()).sql))
    const first = await rates.hit('ada', '300ms')

    expect(first.count).toBe(1)
    expect((await rates.hit('ada', '300ms')).count).toBe(2)
    expect((await rates.hit('ada', '300ms', 5)).count).toBe(7)
    expect((await rates.peek!('ada'))?.count).toBe(7)
    expect((await rates.peek!('bob'))).toBeUndefined()
    expect((await rates.hit('ada', '300ms')).resetAt).toBe(first.resetAt)
    await Bun.sleep(350)
    expect(await rates.peek!('ada')).toBeUndefined()
    expect((await rates.hit('ada', '300ms')).count).toBe(1)
  })

  pgIt('shares the counts between replicas, and stores no key in the clear', async () => {
    const sql = await fresh()
    const [first, second] = handles(2).map(handle => pgRates(handle))

    await Promise.all([first!.hit('203.0.113.9', '60s'), second!.hit('203.0.113.9', '60s'), first!.hit('203.0.113.9', '60s')])
    expect((await second!.peek!('203.0.113.9'))?.count).toBe(3)

    const stored = await rows<{ key: string }>(sql, 'SELECT key FROM kay_rates')

    expect(stored).toHaveLength(1)
    expect(stored[0]!.key).not.toContain('203.0.113.9')
  })
})

pgDescribe('pgVitals', () => {
  pgIt('adds the readings of replicas up, and forgets days past the window', async () => {
    const sql = await fresh()
    const [first, second] = handles(2).map(handle => pgVitals(handle))
    const today = 20_000

    await first!.add('/', [{ vital: 'lcp', bucket: 50 }, { vital: 'cls', bucket: 3 }], today)
    await Promise.all([first!.add('/', [{ vital: 'lcp', bucket: 50 }], today), second!.add('/', [{ vital: 'lcp', bucket: 50 }], today)])
    await second!.add('/old', [{ vital: 'lcp', bucket: 9 }], today - 30)
    expect(await rows(sql, 'SELECT day FROM kay_vitals WHERE route = \'/old\'')).toHaveLength(1)
    await second!.add('/', [{ vital: 'inp', bucket: 7 }], today - 1)

    const counts = (await first!.counts(today - 3)).sort((a, b) => a.vital.localeCompare(b.vital))

    expect(counts).toEqual([
      { route: '/', vital: 'cls', bucket: 3, count: 1 },
      { route: '/', vital: 'inp', bucket: 7, count: 1 },
      { route: '/', vital: 'lcp', bucket: 50, count: 3 },
    ])
    expect(await rows(sql, 'SELECT day FROM kay_vitals WHERE route = \'/old\'')).toHaveLength(0)
  })
})

pgDescribe('pgCache', () => {
  // A runtime of its own and a store of its own, as a process that started has.
  async function boot(tag: string, handle: PgHandle) {
    const runtime = await import(`../src/runtime/cache.ts?${tag}`) as typeof import('../src/runtime/cache')
    const { pgCache } = await import(`../src/server/pg-cache.ts?${tag}`) as typeof import('../src/server/pg-cache')
    const store = pgCache(handle)

    runtime.trackStore(store)

    return { ...runtime, store }
  }

  pgIt('keeps a value across restarts, and drops it on invalidate', async () => {
    const sql = await fresh()
    const [handle] = handles(1)
    const before = await boot('keep-a', handle!)
    let loads = 0

    expect(await before.cached('greeting', '600s', () => ++loads, { store: before.store })).toBe(1)
    await waitFor(async () => (await rows(sql, 'SELECT key FROM kay_cache')).length === 1, 'the row')

    const after = await boot('keep-b', handle!)

    expect(await after.cached('greeting', '600s', () => ++loads, { store: after.store })).toBe(1)
    expect(loads).toBe(1)

    after.invalidate('greeting')
    expect(await after.cached('greeting', '600s', () => ++loads, { store: after.store })).toBe(2)
    await waitFor(async () => (await rows(sql, 'SELECT value FROM kay_cache')).length === 1, 'the row to be written again')
  })

  pgIt('drops the stored values stale for a week on a write, and keeps the ones stale for less', async () => {
    const sql = await fresh()
    const [handle] = handles(1)
    const { store } = await boot('purge', handle!)
    const day = 86_400_000

    await store.set('warm', '"w"', Date.now() + 60_000)
    await rows(sql, `INSERT INTO kay_cache (key, value, fresh_until) VALUES ('old', '"o"', ${Date.now() - 8 * day}), ('recent', '"r"', ${Date.now() - 2 * day})`)
    // The purge ran with the first write, so a store of its own meets the old rows on its first.
    const second = (await boot('purge-b', handle!)).store

    await second.set('another', '"a"', Date.now() + 60_000)
    await waitFor(async () => (await rows<{ key: string }>(sql, 'SELECT key FROM kay_cache ORDER BY key')).length === 3, 'the purge')
    expect((await rows<{ key: string }>(sql, 'SELECT key FROM kay_cache ORDER BY key')).map(row => row.key)).toEqual(['another', 'recent', 'warm'])
  })

  pgIt('hears a message for every listener though one throws', async () => {
    await fresh()

    const [first, second] = handles(2)
    const sender = await boot('listen-a', first!)
    const { store: receiver } = await boot('listen-b', second!)

    // Starts the poll of the receiver, which only a call needing the database does.
    await receiver.keys()
    const heard: string[] = []

    receiver.subscribe!(() => {
      throw new Error('a listener that threw')
    })
    receiver.subscribe!(message => void heard.push(message))
    await waitFor(() => {
      sender.invalidate('greeting')

      return heard.length > 0
    }, 'the poll to read the message')
  })

  pgIt('drops what a value was built from when a key it read is invalidated, even from a process that never held it', async () => {
    const sql = await fresh()
    const [handle] = handles(1)
    const before = await boot('deps-a', handle!)

    before.trackLoads(async (load) => {
      const result = await load()

      return { result, reads: result === 'one' ? ['collection:news'] : [] }
    })
    expect(await before.cached('latest', '600s', () => 'one', { store: before.store })).toBe('one')
    expect(await before.cached('plain', '600s', () => 'two', { store: before.store })).toBe('two')
    await waitFor(async () => (await rows(sql, 'SELECT key FROM kay_cache')).length === 2, 'both rows')

    const after = await boot('deps-b', handle!)

    after.invalidate('collection:news')

    let loads = 0

    expect(await after.cached('latest', '600s', () => `loaded ${++loads}`, { store: after.store })).toBe('loaded 1')
    await waitFor(async () => (await rows<{ value: string }>(sql, 'SELECT value FROM kay_cache WHERE key = \'latest\'')).some(row => row.value.includes('loaded 1') && !row.value.includes('collection:news')), 'the row to be written again')
    expect(await rows(sql, 'SELECT key FROM kay_cache ORDER BY key')).toEqual([{ key: 'latest' }, { key: 'plain' }])
  })

  pgIt('tells another process what one invalidated', async () => {
    await fresh()

    const [first, second] = handles(2)
    const sender = await boot('bus-a', first!)
    const receiver = await boot('bus-b', second!)
    const heard: string[] = []

    const probe = '{"keys":[]}'
    let polling = false

    receiver.store.subscribe!(message => message === probe ? void (polling = true) : heard.push(message))
    // The receiver reads from the moment it first uses the store, and a probe is heard once its poller runs.
    await receiver.store.keys()
    await waitFor(async () => {
      await sender.store.publish!(probe)

      return polling
    }, 'the receiver to poll')
    await sender.store.publish!('{"keys":["a"]}')
    await waitFor(() => heard.length === 1, 'the message')
    expect(heard).toEqual(['{"keys":["a"]}'])
    await Bun.sleep(700)
    expect(heard).toHaveLength(1)
  })

  pgIt('tells another process the invalidations in the order they were made when their ids gain a digit', async () => {
    const sql = await fresh()
    const [first, second] = handles(2)
    const sender = await boot('bus-a', first!)
    const receiver = await boot('bus-b', second!)
    const heard: string[] = []
    let polling = false

    receiver.store.subscribe!(message => message === '{"keys":[]}' ? void (polling = true) : heard.push(message))
    await receiver.store.keys()
    await waitFor(async () => {
      await sender.store.publish!('{"keys":[]}')

      return polling
    }, 'the receiver to poll')
    await sql.unsafe(`SELECT setval('kay_events_id_seq', greatest(89, (SELECT coalesce(max(id), 0) FROM kay_events)))`)

    const messages = Array.from({ length: 30 }, (_, at) => `{"keys":["k${at}"]}`)

    for (const message of messages)
      await sender.store.publish!(message)

    await waitFor(() => heard.length === messages.length, 'every message')
    await Bun.sleep(150)
    expect(heard).toEqual(messages)
  })
})

pgDescribe('pgRooms', () => {
  pgIt('lists the members of every replica, and drops one that left', async () => {
    await fresh()

    const [first, second] = handles(2).map(handle => pgRooms(handle, { poll: '20ms' }))

    first!.add('lobby', 'c1', '"ada"')
    expect(second!.members('lobby')).toEqual([])
    await waitFor(() => second!.members('lobby').length === 1, 'the member of the other replica')
    second!.add('lobby', 'c2', '"bob"')
    expect(second!.members('lobby')).toEqual(['"ada"', '"bob"'])
    await waitFor(() => first!.members('lobby').length === 2, 'the second member')
    expect(first!.members('lobby')).toEqual(['"ada"', '"bob"'])
    first!.remove('lobby', 'c1')
    await waitFor(() => second!.members('lobby').length === 1, 'the leaving')
    expect(second!.members('lobby')).toEqual(['"bob"'])
    expect(first!.members('elsewhere')).toEqual([])
    await closed(first!, second!)
  })

  pgIt('stops counting the members of a replica that went quiet', async () => {
    const sql = await fresh()
    const [first, second] = handles(2).map(handle => pgRooms(handle, { poll: '20ms' }))

    first!.add('lobby', 'c1', '"ada"')
    await waitFor(() => second!.members('lobby').length === 1, 'the member')
    await rows(sql, 'UPDATE kay_room_processes SET seen = 0')
    await waitFor(() => second!.members('lobby').length === 0, 'the member to expire')
    await closed(first!, second!)
  })

  pgIt('removes the members of a store that closed', async () => {
    const sql = await fresh()
    const [handle] = handles(1)
    const first = pgRooms(handle!, { poll: '20ms' })

    await handle!.db()

    first.add('lobby', 'c1', '"ada"')
    await waitFor(async () => (await rows(sql, 'SELECT 1 FROM kay_room_members')).length === 1, 'the row')
    // A stop waits for the promise, so the members are gone when it settles.
    await first.close()
    expect(await rows(sql, 'SELECT 1 FROM kay_room_members')).toEqual([])
  })

  pgIt('delivers a message to the listeners of the other replicas and of its own, honouring except and to', async () => {
    await fresh()

    const [first, second] = handles(2).map(handle => pgRooms(handle, { poll: '20ms' }))
    const own: string[] = []
    const other: [string, string, unknown][] = []

    const probed = [false, false]

    // A probe each way is seen once both pollers have read their starting position, which a message published before is lost to.
    first!.subscribe((room, text) => text.startsWith('probe') ? void (probed[0] ||= text === 'probe-second') : own.push(`${room}:${text}`))
    second!.subscribe((room, text, recipients) => text.startsWith('probe') ? void (probed[1] ||= text === 'probe-first') : other.push([room, text, recipients]))
    await waitFor(() => {
      first!.publish('probe', 'probe-first', {})
      second!.publish('probe', 'probe-second', {})

      return probed.every(Boolean)
    }, 'both pollers to run')
    first!.publish('lobby', 'hello', {})
    first!.publish('lobby', 'quiet', { except: 'c1', to: '"bob"' })
    expect(own).toEqual(['lobby:hello', 'lobby:quiet'])
    await waitFor(() => other.length === 2, 'both messages')
    expect(other).toEqual([['lobby', 'hello', {}], ['lobby', 'quiet', { except: 'c1', to: '"bob"' }]])
    second!.publish('lobby', 'back', {})
    expect(other).toHaveLength(3)
    await waitFor(() => own.length === 3, 'the message back')
    expect(own[2]).toBe('lobby:back')
    await closed(first!, second!)
  })

  pgIt('delivers a message to the listeners of a replica after one that throws', async () => {
    await fresh()

    const [first, second] = handles(2).map(handle => pgRooms(handle, { poll: '20ms' }))
    const heard: string[] = []

    second!.subscribe(() => {
      throw new Error('a listener that threw')
    })
    second!.subscribe((room, text) => void heard.push(`${room}:${text}`))
    await waitFor(() => {
      first!.publish('lobby', 'hello', {})

      return heard.length > 0
    }, 'the message after the throwing listener')
    expect(heard[0]).toBe('lobby:hello')
    await closed(first!, second!)
  })

  pgIt('delivers messages in the order they were published when their ids gain a digit', async () => {
    const sql = await fresh()
    const [first, second] = handles(2).map(handle => pgRooms(handle, { poll: '20ms' }))
    const heard: string[] = []
    let polling = false

    second!.subscribe((_room, text) => text === 'probe' ? void (polling = true) : heard.push(text))
    await waitFor(() => {
      first!.publish('lobby', 'probe', {})

      return polling
    }, 'the other poller to run')
    // The ids are text in the read, so '100' sorted before '99' and a message published after another reached the other replica before it.
    await waitFor(async () => (await rows(sql, 'SELECT id FROM kay_room_messages')).length >= 1, 'the probe row')
    await sql.unsafe(`SELECT setval('kay_room_messages_id_seq', greatest(89, (SELECT coalesce(max(id), 0) FROM kay_room_messages)))`)

    const texts = Array.from({ length: 30 }, (_, at) => `m${at}`)

    for (const text of texts)
      first!.publish('lobby', text, {})

    await waitFor(() => heard.length === texts.length, 'every message')
    await Bun.sleep(150)
    expect(heard).toEqual(texts)
    await closed(first!, second!)
  })

  pgIt('keeps a room state across replicas, two replicas updating one room at once losing nothing', async () => {
    const sql = await fresh()
    const [first, second] = handles(2).map(handle => pgRooms(handle, { poll: '20ms' }))
    const options = { state: () => ({ count: 0 }) }
    const one = rooms<string, string, { count: number }>({ store: first!, ...options })
    const two = rooms<string, string, { count: number }>({ store: second!, ...options })
    const socket = () => ({ raw: { sendText: () => undefined } })

    one.join(socket(), 'lobby', 'ada')
    two.join(socket(), 'lobby', 'bob')
    expect(await one.state('lobby')).toEqual({ count: 0 })

    const bumps = Array.from({ length: 20 }, async (_, at) => (at % 2 === 0 ? one : two).update('lobby', state => ({ count: state.count + 1 })))

    await Promise.all(bumps)
    expect(await one.state('lobby')).toEqual({ count: 20 })
    expect(await two.state('lobby')).toEqual({ count: 20 })
    expect(await rows(sql, 'SELECT state FROM kay_room_state')).toEqual([{ state: '{"count":20}' }])
    await closed(first!, second!)
  })

  pgIt('sends a joiner the state, drops it with the last member, and stores none for an empty room', async () => {
    const sql = await fresh()
    const [handle] = handles(1)
    const store = pgRooms(handle!, { poll: '20ms' })
    const live = rooms<string, undefined, { count: number }>({ store, state: () => ({ count: 0 }), snapshot: state => JSON.stringify(state) })
    const received: string[] = []
    const ada = { raw: { sendText: (text: string) => void received.push(text) } }

    expect(await live.update('empty', state => ({ count: state.count + 5 }))).toEqual({ count: 5 })
    expect(await rows(sql, 'SELECT 1 FROM kay_room_state')).toEqual([])
    live.join(ada, 'lobby')
    await waitFor(() => received.length === 1, 'the snapshot')
    expect(received).toEqual(['{"count":0}'])
    await live.update('lobby', () => ({ count: 3 }))
    live.leave(ada)
    await waitFor(async () => (await rows(sql, 'SELECT 1 FROM kay_room_state')).length === 0, 'the state to go')
    expect(await live.state('lobby')).toEqual({ count: 0 })
    store.close()
  })

  pgIt('drops a state itself when the last member leaves while another replica holds the room\'s lock past the timeout', async () => {
    const sql = await fresh()
    const [handle, other] = handles(2)
    const store = pgRooms(handle!, { poll: '20ms' })
    const live = rooms<string, undefined, { count: number }>({ store, state: () => ({ count: 0 }) })
    const ada = { raw: { sendText: () => undefined } }

    live.join(ada, 'lobby')
    await live.update('lobby', () => ({ count: 3 }))

    // Held for longer than the 5 s the leaving one waits for the lock.
    const holder = (async () => {
      const db = await other!.db()

      await db.begin(async (tx) => {
        await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['kay_room_state\nlobby'])
        await Bun.sleep(5_500)
      })
    })()

    await Bun.sleep(300)
    live.leave(ada)
    await holder
    await waitFor(async () => (await rows(sql, 'SELECT 1 FROM kay_room_state')).length === 0, 'the state to go', 8000)
    store.close()
  }, 20_000)

  pgIt('sends an async coalesce snapshot, and no snapshot to a joiner that left while the state was read', async () => {
    await fresh()

    const [handle] = handles(1)
    const store = pgRooms(handle!, { poll: '20ms' })
    const live = rooms<string, undefined, { count: number }>({ store, state: () => ({ count: 0 }), snapshot: state => `snap${state.count}` })
    const received: string[] = []
    const ada = { raw: { sendText: (text: string) => void received.push(text) } }

    live.join(ada, 'lobby')
    live.leave(ada)
    // The store answers in the order asked: once this state is read, the one read for the first join is too, and its snapshot had its turn.
    await live.state('lobby')
    await Bun.sleep(0)
    expect(received).toEqual([])
    live.join(ada, 'lobby')
    await waitFor(() => received.length === 1, 'the snapshot')

    const send = live.coalesce(async room => `now${(await live.state(room)).count}`, { wait: '10ms' })

    await live.update('lobby', () => ({ count: 4 }))
    send('lobby')
    send('lobby')
    await waitFor(() => received.length === 2, 'the coalesced snapshot')
    await Bun.sleep(100)
    expect(received).toEqual(['snap0', 'now4'])
    store.close()
  })

  pgIt('rejects an update whose function throws and keeps the old state', async () => {
    await fresh()

    const [handle] = handles(1)
    const store = pgRooms(handle!, { poll: '20ms' })
    const live = rooms<string, undefined, { count: number }>({ store, state: () => ({ count: 0 }) })

    live.join({ raw: { sendText: () => undefined } }, 'lobby')
    await live.update('lobby', () => ({ count: 1 }))
    await expect(live.update('lobby', () => {
      throw new Error('no')
    })).rejects.toThrow('no')
    expect(await live.state('lobby')).toEqual({ count: 1 })
    store.close()
  })
})

// Runs `use` with KAY_ROOT on a folder whose package.json names the app, which `pgData` reads when it first touches the database.
async function asApp<Result>(name: string | undefined, use: () => Promise<Result>): Promise<Result> {
  const dir = await scratchDir('pg-app-')
  const before = process.env.KAY_ROOT

  if (name !== undefined)
    await Bun.write(join(dir, 'package.json'), JSON.stringify({ name }))

  process.env.KAY_ROOT = dir

  try {
    return await use()
  }
  finally {
    if (before === undefined)
      delete process.env.KAY_ROOT
    else
      process.env.KAY_ROOT = before
  }
}

async function owner(sql: SQL): Promise<string | undefined> {
  return (await rows<{ value: string }>(sql, 'SELECT value FROM kay_meta WHERE name = \'app\'')).at(0)?.value
}

// What a call fails with, or nothing when it passes.
async function refusal(call: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await call()
  }
  catch (error) {
    return error as Error
  }

  return undefined
}

pgDescribe('pgData app identity', () => {
  pgIt('the first app to boot claims the database and a second one is refused naming both', async () => {
    const sql = await fresh()

    await asApp('shop', async () => pgData(sql).sessions.set('a', { user: 1 }, '1h'))
    expect(await owner(sql)).toBe('shop')

    // Every store refuses, the jobs' included, which would otherwise hand the other app's `mail` jobs to this one.
    const blog = await asApp('blog', async () => pgData(sql))

    for (const touch of [async () => blog.sessions.get('a'), async () => blog.jobs.add({ id: 'x', queue: 'mail', payload: '{}', attempts: 0, runAt: 0 }), async () => blog.cache.get('k')]) {
      const error = await asApp('blog', async () => refusal(touch))

      expect(error?.message).toContain('belongs to the app "shop"')
      expect(error?.message).toContain('"blog" is starting')
      expect(error?.message).toContain('KAY_ADOPT_DATABASE=shop')
    }

    expect(await owner(sql)).toBe('shop')
  })

  pgIt('the same app boots again, on every replica at once', async () => {
    const sql = await fresh()

    await asApp('shop', async () => Promise.all([pgData(sql).sessions.get('a'), pgData(sql).sessions.get('b'), pgData(sql).jobs.add({ id: 'y', queue: 'mail', payload: '{}', attempts: 0, runAt: 0 })]))
    await asApp('shop', async () => pgData(sql).sessions.get('a'))
    expect(await owner(sql)).toBe('shop')
  })

  pgIt('a database from before identities adopts the first app that boots', async () => {
    const sql = await fresh()

    await createDataTables(sql)
    expect(await owner(sql)).toBeUndefined()
    await asApp('legacy', async () => pgData(sql).sessions.get('a'))
    expect(await owner(sql)).toBe('legacy')
  })

  pgIt('KAY_ADOPT_DATABASE naming the owner hands the database to a renamed app, and only that owner', async () => {
    const sql = await fresh()

    await asApp('old-name', async () => pgData(sql).sessions.get('a'))

    process.env.KAY_ADOPT_DATABASE = 'someone-else'

    try {
      await expect(asApp('new-name', async () => pgData(sql).sessions.get('a'))).rejects.toThrow('belongs to the app "old-name"')
      process.env.KAY_ADOPT_DATABASE = 'old-name'
      await asApp('new-name', async () => pgData(sql).sessions.get('a'))
      expect(await owner(sql)).toBe('new-name')
      // Left set, it harms nothing: the owner is no longer the name it expects, so a third app is still refused.
      await expect(asApp('third', async () => pgData(sql).sessions.get('a'))).rejects.toThrow('belongs to the app "new-name"')
    }
    finally {
      delete process.env.KAY_ADOPT_DATABASE
    }
  })

  pgIt('an app with no package.json name claims nothing and is refused nowhere', async () => {
    const sql = await fresh()

    await asApp('shop', async () => pgData(sql).sessions.get('a'))
    await asApp(undefined, async () => pgData(sql).sessions.get('a'))
    expect(await owner(sql)).toBe('shop')
  })

  pgIt('a pgHandle given no name reads the project\'s package.json', async () => {
    const sql = await fresh()

    await asApp('named', async () => pgHandle(sql).db())
    expect(await owner(sql)).toBe('named')
  })
})

pgDescribe('pgData app name', () => {
  pgIt('an executable carries the name it was built with, and none claims nothing', async () => {
    const sql = await fresh()

    try {
      registerBundle({ name: 'compiled' } as unknown as Bundle)
      expect(appName()).toBe('compiled')
      await pgData(sql).sessions.get('a')
      expect(await owner(sql)).toBe('compiled')
      registerBundle({ name: undefined } as unknown as Bundle)
      await pgData(sql).sessions.get('a')
      expect(await owner(sql)).toBe('compiled')
    }
    finally {
      registerBundle(undefined as unknown as Bundle)
    }
  })

  pgIt('two renamed apps adopting one database at once leave one refused', async () => {
    const sql = await fresh()

    await asApp('old', async () => pgData(sql).sessions.get('a'))
    process.env.KAY_ADOPT_DATABASE = 'old'

    try {
      const results = await Promise.allSettled([asApp('one', async () => pgData(sql).sessions.get('a')), asApp('two', async () => pgData(sql).sessions.get('a'))])

      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    }
    finally {
      delete process.env.KAY_ADOPT_DATABASE
    }
  })
})
