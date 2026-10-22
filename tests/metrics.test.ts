import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { cacheReads, countJobRun, jobRuns } from '../src/runtime/counters'
import { liveConnections } from '../src/server/live'
import { statusOf } from '../src/server/log'
import { metricsAllowed } from '../src/server/metrics'
import { dropStore, NOT_FOUND_FILE } from '../src/server/not-found'
import { pages } from './shared-pages'

const PRODUCTION = 'tests/fixtures/production'
const KEY = 'k'.repeat(40)
const TOKEN = 't'.repeat(40)

// The production servers built here count the paths they answered 404 in the working folder's store, which this file leaves as it found it.
const storeKept = existsSync(NOT_FOUND_FILE)
const folderKept = existsSync(dirname(NOT_FOUND_FILE))

type Options = NonNullable<Parameters<typeof pages>[0]>

const stops: (() => Promise<unknown>)[] = []

afterEach(async () => {
  delete process.env.KAY_METRICS_TOKEN
  delete process.env.KAY_PROXY_KEY
  process.env.NODE_ENV = 'test'
  await Promise.all(stops.splice(0).map(async stop => stop()))
})

afterAll(async () => {
  dropStore()

  if (!storeKept)
    await rm(NOT_FOUND_FILE, { force: true })

  // The store opens its folder too, which stays behind empty.
  if (!folderKept)
    await rm(dirname(NOT_FOUND_FILE), { force: true, recursive: true })
})

// A production server on a real socket, so requests carry the address they came from.
async function listening(options: Options, env: Record<string, string> = {}) {
  process.env.NODE_ENV = 'production'
  Object.assign(process.env, env)

  const app = new Elysia().use(await pages({ root: PRODUCTION, prebuilt: false, log: false, ...options })).listen({ port: 0, hostname: '127.0.0.1' })

  stops.push(async () => app.stop())

  return `http://127.0.0.1:${app.server!.port}`
}

async function status(url: string, headers: Record<string, string> = {}) {
  return (await fetch(url, { headers })).status
}

