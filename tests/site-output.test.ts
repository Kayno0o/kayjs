import type { KayConfig } from '../src/config'
import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'

const ROOT = 'tests/fixtures/site-output'

async function appWith(options: Parameters<typeof pages>[0] = {}) {
  return pages({ routes: `${ROOT}/src/routes`, publicDir: `${ROOT}/public`, prebuilt: false, security: false, ...options })
}

async function fetchFrom(app: Awaited<ReturnType<typeof pages>>, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

describe('publicCache', () => {
  const publicCache: KayConfig['publicCache'] = { '/fonts/**': '365d', '**/*.png': '1d', '/img/*': '1h' }

  it('gives a public file the cache of the first pattern its path matches, and keeps revalidating the others', async () => {
    const app = await appWith({ publicCache, dev: false })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=31536000')
    // Both `**/*.png` and `/img/*` match: the first listed wins.
    expect((await fetchFrom(app, '/img/logo.png')).headers.get('cache-control')).toBe('public, max-age=86400')
    expect((await fetchFrom(app, '/notes.txt')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('keeps the etag, and a 304 carries the same cache', async () => {
    const app = await appWith({ publicCache, dev: false })
    const first = await fetchFrom(app, '/fonts/a.woff2')
    const again = await fetchFrom(app, '/fonts/a.woff2', { 'if-none-match': first.headers.get('etag')! })

    expect(again.status).toBe(304)
    expect(again.headers.get('cache-control')).toBe('public, max-age=31536000')
  })

  it('is ignored in development, so an edit shows at once', async () => {
    const app = await appWith({ publicCache, dev: true })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('refuses a duration that is not one', async () => {
    await expect(appWith({ publicCache: { '/x': 'forever' as '1d' }, dev: false })).rejects.toThrow('publicCache[\'/x\']')
  })

  it('applies under a base, whose mount point the proxy takes off', async () => {
    const app = await appWith({ publicCache, base: '/docs', dev: false })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=31536000')
  })
})

describe('robots', () => {
  const site = 'https://x.example'
  const text = async (app: Awaited<ReturnType<typeof pages>>, url = 'http://localhost/robots.txt') => (await app.handle(new Request(url))).text()

  it('keeps allowing everything and pointing at the sitemap when it is not configured', async () => {
    expect(await text(await appWith({ site }))).toBe('User-agent: *\nAllow: /\n\nSitemap: https://x.example/sitemap.xml\n')
  })

  it('lists the paths it disallows and allows, and keeps the sitemap line', async () => {
    const app = await appWith({ site, robots: { disallow: ['/private', '*.pdf$'], allow: ['/private/open'] } })

    expect(await text(app)).toBe('User-agent: *\nAllow: /\nAllow: /private/open\nDisallow: /private\nDisallow: *.pdf$\n\nSitemap: https://x.example/sitemap.xml\n')
  })

  it('serves none with false, leaving the path to the app', async () => {
    const app = await appWith({ site, robots: false })

    expect((await fetchFrom(app, '/robots.txt')).status).toBe(404)
    expect((await fetchFrom(app, '/sitemap.xml')).status).toBe(200)
  })

  it('puts the paths under the mount point', async () => {
    const app = await appWith({ site, base: '/docs', robots: { disallow: ['/private'] } })

    expect(await text(app)).toBe('User-agent: *\nAllow: /\nDisallow: /docs/private\n\nSitemap: https://x.example/docs/sitemap.xml\n')
  })

  it('lists a path in every locale of a site served by path', async () => {
    const app = await appWith({ site, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: `${ROOT}/src/messages` }, robots: { disallow: ['/private'] } })

    expect(await text(app)).toContain('Disallow: /private\nDisallow: /en/private\n')
  })

  it('lists a path in the locale of the host asking, with that host\'s sitemap', async () => {
    const app = await appWith({ site: 'https://x.fr', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr', en: 'x.com' }, messages: `${ROOT}/src/messages` }, robots: { disallow: ['/private'] } })

    expect(await text(app, 'http://x.com/robots.txt')).toBe('User-agent: *\nAllow: /\nDisallow: /private\n\nSitemap: https://x.com/sitemap.xml\n')
    expect(await text(app, 'http://x.fr/robots.txt')).toContain('Sitemap: https://x.fr/sitemap.xml\n')
  })

  it('refuses a rule that is no path, which a line break would make a rule of its own', async () => {
    await expect(appWith({ site, robots: { disallow: ['/a\nAllow: /'] } })).rejects.toThrow('robots.disallow')
    await expect(appWith({ site, robots: { disallow: ['admin'] } })).rejects.toThrow('robots.disallow')
  })

  it('gives way to a robots.txt in public/', async () => {
    const app = await appWith({ site, publicDir: 'tests/fixtures/seo/public', robots: { disallow: ['/private'] } })

    expect(await text(app)).toBe('User-agent: *\nDisallow: /private\n')
  })
})
