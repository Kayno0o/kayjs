import type { Action, Duration } from '../src/runtime'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { extensionServers } from '../src/config-extensions'
import { cached } from '../src/runtime/cache'
import { memoryJobs, memoryRates, rateLimit } from '../src/server'
import { appStore, setupStore } from '../src/server/app-store'
import { pgData } from '../src/server/pg-data'
import { defaultJobStore } from '../src/server/queue'
import { sqliteData } from '../src/server/sqlite-data'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

function counting() {
  const store = memoryRates()
  const seen: string[] = []

  return { seen, store: { hit: (key: string, window: Duration, weight?: number) => {
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
