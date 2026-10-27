import type { Elysia } from 'elysia'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { s } from '../src/runtime'
import { readQuery } from '../src/server/query'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const READ = /<p class="read">([^<]*)<\/p>/
const url = (search: string) => new URL(`http://localhost/page${search}`)
const schema = s.Object({
  period: s.UnionEnum(['24h', '7d', '30d'], { default: '24h', lenient: true }),
  rows: s.Integer({ default: 20, minimum: 1, maximum: 100, lenient: true }),
  note: s.Optional(s.String({ maxLength: 3, lenient: true })),
  strict: s.Optional(s.Integer()),
  needed: s.String({ lenient: true }),
})
const lenient = s.Object({ period: s.UnionEnum(['24h', '7d'], { default: '24h', lenient: true }), strict: s.Optional(s.Integer()) })

describe('a query field marked lenient', () => {
  it('reads a value its schema refuses as its default, or leaves it out when it has none', () => {
    expect(readQuery(schema, url('?period=1y&rows=0&note=toolong&needed=x'))).toEqual({ period: '24h', rows: 20, needed: 'x' })
    expect(readQuery(schema, url('?period=7d&rows=5&note=ab&needed=x'))).toEqual({ period: '7d', rows: 5, note: 'ab', needed: 'x' })
  })

  it('reads a repeated, empty or hostile value as refused', () => {
    expect(readQuery(lenient, url('?period=24h&period=7d')).period).toBe('24h')
    expect(readQuery(lenient, url('?period=')).period).toBe('24h')
    expect(readQuery(lenient, url('?period=__proto__&constructor=x&toString=y')).period).toBe('24h')
    expect(Object.getPrototypeOf(readQuery(lenient, url('?__proto__=x&period=1y')))).toBe(Object.prototype)
  })

  it('keeps refusing a field that is not lenient, and a lenient one with nothing to fall back to', () => {
    expect(() => readQuery(lenient, url('?period=1y&strict=x'))).toThrow()
    expect(() => readQuery(schema, url('?period=1y'))).toThrow()

    try {
      readQuery(lenient, url('?period=1y&strict=x'))
    }
    catch (error) {
      expect((error as { status: number }).status).toBe(400)
      expect((error as { message: string }).message).toContain('strict')
      expect((error as { message: string }).message).not.toContain('period')
    }
  })

  it('leaves a field without the mark refusing, as before', () => {
    expect(() => readQuery(s.Object({ period: s.UnionEnum(['24h', '7d'], { default: '24h' }) }), url('?period=1y'))).toThrow()
  })
})

describe('a lenient query field of a page and its layout', () => {
  let dir = ''
  let plain: Elysia
  let mounted: Elysia
  let localized: Elysia

  const get = async (server: Elysia, path: string) => {
    const response = await server.handle(new Request(`http://localhost${path}`))

    return { status: response.status, html: await response.text() }
  }
  const read = (html: string) => READ.exec(html)?.[1]

  beforeAll(async () => {
    dir = await scratchDir('query-lenient-')
    await Promise.all([
      Bun.write(join(dir, 'routes/traffic/_layout.kay'), '--- server\nimport { s } from \'kay\'\n\nexport const page = { query: s.Object({ period: s.UnionEnum([\'24h\', \'7d\'], { default: \'24h\', lenient: true }) }) }\nconst { period } = ctx.query\n---\nsection(data-period={period})\n  slot\n'),
      Bun.write(join(dir, 'routes/traffic/index.kay'), '--- server\nimport { s } from \'kay\'\n\nexport const page = { query: s.Object({ rows: s.Integer({ default: 10 }) }) }\nconst { period, rows } = ctx.query\n---\np.read {period} {rows}\n'),
      Bun.write(join(dir, 'routes/_error.kay'), '--- server\nconst { status } = ctx.error\n---\nh1 Error {status}\n'),
    ])
    plain = await pages({ root: dir, routes: 'routes', prebuilt: false, security: false })
    mounted = await pages({ root: dir, routes: 'routes', prebuilt: false, security: false, base: '/repo', trailingSlash: 'always' })
    localized = await pages({ root: dir, routes: 'routes', prebuilt: false, security: false, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('serves the page with the default for a stale value, still refusing its strict neighbour', async () => {
    const stale = await get(plain, '/traffic?period=1y')

    expect(stale.status).toBe(200)
    expect(read(stale.html)).toBe('24h 10')
    expect(stale.html).toContain('data-period="24h"')
    expect(read((await get(plain, '/traffic?period=7d')).html)).toBe('7d 10')
    expect((await get(plain, '/traffic?period=1y&rows=x')).status).toBe(400)
  })

  it('holds under a base with trailing slashes and a locale prefix', async () => {
    expect(read((await get(mounted, '/traffic/?period=1y')).html)).toBe('24h 10')
    expect((await get(mounted, '/traffic/?period=1y&rows=x')).status).toBe(400)
    expect(read((await get(localized, '/fr/traffic?period=1y')).html)).toBe('24h 10')
    expect(read((await get(localized, '/traffic?period=1y')).html)).toBe('24h 10')
  })
})
