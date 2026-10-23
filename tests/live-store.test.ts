import type { LiveEntry, LiveStore } from '../src/runtime/live-value'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { afterAll, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { live, liveSlot, liveStoreReady, setLiveStore, watchSlot } from '../src/runtime/live-value'
import { setupStore } from '../src/server/app-store'
import { sqliteLive } from '../src/server/sqlite-live'

// The build gives a declaration its id and name; a test passes them itself.
const declare = live as unknown as (initial: number, id: string, name: string) => { (): number, set: (next: number) => void }
// A value declared with a lifetime: the options come before the id and name the build adds.
const declareTtl = live as unknown as (initial: number, id: string, name: string, options: { ttl: string }) => { (): number, set: (next: number) => void }
const declareKeyedTtl = live as unknown as (initial: (key: string) => number, id: string, name: string, options: { ttl: string }) => { (key: string): number, set: (key: string, next: number) => void, delete: (key: string) => void }
const dirs: string[] = []
const VALUE = resolve('src/runtime/live-value.ts')
const STORE = resolve('src/server/sqlite-live.ts')

// A store is followed only once a value of the app is declared, so every case starts with one.
beforeEach(() => {
  declare(0, 'test:anchor', 'anchor')
})

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

// A process of its own, as a replica or a restart is: declares the values, attaches the store, then runs `body`.
function spawnProcess(path: string, body: string) {
  const script = `import { live, liveSlot, setLiveStore, watchSlot } from ${JSON.stringify(VALUE)}\nimport { sqliteLive } from ${JSON.stringify(STORE)}\nconst count = live(0, 'test:count', 'count')\nconst room = live(id => ({ id, users: 0, since: new Date(0) }), 'test:room', 'room')\nsetLiveStore(sqliteLive(${JSON.stringify(path)}))\n${body}\n`

  return Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' })
}

async function output(child: ReturnType<typeof spawnProcess>): Promise<string> {
  const [text] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return text.trim()
}

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kay-live-'))

  dirs.push(dir)

  return join(dir, 'live.sqlite')
}

