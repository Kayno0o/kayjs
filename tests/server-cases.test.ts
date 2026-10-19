import { beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'

// Pins what a page request answers (status, headers in order, body) on the paths the per-request work touches, so a change to that work shows any byte it moves.
const routes = 'tests/fixtures/server-cases/src/routes'
const messages = 'tests/fixtures/server-cases/src/messages'
const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages }

const sites = {
  plain: { trailingSlash: 'never' },
  slash: { trailingSlash: 'always' },
  based: { base: '/shop', trailingSlash: 'never' },
  basedSlash: { base: '/shop', trailingSlash: 'always' },
  locales: { i18n },
  basedLocales: { base: '/shop', i18n, trailingSlash: 'always' },
} as const

const PATHS = ['/', '/about', '/about/', '/caf%C3%A9', '/café', '/posts/first', '/posts/other', '/dyn/a%20b', '/dyn/%E2%82%AC', '/dyn//x', '/admin', '/admin/', '/nope', '/nope/deep', '/en', '/en/about', '/en/nope', '/fr/about', '/%2e%2e/about', '/a%2Fb', '/a%ZZ']

async function seen(response: Response) {
  // The request id and the build stamp change per run and per checkout: their presence and place stay.
  const headers = [...response.headers].map(([name, value]) => [name, name === 'x-request-id' || name === 'x-kay-build' ? '<set>' : value])

  return { status: response.status, headers, body: await response.text() }
}

describe.each(Object.entries(sites))('the page answers of a site with %s', (_name, options) => {
  let served: Elysia
  // A base sits before every path.
  const prefix = 'base' in options ? options.base : ''

  beforeAll(async () => {
    // One boot at a time: each builds the client bundle into the same `.kay`.
    served = new Elysia().use(await pages({ routes, prebuilt: false, site: 'https://x.example', ...options }))
  })

  it('answers every path as pinned', async () => {
    const app = served
    const answers: Record<string, unknown> = {}

    for (const path of PATHS) {
      for (const method of ['GET', 'HEAD']) {
        answers[`${method} ${path}`] = await seen(await app.handle(new Request(`http://localhost${prefix}${path}`, { method })))
      }
    }

    answers['GET /about as admin'] = await seen(await app.handle(new Request(`http://localhost${prefix}/admin`, { headers: { 'x-admin': '1' } })))
    answers['GET / compressed'] = await seen(await app.handle(new Request(`http://localhost${prefix}/`, { headers: { 'accept-encoding': 'gzip' } })))
    expect(answers).toMatchSnapshot()
  })

  it('answers the same twice', async () => {
    const app = served

    for (const path of ['/', '/posts/first', '/nope', '/admin']) {
      const first = await seen(await app.handle(new Request(`http://localhost${prefix}${path}`)))

      expect(await seen(await app.handle(new Request(`http://localhost${prefix}${path}`)))).toEqual(first)
    }
  })
})
