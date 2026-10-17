import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const FIXTURE = 'tests/fixtures/api-locale'
const routes = `${FIXTURE}/src/routes`
const api = `${FIXTURE}/src/api`
const i18n = { locales: ['en', 'fr'], defaultLocale: 'en', messages: `${FIXTURE}/src/messages` }
const sites = {
  plain: await testSite({ routes, api, islands: false, i18n }),
  prefixed: await testSite({ routes, api, islands: false, i18n: { ...i18n, prefixDefault: true } }),
  mounted: await testSite({ routes, api, islands: false, i18n, base: '/blog' }),
  single: await testSite({ routes, api, islands: false }),
}
const ORIGIN = 'http://localhost'
const FRENCH = { word: 'Refusé', t: 'Bonjour' }
const ENGLISH = { word: 'Refused', t: 'Hello' }

afterAll(async () => {
  await Promise.all(Object.values(sites).map(async site => site.close()))
})

async function read(site: typeof sites.plain, path: string, headers: Record<string, string> = {}) {
  const response = await site.fetch(path, { headers })

  return response.json() as Promise<{ word: string, t: string }>
}

describe('an API handler in the request\'s locale', () => {
  for (const [name, site, base, pages] of [['without a prefix on the default locale', sites.plain, '', { en: '/', fr: '/fr/x' }], ['with it', sites.prefixed, '', { en: '/en/x', fr: '/fr/x' }]] as const) {
    it(`reads the locale of the page it was called from, ${name}`, async () => {
      expect(await read(site, '/api/words', { referer: `${ORIGIN}${base}${pages.fr}` })).toEqual(FRENCH)
      expect(await read(site, '/api/words', { referer: `${ORIGIN}${base}${pages.en}` })).toEqual(ENGLISH)
    })
  }

  it('reads the browser\'s language under a base', async () => {
    expect(await read(sites.mounted, '/api/words', { 'accept-language': 'fr' })).toEqual(FRENCH)
    expect(await read(sites.mounted, '/api/words', { 'accept-language': 'en' })).toEqual(ENGLISH)
  })

  it('reads the locale of the page it was called from under a base', async () => {
    expect(await read(sites.mounted, '/api/words', { referer: `${ORIGIN}/blog/fr/x` })).toEqual(FRENCH)
    expect(await read(sites.mounted, '/api/words', { 'accept-language': 'fr', 'referer': `${ORIGIN}/blog/x` })).toEqual(ENGLISH)
    // A path that only starts like the base is no page of the site.
    expect(await read(sites.mounted, '/api/words', { 'accept-language': 'fr', 'referer': `${ORIGIN}/blogger/en/x` })).toEqual(FRENCH)
  })

  it('falls to the visitor\'s preference with no usable Referer, another origin\'s and a malformed one included', async () => {
    const site = sites.plain

    expect(await read(site, '/api/words', { 'accept-language': 'fr' })).toEqual(FRENCH)
    expect(await read(site, '/api/words', { 'accept-language': 'fr', 'referer': 'https://elsewhere.example/en/x' })).toEqual(FRENCH)
    expect(await read(site, '/api/words', { 'accept-language': 'fr', 'referer': 'not a url' })).toEqual(FRENCH)
    expect(await read(site, '/api/words', { referer: 'https://elsewhere.example/fr/x' })).toEqual(ENGLISH)
    expect(await read(site, '/api/words', { referer: 'not a url' })).toEqual(ENGLISH)
    expect(await read(site, '/api/words')).toEqual(ENGLISH)
    // The page it was called from wins over the browser's language.
    expect(await read(site, '/api/words', { 'accept-language': 'fr', 'referer': `${ORIGIN}/` })).toEqual(ENGLISH)
  })

  it('serves a site without i18n in its one language, whatever the request asks', async () => {
    const response = await sites.single.fetch('/api/words/plain', { headers: { 'accept-language': 'fr', 'referer': `${ORIGIN}/fr/x` } })

    expect(await response.json()).toEqual({ word: 'Refused' })
  })

  it('keeps the locale across an await, and two requests in flight apart', async () => {
    const [slowFrench, fastEnglish, fastFrench, slowEnglish] = await Promise.all([
      read(sites.plain, '/api/words/late?ms=40', { referer: `${ORIGIN}/fr/x` }),
      read(sites.plain, '/api/words/late?ms=5', { referer: `${ORIGIN}/` }),
      read(sites.plain, '/api/words/late?ms=10', { referer: `${ORIGIN}/fr/x` }),
      read(sites.plain, '/api/words/late?ms=30', { referer: `${ORIGIN}/` }),
    ])

    expect([slowFrench, fastFrench]).toEqual([FRENCH, FRENCH])
    expect([fastEnglish, slowEnglish]).toEqual([ENGLISH, ENGLISH])
  })

  it('reads the locale in a stream the handler answers', async () => {
    const stream = async (path: string) => (await sites.plain.fetch(path, { headers: { referer: `${ORIGIN}/fr/x` } })).text()

    expect(await stream('/api/words/stream')).toContain('Refus')
    expect(await stream('/api/words/generator')).toContain('Bonjour')
    expect(await (await sites.plain.fetch('/api/words/stream', { headers: { referer: `${ORIGIN}/` } })).text()).toContain('Refused')
  })

  it('reads the locale in the module\'s onError', async () => {
    const failed = async (path: string, referer: string) => (await sites.plain.fetch(path, { headers: { referer } })).json() as Promise<unknown>

    expect(await failed('/api/words/boom', `${ORIGIN}/fr/x`)).toEqual({ custom: 'Refusé' })
    expect(await failed('/api/words/boom', `${ORIGIN}/`)).toEqual({ custom: 'Refused' })
  })

  it('reads the locale in a route\'s own error hook', async () => {
    const own = async (referer: string) => (await sites.plain.fetch('/api/words/own-error', { headers: { referer } })).json() as Promise<unknown>

    expect(await own(`${ORIGIN}/fr/x`)).toEqual({ own: 'Refusé' })
    expect(await own(`${ORIGIN}/`)).toEqual({ own: 'Refused' })
  })
})
