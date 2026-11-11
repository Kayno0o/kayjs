import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { keptStop, limitedPage, pageLimits, pageOverLimit } from '../src/server/page-limits'
import { Denied } from '../src/server/signals'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

type App = Awaited<ReturnType<typeof pages>>

const FENCE = (settings: string, body = 'h1 Page') => `--- server\nexport const page = ${settings}\n---\n${body}\n`
const LIMIT = (max: number, extra = '') => `{ rateLimit: { max: ${max}, window: '1m'${extra} } }`
const html = { accept: 'text/html' }
const FILES: Record<string, string> = {
  'routes/index.kay': 'h1 Home\n',
  'routes/_error.kay': '--- server\nconst { status, message } = ctx.error\n---\nh1 Error {status}\np {message}\n',
  'routes/search.kay': FENCE(LIMIT(2), 'h1 Search'),
  'routes/keyed.kay': FENCE(LIMIT(1, ', key: ({ request }) => request.headers.get(\'x-user\') ?? undefined'), 'h1 Keyed'),
  'routes/listed.kay': FENCE(`{ rateLimit: [{ max: 5, window: '1m' }, { max: 1, window: '1m' }] }`, 'h1 Listed'),
  'routes/section/_layout.kay': FENCE(LIMIT(1), 'slot'),
  'routes/section/one.kay': 'h1 One\n',
  'routes/section/two.kay': 'h1 Two\n',
  'routes/section/roomy.kay': FENCE(LIMIT(3), 'h1 Roomy'),
  'routes/section/open.kay': FENCE('{ rateLimit: false }', 'h1 Open'),
  'routes/gated/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'authorization\'))\n    deny(401, \'Sign in first\')\n})\n',
  'routes/gated/index.kay': FENCE(LIMIT(2), 'h1 Gated'),
  'routes/shared.txt.ts': 'export const page = { rateLimit: { max: 1, window: \'1m\' } }\n\nexport const GET = () => \'ok\'\n',
  'routes/section/feed.txt.ts': 'export const GET = () => \'feed\'\n',
}

let dir = ''
const apps: Record<string, App> = {}
// Every app gets a client address of its own, as the apps share this process's counters.
const addresses = new Map<App, string>()

