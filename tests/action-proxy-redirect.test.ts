import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'

const site = 'tests/fixtures/site/src/routes'
const redirects = 'tests/fixtures/locale-actions/src/routes'
const ADD = '/_kay/action/tests/fixtures/site/src/routes/index.kay/add'
// The address the visitor's browser used, and the plain-http one the proxy reaches kay on.
const PUBLIC = 'https://shop.example'
const INTERNAL = 'http://shop.example'

type Proxy = 'declared' | 'none'
type Post = 'form' | 'swap'

// What a proxy puts on a request it forwards, and what a visitor could send on one with no proxy in front.
const FORWARDED: Record<string, Record<string, string>> = {
  none: {},
  proto: { 'x-forwarded-proto': 'https' },
  forwarded: { forwarded: 'for=203.0.113.9;proto=https;host=shop.example' },
  hostile: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example', 'forwarded': 'proto=https;host=evil.example', 'x-real-ip': '203.0.113.9' },
}

interface Variant { base: string, trailingSlash: 'always' | 'never' | 'ignore', dev: boolean, proxy: Proxy, site?: string }

async function serve(routes: string, { base, trailingSlash, dev, proxy, site: configured }: Variant): Promise<Elysia> {
  return new Elysia().use(await pages({ routes, prebuilt: false, security: false, base: base || undefined, trailingSlash, dev, site: configured, proxy: proxy === 'declared' ? { header: 'x-real-ip' } : undefined }))
}

interface Sent { page?: string, referer?: string, back?: string, headers?: Record<string, string>, how: Post }

// The action posted the way a browser on `PUBLIC` posts it, to kay reached over plain http.
async function addFrom(app: Elysia, sent: Sent): Promise<{ status: number, location: string | null, redirect: string | null }> {
  const { how, page, referer = page === undefined ? undefined : `${PUBLIC}${page}`, back, headers = {} } = sent
  const post: Record<string, string> = { origin: PUBLIC, ...(referer === undefined ? {} : { referer }), ...(how === 'swap' ? { 'x-kay-navigate': '1', ...(page === undefined ? {} : { 'x-kay-page': page }) } : {}), ...headers }
  const query = back === undefined ? '' : `?kay_back=${encodeURIComponent(back)}`
  const response = await app.handle(new Request(`${INTERNAL}${ADD}${query}`, { method: 'POST', headers: post, body: new URLSearchParams({ title: `Posted ${Bun.randomUUIDv7()}` }) }))

  return { status: response.status, location: response.headers.get('location'), redirect: response.headers.get('x-kay-redirect') }
}

// A plain form is answered with `location`, the swap's post with `x-kay-redirect`; either is a path, which the browser resolves against the origin it is on.
function where({ location, redirect }: { location: string | null, redirect: string | null }, how: Post): string | null {
  expect(how === 'form' ? redirect : location).toBeNull()

  return how === 'form' ? location : redirect
}

