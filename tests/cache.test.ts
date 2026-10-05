import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { cached, invalidate, sqliteCache } from '../src/runtime/cache'
import { pages } from '../src/server'
import { feed } from './fixtures/production/src/news'

afterEach(() => {
  setSystemTime()
  invalidate(() => true)
})

describe('cached', () => {
  it('loads once for concurrent misses and keeps the value for its ttl', async () => {
    let loads = 0
    const load = async () => {
      loads++
      await Bun.sleep(5)

      return loads
    }

    expect(await Promise.all([cached('a', 60, load), cached('a', 60, load)])).toEqual([1, 1])
    expect(await cached('a', 60, load)).toBe(1)
    expect(await cached('b', 60, load)).toBe(2)
  })

  it('gives the stale value past its ttl while refreshing it in the background', async () => {
    let edition = 1
    const load = () => edition

    expect(await cached('news', 60, load)).toBe(1)
    edition = 2
    setSystemTime(Date.now() + 61_000)
    expect(await cached('news', 60, load)).toBe(1)
    await Bun.sleep(0)
    expect(await cached('news', 60, load)).toBe(2)
  })

  it('keeps nothing from a first load that throws, and the stale value through a refresh that throws', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    let failing = true
    const load = () => {
      if (failing)
        throw new Error('down')

      return 'up'
    }

    try {
      await expect(cached('feed', 60, load)).rejects.toThrow('down')
      failing = false
      expect(await cached('feed', 60, load)).toBe('up')

      failing = true
      setSystemTime(Date.now() + 61_000)
      expect(await cached('feed', 60, load)).toBe('up')
      await Bun.sleep(0)
      expect(logged).toHaveBeenCalledTimes(1)
      // A minute before the next attempt, whatever the ttl.
      expect(await cached('feed', 60, load)).toBe('up')
      expect(logged).toHaveBeenCalledTimes(1)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('drops a key, or the keys a function matches, a load already running for one never landing', async () => {
    let value = 'old'
    const load = async () => value

    await Promise.all([cached('post:1', 60, load), cached('post:2', 60, load), cached('tags', 60, load)])
    value = 'new'
    invalidate(key => key.startsWith('post:'))
    expect(await cached('post:1', 60, load)).toBe('new')
    expect(await cached('tags', 60, load)).toBe('old')

    const running = cached('tags:slow', 60, async () => {
      await Bun.sleep(5)

      return 'slow'
    })

    invalidate('tags:slow')
    expect(await running).toBe('slow')
    expect(await cached('tags:slow', 60, load)).toBe('new')
  })

  it('refuses a ttl that is not a positive number of seconds', async () => {
    await expect(cached('x', 0, () => 1)).rejects.toThrow('takes a positive ttl in seconds')
  })

  it('shares a value across requests from a page\'s server fence', async () => {
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, security: false }))
    const visit = async () => (await app.handle(new Request('http://localhost/feed'))).text()

    feed.items = ['one']
    expect(await visit()).toContain('<p class="feed">one</p>')
    feed.items = ['two']
    expect(await visit()).toContain('<p class="feed">one</p>')
    invalidate('feed')
    expect(await visit()).toContain('<p class="feed">two</p>')
  })
})

describe('cached with a store', () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
  })

  async function storePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cache-'))

    dirs.push(dir)

    return join(dir, 'cache.sqlite')
  }

  // A process of its own, as a restart or a second server would be: what `cached` gives it, after its background refresh had time to land.
  async function inProcess(path: string, edition: number): Promise<{ edition: number, date: boolean }> {
    const script = `import { cached, sqliteCache } from ${JSON.stringify(resolve('src/runtime/cache.ts'))}\nconst value = await cached('reviews', 60, () => ({ edition: ${edition}, at: new Date(0) }), { store: sqliteCache(${JSON.stringify(path)}) })\nawait Bun.sleep(20)\nconsole.log(JSON.stringify({ edition: value.edition, date: value.at instanceof Date }))\n`
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' })
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited])

    return JSON.parse(output) as { edition: number, date: boolean }
  }

  it('keeps a value across processes, as devalue does a date, and refreshes it past its ttl as in memory', async () => {
    const path = await storePath()

    expect(await inProcess(path, 1)).toEqual({ edition: 1, date: true })
    expect(await inProcess(path, 2)).toEqual({ edition: 1, date: true })

    const db = new Database(path)

    db.run('UPDATE kay_cache SET fresh_until = 0')
    db.close()
    // Stale: given as it is, refreshed in the background for the next process.
    expect(await inProcess(path, 3)).toEqual({ edition: 1, date: true })
    expect(await inProcess(path, 4)).toEqual({ edition: 3, date: true })
  })

  it('drops a key from the store too, and forgets a row it cannot read', async () => {
    const store = sqliteCache(await storePath())
    let value = 'old'
    const load = () => value

    expect(await cached('post:1', 60, load, { store })).toBe('old')
    value = 'new'
    invalidate(key => key.startsWith('post:'))
    expect(store.keys()).toEqual([])
    expect(await cached('post:1', 60, load, { store })).toBe('new')

    store.set('broken', 'not devalue', Date.now() + 60_000)
    expect(await cached('broken', 60, () => 'loaded', { store })).toBe('loaded')
  })

  it('refuses a value the store cannot hold, keeping nothing', async () => {
    const store = sqliteCache(await storePath())

    await expect(cached('handler', 60, () => ({ run: () => 1 }), { store })).rejects.toThrow('kay: cached(\'handler\') cannot keep its value in a store')
    expect(store.keys()).toEqual([])
    expect(await cached('handler', 60, () => 'plain', { store })).toBe('plain')
  })
})
