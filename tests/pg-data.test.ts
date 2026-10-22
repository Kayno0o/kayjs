import type { SQL } from 'bun'
import type { PgHandle } from '../src/server/pg-data'
import { afterEach, expect } from 'bun:test'
import { cached } from '../src/runtime/cache'
import { rateLimit, rooms } from '../src/server'
import { appStore, setupStore } from '../src/server/app-store'
import { createDataTables, dataTables, pgData, pgHandle } from '../src/server/pg-data'
import { createMissingIndexes, indexStatement, pgJobs } from '../src/server/pg-jobs'
import { pgRooms } from '../src/server/pg-rooms'
import { pgRates, pgSessions, pgVitals } from '../src/server/pg-stores'
import { cleanUpAfterFile, pgDescribe, pgIt, postgres, replicas } from './job-stores'

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

    expect(Object.keys(data).sort()).toEqual(['cache', 'jobs', 'live', 'rates', 'rooms', 'sessions', 'vitals'])
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
    const holding = holder.begin('ISOLATION LEVEL REPEATABLE READ', async (tx) => {
      // Its snapshot makes the build wait for it, so the index stays invalid while the second replica starts.
      await tx.unsafe('SELECT count(*) FROM kay_jobs')
      await held
    })
    const building = async (): Promise<boolean> => (await rows<{ found: boolean }>(sql, 'SELECT EXISTS (SELECT 1 FROM pg_stat_progress_create_index WHERE index_relid = to_regclass(\'kay_jobs_due\')) AS found'))[0]!.found
    const build = (async (): Promise<void> => {
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
    const holding = holder.begin('ISOLATION LEVEL REPEATABLE READ', async (tx) => {
      await tx.unsafe('SELECT count(*) FROM kay_jobs')
      await held
    })
    const building = async (): Promise<boolean> => (await rows<{ found: boolean }>(sql, 'SELECT EXISTS (SELECT 1 FROM pg_stat_progress_create_index WHERE index_relid = to_regclass(\'kay_jobs_key\')) AS found'))[0]!.found
    const build = createDataTables(first)
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
      reserved.release()
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

    receiver.store.subscribe!(message => heard.push(message))
    // The receiver reads from the moment it first uses the store.
    await receiver.store.keys()
    await Bun.sleep(100)
    await sender.store.publish!('{"keys":["a"]}')
    await waitFor(() => heard.length === 1, 'the message')
    expect(heard).toEqual(['{"keys":["a"]}'])
    await Bun.sleep(700)
    expect(heard).toHaveLength(1)
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
    first.close()
    await waitFor(async () => (await rows(sql, 'SELECT 1 FROM kay_room_members')).length === 0, 'the row to go')
  })

  pgIt('delivers a message to the listeners of the other replicas and of its own, honouring except and to', async () => {
    await fresh()

    const [first, second] = handles(2).map(handle => pgRooms(handle, { poll: '20ms' }))
    const own: string[] = []
    const other: [string, string, unknown][] = []

    first!.subscribe((room, text) => own.push(`${room}:${text}`))
    second!.subscribe((room, text, recipients) => other.push([room, text, recipients]))
    await Bun.sleep(150)
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
