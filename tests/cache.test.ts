import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { cached, invalidate, sqliteCache } from '../src/runtime/cache.server'
import { pages } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { prerenderPages } from '../src/server/prerender'
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

  it('refuses a computed ttl that is not a positive duration, which kay check cannot see', async () => {
    await expect(cached('x', Number('0'), () => 1)).rejects.toThrow('cached(\'x\')\'s ttl is 0; it takes a positive duration')
    await expect(cached('y', `${Number('-1')}m`, () => 1)).rejects.toThrow('cached(\'y\')\'s ttl is \'-1m\'')
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

  // A process of its own, as a restart or a second server would be: what `cached` gives it, once a background refresh has landed in the store.
  async function inProcess(path: string, edition: number): Promise<{ edition: number, date: boolean }> {
    const script = `import { cached, sqliteCache } from ${JSON.stringify(resolve('src/runtime/cache.server.ts'))}\nconst store = sqliteCache(${JSON.stringify(path)})\nconst value = await cached('reviews', 60, () => ({ edition: ${edition}, at: new Date(0) }), { store })\nfor (let wait = 0; store.get('reviews')!.freshUntil < Date.now() && wait < 200; wait++)\n  await Bun.sleep(10)\nconsole.log(JSON.stringify({ edition: value.edition, date: value.at instanceof Date }))\n`
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

  it('drops a key a store kept before any call named it, as an action does after a restart', async () => {
    const path = await storePath()

    sqliteCache(path).set('reviews', '["old"]', Date.now() + 60_000)

    // Another process's store, opened afresh.
    const store = sqliteCache(path)

    invalidate('reviews')
    expect(store.keys()).toEqual([])
    expect(await cached('reviews', 60, () => 'new', { store })).toBe('new')
  })

  it('drops a key another process sharing the store invalidated, within a second', async () => {
    const path = await storePath()
    const store = sqliteCache(path)

    expect(await cached('shared', 60, () => 'old', { store })).toBe('old')

    const child = Bun.spawn([process.execPath, '-e', `import { invalidate, sqliteCache } from ${JSON.stringify(resolve('src/runtime/cache.server.ts'))}\nsqliteCache(${JSON.stringify(path)})\ninvalidate(key => key === 'shared')\n`], { stderr: 'inherit' })

    expect(await child.exited).toBe(0)

    // Without the broadcast this process would keep its copy for its whole ttl.
    let value = await cached('shared', 60, () => 'new', { store })

    for (let wait = 0; value === 'old' && wait < 40; wait++) {
      await Bun.sleep(50)
      value = await cached('shared', 60, () => 'new', { store })
    }

    expect(value).toBe('new')
  })

  it('marks a prerendered page stale when another process sharing a store invalidated it, rendering it afresh with no one request\'s timings', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const { news } = await import('./fixtures/production/src/news')
    const path = await storePath()

    sqliteCache(path)

    try {
      await prerenderPages(root, { routes: 'tests/fixtures/production/src/routes' }, (await readClient(root))!)
      const app = await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: true, security: false, serverTiming: true })
      const visit = async () => (await app.handle(new Request('http://localhost/news'))).text()

      expect(await visit()).toContain('<h1>Edition 1</h1>')
      news.edition = 7

      const child = Bun.spawn([process.execPath, '-e', `import { sqliteCache } from ${JSON.stringify(resolve('src/runtime/cache.server.ts'))}\nimport { invalidatePage } from ${JSON.stringify(resolve('src/server/revalidate.ts'))}\nsqliteCache(${JSON.stringify(path)})\ninvalidatePage('/news')\n`], { stderr: 'inherit' })

      expect(await child.exited).toBe(0)

      let html = await visit()

      for (let wait = 0; !html.includes('Edition 7') && wait < 40; wait++) {
        await Bun.sleep(50)
        html = await visit()
      }

      expect(html).toContain('<h1>Edition 7</h1>')
      expect((await app.handle(new Request('http://localhost/news'))).headers.get('server-timing')).toBeNull()
    }
    finally {
      news.edition = 1
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('keeps the stale value when a refresh gives one the store cannot hold, and a value whose store failed to write', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const store = sqliteCache(await storePath())
    let value: unknown = 'plain'

    try {
      expect(await cached('feed', 60, () => value, { store })).toBe('plain')
      value = () => 1
      setSystemTime(Date.now() + 61_000)
      expect(await cached('feed', 60, () => value, { store })).toBe('plain')
      await Bun.sleep(0)
      expect(logged.mock.calls[0]![0]).toContain('cannot keep its value in a store')
      expect(store.get('feed')!.text).toBe('["plain"]')

      const failing = { ...store, set: () => {
        throw new Error('SQLITE_FULL')
      } }

      expect(await cached('full', 60, () => 'kept', { store: failing })).toBe('kept')
      expect(await cached('full', 60, () => 'again', { store: failing })).toBe('kept')
      expect(logged).toHaveBeenCalledTimes(2)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('builds for the browser, where kay/cache leaves SQLite out', async () => {
    const dir = await mkdtemp(join(import.meta.dir, '.dom-'))

    dirs.push(dir)
    await Bun.write(join(dir, 'entry.ts'), 'import { cached } from \'kay/cache\'\n\nexport const posts = cached(\'posts\', 60, () => [])\n')

    const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], target: 'browser' })

    expect(build.success).toBe(true)
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
