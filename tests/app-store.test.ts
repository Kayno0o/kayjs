import type { Action } from '../src/runtime'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { memoryJobs, memoryRates, rateLimit } from '../src/server'
import { setupStore } from '../src/server/app-store'
import { defaultJobStore } from '../src/server/queue'
import { sqliteData } from '../src/server/sqlite-data'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

function counting() {
  const store = memoryRates()
  const seen: string[] = []

  return { seen, store: { hit: (key: string, ms: number, weight?: number) => {
    seen.push(key)

    return store.hit(key, ms, weight)
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

  it('creates no file until sqliteData is used', async () => {
    const path = join(await scratchDir('app-store'), 'app.sqlite')
    const data = sqliteData(path)

    expect(existsSync(path)).toBe(false)
    setupStore(data)
    await rateLimit('app-store-d', { max: 5, window: '1m' }).hit('ada')
    expect(existsSync(path)).toBe(true)
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

describe('an app store without peek', () => {
  it('refuses a limit counting the posts that went through', async () => {
    const { protectionRefusal } = await import('../src/server/protection')
    const rates = { hit: memoryRates().hit }
    const action = { url: '/_kay/a', protection: { rateLimit: { max: 1, window: '1m', count: 'succeeded' } } }

    setupStore({ rates })
    await expect(protectionRefusal(action as never, new Request('http://localhost/_kay/a', { method: 'POST' }), {}, false, null)).rejects.toThrow('peek')
  })
})
