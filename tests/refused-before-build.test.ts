import type { PagesOptions } from '../src/server/app'
import type { ClientBuild } from '../src/server/client'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { resolveProject } from '../src/project'
import { servePages } from '../src/server/app'
import { MANIFEST } from '../src/server/favicon'
import { scratchDir } from './scratch'

const routes = 'tests/fixtures/i18n/src/routes'
const routing = 'tests/fixtures/routing/src/routes'
const content = 'tests/fixtures/content/src/content.config.ts'
const cards = { routes: 'tests/fixtures/cards/src/routes', fonts: [{ family: 'Archivo Black', src: 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff2' }] }
const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' }

// Serves `options` with a client loader that only counts, answering how many builds the server started and what it refused with.
async function refusal(options: PagesOptions, root = process.cwd()): Promise<{ builds: number, message: string }> {
  let builds = 0
  const project = resolveProject(root, { routes, prebuilt: false, security: false, ...options }, { dev: false, prebuilt: false, underKayDev: false })
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
    ['an mcp path a page serves', { routes: 'tests/fixtures/mcp-clash/src/routes', mcp: true }, '`mcp` both serve /mcp'],
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

describe('a refused config naming files of the project', () => {
  it('starts no client build for a public file on the public env module, or an endpoint a public file or a page serves', async () => {
    const dir = await scratchDir('refused-claims-')

    await Bun.write(`${dir}/public/_kay/env.js`, '')
    await Bun.write(`${dir}/public/llms.txt`, 'plain')

    const env = await refusal({ publicDir: `${dir}/public`, publicEnv: t.Object({}) })

    expect(env.message).toContain('`publicEnv` and')
    expect(env.message).toContain('both serve /_kay/env.js')
    expect(env.builds).toBe(0)

    const file = await refusal({ routes: 'tests/fixtures/endpoints/src/routes', publicDir: `${dir}/public` })

    expect(file.message).toContain('llms.txt.ts and the public file')
    expect(file.builds).toBe(0)

    await Bun.write(`${dir}/routes/data.json.kay`, 'h1 Data\n')
    await Bun.write(`${dir}/routes/data.json.ts`, 'export function GET() { return {} }\n')

    const page = await refusal({ routes: `${dir}/routes` })

    expect(page.message).toContain('data.json.kay and')
    expect(page.message).toContain('data.json.ts both serve /data.json')
    expect(page.builds).toBe(0)
  })

  it('refuses an s.Public field named as a secret, and one in a .kay file', async () => {
    const dir = await scratchDir('refused-public-')
    const env = (name: string) => `import { s } from 'kay'\nimport { defineEnv } from 'kay/server'\n\nexport const env = defineEnv(s.Object({ ${name}: s.Public(s.String({ default: 'x' })) }))\n`

    await Bun.write(`${dir}/src/env.ts`, env('STRIPE_SECRET'))
    await Bun.write(`${dir}/routes/index.kay`, 'h1 Home\n')

    const secret = await refusal({ routes: `${dir}/routes`, publicEnv: { type: 'object', properties: {} } as never }, dir)

    expect(secret.message).toContain('s.Public declares STRIPE_SECRET')
    expect(secret.builds).toBe(0)

    await rm(`${dir}/src/env.ts`)
    await Bun.write(`${dir}/src/map.kay`, '---\nimport { s } from \'kay\'\nconst field = s.Public(s.String())\n---\nh1 Map\n')

    const fence = await refusal({ routes: `${dir}/routes`, publicEnv: { type: 'object', properties: {} } as never }, dir)

    expect(fence.message).toContain('src/map.kay declares an s.Public field')
    expect(fence.builds).toBe(0)
  })

  it('refuses an endpoint the router cannot answer, and a page name first when both scans reject', async () => {
    const dir = await scratchDir('refused-scans-')

    await Bun.write(`${dir}/routes/index.kay`, 'h1 Home\n')
    await Bun.write(`${dir}/routes/[...rest].json.ts`, 'export function GET() { return {} }\n')

    const endpoint = await refusal({ routes: `${dir}/routes` })

    expect(endpoint.message).toContain('answers one path per set of params')
    expect(endpoint.builds).toBe(0)

    await Bun.write(`${dir}/routes/a:b.kay`, 'h1 Colon\n')

    const both = await refusal({ routes: `${dir}/routes` })

    expect(both.message).toContain('has a :, * or \' in its name')
    expect(both.builds).toBe(0)
  })

  it('checks the manifest only where nothing else serves it', async () => {
    const dir = await scratchDir('refused-manifest-')

    await Bun.write(`${dir}/public/${MANIFEST.slice(1)}`, '{}')

    const favicon = 'tests/fixtures/cards/src/logo.svg'
    const held = await refusal({ publicDir: `${dir}/public`, favicon, manifest: { startUrl: 'notes' } })
    const redirected = await refusal({ favicon, redirects: { [MANIFEST]: '/about' }, manifest: { startUrl: 'notes' } })
    const made = await refusal({ favicon, manifest: { startUrl: 'notes' } })

    expect(held.message).toBe('a build started')
    expect(redirected.message).toBe('a build started')
    expect(made.message).toContain('the manifest\'s startUrl is a path of the site')
    expect(made.builds).toBe(0)
  })
})
