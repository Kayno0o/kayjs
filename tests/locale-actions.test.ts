import type { I18nConfig } from '../src/config'
import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from './shared-pages'

const routes = 'tests/fixtures/locale-actions/src/routes'
const messages = 'tests/fixtures/i18n/src/messages'

// A plain form post, a form kay's script posts by fetch, and an island calling the action.
type Post = 'form' | 'swap' | 'island'
const POSTS: Post[] = ['form', 'swap', 'island']

interface Variant { base: string, trailingSlash: 'always' | 'never' | 'ignore', prefixDefault: boolean, dev: boolean }

async function serve({ base, trailingSlash, prefixDefault, dev }: Variant): Promise<Elysia> {
  const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages, prefixDefault }

  return new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.example', i18n, base: base || undefined, trailingSlash, dev }))
}

// The action's URL as the router serves it, the proxy having taken the base off.
function actionOf(html: string, base: string): string {
  return (/action="([^"]*\/_kay\/action\/[^"]*)"/).exec(html)![1]!.slice(base.length)
}

// Where the action's redirect goes, posted from `page` the way a form or an island posts.
async function redirectedFrom(app: Elysia, variant: Variant, page: string, how: Post, headers: Record<string, string> = {}): Promise<string | null> {
  const html = await (await app.handle(new Request(`http://localhost${page || '/'}`))).text()
  const action = actionOf(html, variant.base)
  const from = `http://localhost${variant.base}${page}`
  const sent: Record<string, string> = { form: { referer: from }, swap: { 'referer': from, 'x-kay-action': 'form', 'x-kay-page': from }, island: { 'x-kay-action': '1', 'x-kay-page': from, 'content-type': 'application/json' } }[how]
  const response = await app.handle(new Request(`http://localhost${action}`, { method: 'POST', headers: { origin: 'http://localhost', ...sent, ...headers }, body: how === 'island' ? '[{}]' : new FormData() }))

  const where = response.headers.get('location') ?? response.headers.get('x-kay-redirect')

  // Every way of reading the redirect has the base on it.
  return where?.startsWith(`${variant.base}/`) ? where.slice(variant.base.length) : where
}

// Posts the `index`th action of `path` the three ways, answering what the visitor reads and the status.
async function postDown(app: Elysia, variant: Variant, how: Post, path: string, index: number): Promise<{ status: number, text: string }> {
  const html = await (await app.handle(new Request(`http://localhost${path}`))).text()
  const action = [...html.matchAll(/action="([^"]*\/_kay\/action\/[^"]*)"/g)][index]![1]!.slice(variant.base.length)
  const from = `http://localhost${variant.base}${path}`
  const sent: Record<string, string> = { form: { referer: from }, swap: { 'referer': from, 'x-kay-action': 'form', 'x-kay-page': from }, island: { 'x-kay-action': '1', 'x-kay-page': from, 'content-type': 'application/json' } }[how]
  const response = await app.handle(new Request(`http://localhost${action}`, { method: 'POST', headers: { origin: 'http://localhost', ...sent }, body: how === 'island' ? '[{}]' : new FormData() }))

  return { status: response.status, text: await response.text() }
}

const MOUNTED: Variant = { base: '/app', trailingSlash: 'never', prefixDefault: false, dev: false }

