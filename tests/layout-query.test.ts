import type { Elysia } from 'elysia'
import { join } from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { layoutQueries } from '../src/check/shadow'
import { s } from '../src/runtime'
import { pages } from '../src/server'
import { chainQuery } from '../src/server/query'
import { scratchDir } from './scratch'

const routes = 'tests/fixtures/layout-query/src/routes'
const READ = /<p class="read">([^<]*)<\/p>/
const app = await pages({ routes, prebuilt: false, security: false })
const slashed = await pages({ routes, prebuilt: false, security: false, base: '/repo', trailingSlash: 'always' })
const localized = await pages({ routes, prebuilt: false, security: false, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: 'tests/fixtures/layout-query/src/messages' } })

async function get(server: Elysia, path: string): Promise<{ status: number, html: string }> {
  const response = await server.handle(new Request(`http://localhost${path}`))

  return { status: response.status, html: await response.text() }
}

const read = (html: string) => READ.exec(html)?.[1]

describe('a layout\'s query', () => {
  it('types and validates the layout\'s ctx.query, the page under it declaring none', async () => {
    const plain = await get(app, '/traffic/plain?period=7d')

    expect(plain.status).toBe(200)
    expect(read(plain.html)).toBe('7d')
    expect(plain.html).toContain('<section class="traffic" data-period="7d">')
    expect(read((await get(app, '/traffic/plain')).html)).toBe('24h')
  })

  it('merges with the page\'s own, the page reading both and the layout its own', async () => {
    const both = await get(app, '/traffic?site=a&rows=3&period=1h')

    expect(read(both.html)).toBe('1h 3 a number')
    expect(both.html).toContain('data-period="1h"')
    expect(read((await get(app, '/traffic')).html)).toBe('24h  all undefined')
  })

  it('merges nested layouts and the page in order', async () => {
    const deep = await get(app, '/traffic/deep?view=list&period=7d&rows=2')

    expect(read(deep.html)).toBe('7d list 2')
    expect(deep.html).toContain('<div class="deep" data-view="list" data-period="7d">')
    expect(read((await get(app, '/traffic/deep')).html)).toBe('24h grid ')
  })

  it('accepts a name declared again with the same schema, and fails a render where it differs', async () => {
    expect(read((await get(app, '/traffic/same?period=3d')).html)).toBe('3d')
    expect((await get(app, '/traffic/clash')).status).toBe(500)
  })

  it('answers a value a layout\'s schema refuses with 400 through the error page', async () => {
    for (const query of ['period=toolong', 'rows=0', 'period=a&period=b']) {
      const refused = await get(app, `/traffic/deep?${query}`)

      expect(refused.status).toBe(400)
      expect(refused.html).toContain('<h1>Error 400</h1>')
      expect(refused.html).toContain('Invalid query: ')
    }
  })

  it('gives the layouts of a failure page the query their schema reads, a refused field as its default', async () => {
    const refused = await get(app, '/traffic/deep?period=toolong&view=sideways')
    const missing = await get(app, '/traffic/gone?period=7d')
    const unread = await get(app, '/traffic/gone?period=toolong')

    expect(refused.status).toBe(400)
    expect(refused.html).toContain('<section class="traffic" data-period="24h">')
    expect(missing.status).toBe(404)
    expect(missing.html).toContain('<section class="traffic" data-period="7d">')
    expect(missing.html).toContain('Gone')
    expect(unread.html).toContain('data-period="24h"')
  })

  it('reads hostile names as names, polluting nothing', async () => {
    const hostile = await get(app, '/traffic/plain?__proto__=x&constructor=y&toString=z&period=7d')

    expect(hostile.status).toBe(200)
    expect(read(hostile.html)).toBe('7d')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect((await get(app, `/traffic/plain?period=${'a'.repeat(5000)}`)).status).toBe(400)
  })

  it('reads the same under a base, a trailing slash and a locale prefix', async () => {
    const moved = await slashed.handle(new Request('http://localhost/traffic/plain?period=7d'))

    expect(moved.headers.get('location')).toBe('/repo/traffic/plain/?period=7d')
    expect(read((await get(slashed, '/traffic/plain/?period=7d')).html)).toBe('7d')
    expect((await get(slashed, '/traffic/plain/?period=toolong')).status).toBe(400)
    expect(read((await get(localized, '/fr/traffic/plain?period=7d')).html)).toBe('7d')
    expect((await get(localized, '/fr/traffic/plain?period=toolong')).status).toBe(400)
  })

  it('leaves out the layouts a page drops, with their params', async () => {
    const bare = await get(app, '/traffic/bare?period=toolong&site=x')

    expect(bare.status).toBe(200)
    expect(read(bare.html)).toBe('period,site')
  })

  it('gives an island under the layout the layout\'s param through queryParam', async () => {
    const live = await get(app, '/traffic/live?period=7d')

    expect(live.status).toBe(200)
    expect(live.html).toContain('data-kay-query')
    expect(live.html).toMatch(/"period":\{"type":"string"[^}]*"default":"24h"/)
    expect(live.html).toContain('7d')
  })
})

