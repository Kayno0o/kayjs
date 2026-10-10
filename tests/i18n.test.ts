import type { I18nConfig } from '../src/config'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { check } from '../src/check'
import { flattenMessages, localePath, textDirection, translate, untranslatedPath } from '../src/runtime/i18n'
import { pages } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { acceptedLocale, localeSettings, requestLocale } from '../src/server/i18n'
import { prerenderPages } from '../src/server/prerender'

const FIXTURE = 'tests/fixtures/i18n'
const routes = `${FIXTURE}/src/routes`
const messages = `${FIXTURE}/src/messages`
const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages }
const app = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.example', i18n }))

async function get(path: string, served: { handle: (request: Request) => Promise<Response> } = app, headers: Record<string, string> = {}): Promise<{ status: number, html: string, location: string | null, cookie: string | null, vary: string | null, etag: string | null }> {
  const response = await served.handle(new Request(path.startsWith('http') ? path : `http://localhost${path}`, { headers }))

  return { status: response.status, html: await response.text(), location: response.headers.get('location'), cookie: response.headers.get('set-cookie'), vary: response.headers.get('vary'), etag: response.headers.get('etag') }
}

describe('locale prefixes', () => {
  it('serve the default locale unprefixed and every other under its prefix', async () => {
    const french = await get('/')
    const english = await get('/en')

    expect(french.html).toContain('<html lang="fr">')
    expect(french.html).toContain('<h1>Bonjour Ada</h1>')
    expect(french.html).toContain('<p class="locale">fr</p>')
    expect(english.html).toContain('<html lang="en">')
    expect(english.html).toContain('<h1>Hello Ada</h1>')
    expect((await get('/en/about')).html).toContain('<h1>About</h1>')
    expect((await get('/about')).html).toContain('<h1>À propos</h1>')
  })

  it('build links in the page\'s locale, and the same page in another', async () => {
    const { html } = await get('/en/about')

    expect(html).toContain('<a class="home" href="/en">Home</a>')
    expect(html).toContain('<a class="about" href="/en/about" aria-current="page">About</a>')
    expect(html).toContain('<a class="fr" href="/about">FR</a>')
    expect(html).toContain('<a class="en" href="/en/about" aria-current="page">EN</a>')
  })

  it('format plurals, numbers and dates through Intl', async () => {
    const french = await get('/')
    const english = await get('/en')

    expect(french.html).toContain('<p class="items">Aucun article / 1 article / 1 234 articles</p>')
    expect(english.html).toContain('<p class="items">No items / 1 item / 1,234 items</p>')
    expect(english.html).toContain('<p class="price">€1,234.50</p>')
    expect(english.html).toContain('<p class="saved">Saved on Oct 4, 2026</p>')
  })

  it('format relative times in the largest unit they reach, lists, and say which way a locale runs', async () => {
    const french = await get('/')
    const english = await get('/en')

    expect(french.html).toContain('<p class="ago">il y a 3 jours / hier / dans 2 heures / dans 2 semaines</p>')
    expect(english.html).toContain('<p class="ago">3 days ago / yesterday / in 2 hours / in 2 weeks</p>')
    expect(french.html).toContain('<p class="listed">Ada, Grace et Linus</p>')
    expect(english.html).toContain('<p class="listed">Ada, Grace, and Linus</p>')
    expect(english.html).toContain('<p class="direction">ltr rtl</p>')
  })

  it('write dir="rtl" on a page in a locale written right to left, and nothing on one written left to right', async () => {
    expect(['ar', 'he', 'fa-IR', 'ur', 'yi', 'en', 'fr', 'az-Arab', 'zz-invalid-tag-!'].map(textDirection)).toEqual(['rtl', 'rtl', 'rtl', 'rtl', 'rtl', 'ltr', 'ltr', 'rtl', 'ltr'])

    const arabic = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.example', i18n: { ...i18n, locales: ['fr', 'ar'], messages: `${FIXTURE}/rtl-messages` } }))

    expect((await get('/ar', arabic)).html).toContain('<html lang="ar" dir="rtl">')
    expect((await get('/', arabic)).html).toContain('<html lang="fr">')
  })

  it('send an island only the messages it uses', async () => {
    const { html } = await get('/en')

    expect(html).toContain('<script type="application/json" data-kay-i18n>{"locale":"en","settings":{"locales":["fr","en"],"defaultLocale":"fr","prefixDefault":false},"messages":{"counter.label":"Counter"}}</script>')
    expect(html).toContain('<button><!--[-->Counter<!--]--> <!--[-->0<!--]--></button>')
  })

  it('keep the locale in a streamed block, which brings its islands\' messages', async () => {
    const { html } = await get('/en/streamed')

    expect(html).toContain('<p class="later">Home later</p>')
    expect(html).toContain('<script type="application/json" data-kay-i18n>{"locale":"en","settings":{"locales":["fr","en"],"defaultLocale":"fr","prefixDefault":false},"messages":{"counter.label":"Counter"}}</script>')
  })

  it('list every locale\'s copy of a page in the head and the sitemap', async () => {
    const { html } = await get('/en/about')

    expect(html).toContain('<link rel="canonical" href="https://x.example/en/about">')
    expect(html).toContain('<link rel="alternate" hreflang="fr" href="https://x.example/about">')
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://x.example/en/about">')
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://x.example/about">')

    const sitemap = (await get('/sitemap.xml')).html

    expect(sitemap).toContain('<url><loc>https://x.example/en/about</loc><xhtml:link rel="alternate" hreflang="fr" href="https://x.example/about"/><xhtml:link rel="alternate" hreflang="en" href="https://x.example/en/about"/><xhtml:link rel="alternate" hreflang="x-default" href="https://x.example/about"/></url>')
    expect(sitemap).toContain('<loc>https://x.example/about</loc>')
  })

  it('refuse a page under a locale\'s prefix, and a config no request could be served by', async () => {
    const dir = join(process.cwd(), routes, 'en')

    try {
      await Bun.write(join(dir, 'x.kay'), 'p x\n')
      await expect(pages({ routes, prebuilt: false, i18n })).rejects.toThrow('under the prefix of the locale en')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }

    expect(() => localeSettings({ locales: ['fr'], defaultLocale: 'en' })).toThrow('defaultLocale en is not one of its locales')
    expect(() => localeSettings({ locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr' } })).toThrow('none to en')
    expect(() => localeSettings({ locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr', en: 'x.com' }, prefixDefault: true })).toThrow('domains or prefixDefault')
    await expect(pages({ routes, prebuilt: false, i18n: { ...i18n, locales: ['fr', 'de'] } })).rejects.toThrow('so its messages go in')
  })
})

describe('the default locale prefixed', () => {
  it('sends an unprefixed path to the visitor\'s locale: their cookie, then their browser\'s languages', async () => {
    const prefixed = new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true } }))

    expect(await get('/about?x=1', prefixed, { 'accept-language': 'en-US,en;q=0.9,fr;q=0.5' })).toMatchObject({ status: 307, location: '/en/about?x=1' })
    expect(await get('/about', prefixed, { 'accept-language': 'en', 'cookie': 'kay-locale=fr' })).toMatchObject({ status: 307, location: '/fr/about' })
    expect(await get('/', prefixed, { 'accept-language': 'de' })).toMatchObject({ status: 307, location: '/fr' })
    // Only a visitor following a link of the site chose a locale; a first visit, a crawler or a cache filling stays cacheable.
    const same = { 'sec-fetch-site': 'same-origin' }

    expect((await get('/fr/about', prefixed, same)).cookie).toBe('kay-locale=fr; Path=/; Max-Age=31536000; SameSite=Lax')
    expect((await get('/fr/about', prefixed)).cookie).toBeNull()
    expect((await get('/fr/about', prefixed, { ...same, cookie: 'kay-locale=fr' })).cookie).toBeNull()
    expect((await get('/fr/nope', prefixed, same)).cookie).toBeNull()
  })

  it('answers a path no page serves in the visitor\'s locale, varying on what chose it', async () => {
    const prefixed = new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true } }))
    const missing = await get('/nope', prefixed, { 'accept-language': 'en' })

    expect(missing).toMatchObject({ status: 404, vary: 'cookie, accept-language' })
    expect(missing.html).toContain('<h1 class="missing">Home</h1>')
    expect((await get('/fr/nope', prefixed)).html).toContain('<h1 class="missing">Accueil</h1>')
  })
})

