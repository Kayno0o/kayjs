import type { RenderedPage } from '../src/check/seo'
import type { KayConfig } from '../src/config'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { readManifest } from '../src/server/client'
import { publicCacheRules } from '../src/server/public'

import { scratchBuild } from './prerendered'
import { fixtureCopy } from './scratch'

const ROOT = 'tests/fixtures/site-output'

async function appWith(options: Parameters<typeof pages>[0] = {}) {
  return pages({ routes: `${ROOT}/src/routes`, publicDir: `${ROOT}/public`, prebuilt: false, security: false, ...options })
}

async function fetchFrom(app: Awaited<ReturnType<typeof pages>>, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

describe('publicCache', () => {
  it('writes whole seconds, rounded up, for a sub-second or fractional duration', () => {
    const rules = publicCacheRules({ '/a/*': '250ms', '/b/*': '1.5s', '/c/*': '0.4s', '/d/*': '2m' })

    expect(['/a/x', '/b/x', '/c/x', '/d/x'].map(rules)).toEqual(['public, max-age=1', 'public, max-age=2', 'public, max-age=1', 'public, max-age=120'])
  })

  it('keeps a font for 30 days and an image for a day with no setting, and revalidates the rest', async () => {
    const app = await appWith({ dev: false })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=2592000')
    expect((await fetchFrom(app, '/img/logo.png')).headers.get('cache-control')).toBe('public, max-age=86400')
    expect((await fetchFrom(app, '/notes.txt')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('keeps the default by kind through a 304, under a base and with a setting for another path', async () => {
    const app = await appWith({ dev: false, base: '/docs', publicCache: { '/other/**': '1d' } })
    const first = await fetchFrom(app, '/fonts/a.woff2')
    const again = await fetchFrom(app, '/fonts/a.woff2', { 'if-none-match': first.headers.get('etag')! })

    expect(again.status).toBe(304)
    expect(again.headers.get('cache-control')).toBe('public, max-age=2592000')
  })

  it('revalidates a public font or image in development, so an edit shows at once', async () => {
    const app = await appWith({ dev: true })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect((await fetchFrom(app, '/img/logo.png')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('decides by the extension, whatever its case, and never keeps what must stay fresh', () => {
    const rules = publicCacheRules(undefined)
    const revalidate = 'public, max-age=0, must-revalidate'

    expect(['/A.PNG', '/x/f.WOFF2', '/favicon.ico', '/a.b.svg'].map(rules)).toEqual(['public, max-age=86400', 'public, max-age=2592000', 'public, max-age=86400', 'public, max-age=86400'])
    expect(['/sw.js', '/robots.txt', '/manifest.webmanifest', '/site.json', '/png', '/a.png.html', '/a.css', '/.well-known/x'].map(rules).every(control => control === revalidate)).toBe(true)
  })

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

  it('keeps revalidating the files a glob gives 0, whatever their kind', async () => {
    const app = await appWith({ publicCache: { '/fonts/**': 0, '**/*.png': 0 }, dev: false })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect((await fetchFrom(app, '/img/logo.png')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('refuses a duration that is not one', async () => {
    await expect(appWith({ publicCache: { '/x': 'forever' as '1d' }, dev: false })).rejects.toThrow('publicCache[\'/x\']')
  })

  it('refuses a duration that is none in development too', async () => {
    // A development server that fails to boot serves the reason instead.
    const html = await (await fetchFrom(await appWith({ publicCache: { '/x': -1 }, dev: true }), '/')).text()

    expect(html).toContain('Boot failed')
    expect(html).toContain('publicCache[')
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

  it('drops the default Allow when everything is disallowed, which would tie with it', async () => {
    expect(await text(await appWith({ site, robots: { disallow: ['/'] } }))).toBe('User-agent: *\nDisallow: /\n\nSitemap: https://x.example/sitemap.xml\n')
    expect(await text(await appWith({ site, base: '/docs', robots: { disallow: ['/'] } }))).toContain('Allow: /\nDisallow: /docs/\n')
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

describe('sitemap lastmod', () => {
  const site = 'https://x.example'
  const sitemap = async (options: Parameters<typeof pages>[0] = {}, url = 'http://localhost/sitemap.xml') => (await (await appWith({ site, ...options })).handle(new Request(url))).text()

  it('writes the lastmod a page gives each URL it lists, a Date as ISO and a date string as it is', async () => {
    const xml = await sitemap()

    expect(xml).toContain('<url><loc>https://x.example/posts/a</loc><lastmod>2026-03-04T10:00:00.000Z</lastmod></url>')
    expect(xml).toContain('<url><loc>https://x.example/posts/b</loc><lastmod>2026-05-06</lastmod></url>')
    expect(xml).toContain('<url><loc>https://x.example/posts/c</loc></url>')
    expect(xml).toContain('<url><loc>https://x.example/about</loc></url>')
  })

  it('lists a URL with none for a null, and stops the sitemap for a value that is no date', async () => {
    // A page module is imported once per path, so each value gets a copy of its own.
    const xml = async (lastmod: string) => {
      const root = await fixtureCopy('site-output')

      await Bun.write(`${root}/src/routes/posts/[slug].kay`, `--- server\nexport const page = { sitemap: [{ slug: 'a' }], lastmod: ${lastmod} }\n---\nh1 Post\n`)

      return (await (await appWith({ routes: `${root}/src/routes`, site })).handle(new Request('http://localhost/sitemap.xml'))).text()
    }

    expect(await xml('() => null')).toContain('<url><loc>https://x.example/posts/a</loc></url>')
    expect(await xml('\'2026-05-06T10:00:00+02:00\'')).toContain('<lastmod>2026-05-06T08:00:00.000Z</lastmod>')

    for (const hostile of ['\'2026-02-31\'', '\'2026-13-01\'', '\'2026-00-10\'', '\'2026-5-6\'', '\'2026-05-06T10:00:00\'', 'true', '\'soon\'', '{}', 'Number.NaN'])
      expect(await xml(hostile)).toBe('Internal Server Error')
  })

  it('keeps it with the trailing slash, the base and every locale\'s copy', async () => {
    const xml = await sitemap({ trailingSlash: 'always', base: '/docs', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: `${ROOT}/src/messages` } })

    expect(xml).toContain('<loc>https://x.example/docs/posts/a/</loc><lastmod>2026-03-04T10:00:00.000Z</lastmod><xhtml:link')
    expect(xml).toContain('<loc>https://x.example/docs/en/posts/a/</loc><lastmod>2026-03-04T10:00:00.000Z</lastmod>')
  })

  it('gives each host of a site by domain its own pages with the lastmod', async () => {
    const xml = await sitemap({ site: 'https://x.fr', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr', en: 'x.com' }, messages: `${ROOT}/src/messages` } }, 'http://x.com/sitemap.xml')

    expect(xml).toContain('<loc>https://x.com/posts/b</loc><lastmod>2026-05-06</lastmod>')
    expect(xml).not.toContain('<loc>https://x.fr')
  })
})

describe('theme color', () => {
  const THEME = /<meta name="theme-color"[^>]*>/g
  const themes = async (options: Parameters<typeof pages>[0], path = '/about') => (await (await fetchFrom(await appWith({ site: 'https://x.example', ...options }), path)).text()).match(THEME) ?? []

  it('writes one meta per colour scheme for a light and dark pair', async () => {
    expect(await themes({ seo: { themeColor: { light: '#fff', dark: '#111' } } })).toEqual([
      '<meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">',
      '<meta name="theme-color" content="#111" media="(prefers-color-scheme: dark)">',
    ])
  })

  it('takes one colour, and falls back to the manifest\'s', async () => {
    expect(await themes({ seo: { themeColor: '#123456' } })).toEqual(['<meta name="theme-color" content="#123456">'])
    expect(await themes({ manifest: { themeColor: '#654321' } })).toEqual(['<meta name="theme-color" content="#654321">'])
    expect(await themes({ seo: { themeColor: '#123456' }, manifest: { themeColor: '#654321' } })).toEqual(['<meta name="theme-color" content="#123456">'])
  })

  it('writes none by default, and lets a page replace the one of its scheme', async () => {
    expect(await themes({})).toEqual([])

    expect(await themes({ seo: { themeColor: { light: '#fff', dark: '#111' } } }, '/themed')).toEqual([
      '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">',
      '<meta name="theme-color" content="#111" media="(prefers-color-scheme: dark)">',
    ])
  })

  it('is the same under every locale', async () => {
    const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: `${ROOT}/src/messages` }

    expect(await themes({ i18n, seo: { themeColor: { light: '#fff', dark: '#111' } } }, '/en/about')).toHaveLength(2)
  })
})

describe('layout settings', () => {
  it('has a layout\'s noindex ask search engines to leave out every page under it, and the sitemap', async () => {
    const app = await appWith({ site: 'https://x.example' })

    expect(await (await fetchFrom(app, '/private')).text()).toContain('<meta name="robots" content="noindex">')
    expect(await (await fetchFrom(app, '/about')).text()).not.toContain('noindex')
    expect(await (await fetchFrom(app, '/sitemap.xml')).text()).not.toContain('/private')
  })

  it('has the page undo what its layout says', async () => {
    const root = await fixtureCopy('site-output')

    await Bun.write(`${root}/src/routes/private/open.kay`, '--- server\nexport const page = { noindex: false }\n---\nh1 Open\n')

    const app = await appWith({ routes: `${root}/src/routes`, site: 'https://x.example' })

    expect(await (await fetchFrom(app, '/private/open')).text()).not.toContain('noindex')
    expect(await (await fetchFrom(app, '/sitemap.xml')).text()).toContain('<loc>https://x.example/private/open</loc>')
    expect(await (await fetchFrom(app, '/sitemap.xml')).text()).not.toContain('<loc>https://x.example/private</loc>')
  })

  it('has a layout\'s noindex and search: false keep the pages under it out of the search index, and its revalidate set their period', async () => {
    const build = await scratchBuild()
    const rendered: RenderedPage[] = []

    try {
      await build.prerender({ routes: `${ROOT}/src/routes`, search: true, publicDir: `${ROOT}/public` }, { rendered })

      const byPath = new Map(rendered.map(page => [page.path, page]))

      expect(byPath.get('/private')).toMatchObject({ noindex: true, search: false })
      expect(byPath.get('/stale')).toMatchObject({ noindex: false, search: 1 })
      expect((await readManifest(process.cwd(), build.dir))!.pages!['/stale']!.revalidate).toBe(60)
    }
    finally {
      await build.remove()
    }
  })
})