describe('live values in a store', () => {
  it('reaches the watchers of another process, and a process starting reads what is held', async () => {
    const path = await storePath()
    const watcher = spawnProcess(path, `const heard = []
watchSlot(liveSlot('test:room'), 'a', () => heard.push(room('a').users))
console.log('ready')
for (let wait = 0; wait < 300 && heard.length < 1; wait++)
  await Bun.sleep(10)
console.log(JSON.stringify({ heard, count: count(), since: room('a').since instanceof Date }))
process.exit(0)`)
    const reader = watcher.stdout.getReader()

    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('ready')

    const setter = spawnProcess(path, 'count.set(n => n + 4)\nroom.set(\'a\', { id: \'a\', users: 1, since: new Date(5) })\nroom.set(\'a\', { id: \'a\', users: 2, since: new Date(5) })')

    await output(setter)

    const rest = new TextDecoder().decode((await reader.read()).value).trim()

    expect(JSON.parse(rest)).toEqual({ heard: [2], count: 4, since: true })

    const restarted = spawnProcess(path, 'console.log(JSON.stringify([count(), room(\'a\').users, room(\'a\').since.getTime(), room(\'b\').users]))\nroom.delete(\'a\')')

    expect(JSON.parse(await output(restarted))).toEqual([4, 2, 5, 0])

    const after = spawnProcess(path, 'console.log(JSON.stringify([count(), room(\'a\').users]))')

    expect(JSON.parse(await output(after))).toEqual([4, 0])
  })

  it('keeps values in memory with no store, and its own ids out of the store', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const memory = declare(0, 'test:memory', 'memory')
    const own = declare(0, 'kay:test-own', 'own')

    memory.set(1)
    expect(store.entries()).toEqual([])

    setLiveStore(store)
    memory.set(2)
    own.set(3)
    expect(store.entries()).toEqual([['test:memory', '', '[2]']])
    expect(liveSlot('kay:test-own')).toBeDefined()
    watchSlot(liveSlot('test:memory')!, '', () => undefined)
    setLiveStore(undefined)
    memory.set(5)
    expect(store.entries()).toEqual([['test:memory', '', '[2]']])
  })

  it('gives a value declared after the store attached what it holds', async () => {
    const path = await storePath()
    const store = sqliteLive(path)

    void store.set('test:late', '', '[7]')
    setLiveStore(store)

    const late = declare(0, 'test:late', 'late')

    expect(late()).toBe(7)
    setLiveStore(undefined)
  })

  it('reads and writes the store the app setup names, and none after it is removed', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const wired = declare(0, 'test:wired', 'wired')

    setupStore({ live: store })
    wired.set(9)
    expect(store.entries()).toEqual([['test:wired', '', '[9]']])
    setupStore(undefined)
    wired.set(10)
    expect(store.entries()).toEqual([['test:wired', '', '[9]']])
  })

  it('waits for a store that reads late, keeps a value set meanwhile, and writes behind without rejecting', async () => {
    const written: string[] = []
    const late = declare(0, 'test:late-read', 'lateRead')
    const kept = declare(0, 'test:late-kept', 'lateKept')
    const store: LiveStore = {
      entries: async () => {
        await Bun.sleep(30)

        return [['test:late-read', '', '[3]'], ['test:late-kept', '', '[3]']]
      },
      set: async (id, _key, text) => {
        written.push(`${id}=${text}`)

        throw new Error('the database is gone')
      },
      delete: async () => Promise.resolve(),
      subscribe: () => undefined,
    }

    setupStore({ live: store })
    kept.set(5)
    expect(late()).toBe(0)
    await liveStoreReady()
    expect(late()).toBe(3)
    expect(kept()).toBe(5)
    expect(written).toEqual(['test:late-kept=[5]'])
    await Bun.sleep(10)
    setupStore(undefined)
  })

  it('leaves a value as it was when a synchronous store refuses the write, and fails the setup of one that cannot be read', async () => {
    const refusing = declare(0, 'test:refused', 'refused')
    const store: LiveStore = { entries: () => [], set: () => {
      throw new Error('closed')
    }, delete: () => undefined, subscribe: () => undefined }

    setupStore({ live: store })
    expect(() => refusing.set(5)).toThrow('closed')
    expect(refusing()).toBe(0)
    setupStore(undefined)

    setupStore({ live: { ...store, entries: async () => Promise.reject(new Error('database down')) } })
    await expect(liveStoreReady()).rejects.toThrow('database down')
    setupStore(undefined)
  })

  it('tells the watchers of another process a key was deleted, and a value never declared there stays held', async () => {
    const path = await storePath()
    const setter = spawnProcess(path, 'room.set(\'z\', { id: \'z\', users: 3, since: new Date(0) })\nconsole.log(\'set\')\nawait Bun.sleep(1500)\nroom.delete(\'z\')\nroom.delete(\'never\')')

    const reader = setter.stdout.getReader()

    await reader.read()

    const watcher = spawnProcess(path, `const seen = [room('z').users]
watchSlot(liveSlot('test:room'), 'z', () => seen.push(room('z').users))
for (let wait = 0; wait < 300 && seen.length < 2; wait++)
  await Bun.sleep(10)
console.log(JSON.stringify(seen))
process.exit(0)`)

    expect(JSON.parse(await output(watcher))).toEqual([3, 0])
    await setter.exited
  })

  it('goes on to the next event when a watcher throws, and tells the store it replaced to stop', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const calls: string[] = []
    let stopped = 0

    setLiveStore(store)

    const thrown = declare(0, 'test:thrown', 'thrown')
    const other = declare(0, 'test:other', 'other')

    watchSlot(liveSlot('test:thrown')!, '', () => {
      calls.push('thrown')

      throw new Error('a watcher failing')
    })
    watchSlot(liveSlot('test:other')!, '', () => calls.push('other'))

    await output(spawnProcess(path, 'live(0, \'test:thrown\', \'thrown\').set(1)\nlive(0, \'test:other\', \'other\').set(2)'))

    for (let wait = 0; wait < 300 && calls.length < 2; wait++)
      await Bun.sleep(10)

    expect(calls).toEqual(['thrown', 'other'])
    expect([thrown(), other()]).toEqual([1, 2])
    setLiveStore({ entries: () => [], set: () => undefined, delete: () => undefined, subscribe: () => undefined, stop: () => {
      stopped++
    } })
    setLiveStore(undefined)
    expect(stopped).toBe(1)
  })

  it('keeps a bounded number of rows for values nobody declared', () => {
    let hear: ((id: string, key: string, text: string | undefined) => void) | undefined

    setLiveStore({ entries: () => [], set: () => undefined, delete: () => undefined, subscribe: (listener) => {
      hear = listener
    } })
    hear!('test:evicted', '', '[1]')

    for (let row = 0; row < 10_000; row++)
      hear!('test:bulk', String(row), '[0]')

    hear!('test:recent', '', '[2]')

    expect(declare(0, 'test:evicted', 'evicted')()).toBe(0)
    expect(declare(0, 'test:recent', 'recent')()).toBe(2)
    // Declared, so the rows heard leave the process-global count the next test meets.
    declare(0, 'test:bulk', 'bulk')
    setLiveStore(undefined)
  })

  it('stops counting the rows of an id the store holds when it is attached again', () => {
    const keyed = live as unknown as (initial: (key: string) => number, id: string, name: string) => (key: string) => number
    let hear: ((id: string, key: string, text: string | undefined) => void) | undefined
    const first = { entries: () => [], set: () => undefined, delete: () => undefined, subscribe: (listener: typeof hear) => {
      hear = listener
    } }

    setLiveStore(first)

    for (let row = 0; row < 6_000; row++)
      hear!('test:again', String(row), '[1]')

    // A hot reload attaches a store again, which now holds the rows the id was heard with.
    const second = { entries: () => [['test:again', '0', '[1]']] as [string, string, string][], set: () => undefined, delete: () => undefined, subscribe: (listener: typeof hear) => {
      hear = listener
    } }

    setLiveStore(second)

    const surviving = (id: string) => keyed(() => 0, id, id)

    for (let row = 0; row < 9_000; row++)
      hear!('test:crowd', String(row), '[2]')

    hear!('test:after', '0', '[3]')

    expect(surviving('test:crowd')('0')).toBe(2)
    expect(surviving('test:after')('0')).toBe(3)
    // Declared, so no later test meets them among the undeclared.
    expect(surviving('test:again')('0')).toBe(1)
    setLiveStore(undefined)
  })

  it('drops the id heard from longest ago, not the first one inserted', () => {
    const keyed = live as unknown as (initial: (key: string) => number, id: string, name: string) => (key: string) => number
    let hear: ((id: string, key: string, text: string | undefined) => void) | undefined

    setLiveStore({ entries: () => [], set: () => undefined, delete: () => undefined, subscribe: (listener) => {
      hear = listener
    } })
    hear!('test:old', '0', '[1]')

    for (let row = 0; row < 9_999; row++)
      hear!('test:quiet', String(row), '[2]')

    hear!('test:old', '1', '[1]')
    hear!('test:new', '0', '[3]')

    const old = keyed(() => 0, 'test:old', 'old')

    expect([old('0'), old('1')]).toEqual([1, 1])
    expect(keyed(() => 0, 'test:quiet', 'quiet')('0')).toBe(0)
    expect(keyed(() => 0, 'test:new', 'new')('0')).toBe(3)
    setLiveStore(undefined)
  })

  it('ends the poll of a real sqliteLive it replaces', async () => {
    const store = sqliteLive(await storePath())

    declare(0, 'test:poll-end', 'pollEnd')

    const started = spyOn(globalThis, 'setTimeout')
    const cleared = spyOn(globalThis, 'clearTimeout')

    try {
      setLiveStore(store)

      const polls = started.mock.results.map(result => result.value)

      expect(polls.length).toBeGreaterThan(0)
      setLiveStore(undefined)

      for (const poll of polls)
        expect(cleared.mock.calls.map(call => call[0] as unknown)).toContain(poll)
    }
    finally {
      started.mockRestore()
      cleared.mockRestore()
      setLiveStore(undefined)
    }
  })

  it('keeps every row the store held at the start, however many', () => {
    const rows: [string, string, string][] = Array.from({ length: 10_500 }, (_, row) => ['test:many', String(row), '[3]'])

    setLiveStore({ entries: () => rows, set: () => undefined, delete: () => undefined, subscribe: () => undefined })

    const many = (live as unknown as (initial: (key: string) => number, id: string, name: string) => (key: string) => number)(() => 0, 'test:many', 'many')

    expect(many('0')).toBe(3)
    expect(many('10499')).toBe(3)
    setLiveStore(undefined)
  })

  it('writes to the store from a second copy of the module', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const tag = 'second'
    const copy = await import(`../src/runtime/live-value.ts?${tag}`) as { live: typeof declare }

    setLiveStore(store)
    expect(copy.live).not.toBe(live as unknown)
    copy.live(0, 'test:copy', 'copy').set(4)
    expect(store.entries()).toEqual([['test:copy', '', '[4]']])
    setLiveStore(undefined)
  })
})