describe('an action posted from a localized page', () => {
  for (const base of ['', '/app']) {
    for (const trailingSlash of ['never', 'always', 'ignore'] as const) {
      for (const prefixDefault of [false, true]) {
        for (const dev of [false, true]) {
          const variant = { base, trailingSlash, prefixDefault, dev }
          const label = `base ${base || 'unset'}, trailingSlash ${trailingSlash}, prefixDefault ${prefixDefault}, ${dev ? 'dev' : 'production'}`

          it(`runs in the page's locale, ${label}`, async () => {
            const app = await serve(variant)
            const slash = trailingSlash === 'always' ? '/' : ''
            const home = (locale: string) => locale === 'fr' && !prefixDefault ? '/' : `/${locale}${slash}`
            const dashboard = (locale: string) => `${locale === 'fr' && !prefixDefault ? '' : `/${locale}`}/dashboard${slash}`

            for (const how of POSTS) {
              for (const locale of ['fr', 'en']) {
                const redirect = await redirectedFrom(app, variant, home(locale) === '/' && base ? '' : home(locale), how)

                expect(redirect?.replace(/\/$/, '')).toBe(dashboard(locale).replace(/\/$/, ''))
              }
            }
          })
        }
      }
    }
  }

  it('ignores a locale the base or a hostile referer only imitates', async () => {
    const variant = MOUNTED
    const app = await serve(variant)
    const html = await (await app.handle(new Request('http://localhost/'))).text()
    const action = actionOf(html, '/app')
    const post = async (referer: string) => (await app.handle(new Request(`http://localhost${action}`, { method: 'POST', headers: { referer, origin: 'http://localhost' }, body: new FormData() }))).headers.get('location')

    // The page's own locale after the base, then another site's referer, a segment that only starts like the base, an encoded locale and a locale hidden in a longer segment.
    expect(await post('http://localhost/app/en/x')).toBe('/app/en/dashboard')
    expect(await post('http://evil.example/app/en/x')).toBe('/app/dashboard')
    expect(await post('http://localhost/apple/en/x')).toBe('/app/dashboard')
    expect(await post('http://localhost/app/%65n/x')).toBe('/app/dashboard')
    expect(await post('http://localhost/app/english/x')).toBe('/app/dashboard')
    expect(await post('http://localhost/en/app/x')).toBe('/app/dashboard')
  })
})

describe('an action\'s serverError message given as a function', () => {
  for (const base of ['', '/app']) {
    for (const trailingSlash of ['never', 'always'] as const) {
      for (const dev of [false, true]) {
        const variant: Variant = { base, trailingSlash, prefixDefault: false, dev }

        it(`is read the error and the page's locale, whichever way the post is made, base ${base || 'unset'}, trailingSlash ${trailingSlash}, ${dev ? 'dev' : 'production'}`, async () => {
          const app = await serve(variant)
          const slash = trailingSlash === 'always' ? '/' : ''
          const logged = spyOn(console, 'error').mockImplementation(() => undefined)

          try {
            for (const how of POSTS) {
              expect(await postDown(app, variant, how, `/down${slash}`, 0)).toMatchObject({ status: 500, text: expect.stringContaining('fr: mail down') })
              expect(await postDown(app, variant, how, `/en/down${slash}`, 0)).toMatchObject({ status: 500, text: expect.stringContaining('en: mail down') })
            }
          }
          finally {
            logged.mockRestore()
          }
        })
      }
    }
  }

  it('leaves kay\'s message when the function throws, logging both errors', async () => {
    const app = await serve(MOUNTED)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      for (const how of POSTS) {
        expect(await postDown(app, MOUNTED, how, '/down', 1)).toMatchObject({ status: 500, text: expect.stringContaining('Something went wrong on our side') })
      }

      const text = logged.mock.calls.flat().join('\n')

      expect(text).toContain('mail down')
      expect(text).toContain('words down')
    }
    finally {
      logged.mockRestore()
    }
  })

  it('leaves kay\'s message when the function answers a blank text', async () => {
    const app = await serve(MOUNTED)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      for (const how of POSTS) {
        expect(await postDown(app, MOUNTED, how, '/down', 2)).toMatchObject({ status: 500, text: expect.stringContaining('Something went wrong on our side') })
      }
    }
    finally {
      logged.mockRestore()
    }
  })
})

describe('an action posted with kay_back', () => {
  it('runs in the locale of the page it names under a base, over the Referer', async () => {
    const variant = MOUNTED
    const app = await serve(variant)
    const action = actionOf(await (await app.handle(new Request('http://localhost/'))).text(), '/app')
    const post = async (back: string, referer: string) => (await app.handle(new Request(`http://localhost${action}?kay_back=${encodeURIComponent(back)}`, { method: 'POST', headers: { referer, origin: 'http://localhost' }, body: new FormData() }))).headers.get('location')

    expect(await post('/app/en/x', 'http://localhost/app/x')).toBe('/app/en/dashboard')
    expect(await post('/app/x', 'http://localhost/app/en/x')).toBe('/app/dashboard')
    // A target on another host, or one only starting like the base, does not make the locale.
    expect(await post('//evil.example/app/en/x', 'http://localhost/app/x')).toBe('/app/dashboard')
    expect(await post('/apple/en/x', 'http://localhost/app/x')).toBe('/app/dashboard')
  })
})

