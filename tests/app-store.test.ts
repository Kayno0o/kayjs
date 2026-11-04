import type { Action } from '../src/runtime'
import type { AppStore } from '../src/server/app-store'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { extensionServers } from '../src/config-extensions'
import { cached } from '../src/runtime/cache'
import { memoryJobs, memoryRates, rateLimit } from '../src/server'
import { appStore, setupStore, storesOf } from '../src/server/app-store'
import { closeStores } from '../src/server/lifecycle'
import { pgData } from '../src/server/pg-data'
import { defaultJobStore } from '../src/server/queue'
import { sqliteData } from '../src/server/sqlite-data'
import { configuredFiles } from '../src/server/storage'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

function counting() {
  const store = memoryRates()
  const seen: string[] = []

  return { seen, store: { hit: (key: string, window: number, weight?: number) => {
    seen.push(key)

    return store.hit(key, window, weight)
  }, peek: store.peek } }
}

afterEach(() => setupStore(undefined))

describe('the app-wide store', () => {
  it('counts a rate limit naming no store in the app store', async () => {
    const app = counting()

    setupStore({ rates: app.store })
    await rateLimit('app-store-a', { max: 5, window: '1m' }).hit('ada')
    expect(app.seen).toEqual(['app-store-a\nkey:ada'])
  })

  it('prefers the store a limit names over the app store', async () => {
    const app = counting()
    const own = counting()

    setupStore({ rates: app.store })
    await rateLimit('app-store-b', { max: 5, window: '1m', store: own.store }).hit('ada')
    expect(own.seen).toHaveLength(1)
    expect(app.seen).toEqual([])
  })

  it('falls back to memory with no app store, or one without rates', async () => {
    setupStore({ jobs: memoryJobs() })
    const limit = rateLimit('app-store-c', { max: 1, window: '1m' })

    expect(await limit.hit('ada')).toBeUndefined()
    expect(await limit.hit('ada')).toBeGreaterThan(0)
  })

  it('hands queues and locked schedules the app jobs store', () => {
    const jobs = memoryJobs()

    setupStore({ jobs })
    expect(defaultJobStore()).toBe(jobs)
    setupStore(undefined)
    expect(defaultJobStore()).not.toBe(jobs)
  })

  it('names its database for a library keeping tables there, as an absolute url', () => {
    expect(sqliteData('data/app.sqlite').database).toBe(`sqlite://${join(process.cwd(), 'data/app.sqlite')}`)
    expect(sqliteData(':memory:').database).toBeUndefined()
    expect(pgData('postgres://u:p@localhost:5432/app').database).toBe('postgres://u:p@localhost:5432/app')
  })

  it('hands the database of the config store to an extension server', async () => {
    const path = join(await scratchDir('app-store'), 'app.sqlite')
    let given: string | undefined

    setupStore(sqliteData(path))
    await extensionServers([{ name: 'probe', server: (app) => {
      given = app.database

      return new Elysia()
    } }], process.cwd())
    expect(given).toBe(`sqlite://${path}`)
  })

  it('tells an extension server a static export is starting it', async () => {
    const seen: (boolean | undefined)[] = []
    const probe = { name: 'probe', server: (app: { exporting?: boolean | undefined }) => {
      seen.push(app.exporting)

      return new Elysia()
    } }

    await extensionServers([probe], process.cwd(), true)
    await extensionServers([probe], process.cwd())
    expect(seen).toEqual([true, false])
  })

  it('creates no file until sqliteData is used', async () => {
    const path = join(await scratchDir('app-store'), 'app.sqlite')
    const data = sqliteData(path)

    expect(existsSync(path)).toBe(false)
    setupStore(data)
    await rateLimit('app-store-d', { max: 5, window: '1m' }).hit('ada')
    expect(existsSync(path)).toBe(true)
  })

  it('keeps the cached values naming no store in the sqliteData file, and gives sessions a store', async () => {
    const path = join(await scratchDir('app-store'), 'app.sqlite')
    const data = sqliteData(path)

    setupStore(data)
    expect(await cached('app-store-e', '60s', () => 'kept')).toBe('kept')

    using db = new Database(path)

    expect(db.query('SELECT key FROM kay_cache').all()).toEqual([{ key: 'app-store-e' }])
    expect(appStore()?.sessions).toBe(data.sessions)
  })
})

describe('the app store of a test site', () => {
  const routes = 'tests/fixtures/rate-keys/src/routes'
  const locals = (request: Request) => ({ user: request.headers.get('x-user') ?? undefined })

  it.each([
    ['at the root', {}],
    ['behind a base and a trailing slash', { base: '/blog', trailingSlash: 'always' as const }],
  ])('counts an action\'s limit in the store the site is given %s', async (_name, options) => {
    const app = counting()
    const site = await testSite({ routes, islands: false, locals, store: { rates: app.store }, ...options })
    const actions = await import(join(import.meta.dir, 'fixtures/rate-keys/src/routes/index.kay')) as Record<'perUser', Action<Record<never, never>, string>>

    try {
      expect(await site.call(actions.perUser, {}, { headers: { 'x-user': 'ada-store' } })).toBe('ok')
      expect(app.seen.some(key => key.endsWith('key:ada-store'))).toBe(true)
      expect((await site.refusal(actions.perUser, {}, { headers: { 'x-user': 'ada-store' } })).status).toBe(429)
    }
    finally {
      await site.close()
    }
  })
})

