import type { RouterShape } from '../src/server/params'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { slashSpelling } from '../src/server/params'
import { canonicalPath, decodePath, guardUrl } from '../src/server/routes'
import { pages } from './shared-pages'

// Pins what a page request answers (status, headers in order, body) on the paths the per-request work touches, so a change to that work shows any byte it moves.
const messages = resolve('tests/fixtures/server-cases/src/messages')
const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages }

const sites = {
  plain: { trailingSlash: 'never' },
  slash: { trailingSlash: 'always' },
  based: { base: '/shop', trailingSlash: 'never' },
  basedSlash: { base: '/shop', trailingSlash: 'always' },
  locales: { i18n },
  basedLocales: { base: '/shop', i18n, trailingSlash: 'always' },
} as const

const PATHS = ['/', '/about', '/about/', '/caf%C3%A9', '/café', '/posts/first', '/posts/other', '/dyn/a%20b', '/dyn/%E2%82%AC', '/dyn//x', '/search?n=2', '/search?n=0', '/search', '/search?n=2', '/admin', '/admin/', '/nope', '/nope/deep', '/en', '/en/about', '/en/nope', '/fr/about', '/%2e%2e/about', '/a%2Fb', '/a%ZZ']

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
    served = new Elysia().use(await pages({ root: 'tests/fixtures/server-cases', prebuilt: false, site: 'https://x.example', ...options }))
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

// What the path helpers answer for plain and odd paths, so the shortcut for a plain path is the long way's answer.
describe('the path spellings', () => {
  const PATHS = ['/', '/a', '/a/', '/a//', '//a', '//', '/a/b/c', '/a%2Fb', '/a%40b', '/%61dmin', '/caf%C3%A9', '/a@b', '/a!b~c*d\'e(f)', '/a.b', '/a%ZZ', '/100%', '/a;b,c', '/a+b', '/a=b&c', '/$', '/a%5Cb', '/%E2%82%AC']
  const reference = (pathname: string) => pathname.split('/').map(segment => encodeURIComponent(decodePath(segment) ?? segment)).join('/')

  it('canonicalPath keeps plain text and spells the rest as the build does', () => {
    for (const path of PATHS)
      expect(canonicalPath(path)).toBe(reference(path))
  })

  it('guardUrl reads each path one way', () => {
    const expected: Record<string, string> = { '/a': '/a', '//a': '/a', '/%61dmin': '/admin', '/a%2Fb': '/a%2Fb', '/a%40b': '/a@b', '/caf%C3%A9': '/caf%C3%A9', '/a%5Cb': '/a%5Cb', '/100%25': '/100%25', '/a//': '/a//' }

    for (const [path, spelled] of Object.entries(expected))
      expect(guardUrl(`http://localhost${path}`).pathname).toBe(spelled)
  })

  it('slashSpelling leaves a path spelled as wanted, and spells the others the way wanted', () => {
    const plain = { path: '/a' } as RouterShape
    const rest = { path: '/a/*' } as RouterShape

    for (const [path, never, always] of [['/a', '/a', '/a/'], ['/a/', '/a', '/a/'], ['/a//', '/a', '/a/'], ['//a', '/a', '/a/'], ['//a//', '/a', '/a/'], ['/', '/', '/']] as const) {
      expect([slashSpelling(path, plain, 'never'), slashSpelling(path, plain, 'always')]).toEqual([never, always])
      expect(slashSpelling(path, plain, 'ignore')).toBe(path)
    }

    expect([slashSpelling('/a', rest, 'never'), slashSpelling('/a/', rest, 'never'), slashSpelling('/a/b', rest, 'never'), slashSpelling('/a/b/', rest, 'never')]).toEqual(['/a/', '/a/', '/a/b', '/a/b'])
  })
})