describe('locales by domain', () => {
  it('serve each host its locale, linking to another locale on its own host', async () => {
    const domains = new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: { ...i18n, domains: { fr: 'x.fr', en: 'x.com' } } }))
    const english = await get('http://x.com/about', domains)

    expect(english.html).toContain('<h1>About</h1>')
    expect(english.html).toContain('<a class="fr" href="//x.fr/about">FR</a>')
    expect(english.html).toContain('<a class="en" href="/about" aria-current="page">EN</a>')
    expect((await get('http://x.fr/about', domains)).html).toContain('<h1>À propos</h1>')
    expect((await get('http://elsewhere.example/about', domains)).html).toContain('<h1>À propos</h1>')
  })

  it('give each host a sitemap of its own pages, each linking its copies on the other hosts', async () => {
    const domains = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.fr', i18n: { ...i18n, domains: { fr: 'x.fr', en: 'x.com' } } }))
    const english = (await get('http://x.com/sitemap.xml', domains)).html

    expect(english).toContain('<url><loc>https://x.com/about</loc><xhtml:link rel="alternate" hreflang="fr" href="https://x.fr/about"/><xhtml:link rel="alternate" hreflang="en" href="https://x.com/about"/><xhtml:link rel="alternate" hreflang="x-default" href="https://x.fr/about"/></url>')
    expect(english).not.toContain('<loc>https://x.fr/')
    expect((await get('http://x.fr/sitemap.xml', domains)).html).toContain('<loc>https://x.fr/about</loc>')
  })
})

