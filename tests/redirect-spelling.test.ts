import type { I18nConfig } from '../src/config'
import type { LocaleSettings } from '../src/runtime/i18n'
import type { LocaleState } from '../src/runtime/locale-state'
import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { runInLocale } from '../src/runtime/locale-state'
import { refusalOutcome } from '../src/server/render'
import { Redirect } from '../src/server/signals'
import { pages } from './shared-pages'

const messages = resolve('tests/fixtures/i18n/src/messages')
const ACTION = /action="([^"]*\/_kay\/action\/[^"]*)"/

type Slash = 'always' | 'never' | 'ignore' | undefined
type Way = 'page' | 'guard' | 'endpoint' | 'form' | 'swap' | 'island'
const WAYS: Way[] = ['page', 'guard', 'endpoint', 'form', 'swap', 'island']

interface Variant { base: string, trailingSlash: Slash, locales: boolean, dev: boolean }

async function serve({ base, trailingSlash, locales, dev }: Variant): Promise<Elysia> {
  const i18n: I18nConfig | undefined = locales ? { locales: ['fr', 'en'], defaultLocale: 'fr', messages } : undefined

  return new Elysia().use(await pages({ root: 'tests/fixtures/redirect-spelling', prebuilt: false, security: false, site: 'https://x.example', i18n, base: base || undefined, trailingSlash, dev }))
}

// Where `to` sends a visit, posted or read the way each `way` does, from the page in `locale`; the answer as the browser would read it, with the base taken off.
async function redirectedTo(app: Elysia, variant: Variant, way: Way, to: string, locale = 'fr'): Promise<string | null> {
  const prefix = locale === 'fr' || !variant.locales ? '' : `/${locale}`
  const slash = variant.trailingSlash === 'always' ? '/' : ''
  const send = async (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init))
  let response: Response

  if (way === 'page' || way === 'guard' || way === 'endpoint') {
    const page = { page: '/bounce', guard: '/gated', endpoint: '/jump.txt' }[way]

    response = await send(`${prefix}${page}${page === '/jump.txt' ? '' : slash}?to=${encodeURIComponent(to)}`)
  }
  else {
    const html = await (await send(`${prefix}/act${slash}`)).text()
    const action = ACTION.exec(html)![1]!.slice(variant.base.length)
    const from = `http://localhost${variant.base}${prefix}/act${slash}`
    const form = new FormData()

    form.set('to', to)

    const headers: Record<string, string> = { form: { referer: from }, swap: { 'referer': from, 'x-kay-action': 'form', 'x-kay-navigate': '1', 'x-kay-page': from }, island: { 'x-kay-action': '1', 'x-kay-page': from, 'content-type': 'application/json' } }[way]

    response = await send(action, { method: 'POST', headers: { origin: 'http://localhost', ...headers }, body: way === 'island' ? JSON.stringify([{ to: 1 }, to]) : form })
  }

  const where = response.headers.get('x-kay-redirect') ?? response.headers.get('location')

  return where?.startsWith(`${variant.base}/`) ? where.slice(variant.base.length) : where
}

describe('a redirect to a page of the site', () => {
  for (const base of ['', '/app']) {
    for (const trailingSlash of ['always', 'never', 'ignore', undefined] as const) {
      for (const dev of [false, true]) {
        const variant: Variant = { base, trailingSlash, locales: false, dev }
        const label = `base ${base || 'unset'}, trailingSlash ${trailingSlash ?? 'unset'}, ${dev ? 'dev' : 'production'}`

        it(`is spelled as the page's links are, in one response, ${label}`, async () => {
          const app = await serve(variant)
          const slash = trailingSlash === 'always' ? '/' : ''

          for (const way of WAYS) {
            // A query and a hash go along, and a path already spelled either way settles on the setting's, `ignore` keeping what was written.
            expect(await redirectedTo(app, variant, way, '/deferred?x=1#top'), way).toBe(`/deferred${slash}?x=1#top`)
            expect(await redirectedTo(app, variant, way, '/deferred'), way).toBe(`/deferred${slash}`)
            expect(await redirectedTo(app, variant, way, '/deferred/'), way).toBe(trailingSlash === 'ignore' ? '/deferred/' : `/deferred${slash}`)
            expect(await redirectedTo(app, variant, way, '/docs/a/b'), way).toBe(`/docs/a/b${slash}`)
            expect(await redirectedTo(app, variant, way, '/'), way).toBe('/')
          }
        })
      }
    }
  }
})

describe('a redirect to something that is no page', () => {
  for (const trailingSlash of ['always', 'never'] as const) {
    it(`is left as written, trailingSlash ${trailingSlash}`, async () => {
      const variant: Variant = { base: '/app', trailingSlash, locales: false, dev: false }
      const app = await serve(variant)

      for (const way of WAYS) {
        for (const to of ['/data.json', '/logo.png', '/jump.txt', '/missing', '/_kay/x', '/index.html']) {
          expect(await redirectedTo(app, variant, way, to), `${way} ${to}`).toBe(to)
        }

        for (const to of ['https://other.example/deferred', 'http://localhost/deferred', '?page=2', '#top', 'relative/path'])
          expect(await redirectedTo(app, variant, way, to), `${way} ${to}`).toBe(to)
      }
    })
  }
})

