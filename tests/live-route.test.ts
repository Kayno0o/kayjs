import type { LivePage, LiveRequest } from '../src/runtime/live-value'
import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { chromium } from 'playwright-core'
import { invalidate } from '../src/runtime/cache'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { decodeServerValue } from '../src/runtime/wire'
import { browserPath, testSite } from '../src/test'
import { db } from './fixtures/live-cache/src/data'
import { Feed, JSON_POST } from './live-helpers'

const ROOT = 'tests/fixtures/live-cache'
const HEADER = 'x-kay-live'

// The page of proof a route answered with, read as the browser reads it.
function proofOf(response: Response): LivePage | undefined {
  const text = response.headers.get(HEADER)

  return text === null ? undefined : decodeServerValue(decodeURIComponent(text)) as LivePage
}

function requestOf(page: LivePage, watch: string[]): LiveRequest {
  return { proofs: [{ keys: page.values.map(([id, key]) => [id, key] as [string, string]), at: page.at, sig: page.sig }], watch: watch.map(key => [CACHE_LIVE_ID, key] as [string, string]) }
}

describe('a route a resource reads, following cached values', () => {
  let site: TestSite

  const ask = async (path: string, init?: { method?: string, headers?: Record<string, string> }) => site.fetch(path, { headers: { accept: 'application/json' }, ...init })
  const stream = async (request: LiveRequest) => site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify(request) })

  beforeAll(async () => {
    site = await testSite({ root: ROOT, locals: request => ({ user: request.headers.get('x-user') ?? undefined }) })
  })

  afterAll(async () => site.close())

  it('answers with the proof of the live keys its handler read, with the time it read each', async () => {
    const before = Date.now()
    const response = await ask('/api/orders')
    const page = proofOf(response)!

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ orders: db.orders })
    expect(page.values.map(([id, key]) => [id, key])).toEqual([[CACHE_LIVE_ID, 'orders']])
    expect(page.values[0]![2]).toBeGreaterThanOrEqual(before)
    expect(page.values[0]![2]).toBeLessThanOrEqual(Date.now())
  })

  it('names a key once however often the handler reads it, and writes nothing for a route reading none', async () => {
    expect(proofOf(await ask('/api/orders/twice'))!.values.map(([, key]) => key)).toEqual(['orders'])
    expect((await ask('/api/orders/plain')).headers.has(HEADER)).toBe(false)
    expect((await ask('/api/orders/none')).headers.has(HEADER)).toBe(false)
  })

  it('answers a 2xx status() and a Response of its own with it too', async () => {
    const created = await ask('/api/orders/created')
    const own = await ask('/api/orders/response')

    expect(created.status).toBe(201)
    expect(proofOf(created)!.values.map(([, key]) => key)).toEqual(['orders'])
    expect(proofOf(own)!.values.map(([, key]) => key)).toEqual(['orders'])
    // A second answer is its own proof, not a copy of the first.
    expect(proofOf(await ask('/api/orders/response'))!.at).toBeGreaterThanOrEqual(proofOf(own)!.at)
  })

  it('answers only a GET with it', async () => {
    const response = await ask('/api/orders', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(response.headers.has(HEADER)).toBe(false)
  })

  it('writes nothing on a refusal or a failure of the route', async () => {
    const missing = await ask('/api/orders/missing')
    const thrown = await ask('/api/orders/throws')
    const guarded = await ask('/api/guarded')
    const signedIn = await ask('/api/guarded', { headers: { 'accept': 'application/json', 'x-user': 'ada' } })

    expect(missing.status).toBe(404)
    expect(missing.headers.has(HEADER)).toBe(false)
    expect(thrown.status).toBe(500)
    expect(thrown.headers.has(HEADER)).toBe(false)
    expect(guarded.status).toBe(401)
    expect(guarded.headers.has(HEADER)).toBe(false)
    expect(signedIn.status).toBe(200)
    expect(proofOf(signedIn)!.values.map(([, key]) => key)).toEqual(['secret'])
  })

  it('writes nothing on a refusal answered by name, a number set on the context, or a Response of its own', async () => {
    for (const path of ['/api/orders/named-set', '/api/orders/named-status', '/api/orders/set-number', '/api/orders/own-error'])
      expect((await ask(path)).headers.has(HEADER)).toBe(false)

    expect((await ask('/api/orders/named-set')).status).toBe(400)
    expect((await ask('/api/orders/named-status')).status).toBe(404)
    expect((await ask('/api/orders/set-number')).status).toBe(418)
  })

  it('answers a 2xx status set by name with the proof', async () => {
    const response = await ask('/api/orders/named-ok')

    expect(response.status).toBe(201)
    expect(proofOf(response)!.values.map(([, key]) => key)).toEqual(['orders'])
  })

  it('answers a redirect, whose proof a following fetch never sees, as the target gives its own', async () => {
    const response = await ask('/api/orders/redirect')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/api/orders')
  })

  it('gives a visitor the proof of what the handler read for them only', async () => {
    const anonymous = await ask('/api/orders/mine')
    const member = await ask('/api/orders/mine', { headers: { 'accept': 'application/json', 'x-user': 'ada' } })

    expect(anonymous.headers.has(HEADER)).toBe(false)
    expect(proofOf(member)!.values.map(([, key]) => key)).toEqual(['secret'])
    // The proof of the other route does not cover that key.
    expect((await stream(requestOf(proofOf(await ask('/api/orders'))!, ['secret']))).status).toBe(403)
  })

  it('has a stream send the time of each invalidation to the proof it was given, 0 first', async () => {
    const page = proofOf(await ask('/api/orders'))!
    const feed = new Feed(await stream(requestOf(page, ['orders'])))

    expect(await feed.next()).toEqual([[CACHE_LIVE_ID, 'orders', 0]])
    invalidate('orders')

    const [[, , changed]] = await feed.next() as [[string, string, number]]

    expect(changed).toBeGreaterThanOrEqual(page.values[0]![2] as number)
    await feed.close()
  })

  it('refuses a connection asking for a key whose proof is out of date, with another one valid', async () => {
    const page = proofOf(await ask('/api/orders'))!
    const other = proofOf(await ask('/api/orders/mine', { headers: { 'accept': 'application/json', 'x-user': 'ada' } }))!
    const old = { ...requestOf(other, []).proofs[0]!, at: other.at - 2 * 60 * 60 * 1000 }
    const request = requestOf(page, ['orders', 'secret'])

    expect((await stream({ ...request, proofs: [...request.proofs, old] })).status).toBe(403)

    const covered = await stream({ ...request, proofs: [...request.proofs, requestOf(other, []).proofs[0]!] })

    expect(covered.status).toBe(200)
    await covered.body?.cancel()
  })

  it('refuses a forged proof, a key it does not cover and a changed one', async () => {
    const page = proofOf(await ask('/api/orders'))!

    expect((await stream({ ...requestOf(page, ['orders']), proofs: [{ ...requestOf(page, []).proofs[0]!, sig: `${page.sig.slice(1)}x` }] })).status).toBe(403)
    expect((await stream(requestOf(page, ['latest']))).status).toBe(403)
    expect((await stream({ proofs: [{ ...requestOf(page, []).proofs[0]!, keys: [[CACHE_LIVE_ID, 'orders'], [CACHE_LIVE_ID, 'secret']] }], watch: [[CACHE_LIVE_ID, 'secret']] })).status).toBe(403)
  })

  it('fails the handler that reads a key over 256 characters, or more key text than a header holds', async () => {
    const long = await ask('/api/orders/long')
    const many = await ask('/api/orders/many')

    expect(long.status).toBe(500)
    expect(long.headers.has(HEADER)).toBe(false)
    expect(many.status).toBe(500)
    expect(many.headers.has(HEADER)).toBe(false)
  })

  it.each([
    ['a base path and a trailing slash', { base: '/shop', trailingSlash: 'always' as const }, '/api/orders/'],
    ['a base path', { base: '/shop' }, '/api/orders'],
  ])('gets its proof and its stream under %s', async (_, options, path) => {
    const shop = await testSite({ root: ROOT, ...options })

    try {
      const response = await shop.fetch(path, { headers: { accept: 'application/json' } })
      const page = proofOf(response)!
      const feed = new Feed(await shop.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify(requestOf(page, ['orders'])) }))

      expect(page.values.map(([, key]) => key)).toEqual(['orders'])
      expect((await feed.next())[0]![1]).toBe('orders')
      await feed.close()
    }
    finally {
      await shop.close()
    }
  })
})