describe('translated paths', () => {
  const paths = { '/about': { fr: '/a-propos', en: '/about-us' }, '/blog/:slug': { en: '/articles/:slug' } }
  const translated = { ...i18n, paths }

  it('serve a page at its path in each locale, links and the locale switcher following', async () => {
    const served = new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: translated }))
    const english = await get('/en/about-us', served)

    expect(english.html).toContain('<h1>About</h1>')
    expect(english.html).toContain('<a class="about" href="/en/about-us" aria-current="page">About</a>')
    expect(english.html).toContain('<a class="fr" href="/a-propos">FR</a>')
    expect((await get('/a-propos', served)).html).toContain('<h1>À propos</h1>')
    expect((await get('/en/articles/hello', served)).html).toContain('<h1 class="post">hello</h1>')
    expect((await get('/en/articles/hello', served)).html).toContain('<a class="fr" href="/blog/hello">FR</a>')
    expect((await get('/blog/hello', served)).html).toContain('<h1 class="post">hello</h1>')
  })

  it('send a locale\'s untranslated path to its translation', async () => {
    const served = new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: translated }))

    expect(await get('/en/about?x=1', served)).toMatchObject({ status: 308, location: '/en/about-us?x=1' })
    expect(await get('/about', served)).toMatchObject({ status: 308, location: '/a-propos' })
    expect(await get('/en/blog/hello', served)).toMatchObject({ status: 308, location: '/en/articles/hello' })
    expect((await get('/en/a-propos', served)).status).toBe(404)
  })

  it('serve a host only its own locale\'s paths, and list them in the sitemap', async () => {
    const domains = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.fr', i18n: { ...translated, domains: { fr: 'x.fr', en: 'x.com' } } }))
    const english = await get('http://x.com/about-us', domains)

    expect(english.html).toContain('<h1>About</h1>')
    expect(english.html).toContain('<a class="fr" href="//x.fr/a-propos">FR</a>')
    expect(await get('http://x.com/about', domains)).toMatchObject({ status: 308, location: '/about-us' })
    expect((await get('http://x.fr/about-us', domains)).status).toBe(404)
    expect((await get('http://x.fr/a-propos', domains)).html).toContain('<h1>À propos</h1>')
    expect((await get('http://x.com/sitemap.xml', domains)).html).toContain('<url><loc>https://x.com/about-us</loc><xhtml:link rel="alternate" hreflang="fr" href="https://x.fr/a-propos"/><xhtml:link rel="alternate" hreflang="en" href="https://x.com/about-us"/>')
  })

  it('carry params, the query and a trailing slash, the most named pattern winning', () => {
    const settings = localeSettings({ ...i18n, paths: { '/blog/:slug': { en: '/articles/:slug' }, '/blog/new': { en: '/write' }, '/docs/*': { en: '/guide/*' }, '/archive/:page?': { en: '/past/:page?' }, '/about': { fr: '/à-propos' } } })

    expect(localePath(settings, '/blog/hello?ref=1#top', 'en')).toBe('/en/articles/hello?ref=1#top')
    expect(localePath(settings, '/blog/new', 'en')).toBe('/en/write')
    expect(localePath(settings, '/docs/a/b/', 'en')).toBe('/en/guide/a/b/')
    expect(localePath(settings, '/archive', 'en')).toBe('/en/past')
    expect(localePath(settings, '/archive/2', 'en')).toBe('/en/past/2')
    expect(localePath(settings, '/about', 'fr')).toBe('/%C3%A0-propos')
    expect(untranslatedPath(settings, '/%C3%A0-propos', 'fr')).toBe('/about')
    expect(untranslatedPath(settings, '/articles/hello', 'en')).toBe('/blog/hello')
    expect(untranslatedPath(settings, '/articles/hello', 'fr')).toBe('/articles/hello')
  })

  it('refuse a translation whose params are not the page\'s, or that another page of its locale takes', async () => {
    expect(() => localeSettings({ ...i18n, paths: { '/blog/:slug': { en: '/articles/:id' } } })).toThrow('whose params are not the page\'s')
    expect(() => localeSettings({ ...i18n, paths: { '/about': { de: '/uber' } } })).toThrow('de, which is not one of its locales')
    await expect(pages({ routes, prebuilt: false, security: false, i18n: { ...i18n, paths: { '/contact': { en: '/reach-us' } } } })).rejects.toThrow('translates /contact, which no page serves')
    await expect(pages({ routes, prebuilt: false, security: false, i18n: { ...i18n, paths: { '/about': { en: '/' } } } })).rejects.toThrow('are both served at / in en')
  })
})

