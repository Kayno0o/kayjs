import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { defineContext } from '../src/runtime/template-context'
import { loadContextValues, useContexts } from '../src/server/context-values'
import { contextReadsOf, routeMounts, scanRoutes } from '../src/server/routes'
import { loads } from './fixtures/request-keys/lib/state'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const FIXTURE = 'tests/fixtures/request-keys'
const CONTEXT = resolve(`${FIXTURE}/lib/context.ts`)
const EXTENSION = { name: 'keys', context: CONTEXT }
const I18N = { locales: ['en', 'fr'], defaultLocale: 'en' }

interface Variant { base: string, dev: boolean, locale: boolean }

const variants: Variant[] = [false, true].flatMap(dev => ['', '/repo'].flatMap(base => [false, true].map(locale => ({ dev, base, locale }))))
const apps = new Map<string, ReturnType<typeof pages>>()

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

const VISITOR = { 'x-user': 'Ada', 'x-cart': '3' }

describe('a context of keyed loaders', () => {
  for (const variant of variants) {
    const label = `${variant.dev ? 'dev' : 'production'}, base ${variant.base || 'unset'}, ${variant.locale ? 'locale prefix' : 'no locale'}`

    it(`runs only the loaders of the keys a page's templates read, in the first bytes, ${label}`, async () => {
      const cart = await get(variant, '/cart', VISITOR)

      expect(cart.status).toBe(200)
      expect(cart.html).toContain('<p id="cart">3</p>')
      expect(cart.html).not.toContain('id="who"')
      expect(cart.html).not.toContain('kay-await')
      expect(cart.loads).toEqual(['cart'])
      expect(cart.headers.get('cache-control')).toBe('private, no-cache')

      const who = await get(variant, '/who', VISITOR)

      expect(who.html).toContain('<p id="who">Ada</p>')
      expect(who.loads).toEqual(['user'])

      const both = await get(variant, '/both', VISITOR)

      expect(both.html).toContain('<p id="who">Ada</p>')
      expect(both.html).toContain('<p id="cart">3</p>')
      expect(both.loads.sort()).toEqual(['cart', 'user'])
    })

    it(`loads every key for a template using ctx whole, and none for a page reaching no template, ${label}`, async () => {
      const whole = await get(variant, '/whole', VISITOR)

      expect(whole.html).toContain('<p id="keys">cartCount,user</p>')
      expect(whole.loads.sort()).toEqual(['cart', 'user'])

      const plain = await get(variant, '/plain', VISITOR)

      expect(plain.loads).toEqual([])
      expect(plain.headers.get('cache-control') ?? '').not.toContain('private')
    })

    it(`loads every key for an error page, each once, ${label}`, async () => {
      const broken = await get(variant, '/broken', VISITOR)

      expect(broken.status).toBe(500)
      expect(broken.html).toContain('<p id="err">cart 3</p>')
      expect(broken.loads.sort()).toEqual(['cart', 'user'])
    })
  }

  it('loads every key for a template spreading ctx', async () => {
    const spread = await get({ base: '', dev: false, locale: false }, '/spread', VISITOR)

    expect(spread.html).toContain('<p id="spread">3 Ada</p>')
    expect(spread.loads.sort()).toEqual(['cart', 'user'])
  })

  it('reads no member of Object.prototype off ctx and runs no loader for one', async () => {
    const hostile = await get({ base: '', dev: false, locale: false }, '/hostile', VISITOR)

    expect(hostile.html).toContain('<p id="ctor">undefined undefined undefined</p>')
    expect(hostile.loads).toEqual([])
  })

  it('types the values from the loaders, and names a loader that answers a key twice across extensions', async () => {
    const typed = defineContext({ count: () => 1, name: async () => 'a' })
    const request = new Request('http://localhost/twice')

    expect(Object.keys(typed.loaders ?? {})).toEqual(['count', 'name'])
    useContexts(request, [CONTEXT, CONTEXT], false, ['cartCount'])
    await expect(loadContextValues(request)).rejects.toThrow('two extensions give ctx.cartCount')
  })

  it('loads the keys asked later once and the keys already loaded never again, retrying a loader that threw', async () => {
    const dir = await scratchDir('request-keys-retry-')
    const file = resolve(dir, 'flaky.ts')

    await Bun.write(file, 'import { defineContext } from \'kay/library\'\n\nexport const calls: string[] = []\n\nexport default defineContext({\n  async a() {\n    calls.push(\'a\')\n    await Bun.sleep(5)\n\n    if (calls.filter(call => call === \'a\').length === 1)\n      throw new Error(\'store down\')\n\n    return 1\n  },\n  b() {\n    calls.push(\'b\')\n\n    return 2\n  },\n})\n')
    const { calls } = await import(file) as { calls: string[] }
    const request = new Request('http://localhost/flaky')

    useContexts(request, [file], false, ['a'])
    await expect(loadContextValues(request)).rejects.toThrow('store down')
    await Promise.all([loadContextValues(request), loadContextValues(request)])
    useContexts(request, [file], false, undefined)
    await loadContextValues(request)
    await loadContextValues(request)
    expect(calls).toEqual(['a', 'a', 'b'])
  })

  it('marks as needing every key the pages whose templates name ctx in no static read, and narrows the rest', async () => {
    const root = resolve(FIXTURE)
    const routes = await scanRoutes(resolve(FIXTURE, 'src/routes'), routeMounts(root, [EXTENSION]))
    const keys = Object.fromEntries(routes.map(route => [route.pattern, route.contextKeys]))

    expect(keys['/cart']).toEqual(['cartCount'])
    expect(keys['/who']).toEqual(['user'])
    expect(keys['/both']?.slice().sort()).toEqual(['cartCount', 'user'])
    expect(keys['/whole']).toBeUndefined()
    expect(keys['/spread']).toBeUndefined()
    expect(keys['/plain']).toBeUndefined()
    expect(routes.find(route => route.pattern === '/plain')!.layouts).toEqual([])
    expect(routes.find(route => route.pattern === '/whole')!.layouts).toHaveLength(1)
  })

  it('scans the same keys from the build\'s record as from the templates', async () => {
    const root = resolve(FIXTURE)
    const routesDir = resolve(FIXTURE, 'src/routes')
    const mounts = routeMounts(root, [EXTENSION])
    const reads = await contextReadsOf(routesDir, mounts)
    const live = await scanRoutes(routesDir, mounts)
    const recorded = await scanRoutes(routesDir, mounts, { ...reads, recorded: true })
    const view = (routes: typeof live) => routes.map(route => [route.pattern, route.layouts, route.contextKeys])

    expect(view(recorded)).toEqual(view(live))
    expect(recorded.find(route => route.pattern === '/cart')!.contextKeys).toEqual(['cartCount'])
  })
})