beforeAll(async () => {
  dir = await scratchDir('page-rate-limit-')
  await Promise.all(Object.entries(FILES).map(async ([name, text]) => Bun.write(join(dir, name), text)))

  const base = { root: dir, dirs: { routes: 'routes' }, prebuilt: false, security: false, requireGuards: false, observe: { log: false } } as const

  apps.plain = await pages(base)
  apps.mounted = await pages({ ...base, base: '/blog', trailingSlash: 'always' })
  apps.dev = await pages({ ...base, dev: true })

  for (const [index, app] of Object.values(apps).entries())
    addresses.set(app, `10.0.${index}.1`)
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

async function get(app: App, path: string, headers: Record<string, string> = {}) {
  const response = await app.handle(new Request(`http://localhost${path}`, { headers: { ...html, 'x-forwarded-for': addresses.get(app) ?? '10.0.0.1', ...headers } }))

  return { status: response.status, body: await response.text(), headers: response.headers }
}

const paths = { plain: (path: string) => path, mounted: (path: string) => `/blog${path === '/' ? '' : path}/`, dev: (path: string) => path }

for (const name of ['plain', 'mounted', 'dev'] as const) {
  const at = paths[name]

  describe(`a page's rateLimit (${name})`, () => {
    it('answers 429 with Retry-After through _error.kay once past max', async () => {
      const app = apps[name]!
      const seen = [(await get(app, at('/search'))).status, (await get(app, at('/search'))).status]
      const over = await get(app, at('/search'))

      expect(seen).toEqual([200, 200])
      expect(over.status).toBe(429)
      expect(over.body).toContain('Error 429')
      expect(over.body).toContain('Too many requests')
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(over.headers.get('cache-control')).toContain('private')
    })

    it('counts under the key the limit names, each person apart', async () => {
      const app = apps[name]!

      expect((await get(app, at('/keyed'), { 'x-user': `a-${name}` })).status).toBe(200)
      expect((await get(app, at('/keyed'), { 'x-user': `b-${name}` })).status).toBe(200)
      expect((await get(app, at('/keyed'), { 'x-user': `a-${name}` })).status).toBe(429)
    })

    it('tells the longest wait of a list of limits, each counting every request', async () => {
      const app = apps[name]!

      expect((await get(app, at('/listed'))).status).toBe(200)
      expect((await get(app, at('/listed'))).status).toBe(429)
    })

    it('is inherited from a layout, each page counting apart, and overridden by a page', async () => {
      const app = apps[name]!

      expect((await get(app, at('/section/one'))).status).toBe(200)
      expect((await get(app, at('/section/one'))).status).toBe(429)
      expect((await get(app, at('/section/two'))).status).toBe(200)

      for (let count = 0; count < 3; count++)
        expect((await get(app, at('/section/roomy'))).status).toBe(200)

      expect((await get(app, at('/section/roomy'))).status).toBe(429)

      for (let count = 0; count < 5; count++)
        expect((await get(app, at('/section/open'))).status).toBe(200)
    })

    it('counts a request the guards refuse, and answers 429 in place of the refusal once over', async () => {
      const app = apps[name]!
      const refused = [(await get(app, at('/gated'))).status, (await get(app, at('/gated'))).status]

      expect(refused).toEqual([401, 401])
      expect((await get(app, at('/gated'))).status).toBe(429)
      expect((await get(app, at('/gated'), { authorization: 'Bearer x' })).status).toBe(429)
    })

    it('counts after the guards for a request they let through', async () => {
      const app = apps[name]!
      const headers = { 'authorization': 'Bearer y', 'x-forwarded-for': `10.1.0.${name.length}` }

      expect((await get(app, at('/gated'), headers)).status).toBe(200)
    })

    it('shares its counter with an endpoint of the same name only, leaving the other limits alone', async () => {
      const app = apps[name]!

      expect((await get(app, '/shared.txt')).status).toBe(200)
      expect((await get(app, '/shared.txt')).status).toBe(429)
      expect((await get(app, at('/'))).status).toBe(200)
    })
  })
}

describe('the counter of a page', () => {
  it('is kept in the app\'s store.rates, under the route\'s pattern', async () => {
    const keys: string[] = []
    const rates = {
      hit: async (key: string, windowMs: number, weight = 1) => {
        keys.push(key)

        return { count: weight, resetAt: Date.now() + windowMs }
      },
    }
    const app = await pages({ root: dir, dirs: { routes: 'routes' }, prebuilt: false, security: false, requireGuards: false, observe: { log: false }, store: { rates } })

    expect((await get(app, '/search')).status).toBe(200)
    expect(keys.some(key => key.startsWith('/search\n'))).toBe(true)
  })

  it('is made once for a limit and a route, named by the route\'s pattern', () => {
    const modules = [{ page: { rateLimit: [{ max: 2, window: '1m' }, { max: 9, window: '1m' }] } }]
    const first = pageLimits({ pattern: '/a' }, modules)

    expect(first.map(entry => entry.name)).toEqual(['/a', '/a#1'])
    expect(pageLimits({ pattern: '/a' }, modules)).toBe(first)
    expect(pageLimits({ pattern: '/b' }, [...modules]).map(entry => entry.name)).toEqual(['/b', '/b#1'])
    expect(limitedPage([{ page: { rateLimit: [] } }])).toBeUndefined()
    expect(limitedPage(modules)).toBe(true)
    expect(pageLimits({ pattern: '/a' }, [...modules, { page: { rateLimit: false } }])).toEqual([])
  })

  it('counts a request once when its render is run again for the viewer', async () => {
    const modules = [{ page: { rateLimit: { max: 1, window: '1m' } } }]
    const rendering = (request: Request) => ({ ctx: { request, locale: 'en', cookies: {}, locals: {} } as never, headers: new Headers() })
    const request = new Request('http://localhost/again', { headers: { 'x-forwarded-for': '10.8.8.8' } })

    expect(await pageOverLimit({ pattern: '/again' }, modules, rendering(request))).toBeUndefined()
    expect(await pageOverLimit({ pattern: '/again' }, modules, rendering(request))).toBeUndefined()
    expect(await pageOverLimit({ pattern: '/again' }, modules, rendering(new Request('http://localhost/again', { headers: { 'x-forwarded-for': '10.8.8.8' } })))).toBeInstanceOf(Denied)
  })

  it('refuses a limit that cannot count', () => {
    expect(() => pageLimits({ pattern: '/bad' }, [{ page: { rateLimit: { max: 0, window: '1m' } } }])).toThrow('max')
  })
})

describe('a prerendered page with a rateLimit', () => {
  let root = ''

  beforeAll(async () => {
    root = await scratchDir('page-rate-prerendered-')
    await Promise.all(Object.entries({
      'tsconfig.json': '{}',
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ observe: { log: false }, requireGuards: false })\n',
      'src/routes/index.kay': 'h1 Home\n',
      'src/routes/fixed.kay': FENCE(`{ prerender: true, rateLimit: { max: 1, window: '1m' } }`, 'h1 Fixed'),
    }).map(async ([name, text]) => Bun.write(join(root, name), text)))
  }, 60_000)

  afterAll(async () => rm(root, { recursive: true, force: true }))

  it('is written by the build, which warns, and counted by the server serving it', async () => {
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code).toBe(0)
    expect(`${report}${output}`).toContain('sets `rateLimit` and is prerendered')
    expect(await Bun.file(join(outputDir(root), 'manifest.json')).text()).toContain('/fixed')

    const app = await pages({ root, prebuilt: true, security: false, requireGuards: false, observe: { log: false } })
    const ip = { 'x-forwarded-for': '10.7.7.7' }
    const first = await get(app, '/fixed', ip)
    const second = await get(app, '/fixed', ip)

    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toContain('private')
    expect(second.status).toBe(429)
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
  }, 120_000)

  it('is not kept on its own when nothing marks it', () => {
    const limited = [{ page: { rateLimit: { max: 1, window: '1m' } } }]

    const reasons: string[] = []
    const stops = (revalidate: unknown, chain: object[], auto: boolean) => keptStop('a.kay', revalidate, chain, auto, why => reasons.push(why))

    expect(stops(undefined, limited, true)).toBe(true)
    expect(reasons.pop()).toContain('rateLimit')
    expect(stops(undefined, [{}], true)).toBe(false)
    expect(stops('1h', [{}], true)).toBe(true)
    expect(reasons.pop()).toContain('ttl')
    expect(stops(undefined, limited, false)).toBe(false)
    expect(reasons).toEqual([])
  })
})