describe('a redirect on a localized site', () => {
  for (const base of ['', '/app']) {
    for (const trailingSlash of ['always', 'never'] as const) {
      const variant: Variant = { base, trailingSlash, locales: true, dev: false }

      it(`goes to the page in the page's locale, base ${base || 'unset'}, trailingSlash ${trailingSlash}`, async () => {
        const app = await serve(variant)
        const slash = trailingSlash === 'always' ? '/' : ''

        for (const way of WAYS) {
          expect(await redirectedTo(app, variant, way, '/deferred?x=1#top', 'fr'), way).toBe(`/deferred${slash}?x=1#top`)

          // An endpoint has no locale prefix, so it redirects in the default locale.
          if (way === 'endpoint')
            continue

          expect(await redirectedTo(app, variant, way, '/deferred?x=1#top', 'en'), way).toBe(`/en/deferred${slash}?x=1#top`)
          expect(await redirectedTo(app, variant, way, '/docs/a', 'en'), way).toBe(`/en/docs/a${slash}`)
          // Already under a prefix, or localized by the app, it is not prefixed twice.
          expect(await redirectedTo(app, variant, way, '/en/deferred', 'en'), way).toBe(`/en/deferred${slash}`)
          expect(await redirectedTo(app, variant, way, '/data.json', 'en'), way).toBe('/data.json')
        }
      })
    }
  }
})

describe('a redirect to a path that is hostile or odd', () => {
  it('never leaves the site, and is spelled once', async () => {
    const variant: Variant = { base: '', trailingSlash: 'always', locales: false, dev: false }
    const app = await serve(variant)
    const cases: Record<string, string> = {
      '/deferred//': '/deferred//',
      '/a/../deferred': '/a/../deferred',
      '/%2e%2e/deferred': '/%2e%2e/deferred',
      '/deferred%2F': '/deferred%2F',
      '/docs/日本語': '/docs/%E6%97%A5%E6%9C%AC%E8%AA%9E/',
      '/a\\b': '/a\\b',
    }

    for (const way of WAYS) {
      for (const [to, expected] of Object.entries(cases)) {
        const where = await redirectedTo(app, variant, way, to)

        expect(where?.startsWith('/') && !where.startsWith('//'), `${way} ${to} -> ${where}`).toBe(true)
        expect(await redirectedTo(app, variant, way, where!), `${way} ${to} twice`).toBe(where)
        expect(where, `${way} ${to}`).toBe(expected)
      }
    }
  })
})

describe('a redirect on a site whose root catch-all page could take any path', () => {
  const extension = { name: 'kay-test-auth', server: new Elysia({ name: 'kay-test-auth' }).get('/auth/:provider', () => 'auth').get('/contact', () => 'contact') }

  for (const dev of [false, true]) {
    it(`spells a page and leaves what else serves the path as written, ${dev ? 'dev' : 'production'}`, async () => {
      const app = new Elysia().use(await pages({ root: 'tests/fixtures/redirect-shadow', prebuilt: false, security: false, trailingSlash: 'always', dev, extensions: [extension] }))

      const where = async (to: string) => {
        const response = await app.handle(new Request(`http://localhost/bounce/?to=${encodeURIComponent(to)}`))

        return response.headers.get('location')
      }

      // Pages, the catch-all's included, next to a `[slug].json` endpoint whose pattern is `/:slug`.
      expect(await where('/about')).toBe('/about/')
      expect(await where('/anything/else')).toBe('/anything/else/')
      expect(await where('/')).toBe('/')

      // An API module's route, an extension's, a public file with no extension and kay's own.
      // An extension's route at the very pattern of a page is reached first, so it is no page's.
      for (const to of ['/api/ping/hello', '/auth/github', '/contact', '/plain', '/_kay/x', '/x.json'])
        expect(await where(to), to).toBe(to)
    })
  }
})

describe('the dev tool\'s guard outcome', () => {
  it('names the Location that goes out, spelled, and the plain one without a spelling', () => {
    const spelled = (location: string) => `${location}/`

    expect(refusalOutcome(new Redirect('/deferred', 302), spelled)).toBe('redirected to /deferred/ (302)')
    expect(refusalOutcome(new Redirect('/deferred', 302))).toBe('redirected to /deferred (302)')
  })
})

describe('the dev tool\'s guard outcome in a render', () => {
  // A redirect answers without a page, so no dev tool carries its outcome: a denial is the refusal a dev render shows.
  const served = async (dev: boolean) => new Elysia().use(await pages({ root: 'tests/fixtures/guard-outcome', prebuilt: false, security: false, site: 'https://x.example', dev }))
  const visit = async (dev: boolean) => (await served(dev)).handle(new Request('http://localhost/gated', { headers: { accept: 'text/html' } }))

  it('names what the refusing guard did in a dev render', async () => {
    const response = await visit(true)
    const html = await response.text()
    const request = JSON.parse((/id="kay-dev-request">([^<]*)</).exec(html)![1]!.replaceAll('\\u003c', '<')) as { guards: { file: string, outcome: string }[] }

    expect(response.status).toBe(403)
    expect(request.guards).toEqual([{ file: expect.stringContaining('gated/_guard.ts'), outcome: 'denied with 403: No entry' }])
  })

  it('shows no dev tool in production', async () => {
    const response = await visit(false)

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('kay-dev-request')
  })
})

describe('a redirect on a site with locales by domain', () => {
  const settings: LocaleSettings = { locales: ['fr', 'en'], defaultLocale: 'fr', prefixDefault: false, hosts: { fr: 'fr.example', en: 'en.example' }, paths: { '/about': { fr: '/a-propos', en: '/about-us' } }, pages: ['/', '/about'] }
  const at = (host: string, locale: string) => runInLocale({ settings, locale, host, path: '/', messages: {} } as unknown as LocaleState, () => new Redirect('/about', 302).location)

  it('stays on a host the app does not name, and follows the page on one it does', () => {
    expect(at('localhost:3000', 'fr')).toBe('/about')
    expect(at('staging.example', 'en')).toBe('/about')
    expect(at('en.example', 'en')).toBe('/about-us')
    expect(at('fr.example', 'fr')).toBe('/a-propos')
  })
})