// The same action posted the three ways, with the target it redirects to, under each way a site is served.
async function redirectTo(app: Elysia, variant: Variant, how: Post, to: string, path = '/to'): Promise<{ location: string | null, redirect: string | null }> {
  const html = await (await app.handle(new Request(`http://localhost${path}`))).text()
  const action = actionOf(html, variant.base)
  const from = `http://localhost${variant.base}${path}`
  const sent: Record<string, string> = { form: { referer: from }, swap: { 'referer': from, 'x-kay-action': 'form', 'x-kay-navigate': '1', 'x-kay-page': from }, island: { 'x-kay-action': '1', 'x-kay-page': from, 'content-type': 'application/json' } }[how]
  const form = new FormData()

  form.set('to', to)

  const response = await app.handle(new Request(`http://localhost${action}`, { method: 'POST', headers: { origin: 'http://localhost', ...sent }, body: how === 'island' ? JSON.stringify([{ to: 1 }, to]) : form }))

  return { location: response.headers.get('location'), redirect: response.headers.get('x-kay-redirect') }
}

describe('an action\'s redirect under a base', () => {
  for (const base of ['', '/app']) {
    for (const trailingSlash of ['never', 'always', 'ignore'] as const) {
      for (const dev of [false, true]) {
        const variant: Variant = { base, trailingSlash, prefixDefault: false, dev }

        it(`goes under the base whichever way it is read, base ${base || 'unset'}, trailingSlash ${trailingSlash}, ${dev ? 'dev' : 'production'}`, async () => {
          const app = await serve(variant)
          const slash = trailingSlash === 'always' ? '/' : ''

          for (const how of POSTS) {
            const { location, redirect } = await redirectTo(app, variant, how, `/dashboard${slash}?x=1#top`, `/to${slash}`)

            // A plain form is answered with `location`, a call or the swap with `x-kay-redirect`, and each names the page under the base.
            expect(how === 'form' ? location : redirect).toBe(`${base}/dashboard${slash}?x=1#top`)
            expect(how === 'form' ? redirect : location).toBeNull()
          }
        })
      }
    }
  }

  it('puts a localized page under the base', async () => {
    const variant = MOUNTED
    const app = await serve(variant)

    for (const how of POSTS) {
      const { location, redirect } = await redirectTo(app, variant, how, '/en/dashboard')

      expect(location ?? redirect).toBe('/app/en/dashboard')
    }
  })

  it('leaves a target that is no path of the site as it is', async () => {
    const variant = MOUNTED
    const app = await serve(variant)

    for (const how of POSTS) {
      for (const target of ['https://other.example/x', 'http://localhost/dashboard']) {
        const { location, redirect } = await redirectTo(app, variant, how, target)

        expect(location ?? redirect).toBe(target)
      }
    }
  })

  it('refuses a target a browser would read as another host, whichever way the call is made', async () => {
    const variant = MOUNTED
    const app = await serve(variant)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      for (const how of POSTS) {
        for (const target of ['//evil.example/x', '/\\evil.example/x']) {
          const { location, redirect } = await redirectTo(app, variant, how, target)

          expect([location, redirect]).toEqual([null, null])
        }
      }
    }
    finally {
      logged.mockRestore()
    }
  })

  it('writes a redirect without the base, so one already carrying it goes under it again', async () => {
    const variant = MOUNTED
    const app = await serve(variant)

    for (const how of POSTS) {
      const { location, redirect } = await redirectTo(app, variant, how, '/app/dashboard')

      expect(location ?? redirect).toBe('/app/app/dashboard')
    }
  })

  it('puts a lookalike of the base under it, as any other path', async () => {
    const variant = MOUNTED
    const app = await serve(variant)

    for (const how of POSTS) {
      for (const target of ['/apple', '/app2/x', '/']) {
        const { location, redirect } = await redirectTo(app, variant, how, target)

        expect(location ?? redirect).toBe(`/app${target}`)
      }
    }
  })
})
