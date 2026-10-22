import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { loadContextValues, useContexts } from '../src/server/context-values'
import { routeMounts, scanRoutes } from '../src/server/routes'
import { loads } from './fixtures/request-values/lib/state'
import { pages } from './shared-pages'

const FIXTURE = 'tests/fixtures/request-values'
const CONTEXT = resolve(`${FIXTURE}/lib/context.ts`)
const EXTENSION = { name: 'values', context: CONTEXT }
const I18N = { locales: ['en', 'fr'], defaultLocale: 'en' }

interface Variant { base: string, dev: boolean, locale: boolean }

const variants: Variant[] = [false, true].flatMap(dev => ['', '/repo'].flatMap(base => [false, true].map(locale => ({ dev, base, locale }))))
const apps = new Map<string, ReturnType<typeof pages>>()

// A request from a visitor named by headers, where the proxy in front of kay has stripped the base.
async function get(variant: Variant, path: string, headers: Record<string, string> = {}) {
  const key = JSON.stringify(variant)
  let held = apps.get(key)

  if (!held) {
    held = pages({ root: FIXTURE, extensions: [EXTENSION], prebuilt: false, security: false, inlineStyles: false, site: 'https://site.example', dev: variant.dev, base: variant.base || undefined, i18n: variant.locale ? I18N : undefined })
    apps.set(key, held)
  }

  loads.length = 0

  const response = await (await held).handle(new Request(`http://localhost${variant.locale ? '/fr' : ''}${path}`, { headers }))

  return { status: response.status, html: await response.text(), headers: response.headers, loads: [...loads] }
}

const ADA = { 'x-user': 'Ada', 'x-roles': 'admin' }
const BOB = { 'x-user': 'Bob' }

describe('a template reading ctx', () => {
  for (const variant of variants) {
    const label = `${variant.dev ? 'dev' : 'production'}, base ${variant.base || 'unset'}, ${variant.locale ? 'locale prefix' : 'no locale'}`

    it(`shows the user and the role check in the first bytes of a page reaching it, however deep, ${label}`, async () => {
      for (const path of ['/gated', '/deep']) {
        const admin = await get(variant, path, ADA)

        expect(admin.status).toBe(200)
        expect(admin.html).toContain('<p id="who">Ada</p>')
        expect(admin.html).toContain('<p id="admin">Admin</p>')
        expect(admin.html).toContain('id="inside"')
        expect(admin.html).not.toContain('kay-await')
        expect(admin.loads).toHaveLength(1)
        expect(admin.headers.get('cache-control')).toBe('private, no-cache')
        expect(admin.headers.get('vary')).toContain('cookie')

        const member = await get(variant, path, BOB)

        expect(member.html).toContain('<p id="who">Bob</p>')
        expect(member.html).not.toContain('id="admin"')

        const guest = await get(variant, path)

        expect(guest.html).not.toContain('id="who"')
        expect(guest.html).not.toContain('id="admin"')
      }
    })

    it(`reads it in a layout and in a page's own template, once per request, ${label}`, async () => {
      const inner = await get(variant, '/inner/page', ADA)

      expect(inner.html).toContain('<nav id="admin-nav">Admin menu</nav>')
      expect(inner.loads).toHaveLength(1)
      expect((await get(variant, '/inner/page', BOB)).html).not.toContain('admin-nav')
      expect((await get(variant, '/inline', ADA)).html).toContain('<p id="name">Ada</p>')
      expect((await get(variant, '/inline')).html).toContain('<p id="name">Guest</p>')

      const fenced = await get(variant, '/fenced', ADA)

      expect(fenced.html).toMatch(/<p id="path">[^<]*\/fenced<\/p>/)
      expect(fenced.html).toContain('<p id="name">Ada</p>')
    })

    it(`loads nothing and keeps a page reaching no template cacheable, ${label}`, async () => {
      const plain = await get(variant, '/plain', ADA)

      expect(plain.html).toContain('id="plain"')
      expect(plain.loads).toEqual([])
      expect(plain.headers.get('cache-control') ?? '').not.toContain('private')
    })
  }

  it('is refused in a prerendered page, which holds no request', async () => {
    const request = new Request('http://localhost/gated')

    useContexts(request, [CONTEXT], true)
    await expect(loadContextValues(request)).rejects.toThrow('a prerendered page renders once')
  })

  it('is mounted only where an extension gives a context, around the pages reaching a template that reads it', async () => {
    const root = resolve(FIXTURE)
    const wrapped = async (extensions: { name: string, context?: string }[]) => (await scanRoutes(resolve(FIXTURE, 'src/routes'), routeMounts(root, extensions))).filter(route => route.layouts.some(layout => layout.includes('context-layout'))).map(route => route.pattern).sort()

    expect(await wrapped([EXTENSION])).toEqual(['/deep', '/fenced', '/gated', '/inline', '/inner/page'])
    expect(await wrapped([{ name: 'none' }])).toEqual([])
  })

  it('is no island\'s to read, which renders in the browser too', () => {
    const messages = (source: string, insideIsland?: boolean) => compileKay(source, 'test.kay', { insideIsland }).diagnostics.map(d => d.message)
    const reactive = '---\nimport { signal } from "kay"\nconst count = signal(0)\n---\np {ctx.user?.name} {count()}\n'

    expect(messages(reactive)).toEqual([expect.stringContaining('`ctx` is read on the server')])
    expect(messages('p {ctx.user?.name}\n', true)).toEqual([expect.stringContaining('`ctx` is read on the server')])
    expect(messages('p {ctx.user?.name}\n')).toEqual([])
  })

  it('keeps a script\'s own ctx, and a fence\'s, as they are', () => {
    const own = compileKay('---\nconst ctx = { user: 1 }\n---\np {ctx.user}\n', 'test.kay')
    const fence = compileKay('--- server\nconst path = ctx.url.pathname\n---\np {path}\n', 'test.kay')

    for (const compiled of [own, fence]) {
      expect(compiled.diagnostics).toEqual([])
      expect(compiled.tsx).not.toContain('import { ctx }')
    }
  })
})