// A sleep overshoots on a loaded runner, so a value is only expected alive while the clock has not passed its end after the read.
function expectAliveBefore<T>(endsAt: number, read: () => T, expected: T): void {
  const value = read()

  if (Date.now() < endsAt)
    expect(value).toEqual(expected)
}

describe('a live value with a lifetime', () => {
  it('goes back to what the declaration gives once its lifetime passed, and tells the watchers', async () => {
    const mortal = declareTtl(0, 'test:ttl-memory', 'ttlMemory', { ttl: '300ms' })
    const heard: number[] = []

    watchSlot(liveSlot('test:ttl-memory')!, '', () => heard.push(mortal()))
    const endsAt = Date.now() + 300

    mortal.set(5)
    expect(mortal()).toBe(5)
    await Bun.sleep(100)
    expectAliveBefore(endsAt, mortal, 5)
    await Bun.sleep(400)
    expect(mortal()).toBe(0)
    expect(heard).toEqual([5, 0])
  })

  it('is kept for the lifetime since its last write, even a write of the value it holds', async () => {
    const mortal = declareTtl(0, 'test:ttl-renewed', 'ttlRenewed', { ttl: '300ms' })

    mortal.set(5)
    await Bun.sleep(200)

    const endsAt = Date.now() + 300

    mortal.set(5)
    await Bun.sleep(200)
    expectAliveBefore(endsAt, mortal, 5)
    await Bun.sleep(300)
    expect(mortal()).toBe(0)
  })

  it('expires each key on its own', async () => {
    const room = declareKeyedTtl(() => 0, 'test:ttl-keyed', 'ttlKeyed', { ttl: '300ms' })

    const aEnds = Date.now() + 300

    room.set('a', 1)
    await Bun.sleep(200)

    const bEnds = Date.now() + 300

    room.set('b', 2)
    await Bun.sleep(150)

    const [a, b] = [room('a'), room('b')]
    const read = Date.now()

    if (read >= aEnds && read < bEnds)
      expect([a, b]).toEqual([0, 2])

    await Bun.sleep(250)
    expect([room('a'), room('b')]).toEqual([0, 0])
  })

  it('drops 20,000 keys ending a few milliseconds apart without scanning the ones still to come', async () => {
    const room = declareKeyedTtl(() => 0, 'test:ttl-many', 'ttlMany', { ttl: '5s' })
    const expires = liveSlot('test:ttl-many')!.expires
    let yielded = 0

    for (const method of [Symbol.iterator, 'values', 'entries'] as const) {
      const original = expires[method].bind(expires) as () => Iterator<unknown>

      ;(expires as unknown as Record<string | symbol, unknown>)[method] = function* () {
        const iterator = original()

        for (let step = iterator.next(); step.done !== true; step = iterator.next()) {
          yielded++
          yield step.value
        }
      }
    }

    for (let key = 0; key < 20_000; key++) {
      room.set(String(key), 1)

      // Spreads the ends over a few timer passes.
      if (key % 2000 === 1999)
        await Bun.sleep(5)
    }

    expect(expires.size).toBe(20_000)
    await Bun.sleep(5500)
    expect(expires.size).toBe(0)
    expect(room('0') + room('19999')).toBe(0)
    // Each key is read once as it is dropped, and a pass stops at the first key still to come.
    expect(yielded).toBeLessThan(20_000 + 300)
  })

  it('does not drop a key a watcher renewed while told of another that ended with it', async () => {
    let hear: ((id: string, key: string, text: string | undefined, expiresAt?: number) => void) | undefined

    setLiveStore({ entries: () => [], set: () => undefined, delete: () => undefined, subscribe: (listener) => {
      hear = listener
    } })

    const room = declareKeyedTtl(() => 0, 'test:ttl-renewed-by-watcher', 'ttlRenewedByWatcher', { ttl: '60s' })
    const ends = Date.now() + 100

    hear!('test:ttl-renewed-by-watcher', 'a', '[1]', ends)
    hear!('test:ttl-renewed-by-watcher', 'b', '[2]', ends)
    watchSlot(liveSlot('test:ttl-renewed-by-watcher')!, 'a', () => room.set('b', 7))
    await Bun.sleep(250)
    expect([room('a'), room('b')]).toEqual([0, 7])
    setLiveStore(undefined)
  })

  it('drops an end heard out of order on time', async () => {
    let hear: ((id: string, key: string, text: string | undefined, expiresAt?: number) => void) | undefined

    setLiveStore({ entries: () => [], set: () => undefined, delete: () => undefined, subscribe: (listener) => {
      hear = listener
    } })

    const room = declareKeyedTtl(() => 0, 'test:ttl-unordered', 'ttlUnordered', { ttl: '60s' })
    const now = Date.now()

    hear!('test:ttl-unordered', 'late', '[1]', now + 400)
    hear!('test:ttl-unordered', 'soon', '[2]', now + 100)
    hear!('test:ttl-unordered', 'middle', '[3]', now + 250)

    // The time each key is first seen gone must not precede its end and must keep the order of the ends, whatever the sleeps overshoot by.
    const ends = { soon: now + 100, middle: now + 250, late: now + 400 }
    const gone: Record<string, number> = {}
    const deadline = now + 5000

    while (Object.keys(gone).length < 3 && Date.now() < deadline) {
      const values = { soon: room('soon'), middle: room('middle'), late: room('late') }
      const read = Date.now()

      for (const [key, value] of Object.entries(values)) {
        if (value === 0)
          gone[key] ??= read
      }

      await Bun.sleep(10)
    }

    expect(Object.keys(gone)).toEqual(['soon', 'middle', 'late'])
    expect(gone.soon!).toBeLessThanOrEqual(gone.middle!)
    expect(gone.middle!).toBeLessThanOrEqual(gone.late!)
    expect(gone.soon!).toBeGreaterThanOrEqual(ends.soon)
    expect(gone.middle!).toBeGreaterThanOrEqual(ends.middle)
    expect(gone.late!).toBeGreaterThanOrEqual(ends.late)
    setLiveStore(undefined)
  })

  it('gives a value stored before its ttl was declared an end from the declaration, kept in the store', async () => {
    const written: [string, string, number | undefined][] = []
    const store: LiveStore = { entries: () => [['test:ttl-before', '', '[4]'], ['test:ttl-before-declared', '', '[5]']], set: (id, _key, _text, expiresAt) => void written.push([id, _key, expiresAt]), delete: () => undefined, subscribe: () => undefined }
    // Declared after the store was read, then before it.
    const early = declareTtl(0, 'test:ttl-before-declared', 'ttlBeforeDeclared', { ttl: '300ms' })

    setLiveStore(store)

    const late = declareTtl(0, 'test:ttl-before', 'ttlBefore', { ttl: '300ms' })

    expect([early(), late()]).toEqual([5, 4])
    expect(written.map(row => row[0]).sort()).toEqual(['test:ttl-before', 'test:ttl-before-declared'])

    for (const row of written)
      expect(Math.abs((row[2] ?? 0) - Date.now() - 300)).toBeLessThan(200)

    await Bun.sleep(150)
    expectAliveBefore(Math.min(...written.map(row => row[2] ?? 0)), () => [early(), late()], [5, 4])
    await Bun.sleep(300)
    expect([early(), late()]).toEqual([0, 0])
    setLiveStore(undefined)
  })

  it('keeps the end it gave in a SQLite store, so a restart does not renew it', async () => {
    const path = await storePath()
    const old = sqliteLive(path)

    await old.set('test:ttl-kept', '', '[3]')
    old.stop?.()

    const store = sqliteLive(path)

    setLiveStore(store)
    declareTtl(0, 'test:ttl-kept', 'ttlKept', { ttl: '60s' })
    await Bun.sleep(50)
    setLiveStore(undefined)

    const row = (sqliteLive(path).entries() as LiveEntry[]).find(entry => entry[0] === 'test:ttl-kept')

    expect(row?.[3]).toBeGreaterThan(Date.now() + 50_000)
    store.stop?.()
  })

  it('dates the row without writing its text again, so a value set meanwhile survives', async () => {
    const path = await storePath()
    const first = sqliteLive(path)
    const other = sqliteLive(path)

    await first.set('test:ttl-race', '', '[1]')
    setLiveStore(first)

    // Another process sets the row after this one read it and before the end is written.
    const entries = first.entries.bind(first)

    first.entries = async () => {
      const rows = entries()

      void other.set('test:ttl-race', '', '[2]')

      return rows
    }

    setLiveStore(undefined)
    setLiveStore(first)
    declareTtl(0, 'test:ttl-race', 'ttlRace', { ttl: '60s' })

    const row = (sqliteLive(path).entries() as LiveEntry[]).find(entry => entry[0] === 'test:ttl-race')

    expect(row?.[2]).toBe('[2]')
    setLiveStore(undefined)
    first.stop?.()
    other.stop?.()
  })

  it('dates more rows than a queue holds with one statement and one event', async () => {
    const path = await storePath()
    const old = sqliteLive(path)
    const ROWS = 10_500

    await old.set('test:ttl-many', 'seed', '[0]')
    old.stop?.()

    const db = new Database(path)

    db.transaction(() => {
      const insert = db.query('INSERT INTO kay_live (id, key, value) VALUES (?, ?, ?)')

      for (let row = 0; row < ROWS; row++)
        insert.run('test:ttl-many', `k${row}`, '[1]')
    })()

    const before = (db.query('SELECT count(*) AS count FROM kay_live_events').get() as { count: number }).count
    const store = sqliteLive(path)
    // Another process, which hears the ends through the one event.
    const script = `import { sqliteLive } from ${JSON.stringify(STORE)}\nconst store = sqliteLive(${JSON.stringify(path)})\nconst heard = []\nstore.subscribe((id, key, text, expiresAt) => id === 'test:ttl-many' && heard.push(expiresAt))\nconsole.log('ready')\nfor (let wait = 0; wait < 400 && heard.length < ${ROWS + 1}; wait++)\n  await Bun.sleep(25)\nconsole.log(JSON.stringify({ heard: heard.length, dated: heard.every(at => at > Date.now() + 50000) }))\nprocess.exit(0)`
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' })
    const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader()

    expect((await lines.read()).value).toContain('ready')
    setLiveStore(store)
    declareKeyedTtl(() => 0, 'test:ttl-many', 'ttlMany', { ttl: '60s' })

    const heard = JSON.parse(((await lines.read()).value as string).trim()) as { heard: number, dated: boolean }

    await child.exited
    setLiveStore(undefined)

    const after = db.query('SELECT count(*) AS count, count(expires_at) AS dated FROM kay_live WHERE id = ?').get('test:ttl-many') as { count: number, dated: number }

    expect(after.dated).toBe(after.count)
    expect(after.count).toBe(ROWS + 1)
    expect((db.query('SELECT count(*) AS count FROM kay_live_events').get() as { count: number }).count - before).toBe(1)
    expect(heard).toEqual({ heard: ROWS + 1, dated: true })
    db.close()
    store.stop?.()
  })

  it('asks a store offering endAll once for the rows of an id, and keeps them with a local end', async () => {
    const calls: [string, number][] = []
    const store: LiveStore = { entries: () => [['test:ttl-all', 'a', '[1]'], ['test:ttl-all', 'b', '[2]']], set: () => undefined, endAll: (id, ttl) => void calls.push([id, ttl]), delete: () => undefined, subscribe: () => undefined }

    setLiveStore(store)

    const keyed = declareKeyedTtl(() => 0, 'test:ttl-all', 'ttlAll', { ttl: '300ms' })

    expect([keyed('a'), keyed('b')]).toEqual([1, 2])
    await Promise.resolve()
    expect(calls).toEqual([['test:ttl-all', 300]])
    await Bun.sleep(400)
    expect([keyed('a'), keyed('b')]).toEqual([0, 0])
    setLiveStore(undefined)
  })

  it('goes on when endAll throws or rejects', async () => {
    const refused = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      for (const endAll of [(): void => {
        throw new Error('the database is locked')
      }, async (): Promise<void> => Promise.reject(new Error('the database is down'))]) {
        setLiveStore({ entries: () => [['test:ttl-all-refused', 'a', '[1]']], set: () => undefined, endAll, delete: () => undefined, subscribe: () => undefined })

        const keyed = declareKeyedTtl(() => 0, 'test:ttl-all-refused', 'ttlAllRefused', { ttl: '60s' })

        expect(keyed('a')).toBe(1)
        await Bun.sleep(10)
      }
    }
    finally {
      refused.mockRestore()
      setLiveStore(undefined)
    }
  })

  it('goes on when the store refuses to keep the end', () => {
    setLiveStore({ entries: () => [['test:ttl-refused', '', '[3]']], set: () => {
      throw new Error('the database is locked')
    }, delete: () => undefined, subscribe: () => undefined })
    expect(declareTtl(0, 'test:ttl-refused', 'ttlRefused', { ttl: '60s' })()).toBe(3)
    setLiveStore(undefined)
  })

  it('leaves a value without a ttl alone', () => {
    const written: string[] = []

    setLiveStore({ entries: () => [['test:ttl-never', '', '[6]']], set: id => void written.push(id), delete: () => undefined, subscribe: () => undefined })
    expect(declare(0, 'test:ttl-never', 'ttlNever')()).toBe(6)
    expect(written).toEqual([])
    setLiveStore(undefined)
  })

  it('refuses a lifetime that is not a positive duration', () => {
    expect(() => declareTtl(0, 'test:ttl-bad', 'ttlBad', { ttl: '0s' })).toThrow(/ttl/)
    expect(() => declareTtl(0, 'test:ttl-bad', 'ttlBad', { ttl: 'soon' })).toThrow(/ttl/)
  })

  it('is written to a store with the time it ends, and is not read back once past', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const mortal = declareTtl(0, 'test:ttl-sqlite', 'ttlSqlite', { ttl: '100ms' })
    const forever = declare(0, 'test:ttl-none', 'ttlNone')
    const before = Date.now()

    setLiveStore(store)
    mortal.set(3)
    forever.set(4)

    const rows = store.entries() as [string, string, string, number?][]

    expect(rows.find(row => row[0] === 'test:ttl-none')).toEqual(['test:ttl-none', '', '[4]'])

    const held = rows.find(row => row[0] === 'test:ttl-sqlite')

    expect(held?.slice(0, 3)).toEqual(['test:ttl-sqlite', '', '[3]'])
    expect(held?.[3]).toBeGreaterThanOrEqual(before + 100)
    expect(held?.[3]).toBeLessThanOrEqual(Date.now() + 100)
    await Bun.sleep(150)
    expect((store.entries() as LiveEntry[]).map(row => row[0])).toEqual(['test:ttl-none'])
    setLiveStore(undefined)
  })

  it('is dropped from the file by a write an hour after it expired', async () => {
    const path = await storePath()
    const store = sqliteLive(path)

    await store.set('test:ttl-swept', '', '[1]', Date.now() + 10)
    await Bun.sleep(30)

    const count = () => new Database(path, { readonly: true }).query<{ n: number }, []>('SELECT count(*) AS n FROM kay_live').get()!.n

    expect(count()).toBe(1)
    setSystemTime(new Date(Date.now() + 2 * 3_600_000))

    try {
      await store.set('test:ttl-other', '', '[2]')
    }
    finally {
      setSystemTime()
    }

    expect(count()).toBe(1)
  })

  it('reaches another process with the time it ends', async () => {
    const path = await storePath()
    const second = sqliteLive(path)
    const heard: unknown[][] = []

    await second.set('test:ttl-heard', '', '[1]', Date.now() + 60_000)
    void second.entries()
    second.subscribe((...args) => heard.push(args))

    // Another process of the file: it shares this one's id inside a test, so its write is made by hand.
    const other = new Database(path)

    other.run('INSERT OR REPLACE INTO kay_live (id, key, value, expires_at) VALUES (\'test:ttl-heard\', \'\', \'[2]\', 4000000000000)')
    other.run('INSERT INTO kay_live_events (origin, id, key, at) VALUES (\'another\', \'test:ttl-heard\', \'\', ?)', [Date.now()])
    other.close()

    for (let wait = 0; wait < 300 && heard.length < 1; wait++)
      await Bun.sleep(10)

    expect(heard).toEqual([['test:ttl-heard', '', '[2]', 4_000_000_000_000]])
    second.stop?.()
  })

  it('expires from the time another process wrote it, and a value past it when read is left out', async () => {
    const path = await storePath()
    const store = sqliteLive(path)

    await store.set('test:ttl-late', '', '[7]', Date.now() + 1500)
    await store.set('test:ttl-gone', '', '[8]', Date.now() - 1)
    setLiveStore(store)

    const late = declareTtl(0, 'test:ttl-late', 'ttlLate', { ttl: '60s' })
    const gone = declareTtl(0, 'test:ttl-gone', 'ttlGone', { ttl: '60s' })

    expect(late()).toBe(7)
    expect(gone()).toBe(0)
    await Bun.sleep(1600)
    expect(late()).toBe(0)
    setLiveStore(undefined)
  })

  it('ends a value heard with its end, and treats a row heard past it as deleted', async () => {
    let hear: ((id: string, key: string, text: string | undefined, expiresAt?: number) => void) | undefined

    setLiveStore({ entries: () => [], set: () => undefined, delete: () => undefined, subscribe: (listener) => {
      hear = listener
    } })

    const heard = declareTtl(0, 'test:ttl-subscribed', 'ttlSubscribed', { ttl: '60s' })

    hear!('test:ttl-subscribed', '', '[4]', Date.now() + 100)
    expect(heard()).toBe(4)
    await Bun.sleep(250)
    expect(heard()).toBe(0)
    hear!('test:ttl-subscribed', '', '[6]', Date.now() + 60_000)
    expect(heard()).toBe(6)
    hear!('test:ttl-subscribed', '', '[7]', Date.now() - 1)
    expect(heard()).toBe(0)
    setLiveStore(undefined)
  })

  it('opens a file made before the option existed, and keeps its rows', async () => {
    const path = await storePath()
    const old = new Database(path)

    old.run('CREATE TABLE kay_live (id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (id, key))')
    old.run('INSERT INTO kay_live VALUES (\'test:ttl-old\', \'\', \'[9]\')')
    old.close()

    const store = sqliteLive(path)

    expect(store.entries()).toEqual([['test:ttl-old', '', '[9]']])
    await store.set('test:ttl-old', '', '[10]', Date.now() + 60_000)
    expect((store.entries() as LiveEntry[]).map(row => row[2])).toEqual(['[10]'])
    store.stop?.()
  })
})

// Checked by `kay check`, never run: the options type refuses what the runtime refuses.
export function liveOptionTypes(): void {
  live(0, { ttl: '1h' })
  live((id: string) => id.length, { ttl: '5m' })
  // @ts-expect-error a lifetime is a duration with its unit
  live(0, { ttl: 'soon' })
  // @ts-expect-error a lifetime is positive
  live(0, { ttl: '0s' })
}