describe('a post answered behind a TLS-terminating proxy', () => {
  for (const base of ['', '/repo']) {
    for (const dev of [false, true]) {
      for (const proxy of ['declared', 'none'] as const) {
        const label = `base ${base || 'unset'}, ${dev ? 'dev' : 'production'}, proxy ${proxy}`

        it(`goes back to the page as a path whichever way the proxy forwards the scheme, ${label}`, async () => {
          const app = await serve(site, { base, trailingSlash: 'never', dev, proxy })

          for (const how of ['form', 'swap'] as const) {
            for (const [name, headers] of Object.entries(FORWARDED)) {
              const answer = await addFrom(app, { how, page: `${base}/todos/1?sort=new`, headers })

              expect([name, answer.status, where(answer, how)]).toEqual([name, 303, `${base}/todos/1?sort=new`])
            }
          }
        })

        it(`names the page by kay_back, by x-kay-page and by the Referer alike, ${label}`, async () => {
          const app = await serve(site, { base, trailingSlash: 'never', dev, proxy })

          for (const how of ['form', 'swap'] as const) {
            const named = `${base}/about?x=1&y=2`

            expect(where(await addFrom(app, { how, back: named }), how)).toBe(named)
            expect(where(await addFrom(app, { how, referer: `${PUBLIC}${named}` }), how)).toBe(named)
            expect(where(await addFrom(app, { how, page: named }), how)).toBe(named)
            // Named by all three, the form's `kay_back` wins, then kay's script, which a plain form has none of, then the Referer.
            expect(where(await addFrom(app, { how, back: `${base}/about`, page: `${base}/todos/1` }), how)).toBe(`${base}/about`)
            expect(where(await addFrom(app, { how, page: `${base}/todos/1`, referer: `${PUBLIC}${base}/about` }), how)).toBe(how === 'swap' ? `${base}/todos/1` : `${base}/about`)
          }
        })
      }
    }
  }

  for (const trailingSlash of ['always', 'never', 'ignore'] as const) {
    it(`keeps the page's path as the browser has it, trailingSlash ${trailingSlash}`, async () => {
      const app = await serve(site, { base: '/repo', trailingSlash, dev: false, proxy: 'declared' })

      for (const how of ['form', 'swap'] as const) {
        for (const page of ['/repo/', '/repo/todos/1', '/repo/todos/1/', '/repo/todos/1/?a=b']) {
          expect(where(await addFrom(app, { how, page, headers: FORWARDED.proto! }), how)).toBe(page)
        }
      }
    })
  }

  it('counts an https site in kay.config.ts as the browser\'s scheme without any forwarded header', async () => {
    const app = await serve(site, { base: '', trailingSlash: 'never', dev: false, proxy: 'none', site: PUBLIC })

    for (const how of ['form', 'swap'] as const)
      expect(where(await addFrom(app, { how, page: '/about' }), how)).toBe('/about')
  })

  it('goes to the home page when no page is named, or when what names it is another site\'s', async () => {
    const app = await serve(site, { base: '', trailingSlash: 'never', dev: false, proxy: 'none' })

    for (const how of ['form', 'swap'] as const) {
      expect(where(await addFrom(app, { how, headers: FORWARDED.hostile! }), how)).toBe('/')
      expect(where(await addFrom(app, { how, referer: 'https://evil.example/x?y=1', headers: FORWARDED.hostile! }), how)).toBe('/')
      expect(where(await addFrom(app, { how, back: 'https://evil.example/x' }), how)).toBe('/')
      expect(where(await addFrom(app, { how, back: '//evil.example/x' }), how)).toBe('/')
      expect(where(await addFrom(app, { how, page: '//evil.example/x' }), how)).toBe('/')
      expect(where(await addFrom(app, { how, page: 'https://evil.example/x' }), how)).toBe('/')
    }
  })

  it('never lets a forwarded header from a client with no proxy in front name another host', async () => {
    const app = await serve(site, { base: '', trailingSlash: 'never', dev: false, proxy: 'none' })

    for (const how of ['form', 'swap'] as const) {
      const answer = await addFrom(app, { how, page: '/about', headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', 'forwarded': 'host=evil.example;proto=https' } })
      const target = where(answer, how)

      expect(target).toBe('/about')
      expect(URL.parse(target!)).toBeNull()
    }
  })

  it('leaves a redirect the action names to another origin as it is, a path of the site under the base', async () => {
    for (const base of ['', '/app']) {
      for (const dev of [false, true]) {
        const app = await serve(redirects, { base, trailingSlash: 'never', dev, proxy: 'declared' })
        const html = await (await app.handle(new Request(`${INTERNAL}/to`))).text()
        const action = (/action="([^"]*\/_kay\/action\/[^"]*)"/).exec(html)![1]!.slice(base.length)

        for (const how of ['form', 'swap'] as const) {
          for (const [to, expected] of [['https://other.example/x', 'https://other.example/x'], ['/dashboard?x=1', `${base}/dashboard?x=1`]] as const) {
            const form = new URLSearchParams({ to })
            const headers: Record<string, string> = { origin: PUBLIC, referer: `${PUBLIC}${base}/to`, ...FORWARDED.proto, ...(how === 'swap' ? { 'x-kay-navigate': '1', 'x-kay-page': `${base}/to` } : {}) }
            const response = await app.handle(new Request(`${INTERNAL}${action}`, { method: 'POST', headers, body: form }))

            expect(where({ location: response.headers.get('location'), redirect: response.headers.get('x-kay-redirect') }, how)).toBe(expected)
          }
        }
      }
    }
  })

  it('renders a refused post\'s page with a base the browser resolves on its own scheme, and goes back to it as a path', async () => {
    for (const base of ['', '/repo']) {
      const app = await serve(site, { base, trailingSlash: 'never', dev: false, proxy: 'declared' })
      const refused = await app.handle(new Request(`${INTERNAL}${ADD}`, { method: 'POST', headers: { 'origin': PUBLIC, 'referer': `${PUBLIC}${base}/?sort=new`, 'x-forwarded-proto': 'https' }, body: new URLSearchParams({ title: '' }) }))
      const html = await refused.text()

      expect(refused.status).toBe(422)
      expect(html).toContain(`<base href="${base}/?sort=new">`)
      expect(html).not.toContain('http://shop.example')
    }
  })
})