const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a resource following a route, in a browser', () => {
  let site: TestSite

  const shows = (count: number) => [(expected: number) => document.querySelector('p.answer')?.textContent === `${expected} via ready`, { timeout: 5000 }, count] as const
  const change = (orders: number) => {
    db.orders = orders
    invalidate('orders')
  }

  // How many connections to refuse before the server accepts one.
  let refusals = 0

  beforeAll(async () => {
    const refuse = new Elysia().onRequest(({ request }) => request.method === 'POST' && new URL(request.url).pathname === '/_kay/live' && refusals-- > 0 ? new Response(null, { status: 403 }) : undefined)

    site = await testSite({ root: ROOT, use: [refuse], browser: { path: chrome } })
  }, 120_000)

  afterAll(async () => site?.close())

  it('follows a page and a route together, after the connection was refused once', async () => {
    refusals = 1
    change(20)

    await using page = await site.open('/resource-both')

    await page.waitUntil(...shows(20))
    db.news = ['first', 'fresh']
    invalidate('latest')
    await page.waitUntil(() => document.querySelector('p.latest')?.textContent === 'fresh', { timeout: 8000 })
    change(21)
    await page.waitUntil(...shows(21))
    expect(page.errors).toEqual([])
  }, 30_000)

  it('shows an invalidation in every open tab, without the resource turning to loading', async () => {
    change(1)

    await using first = await site.open('/resource')
    await using second = await site.open('/resource')

    await first.waitUntil(...shows(1))
    await second.waitUntil(...shows(1))
    await first.evaluate(() => {
      const seen: string[] = []

      Object.assign(window, { seen })
      new MutationObserver(() => seen.push(document.querySelector('p.answer')?.textContent ?? '')).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    change(2)
    await first.waitUntil(...shows(2))
    await second.waitUntil(...shows(2))
    change(3)
    await first.waitUntil(...shows(3))
    expect((await first.evaluate(() => (window as unknown as { seen: string[] }).seen)).some(text => text.includes('loading'))).toBe(false)
    expect(first.errors).toEqual([])
    expect(second.errors).toEqual([])
  })

  it('opens no connection and loads no chunk for a resource whose route reads no live key', async () => {
    await using page = await site.open('/resource-plain')

    await page.waitUntil(() => document.querySelector('p.answer')?.textContent?.endsWith('via ready') === true, { timeout: 5000 })
    await Bun.sleep(300)
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('live-cache') || entry.name.includes('/_kay/live')))).toBe(false)
  })
})