describe('metrics', () => {
  it('is off unless asked for', async () => {
    const url = await listening({})

    expect(await status(`${url}/metrics`)).toBe(404)
  })

  it('serves the Prometheus text to a collector on the machine, counting requests by route and status', async () => {
    const url = await listening({ metrics: true })

    await fetch(`${url}/contact`)
    await fetch(`${url}/contact`)
    await fetch(`${url}/shop/a`)
    await fetch(`${url}/shop/b`)
    await fetch(`${url}/missing-one`)
    await fetch(`${url}/missing-two`)

    const response = await fetch(`${url}/metrics`)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(text).toMatch(/^# TYPE kay_http_requests_total counter$/m)
    expect(text).toMatch(/^kay_http_requests_total\{method="GET",route="\/contact",status="200"\} 2$/m)
    // A page with a parameter is one series, named by its pattern.
    expect(text).toMatch(/^kay_http_requests_total\{method="GET",route="\/shop\/[^"]*",status="200"\} 2$/m)
    expect(text).not.toContain('/shop/a')
    // A path nothing serves is one series however many are asked, so a scan cannot grow the page.
    expect(text).not.toContain('missing-one')
    expect(text).toMatch(/^kay_http_request_duration_seconds_count\{method="GET",route="\/contact"\} 2$/m)
    expect(text).toMatch(/^kay_http_request_duration_seconds_bucket\{method="GET",route="\/contact",le="\+Inf"\} 2$/m)
    expect(text).toMatch(/^kay_cache_reads_total\{result="hit"\} \d+$/m)
    expect(text).toMatch(/^kay_live_connections \d+$/m)
    expect(text).toMatch(/^# TYPE kay_job_runs_total counter$/m)
    // The scrape and the health probe are no traffic of the site.
    expect(text).not.toContain('route="/metrics"')
    expect(text).not.toContain('/_kay/health')
  })

  it('refuses a request without a socket, or that a proxy forwarded', async () => {
    const url = await listening({ metrics: true })

    for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip'])
      expect(await status(`${url}/metrics`, { [header]: '203.0.113.9' })).toBe(403)

    process.env.NODE_ENV = 'production'

    const app = await pages({ root: PRODUCTION, prebuilt: false, metrics: true })

    expect((await app.handle(new Request('http://localhost/metrics'))).status).toBe(403)
  })

  it('refuses the header a configured proxy sets', async () => {
    const url = await listening({ metrics: true, proxy: { header: 'x-client' } })

    expect(await status(`${url}/metrics`, { 'x-client': '203.0.113.9' })).toBe(403)
    expect(await status(`${url}/metrics`)).toBe(200)
  })

  it('guards the path with a trailing slash and a query alike, and a HEAD answers no body', async () => {
    const url = await listening({ metrics: true })

    expect(await status(`${url}/metrics/`, { 'x-forwarded-for': '203.0.113.9' })).toBe(403)
    expect(await status(`${url}/metrics?x=1`, { 'x-forwarded-for': '203.0.113.9' })).toBe(403)
    expect(await status(`${url}/metrics/`)).toBe(200)

    const head = await fetch(`${url}/metrics`, { method: 'HEAD' })

    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('answers a request with the token from anywhere, and without it only a direct one on the machine', async () => {
    const url = await listening({ metrics: true }, { KAY_METRICS_TOKEN: TOKEN })

    expect(await status(`${url}/metrics`)).toBe(403)
    expect(await status(`${url}/metrics`, { authorization: 'Bearer wrong' })).toBe(403)
    expect(await status(`${url}/metrics`, { authorization: TOKEN })).toBe(403)
    expect(await status(`${url}/metrics`, { authorization: `bearer ${TOKEN}` })).toBe(200)
    expect(await status(`${url}/metrics`, { authorization: `Bearer ${TOKEN}` })).toBe(200)
    expect(await status(`${url}/metrics`, { 'authorization': `Bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.9' })).toBe(200)
  })

  it('moves to the path asked for and leaves /metrics to the app', async () => {
    const url = await listening({ metrics: { path: '/_internal/stats' } })

    expect(await status(`${url}/_internal/stats`)).toBe(200)
    expect(await status(`${url}/_internal/stats`, { 'x-forwarded-for': '203.0.113.9' })).toBe(403)
    expect(await status(`${url}/metrics`)).toBe(404)
  })

  it('guards the path under a base, with or without the base kept', async () => {
    const url = await listening({ metrics: true, base: '/docs' })

    for (const path of ['/metrics', '/docs/metrics', '/docs/metrics/']) {
      expect(await status(`${url}${path}`)).toBe(200)
      expect(await status(`${url}${path}`, { 'x-forwarded-for': '203.0.113.9' })).toBe(403)
    }
  })

  it('serves nothing under kay dev', async () => {
    const url = await listening({ metrics: true, dev: true })

    expect(await status(`${url}/metrics`)).toBe(404)
  })

  it('lets a collector past the proxy key on the metrics path alone, by its own rule', async () => {
    const url = await listening({ metrics: true, proxy: { key: 'x-upstream-key' } }, { KAY_PROXY_KEY: KEY })

    expect(await status(`${url}/metrics`)).toBe(200)
    expect(await status(`${url}/metrics`, { 'x-forwarded-for': '203.0.113.9' })).toBe(403)
    expect(await status(`${url}/metrics`, { 'x-upstream-key': KEY })).toBe(403)
    expect(await status(`${url}/contact`)).toBe(403)
    expect(await status(`${url}/contact`, { 'x-upstream-key': KEY })).toBe(200)
  })

  it('keeps the proxy key on everything under the metrics path', async () => {
    const url = await listening({ metrics: true, proxy: { key: 'x-upstream-key' } }, { KAY_PROXY_KEY: KEY })

    expect(await status(`${url}/metrics/anything`)).toBe(403)
    expect(await status(`${url}/metrics/`)).toBe(200)
  })

  it('names a path nothing serves unmatched, and counts a string status by its code', async () => {
    const url = await listening({ metrics: true })

    await fetch(`${url}/missing-one`)
    await fetch(`${url}/missing-two`)

    const text = await (await fetch(`${url}/metrics`)).text()

    expect(text).toMatch(/^kay_http_requests_total\{method="GET",route="unmatched",status="404"\} 2$/m)
    expect(statusOf(undefined, { status: 'Not Found' })).toBe(404)
  })

  it.each(['always', 'never'] as const)('serves and guards the path under trailingSlash %s', async (trailingSlash) => {
    const url = await listening({ metrics: true, trailingSlash })

    expect(await status(`${url}/metrics`, { 'x-forwarded-for': '203.0.113.9' })).toBe(403)
    expect(await status(`${url}/metrics/`, { 'x-forwarded-for': '203.0.113.9' })).toBe(403)
    expect((await fetch(`${url}/metrics`, { redirect: 'manual' })).status).toBe(200)
  })

  it('counts no live connection while none is open', async () => {
    const url = await listening({ metrics: true })

    expect(await (await fetch(`${url}/metrics`)).text()).toMatch(/^kay_live_connections 0$/m)
    expect(liveConnections()).toBe(0)
  })

  it('warns at boot of a proxy without a token, and of nothing else', async () => {
    const logged = spyOn(console, 'warn').mockImplementation(() => undefined)
    const warnings = () => logged.mock.calls.flat().filter(line => String(line).includes('metrics is read by any request')).length
    const proxy = { key: 'x-upstream-key' }
    const env = { KAY_PROXY_KEY: KEY }

    try {
      await listening({ metrics: true }, env)
      expect(warnings()).toBe(0)
      // A page at the path keeps it, so kay serves no metrics there.
      await listening({ metrics: { path: '/contact' }, proxy }, env)
      expect(warnings()).toBe(0)
      await listening({ metrics: true, proxy }, { ...env, KAY_METRICS_TOKEN: TOKEN })
      expect(warnings()).toBe(0)
      delete process.env.KAY_METRICS_TOKEN
      await listening({ metrics: true, proxy }, env)
      expect(warnings()).toBe(1)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('decides by the socket address and the marks of a proxy', () => {
    const plain = new Request('http://localhost/metrics')

    expect(metricsAllowed(plain, '127.0.0.1')).toBe(true)
    expect(metricsAllowed(plain, '::1')).toBe(true)
    expect(metricsAllowed(plain, '10.0.0.5')).toBe(true)
    expect(metricsAllowed(plain, '172.18.0.2')).toBe(true)
    expect(metricsAllowed(plain, '203.0.113.9')).toBe(false)
    expect(metricsAllowed(plain, '2001:db8::1')).toBe(false)
    expect(metricsAllowed(plain, undefined)).toBe(false)
    expect(metricsAllowed(new Request('http://localhost/metrics', { headers: { 'x-upstream-key': 'k' } }), '127.0.0.1', { key: 'x-upstream-key' })).toBe(false)
    expect(metricsAllowed(new Request('http://localhost/metrics', { headers: { 'x-forwarded-for': '203.0.113.9' } }), '127.0.0.1')).toBe(false)
  })
})

describe('counters', () => {
  it('counts cached reads and scheduled runs', async () => {
    const { cached } = await import('../src/runtime/cache')
    const before = { ...cacheReads }

    await cached('metrics-test', '1m', () => 1)
    await cached('metrics-test', '1m', () => 1)

    expect(cacheReads.miss - before.miss).toBe(1)
    expect(cacheReads.hit - before.hit).toBe(1)

    countJobRun('metrics-test-schedule', 'ok')
    countJobRun('metrics-test-schedule', 'failed')

    expect(jobRuns.get('metrics-test-schedule')).toEqual({ ok: 1, failed: 1, skipped: 0 })
  })
})