describe('the MCP endpoint', () => {
  it('counts its limit in the store the site is given, so replicas share it', async () => {
    const app = counting()
    const site = await testSite({ routes: 'tests/fixtures/mcp/src/routes', api: 'tests/fixtures/mcp/src/api', mcp: { rateLimit: 2 }, islands: false, store: { rates: app.store } })
    const ping = async () => site.fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })

    try {
      expect((await ping()).status).toBe(200)
      expect((await ping()).status).toBe(200)
      expect((await ping()).status).toBe(429)
      expect(app.seen.length).toBe(3)
    }
    finally {
      await site.close()
    }
  })
})

describe('an app store without peek', () => {
  it('refuses a limit counting the posts that went through', async () => {
    const { protectionRefusal } = await import('../src/server/protection')
    const rates = { hit: memoryRates().hit }
    const action = { url: '/_kay/a', protection: { rateLimit: { max: 1, window: '1m', count: 'succeeded' } } }

    setupStore({ rates })
    await expect(protectionRefusal(action as never, new Request('http://localhost/_kay/a', { method: 'POST' }), { body: {}, form: false, server: null })).rejects.toThrow('peek')
  })
})

describe('the store contract', () => {
  it('takes a close or ping answering anything, as a client\'s quit() does', async () => {
    const redis = { quit: async () => 'OK' as const }
    const store: AppStore = { close: async () => redis.quit(), ping: () => 1 }

    setupStore(store)
    await closeStores()
    expect(appStore()).toBe(store)
  })

  it('lists each store once, the store object last', () => {
    const shared = { get: () => undefined, set: () => undefined, delete: () => undefined }
    const files = { write: async () => undefined, read: async () => undefined, delete: async () => false }
    const store = { sessions: shared, files }

    const listed = storesOf(store)

    expect(listed).toHaveLength(3)
    expect(listed[0] === shared && listed[1] === files && listed[2] === store).toBe(true)
    expect(storesOf({ sessions: shared, jobs: undefined })).toHaveLength(2)
    expect(storesOf(undefined)).toEqual([])
  })

  it('closes each store once, the others still closing when one fails', async () => {
    const closed: string[] = []
    const failing = { get: () => undefined, set: () => undefined, delete: () => undefined, close: async () => {
      throw new Error('refused')
    } }
    const files = { write: async () => undefined, read: async () => undefined, delete: async () => false, close: () => {
      closed.push('files')
    } }
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const exitCode = process.exitCode

    try {
      setupStore({ sessions: failing, files, close: () => {
        closed.push('store')
      } })
      await closeStores()
      expect(closed).toEqual(['files', 'store'])
      expect(logged).toHaveBeenCalled()
    }
    finally {
      logged.mockRestore()
      process.exitCode = exitCode
    }
  })

  it('reads the fileStore of before 1.87 first, then store.files, so no store factory moves files', () => {
    const files = { write: async () => undefined, read: async () => undefined, delete: async () => false }
    const old = { ...files }

    expect(configuredFiles({ store: { files }, fileStore: old })).toBe(old)
    expect(configuredFiles({ store: { files } })).toBe(files)
    expect(configuredFiles({ store: sqliteData(':memory:'), fileStore: old })).toBe(old)
    expect(configuredFiles({ store: sqliteData(':memory:') })).toBeUndefined()
    expect(configuredFiles({})).toBeUndefined()
  })

  it('leaves the files to the app: neither sqliteData nor pgData fills them', () => {
    expect(sqliteData(':memory:')).not.toHaveProperty('files')
    expect(pgData('postgres://localhost/none')).not.toHaveProperty('files')
  })

  it('names each factory after its backend and the key of the store it makes', async () => {
    const server = await import('../src/server')
    const factories = Object.keys(server).filter(name => (/^(?:memory|sqlite|pg|disk|s3)[A-Z]/).test(name))
    // `Data` is a store of every kind, `Store` and `StoreAt` the session stores kept under their old names until 1.90.
    const things = new Set(['Sessions', 'Cache', 'Live', 'Jobs', 'Rates', 'Rooms', 'Vitals', 'Notifications', 'Push', 'Files', 'Kv', 'Data', 'Store', 'StoreAt'])

    expect(factories.filter(name => !things.has(name.replace(/^(?:memory|sqlite|pg|disk|s3)/, '')))).toEqual([])
  })
})

describe('appDatabase', () => {
  it('reads the database of the store: a SQLite file by its path, else a url, and nothing without one', async () => {
    const { appDatabase } = await import('../src/server/app-database')

    expect(appDatabase()).toBeUndefined()
    setupStore({ database: 'sqlite:///srv/app/data/app.sqlite' })
    expect(appDatabase()).toEqual({ kind: 'sqlite', path: '/srv/app/data/app.sqlite' })
    setupStore({ database: 'postgres://u@db/app' })
    expect(appDatabase()).toEqual({ kind: 'pg', source: 'postgres://u@db/app' })
    const sql = {} as import('bun').SQL

    setupStore({ sql })
    expect(appDatabase()).toEqual({ kind: 'pg', source: sql })
    setupStore({ rates: undefined })
    expect(appDatabase()).toBeUndefined()
  })
})