describe('locale detection', () => {
  it('matches Accept-Language by tag, then by language, by quality', () => {
    expect(acceptedLocale(['fr', 'en'], 'de-DE, en-GB;q=0.8, fr;q=0.9')).toBe('fr')
    expect(acceptedLocale(['fr', 'en-GB'], 'en-US')).toBe('en-GB')
    expect(acceptedLocale(['fr', 'en'], 'de, *;q=0.5')).toBeUndefined()
    expect(acceptedLocale(['fr', 'en'], 'en;q=0, fr;q=0.1')).toBe('fr')
  })

  it('runs an action in the locale of the page it was sent from', () => {
    const settings = localeSettings(i18n)
    const from = (referer: string, headers: Record<string, string> = {}) => requestLocale(settings, new Request('http://localhost/_kay/action/x', { headers: { referer, ...headers } }))

    expect(from('http://localhost/en/about')).toBe('en')
    expect(from('http://localhost/about', { 'accept-language': 'en' })).toBe('fr')
    expect(from('http://elsewhere.example/en/about', { 'accept-language': 'en' })).toBe('en')
    // A post from the page a refused post answered, whose form names it.
    expect(requestLocale(settings, new Request('http://localhost/_kay/action/x', { headers: { referer: 'http://localhost/_kay/action/x' } }), 'http://localhost/en/about')).toBe('en')
  })

  it('falls back to the default locale\'s message, then fails on a key no locale has, which production shows as itself', () => {
    const fallback = flattenMessages({ a: 'A', b: { c: 'C {n}' } })
    const translations = { locale: 'en', messages: new Map(), fallback }
    const mode = process.env.NODE_ENV

    expect(translate(translations, 'b.c', { n: 2 })).toBe('C 2')
    expect(() => translate(translations, 'missing')).toThrow('kay: no locale has the message "missing"')

    try {
      process.env.NODE_ENV = 'production'
      expect(translate(translations, 'missing')).toBe('missing')
    }
    finally {
      if (mode === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = mode
    }
  })

  it('fails the render of a page asking for a computed key no locale has, as a test serving it sees', async () => {
    const page = join(routes, 'computed.kay')

    await Bun.write(page, '--- server\nimport { t } from \'kay/i18n\'\n\nconst state = [\'drafted\'][0]!\nconst label = t(`status.${state}` as never)\n---\np {label}\n')

    try {
      const served = new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n, onError: () => undefined }))

      expect((await get('/computed', served)).status).toBe(500)
    }
    finally {
      await rm(page, { force: true })
    }
  })
})

