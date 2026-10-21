import type { PagesOptions } from '../src/server/app'
import type { ClientBuild } from '../src/server/client'
import { describe, expect, it } from 'bun:test'
import { resolveProject } from '../src/project'
import { servePages } from '../src/server/app'
import { scratchDir } from './scratch'

const routes = 'tests/fixtures/i18n/src/routes'
const routing = 'tests/fixtures/routing/src/routes'
const content = 'tests/fixtures/content/src/content.config.ts'
const cards = { routes: 'tests/fixtures/cards/src/routes', fonts: [{ family: 'Archivo Black', src: 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff2' }] }
const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' }

// Serves `options` with a client loader that only counts, answering how many builds the server started and what it refused with.
async function refusal(options: PagesOptions): Promise<{ builds: number, message: string }> {
  let builds = 0
  const project = resolveProject(process.cwd(), { routes, prebuilt: false, security: false, ...options }, { dev: false, prebuilt: false, underKayDev: false })
  const loadClient = (): ClientBuild => {
    builds++

    throw new Error('a build started')
  }

  try {
    await servePages(project, loadClient)
  }
  catch (error) {
    return { builds, message: (error as Error).message }
  }

  throw new Error('the config was not refused')
}

describe('a refused config', () => {
  it.each([
    ['images.maxDensity', { images: { maxDensity: 0.5 } }, 'images.maxDensity is 0.5'],
    ['markdown.readingSpeed', { markdown: { readingSpeed: 0 } }, 'readingSpeed'],
    ['an i18n locale with no messages', { i18n: { ...i18n, locales: ['fr', 'de'] } }, 'so its messages go in'],
    ['cors origins', { cors: { origins: ['example.com'] } }, 'no origin'],
    ['cors credentials', { cors: { origins: '*', credentials: true } as never }, 'credentials'],
    ['health.timeout', { health: { timeout: 0 } }, 'health.timeout is'],
    ['requestIdHeader', { requestIdHeader: 'x-bad header' }, 'requestIdHeader is'],
    ['proxy', { proxy: {} }, 'kay: proxy'],
    ['a redirect from a page', { routes: routing, redirects: { '/about': '/bare' } }, 'the redirect from /about takes a path a page serves'],
    ['the manifest startUrl', { manifest: { startUrl: 'notes' } }, 'the manifest\'s startUrl is a path of the site'],
    ['an i18n path no page serves', { i18n: { ...i18n, paths: { '/contact': { en: '/reach-us' } } } }, 'translates /contact, which no page serves'],
    ['an i18n path another page takes', { i18n: { ...i18n, paths: { '/about': { en: '/' } } } }, 'are both served at / in en'],
    ['a content config that is missing', { content: 'tests/fixtures/content/src/missing.config.ts' }, 'there is no such file'],
    ['a feed without the site', { routes: 'tests/fixtures/content/src/routes', content }, 'has a feed, whose links need the site\'s URL'],
    ['images.card.background', { ...cards, images: { card: { background: 'white' } } }, 'images.card.background is white'],
    ['images.card.font', { ...cards, images: { card: { font: { family: 'Inter' } } } }, 'images.card.font names Inter'],
    ['images.card.logo', { ...cards, images: { card: { logo: 'tests/fixtures/cards/src/none.svg' } } }, 'which does not exist'],
  ] as [string, PagesOptions, string][])('starts no client build: %s', async (_, options, message) => {
    const refused = await refusal(options)

    expect(refused.message).toContain(message)
    expect(refused.builds).toBe(0)
  })
})

describe('a refused config naming a file of the project', () => {
  it('starts no client build for a public file at a page\'s path, or one a redirect takes', async () => {
    const dir = await scratchDir('refused-public-')

    await Bun.write(`${dir}/en/about`, 'shadowed')
    await Bun.write(`${dir}/old`, 'moved')

    const shadowed = await refusal({ publicDir: dir, i18n })

    expect(shadowed.message).toContain('and a page both serve /en/about')
    expect(shadowed.builds).toBe(0)

    const taken = await refusal({ routes: 'tests/fixtures/site/src/routes', publicDir: dir, redirects: { '/old': '/about' } })

    expect(taken.message).toContain('/old and the redirect from /old both serve /old')
    expect(taken.builds).toBe(0)
  })
})