describe('chainQuery', () => {
  it('refuses a name optional in one schema and required in the other', () => {
    expect(() => chainQuery(['a.kay', 'b.kay'], [{ page: { query: s.Object({ q: s.Optional(s.String()) }) } }, { page: { query: s.Object({ q: s.String() }) } }])).toThrow('`q` is declared')
  })

  const layout = s.Object({ period: s.String({ default: '24h' }), shared: s.Optional(s.String()) })
  const page = s.Object({ site: s.String(), shared: s.Optional(s.String()) })

  it('keeps a single schema as it is, and merges several once', () => {
    expect(chainQuery(['page.kay'], [{ page: { query: page } }])).toBe(page)
    expect(chainQuery(['page.kay'], [{}])).toBeUndefined()

    const merged = chainQuery(['layout.kay', 'page.kay'], [{ page: { query: layout } }, { page: { query: page } }]) as { properties: object, required: string[] }

    expect(Object.keys(merged.properties)).toEqual(['period', 'shared', 'site'])
    expect(merged.required).toEqual(['period', 'site'])
    expect(chainQuery(['layout.kay', 'page.kay'], [{ page: { query: layout } }, { page: { query: page } }])).toBe(merged)
  })

  it('names both files of a name declared with two schemas', () => {
    expect(() => chainQuery(['layout.kay', 'page.kay'], [{ page: { query: s.Object({ q: s.String() }) } }, { page: { query: s.Object({ q: s.Integer() }) } }])).toThrow('`q` is declared by the `query` of both layout.kay and page.kay, with different schemas')
  })
})

describe('chainQuery without a layout query', () => {
  it('returns the page\'s schema and allocates no array', () => {
    const page = s.Object({ site: s.String() })
    const flatMap = spyOn(Array.prototype, 'flatMap')

    try {
      expect(chainQuery(['layout.kay', 'page.kay'], [{ page: { query: 'nope' } }, { page: { query: page } }])).toBe(page)
      expect(chainQuery(['layout.kay', 'page.kay'], [{}, {}])).toBeUndefined()
      expect(flatMap).not.toHaveBeenCalled()
    }
    finally {
      flatMap.mockRestore()
    }
  })
})

describe('layoutQueries of a mounted extension page', () => {
  const query = '--- server\nimport { s } from \'kay\'\n\nexport const page = { query: s.Object({ q: s.String() }) }\n---\nslot\n'

  it('types the app\'s layouts above its URL, the app\'s winning over the extension\'s at one directory', async () => {
    const dir = await scratchDir('layout-query-mount-')
    const app = join(dir, 'app/src/routes')
    const lib = join(dir, 'lib/routes')
    const mounts = [{ dir: lib, prefix: '/auth' }]
    const page = join(lib, 'login/index.kay')

    await Promise.all([
      Bun.write(join(app, '_layout.kay'), query),
      Bun.write(join(app, 'auth/_layout.kay'), query),
      Bun.write(join(lib, '_layout.kay'), query),
      Bun.write(join(lib, 'login/_layout.kay'), query),
      Bun.write(page, 'p login\n'),
    ])

    const import_ = (layout: string) => `(typeof import(${JSON.stringify(layout)}))["page"]["query"]`

    expect(layoutQueries(page, 'p login\n', app, mounts)).toEqual([
      import_('../../../app/src/routes/_layout.kay'),
      import_('../../../app/src/routes/auth/_layout.kay'),
      import_('./_layout.kay'),
    ])
  })
})