describe('prerendering', () => {
  async function prerendered(config: I18nConfig, check: () => Promise<void>): Promise<void> {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      expect(await prerenderPages(root, { routes, i18n: config }, (await readClient(root))!)).toBe(2)
      await check()
    }
    finally {
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  }

  it('renders a page once per locale, each served back from its file', async () => {
    await prerendered(i18n, async () => {
      expect(await Bun.file(join(process.cwd(), '.kay/client/pages/index.html')).text()).toContain('<h1>Bonjour Ada</h1>')
      expect(await Bun.file(join(process.cwd(), '.kay/client/pages/en.html')).text()).toContain('<h1>Hello Ada</h1>')

      const built = new Elysia().use(await pages({ routes, prebuilt: true, security: false, i18n }))
      const english = await get('/en', built)

      expect(english.html).toContain('<h1>Hello Ada</h1>')
      expect(english.etag).not.toBeNull()
    })
  })

  it('keeps each domain\'s copy apart, served to its host', async () => {
    const domains = { ...i18n, domains: { fr: 'x.fr', en: 'x.com' } }

    await prerendered(domains, async () => {
      const built = new Elysia().use(await pages({ routes, prebuilt: true, security: false, i18n: domains }))
      const english = await get('http://x.com/', built)
      const french = await get('http://x.fr/', built)

      expect(english.html).toContain('<h1>Hello Ada</h1>')
      expect(french.html).toContain('<h1>Bonjour Ada</h1>')
      expect(english.etag).not.toBeNull()
      expect(english.etag).not.toBe(french.etag)
    })
  })
})

