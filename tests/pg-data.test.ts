import type { SQL } from 'bun'
import type { PgHandle } from '../src/server/pg-data'
import { afterEach, expect } from 'bun:test'
import { cached } from '../src/runtime/cache'
import { rateLimit, rooms } from '../src/server'
import { appStore, setupStore } from '../src/server/app-store'
import { createDataTables, dataTables, pgData, pgHandle } from '../src/server/pg-data'
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

  await sql.unsafe(`DROP TABLE IF EXISTS ${dataTables.join(', ')}`)

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

afterEach(() => setupStore(undefined))

pgDescribe('pgData', () => {
  pgIt('gives each kind the SQLite one gives', async () => {
    const data = pgData(await fresh())

    expect(Object.keys(data).sort()).toEqual(['cache', 'jobs', 'rates', 'rooms', 'sessions', 'vitals'])
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

  pgIt('keeps no room state, so rooms({ state }) refuses it', async () => {
    await fresh()

    const store = pgRooms(pgHandle((await postgres()).sql))

    expect(() => rooms<string, undefined, number>({ store, state: () => 0 })).toThrow('state')
  })
})