describe('kay check', () => {
  it('types t() from the default locale\'s messages and reports a locale that strays from them', async () => {
    expect(await check(FIXTURE, { i18n: { ...i18n, messages: undefined } })).toEqual([])
    // Unprefixed links stay valid with every locale prefixed: the server sends them on to the visitor's.
    expect(await check(FIXTURE, { i18n: { ...i18n, messages: undefined, prefixDefault: true } })).toEqual([])

    const english = join(FIXTURE, 'src/messages/en.ts')
    const page = join(FIXTURE, 'src/routes/typo.kay')
    const source = await Bun.file(english).text()

    try {
      await Bun.write(english, source.replace('  greeting: \'Hello {name}\',\n', '').replace('Saved on {date}', 'Saved on {day}').replace('counter: { label: \'Counter\', more: \'More\' }', 'counter: { label: \'Counter\', more: \'More\', less: \'Less\' }'))
      await Bun.write(page, '--- server\nimport { t } from \'kay/i18n\'\n\nconst a = t(\'nav.hom\')\nconst b = t(\'greeting\')\nconst c = t(\'greeting\', { nom: \'Ada\' })\nconst d = t(\'items\', { count: \'2\' })\n---\np {a} {b} {c} {d}\n')

      const diagnostics = (await check(FIXTURE, { i18n: { ...i18n, messages: undefined } })).map(({ file, line, message }) => ({ file: file.slice(file.indexOf(FIXTURE)), line, message }))

      expect(diagnostics).toContainEqual({ file: english, line: 1, message: 'lacks greeting, which src/messages/fr.ts has' })
      expect(diagnostics).toContainEqual({ file: english, line: 7, message: 'gives saved without {date}, which src/messages/fr.ts has' })
      expect(diagnostics).toContainEqual({ file: english, line: 7, message: 'gives saved a {day}, which src/messages/fr.ts has not, so nothing fills it' })
      expect(diagnostics).toContainEqual({ file: english, line: 6, message: 'has counter.less, which src/messages/fr.ts lacks, so no `t()` can name it' })
      expect(diagnostics.filter(diagnostic => diagnostic.file === page).map(diagnostic => diagnostic.line)).toEqual([4, 5, 6, 7])
    }
    finally {
      await Bun.write(english, source)
      await rm(page, { force: true })
    }
  })

  it('checks a link against the path its locale gives the page, and reports a translation another page takes', async () => {
    const paths = { '/about': { en: '/about-us' } }
    const page = join(FIXTURE, 'src/routes/links.kay')

    try {
      await Bun.write(page, 'a(href="/en/about-us") About\na(href="/a-propos") À propos\na(href="/en/about") About\n')

      const diagnostics = (await check(FIXTURE, { i18n: { ...i18n, messages: undefined, paths } })).map(({ file, line, message }) => ({ file: file.slice(file.indexOf(FIXTURE)), line, message }))

      expect(diagnostics.filter(diagnostic => diagnostic.file === page).map(diagnostic => diagnostic.line)).toEqual([2, 3])
    }
    finally {
      await rm(page, { force: true })
    }

    const clash = await check(FIXTURE, { i18n: { ...i18n, messages: undefined, paths: { '/about': { en: '/' } } } })

    expect(clash.map(({ message }) => message)).toContainEqual(expect.stringContaining('are both served at / in en'))
  })

  it('reports a locale config no request could be served by, at the config', async () => {
    const diagnostics = await check(FIXTURE, { i18n: { locales: ['fr'], defaultLocale: 'en' } })

    expect(diagnostics.map(({ file, message }) => ({ file: file.slice(file.indexOf(FIXTURE)), message }))).toContainEqual({ file: `${FIXTURE}/kay.config.ts`, message: 'kay: i18n\'s defaultLocale en is not one of its locales: fr' })
  })
})

describe('in the browser', () => {
  it('reads the messages the page sent, those of a streamed part included', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/en/about-us' })

    try {
      const { alternate, formatNumber, localize, t } = await import('../src/runtime/i18n.client')
      const payload = { locale: 'en', settings: localeSettings({ ...i18n, paths: { '/about': { fr: '/a-propos', en: '/about-us' } } }), messages: { 'counter.label': 'Counter' } }

      document.head.innerHTML = `<script type="application/json" data-kay-i18n>${JSON.stringify(payload)}</script>`

      expect(t('counter.label')).toBe('Counter')
      expect(localize('/about')).toBe('/en/about-us')
      expect(localize('/')).toBe('/en')
      expect(alternate('fr')).toBe('/a-propos')
      expect(formatNumber(1234)).toBe('1,234')

      document.body.innerHTML = '<script type="application/json" data-kay-i18n>{"messages":{"items":{"one":"{count} item","other":"{count} items"}}}</script>'

      expect(t('items', { count: 2 })).toBe('2 items')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})
