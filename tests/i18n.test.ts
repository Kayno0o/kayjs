import type { I18nConfig, KayConfig } from '../src/config'
import type { ScratchBuild } from './prerendered'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, jest, spyOn } from 'bun:test'
import { Elysia, t } from 'elysia'
import { chromium } from 'playwright-core'
import { check } from '../src/check'
import { compileKay } from '../src/compiler'
import { islandMessages } from '../src/compiler/codegen'
import { collection } from '../src/content'
import { ContentError } from '../src/content/validate'
import { flattenMessages, localeName, localePath, localizedLink, textDirection, translate, untranslatedPath } from '../src/runtime/i18n'
import { relativeTime } from '../src/runtime/i18n.server'
import { runInLocale } from '../src/runtime/locale-state'
import { pages } from '../src/server'
import { acceptedLocale, localeSettings, messagesScript, requestLocale } from '../src/server/i18n'
import { hookPrerendered } from '../src/server/page-hook'
import { browserPath, testSite } from '../src/test'
import { scratchBuild } from './prerendered'
import { fixtureCopy, scratchDir } from './scratch'

const FIXTURE = 'tests/fixtures/i18n'
const routes = `${FIXTURE}/src/routes`
const messages = `${FIXTURE}/src/messages`
const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages }
const SITE = 'https://x.example'
// Without BUN_CHROME_PATH or a Chrome on the PATH, the Chromium playwright-core installed for the browser tests.
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const app = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.example', i18n }))

// Built by the first test reading it, then shared by the others, as building the fixture's pages again for each would only cost time.
function once<T>(build: () => Promise<T>): () => Promise<T> {
  let built: Promise<T> | undefined

  return async () => built ??= build()
}

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
    expect(html).toContain('<a class="fr" href="/about" hreflang="fr">FR</a>')
    expect(html).toContain('<a class="en" href="/en/about" hreflang="en" aria-current="page">EN</a>')
  })

  it('send a link written as the default locale names a page to the page\'s locale\'s copy, but one carrying hreflang, a file and another site\'s', async () => {
    const english = (await get('/en/about')).html
    const french = (await get('/about')).html

    expect(english).toContain('<nav class="links"><a class="post" href="/en/blog/hello?x=1#top">Post</a><a class="self" href="/en/about" aria-current="page">About</a><a class="file" href="/blog/cover.png">Cover</a><a class="out" href="https://example.com/about">Elsewhere</a><a class="kept" href="/about" hreflang="fr">À propos</a><a class="dynamic" href="/en/blog/hello">Post</a><a href="/en/blog/new" class="spread">New</a></nav>')
    expect(french).toContain('<nav class="links"><a class="post" href="/blog/hello?x=1#top">Post</a><a class="self" href="/about" aria-current="page">About</a>')
    expect((await get('/en')).html).toContain('<a class="island" href="/en/about">About</a>')
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

  it('list the configured locales, each named in its own language whichever one the page is in', async () => {
    expect((await get('/')).html).toContain('<p class="switcher">fr=Français en=English</p>')
    expect((await get('/en')).html).toContain('<p class="switcher">fr=Français en=English</p>')
    expect(localeName('ja')).toBe('日本語')
    expect(localeName('pt-BR')).toBe('Português (Brasil)')
    expect(localeName('xx-not a locale')).toBe('xx-not a locale')
  })

  it('render a message\'s tags through T\'s blocks, its placeholders filled and escaped inside a tag and out', async () => {
    expect((await get('/')).html).toContain('<p class="intro">Lisez <strong>notre histoire</strong>, &lt;Ada>, ou <em>la doc de &lt;Ada></em>.</p>')
    expect((await get('/en')).html).toContain('<p class="intro">Read <strong>our story</strong>, &lt;Ada>, or <em>the docs of &lt;Ada></em>.</p>')
    expect(islandMessages('T(key="intro" name={name})\nT(name={name} key=\'rich.other\')\np {t(\'nav.home\')}')).toBe(', ["intro","rich.other","nav.home"]')
  })

  it('write dir="rtl" on a page in a locale written right to left, and nothing on one written left to right', async () => {
    expect(['ar', 'he', 'fa-IR', 'ur', 'yi', 'en', 'fr', 'az-Arab', 'zz-invalid-tag-!'].map(textDirection)).toEqual(['rtl', 'rtl', 'rtl', 'rtl', 'rtl', 'ltr', 'ltr', 'rtl', 'ltr'])

    const arabic = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.example', i18n: { ...i18n, locales: ['fr', 'ar'], messages: `${FIXTURE}/rtl-messages` } }))

    expect((await get('/ar', arabic)).html).toContain('<html lang="ar" dir="rtl">')
    expect((await get('/', arabic)).html).toContain('<html lang="fr">')
  })

  it('send an island only the messages it uses', async () => {
    const { html } = await get('/en')

    expect(html).toContain('<script type="application/json" data-kay-i18n>{"locale":"en","settings":{"locales":["fr","en"],"defaultLocale":"fr","prefixDefault":false,"pages":["/about","/blog/:slug","/blog/new","/","/streamed"]},"messages":{"counter.label":"Counter","intro":"Read \\u003cabout>our story\\u003c/about>, {name}, or \\u003cdocs>the docs of {name}\\u003c/docs>."}}</script>')
    expect(html).toContain('<button><!--[-->Counter<!--]--> <!--[-->0<!--]--></button>')
  })

  it('keep the locale in a streamed block, which brings its islands\' messages', async () => {
    const { html } = await get('/en/streamed')

    expect(html).toContain('<p class="later">Home later</p>')
    expect(html).toContain('<script type="application/json" data-kay-i18n>{"locale":"en","settings":{"locales":["fr","en"],"defaultLocale":"fr","prefixDefault":false,"pages":["/about","/blog/:slug","/blog/new","/","/streamed"]},"messages":{"counter.label":"Counter","intro":"Read \\u003cabout>our story\\u003c/about>, {name}, or \\u003cdocs>the docs of {name}\\u003c/docs>."}}</script>')
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
    const copy = await fixtureCopy('i18n')

    try {
      await Bun.write(join(copy, 'src/routes/en/x.kay'), 'p x\n')
      await expect(pages({ routes: `${copy}/src/routes`, prebuilt: false, i18n: { ...i18n, messages: `${copy}/src/messages` } })).rejects.toThrow('under the prefix of the locale en')
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }

    expect(() => localeSettings({ locales: ['fr'], defaultLocale: 'en' })).toThrow('defaultLocale en is not one of its locales')
    expect(() => localeSettings({ locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr' } })).toThrow('none to en')
    expect(() => localeSettings({ locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr', en: 'x.com' }, prefixDefault: true })).toThrow('domains or prefixDefault')
    await expect(pages({ routes, prebuilt: false, i18n: { ...i18n, locales: ['fr', 'de'] } })).rejects.toThrow('so its messages go in')
  })
})

describe('the default locale prefixed', () => {
  const prefixedSite = once(async () => new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true } })))

  it('sends an unprefixed path to the visitor\'s locale: their cookie, then their browser\'s languages', async () => {
    const prefixed = await prefixedSite()

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
    const prefixed = await prefixedSite()
    const missing = await get('/nope', prefixed, { 'accept-language': 'en' })

    expect(missing).toMatchObject({ status: 404, vary: 'cookie, accept-language' })
    expect(missing.html).toContain('<h1 class="missing">Home</h1>')
    expect((await get('/fr/nope', prefixed)).html).toContain('<h1 class="missing">Accueil</h1>')
  })
})

describe('locales by domain', () => {
  const domainsSite = once(async () => new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.fr', i18n: { ...i18n, domains: { fr: 'x.fr', en: 'x.com' } } })))

  it('serve each host its locale, linking to another locale on its own host', async () => {
    const domains = await domainsSite()
    const english = await get('http://x.com/about', domains)

    expect(english.html).toContain('<h1>About</h1>')
    expect(english.html).toContain('<a class="fr" href="//x.fr/about" hreflang="fr">FR</a>')
    expect(english.html).toContain('<a class="en" href="/about" hreflang="en" aria-current="page">EN</a>')
    expect((await get('http://x.fr/about', domains)).html).toContain('<h1>À propos</h1>')
    expect((await get('http://elsewhere.example/about', domains)).html).toContain('<h1>À propos</h1>')
  })

  it('give each host a sitemap of its own pages, each linking its copies on the other hosts', async () => {
    const domains = await domainsSite()
    const english = (await get('http://x.com/sitemap.xml', domains)).html

    expect(english).toContain('<url><loc>https://x.com/about</loc><xhtml:link rel="alternate" hreflang="fr" href="https://x.fr/about"/><xhtml:link rel="alternate" hreflang="en" href="https://x.com/about"/><xhtml:link rel="alternate" hreflang="x-default" href="https://x.fr/about"/></url>')
    expect(english).not.toContain('<loc>https://x.fr/')
    expect((await get('http://x.fr/sitemap.xml', domains)).html).toContain('<loc>https://x.fr/about</loc>')
    expect((await get('http://x.com/about', domains)).html).toContain('<a class="post" href="/blog/hello?x=1#top">Post</a>')
  })
})

describe('translated paths', () => {
  const paths = { '/about': { fr: '/a-propos', en: '/about-us' }, '/blog/:slug': { en: '/articles/:slug' } }
  const translated = { ...i18n, paths }
  const translatedSite = once(async () => new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: translated })))

  it('serve a page at its path in each locale, links and the locale switcher following', async () => {
    const served = await translatedSite()
    const english = await get('/en/about-us', served)

    expect(english.html).toContain('<h1>About</h1>')
    expect(english.html).toContain('<a class="about" href="/en/about-us" aria-current="page">About</a>')
    expect(english.html).toContain('<a class="post" href="/en/articles/hello?x=1#top">Post</a><a class="self" href="/en/about-us" aria-current="page">About</a>')
    expect((await get('/a-propos', served)).html).toContain('<a class="self" href="/a-propos" aria-current="page">About</a>')
    expect(english.html).toContain('<a class="fr" href="/a-propos" hreflang="fr">FR</a>')
    expect((await get('/a-propos', served)).html).toContain('<h1>À propos</h1>')
    expect((await get('/en/articles/hello', served)).html).toContain('<h1 class="post">hello</h1>')
    expect((await get('/en/articles/hello', served)).html).toContain('<a class="fr" href="/blog/hello" hreflang="fr">FR</a>')
    expect((await get('/blog/hello', served)).html).toContain('<h1 class="post">hello</h1>')
  })

  it('localize a link by the page patterns and feeds the settings name, whichever way locales reach the URL', () => {
    const settings = { ...localeSettings(translated), pages: ['/', '/about', '/blog/:slug', '/docs/*'], feeds: ['/blog/rss.xml'] }

    expect(['/', '/about/', '/blog/a?b#c', '/blog/rss.xml', '/docs/a/b', '/docs/a/b.pdf', '/fr/about', '/en/about', '/nowhere', 'about', '//x.com/about'].map(href => localizedLink(settings, href, 'en'))).toEqual(['/en', '/en/about-us/', '/en/articles/a?b#c', '/en/blog/rss.xml', '/en/docs/a/b', '/docs/a/b.pdf', '/fr/about', '/en/about', '/nowhere', 'about', '//x.com/about'])
    expect(['/', '/about', '/blog/rss.xml'].map(href => localizedLink({ ...settings, prefixDefault: true }, href, 'fr'))).toEqual(['/fr', '/fr/a-propos', '/fr/blog/rss.xml'])
    expect(['/about', '/en/about'].map(href => localizedLink({ ...settings, hosts: { fr: 'x.fr', en: 'x.com' }, feeds: undefined }, href, 'en', 'x.com'))).toEqual(['/about-us', '/en/about'])
  })

  it('send a locale\'s untranslated path to its translation', async () => {
    const served = await translatedSite()

    expect(await get('/en/about?x=1', served)).toMatchObject({ status: 308, location: '/en/about-us?x=1' })
    expect(await get('/about', served)).toMatchObject({ status: 308, location: '/a-propos' })
    expect(await get('/en/blog/hello', served)).toMatchObject({ status: 308, location: '/en/articles/hello' })
    expect((await get('/en/a-propos', served)).status).toBe(404)
  })

  it('serve a host only its own locale\'s paths, and list them in the sitemap', async () => {
    const domains = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.fr', i18n: { ...translated, domains: { fr: 'x.fr', en: 'x.com' } } }))
    const english = await get('http://x.com/about-us', domains)

    expect(english.html).toContain('<h1>About</h1>')
    expect(english.html).toContain('<a class="fr" href="//x.fr/a-propos" hreflang="fr">FR</a>')
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
    expect(() => localeSettings({ ...i18n, paths: { '/about': { en: '/about//us' } } })).toThrow('has an empty segment')
    expect(localeSettings({ ...i18n, paths: { '/about': { en: '/about-us/' } } }).paths).toEqual({ '/about': { en: '/about-us' } })
  })

  it('keep the path of a page a translated pattern would also take', async () => {
    const served = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: SITE, i18n: { ...i18n, paths: { '/blog/:slug': { en: '/articles/:slug' } } } }))
    const sitemap = (await get('/sitemap.xml', served)).html

    expect((await get('/en/blog/new', served)).html).toContain('<h1 class="new">New post</h1>')
    expect(sitemap).toContain('<loc>https://x.example/en/blog/new</loc>')
    expect(sitemap).not.toContain('/en/articles/new')
  })
})

describe('localized content', () => {
  const site = 'tests/fixtures/i18n-content'
  const content = `${site}/src/content.config.ts`
  const config = { routes: `${site}/src/routes`, content, prebuilt: false, security: false as const, site: SITE, i18n: { ...i18n, messages: `${site}/src/messages` } }
  const contentSite = once(async () => new Elysia().use(await pages(config)))

  it('reads the request\'s locale\'s entry, the default locale\'s standing in for one it lacks', async () => {
    const served = await contentSite()
    const english = (await get('/en/news/hello', served)).html
    const fallback = (await get('/en/news/launch', served)).html

    expect(english).toContain('<h1 class="entry">Hello</h1>')
    expect(english).toContain('<p class="written">en</p>')
    expect(english).toContain('<p class="translations">en fr</p>')
    expect(english).toContain('<p>First post.</p>')
    expect(english).toContain('<p>See <a href="/en/news/launch">the launch</a>, <a href="/en/news/rss.xml">the feed</a>, <a href="/news/cover.png">a picture</a> and <a href="/news/hello" hreflang="fr">the French one</a>.</p>')
    expect(fallback).toContain('<h1 class="entry">Lancement</h1>')
    expect(fallback).toContain('<p class="written">fr</p>')
    expect((await get('/news/hello', served)).html).toContain('<h1 class="entry">Bonjour</h1>')
    expect((await get('/en/news', served)).html).toContain('<ul class="news"><li>English only (en)</li><li>Hello (en)</li><li>Lancement (fr)</li></ul>')
  })

  it('serve a feed per locale of the entries written in it, and list every locale\'s copy in the sitemap', async () => {
    const served = await contentSite()
    const english = (await get('/en/news/rss.xml', served)).html
    const french = (await get('/news/rss.xml', served)).html
    const sitemap = (await get('/sitemap.xml', served)).html

    expect(english).toContain('<atom:link href="https://x.example/en/news/rss.xml" rel="self" type="application/rss+xml"/>')
    expect(english).toContain('<link>https://x.example/en/news/hello</link>')
    expect(english).toContain('<channel>\n<title>News</title>\n<link>https://x.example/en</link>')
    expect(french).toContain('<link>https://x.example/</link>')
    expect(english).not.toContain('Lancement')
    expect(french).toContain('<link>https://x.example/news/launch</link>')
    expect(french).toContain('<title>Bonjour</title>')
    expect(sitemap).toContain('<loc>https://x.example/en/news/launch</loc>')
    expect(sitemap).toContain('<loc>https://x.example/news/hello</loc>')
    // An entry the default locale lacks is served only where it is written.
    expect(sitemap).toContain('<loc>https://x.example/en/news/english-only</loc>')
    expect(sitemap).not.toContain('<loc>https://x.example/news/english-only</loc>')
    expect((await get('/news/english-only', served)).status).toBe(404)

    const domains = new Elysia().use(await pages({ ...config, i18n: { ...config.i18n, domains: { fr: 'x.fr', en: 'x.com' } } }))
    const onHost = (await get('http://x.com/news/rss.xml', domains)).html

    expect(onHost).toContain('<atom:link href="https://x.com/news/rss.xml" rel="self" type="application/rss+xml"/>')
    expect(onHost).toContain('<link>https://x.com/news/hello</link>')
    expect(onHost).toContain('<link>https://x.com/</link>')
    expect(onHost).not.toContain('Lancement')
  })

  it('lists every locale\'s entries outside a request, and refuses an entry outside a locale folder', async () => {
    const { news } = await import('./fixtures/i18n-content/src/content.config')

    expect((await news.all()).map(entry => `${entry.locale}/${entry.slug}`)).toEqual(['en/english-only', 'en/hello', 'fr/hello', 'fr/launch'])
    expect((await news.all('en')).map(entry => entry.slug)).toEqual(['english-only', 'hello'])
    expect((await news.get('hello', 'fr'))?.data.title).toBe('Bonjour')

    const loose = collection({ name: 'loose', load: () => [{ slug: 'hello', data: {} }] }, { schema: t.Object({}), localized: true })

    await expect(loose.all()).rejects.toThrow(ContentError)
  })

  it('has kay check hold a translation to the schema', async () => {
    const copy = await fixtureCopy('i18n-content')
    const broken = join(copy, 'src/content/news/en/broken.md')

    try {
      await Bun.write(broken, '---\ntitle: Broken\ndate: someday\n---\n')

      const diagnostics = (await check(copy, { site: SITE, lints: { seo: 'allow' }, i18n: { ...i18n, messages: undefined } })).map(({ file, line, message }) => ({ file: file.slice(file.indexOf(copy)), line, message }))

      // The entry alone: the fixture's own entries pass.
      expect(diagnostics).toEqual([{ file: broken, line: 3, message: expect.stringContaining('date: ') }])
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  }, 30_000)
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
    const copy = await fixtureCopy('i18n')

    await Bun.write(join(copy, 'src/routes/computed.kay'), '--- server\nimport { t } from \'kay/i18n\'\n\nconst state = [\'drafted\'][0]!\nconst label = t(`status.${state}` as never)\n---\np {label}\n')

    try {
      const served = new Elysia().use(await pages({ routes: `${copy}/src/routes`, prebuilt: false, security: false, i18n: { ...i18n, messages: `${copy}/src/messages` }, onError: () => undefined }))

      expect((await get('/computed', served)).status).toBe(500)
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})

describe('prerendering', () => {
  async function prerendered(config: I18nConfig, check: (build: ScratchBuild) => Promise<void>, more: Partial<KayConfig> = {}): Promise<void> {
    const build = await scratchBuild()

    try {
      // The home page that marks prerender, and the pages reading nothing from a request, in each of the two locales.
      expect(await build.prerender({ routes, i18n: config, ...more })).toBe(6)
      await check(build)
    }
    finally {
      await build.remove()
    }
  }

  it('renders a page once per locale, each served back from its file', async () => {
    await prerendered(i18n, async (build) => {
      expect(await Bun.file(join(build.pages, 'index.html')).text()).toContain('<h1>Bonjour Ada</h1>')
      expect(await Bun.file(join(build.pages, 'en.html')).text()).toContain('<h1>Hello Ada</h1>')

      const built = new Elysia().use(await build.serve({ routes, security: false, i18n }))
      const english = await get('/en', built)

      expect(english.html).toContain('<h1>Hello Ada</h1>')
      expect(english.etag).not.toBeNull()
    })
  })

  it('links no locale manifest from a page prerendered while the app serves the default one itself', async () => {
    const publicDir = await scratchDir('manifest-')

    await Bun.write(join(publicDir, 'manifest.webmanifest'), '{"name":"Mine"}')
    await prerendered(i18n, async (build) => {
      expect(await Bun.file(join(build.pages, 'en.html')).text()).toContain('<link rel="manifest" href="/manifest.webmanifest">')
    }, { publicDir, seo: { name: { fr: 'Le site', en: 'The site' } } })
  })

  it('hands a page hook the locale each page was rendered in', async () => {
    await prerendered(i18n, async (build) => {
      const seen: Record<string, string> = {}

      await hookPrerendered(build.dir, [({ path, locale, html }) => {
        seen[path] = locale

        return html
      }], { clientDir: (await build.client()).dir, publicDir: join(build.dir, 'public'), base: '' }, build.dir)

      expect(seen['/']).toBe('fr')
      expect(seen['/en']).toBe('en')
    })
  })

  it('keeps each domain\'s copy apart, served to its host', async () => {
    const domains = { ...i18n, domains: { fr: 'x.fr', en: 'x.com' } }

    await prerendered(domains, async (build) => {
      const built = new Elysia().use(await build.serve({ routes, security: false, i18n: domains }))
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
  // A copy, as these tests write pages and messages into it.
  let fixture: string

  beforeAll(async () => {
    fixture = await fixtureCopy('i18n')
  })

  afterAll(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  it('types t() and T from the default locale\'s messages, holds every other locale to them, and checks links against each locale\'s paths', async () => {
    const english = join(fixture, 'src/messages/en.ts')
    const typo = join(fixture, 'src/routes/typo.kay')
    const rich = join(fixture, 'src/routes/rich.kay')
    const links = join(fixture, 'src/routes/links.kay')
    const source = await Bun.file(english).text()

    try {
      await Promise.all([
        Bun.write(english, source
          .replace('  greeting: \'Hello {name}\',\n', '')
          .replace('Saved on {date}', 'Saved on {day}')
          .replace('counter: { label: \'Counter\', more: \'More\' }', 'counter: { label: \'Counter\', more: \'More\', less: \'Less\' }')
          .replace('Read <about>our story</about>, {name}, or <docs>the docs of {name}</docs>.', 'Read <story>our story</story>, {name}, or the docs of {name}.')),
        Bun.write(typo, '--- server\nimport { t } from \'kay/i18n\'\n\nconst a = t(\'nav.hom\')\nconst b = t(\'greeting\')\nconst c = t(\'greeting\', { nom: \'Ada\' })\nconst d = t(\'items\', { count: \'2\' })\n---\np {a} {b} {c} {d}\n'),
        Bun.write(rich, [
          '--- server',
          'import { T } from \'kay/i18n\'',
          '---',
          'T(key="intro" name="Ada")',
          '  @about(text)',
          '    strong {text}',
          '  @docs(text)',
          '    em {text.toUpperCase()}',
          'T(key="intro" name="Ada")',
          '  @about(text)',
          '    strong {text}',
          'T(key="intro" nom="Ada")',
          '  @about(text)',
          '    strong {text}',
          '  @docs(text)',
          '    em {text}',
          'T(key="intr" name="Ada")',
          'T(key="greeting" name="Ada")',
          '  @about(text)',
          '    strong {text}',
          '',
        ].join('\n')),
        Bun.write(links, 'a(href="/en/about-us") About\na(href="/a-propos") À propos\na(href="/en/about") About\n'),
      ])

      // Every locale prefixed, /about translated, and /streamed given the path of the home page in en.
      const diagnostics = await check(fixture, { site: SITE, lints: { seo: 'allow' }, i18n: { ...i18n, messages: undefined, prefixDefault: true, paths: { '/about': { en: '/about-us' }, '/streamed': { en: '/' } } } })
      const found = diagnostics.map(({ file, line, message }) => ({ file: file.slice(file.indexOf(fixture) + fixture.length + 1), line, message }))
      const lines = Object.fromEntries(Object.entries(Object.groupBy(found, ({ file }) => file)).map(([file, at]) => [file, at!.map(({ line }) => line).toSorted((a, b) => a - b)]))

      const expected = {
        'src/messages/en.ts': [1, 6, 7, 7, 8, 8, 8],
        'src/routes/typo.kay': [4, 5, 6, 7],
        'src/routes/rich.kay': [9, 12, 17, 19],
        'src/routes/links.kay': [2, 3],
        'src/routes': [1],
      }

      // What the changes break and nothing else: the fixture's own pages pass, their unprefixed links included, as the server sends those on to the visitor's locale. A file reported that should not be is shown with its messages.
      expect(found.filter(({ file }) => !(file in expected))).toEqual([])
      expect(lines).toEqual(expected)
      expect(found.filter(({ file }) => file === 'src/messages/en.ts').map(({ line, message }) => [line, message])).toEqual(expect.arrayContaining([
        [1, 'lacks greeting, which src/messages/fr.ts has'],
        [7, 'gives saved without {date}, which src/messages/fr.ts has'],
        [7, 'gives saved a {day}, which src/messages/fr.ts has not, so nothing fills it'],
        [6, 'has counter.less, which src/messages/fr.ts lacks, so no `t()` can name it'],
        [8, 'gives intro without <about>, which src/messages/fr.ts has, so its block renders nothing'],
        [8, 'gives intro without <docs>, which src/messages/fr.ts has, so its block renders nothing'],
        [8, 'gives intro a <story>, which src/messages/fr.ts has not, so no block renders it'],
      ]))
      expect(found.find(({ file }) => file === 'src/routes')?.message).toContain('are both served at / in en')
    }
    finally {
      await Promise.all([Bun.write(english, source), rm(typo, { force: true }), rm(rich, { force: true }), rm(links, { force: true })])
    }
  })

  it('reports a locale config no request could be served by, at the config', async () => {
    const diagnostics = await check(fixture, { site: SITE, lints: { seo: 'allow' }, i18n: { locales: ['fr'], defaultLocale: 'en' } })

    expect(diagnostics.map(({ file, message }) => ({ file: file.slice(file.indexOf(fixture)), message }))).toContainEqual({ file: `${fixture}/kay.config.ts`, message: 'kay: i18n\'s defaultLocale en is not one of its locales: fr' })
  })
})

describe('relativeTime', () => {
  it('reads the page as rendered at one moment on the server, which the page sends its islands once', () => {
    const state = { locale: 'en', messages: new Map(), settings: localeSettings(i18n), path: '/', implicit: true as const }

    jest.useFakeTimers({ now: 1_000_000 })

    try {
      const scripts = runInLocale(state, () => {
        const ago = relativeTime(() => 940_000)

        jest.advanceTimersByTime(5000)

        const later = relativeTime(() => 970_000, { style: 'short' })

        return [ago(), later(), messagesScript(new Set(), true), messagesScript(new Set(), false)]
      })

      expect(scripts).toEqual(['1 minute ago', '30 sec. ago', '<script type="application/json" data-kay-i18n>{"locale":"en","messages":{},"now":1000000}</script>', ''])
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('makes a component an island, read by calling it in its template as a memo', () => {
    const compiled = compileKay('---\nimport { relativeTime } from \'kay/i18n\'\n\nconst { date } = props<{ date: number }>()\nconst ago = relativeTime(() => date)\n---\ntime {ago()}\n', join(process.cwd(), 'ago.kay'), { output: 'html', hydratable: true })

    expect(compiled.tsx).toContain('KayIsland(')
    expect(compiled.tsx).toContain('KayChild((ago()))')
    expect(compileKay('---\nimport { formatDate } from \'kay/i18n\'\n---\ntime {formatDate(0)}\n', join(process.cwd(), 'date.kay'), { output: 'html', hydratable: true }).tsx).not.toContain('KayIsland(')
  })
})

describe('in the browser', () => {
  it('reads the messages the page sent, those of a streamed part included', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/en/about-us' })

    try {
      const { alternate, formatNumber, localeName: nameOf, locales, localize, localizedHref, t } = await import('../src/runtime/i18n.client')
      const payload = { locale: 'en', settings: localeSettings({ ...i18n, paths: { '/about': { fr: '/a-propos', en: '/about-us' } } }), messages: { 'counter.label': 'Counter' } }

      document.head.innerHTML = `<script type="application/json" data-kay-i18n>${JSON.stringify(payload)}</script>`

      expect(t('counter.label')).toBe('Counter')
      expect(localize('/about')).toBe('/en/about-us')
      expect(localize('/')).toBe('/en')
      expect(alternate('fr')).toBe('/a-propos')
      expect(formatNumber(1234)).toBe('1,234')
      expect(locales()).toEqual(['fr', 'en'])
      expect(nameOf('fr')).toBe('Français')

      // Once read on a parsed page, a known message, the locale and the settings search the page no more, as a list row each calling them would.
      const searched = spyOn(document, 'querySelectorAll')

      for (const row of [1, 2, 3])
        expect([t('counter.label'), formatNumber(row), localize('/about'), localizedHref('/about')]).toEqual(['Counter', String(row), '/en/about-us', '/about'])

      expect(searched).not.toHaveBeenCalled()
      searched.mockRestore()

      document.body.innerHTML = '<script type="application/json" data-kay-i18n>{"messages":{"items":{"one":"{count} item","other":"{count} items"}}}</script>'

      expect(t('items', { count: 2 })).toBe('2 items')

      // A payload that does not parse is reported once, and the others still read.
      const logged = spyOn(console, 'error').mockImplementation(() => undefined)

      document.body.innerHTML = '<script type="application/json" data-kay-i18n>{broken</script><script type="application/json" data-kay-i18n>{"messages":{"after.broken":"Still read"}}</script>'
      expect(t('after.broken')).toBe('Still read')
      expect(t('after.broken')).toBe('Still read')
      expect(logged).toHaveBeenCalledTimes(1)
      logged.mockRestore()

      const { T } = await import('../src/runtime/i18n.client')
      const { render } = await import('../src/runtime/dom')
      const container = document.createElement('p')

      document.body.innerHTML = '<script type="application/json" data-kay-i18n>{"messages":{"intro":"Read <about>our story</about>, {name}, or <b>{name}</b>."}}</script>'
      render(() => T({ key: 'intro', name: '<Ada>', about: text => Object.assign(document.createElement('strong'), { textContent: text }) }), container)

      expect(container.innerHTML).toBe('<!--[-->Read <strong>our story</strong>, &lt;Ada&gt;, or &lt;Ada&gt;.<!--]-->')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  it('renders a relative time first as the server did, then ticks at its unit\'s pace until its root goes', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/en' })
    jest.useFakeTimers({ now: 1_010_000 })
    const { flush, root } = await import('../src/runtime')

    try {
      const { relativeTime } = await import('../src/runtime/i18n.client')

      document.body.innerHTML = '<script type="application/json" data-kay-i18n>{"locale":"en","messages":{},"now":1000000}</script>'

      const texts: string[] = []
      const timers: number[] = []
      const dispose = root((dispose) => {
        const ago = relativeTime(() => 970_000)

        texts.push(ago())
        flush()
        texts.push(ago())
        jest.advanceTimersByTime(1000)
        texts.push(ago())
        // A minute away, it ticks each minute.
        jest.advanceTimersByTime(20_000)
        flush()
        texts.push(ago())
        jest.advanceTimersByTime(59_000)
        texts.push(ago())
        jest.advanceTimersByTime(1000)
        texts.push(ago())
        // A hidden tab holds no timer and the time rests, then catches up at once when it shows again.
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        document.dispatchEvent(new Event('visibilitychange'))
        flush()
        timers.push(jest.getTimerCount())
        jest.advanceTimersByTime(3_600_000)
        texts.push(ago())
        Reflect.deleteProperty(document, 'hidden')
        document.dispatchEvent(new Event('visibilitychange'))
        flush()
        timers.push(jest.getTimerCount())
        texts.push(ago())

        return dispose
      })

      dispose()
      jest.advanceTimersByTime(3_600_000)
      timers.push(jest.getTimerCount())
      expect([texts, timers]).toEqual([['30 seconds ago', '40 seconds ago', '41 seconds ago', '1 minute ago', '1 minute ago', '2 minutes ago', '2 minutes ago', '1 hour ago'], [0, 1, 0]])
    }
    finally {
      // A fake queueMicrotask holds the flush the last tick queued, which every later effect of the process would wait on.
      flush()
      jest.useRealTimers()
      await GlobalRegistrator.unregister()
    }
  })

  it('shares one timer between the relative times of a pace', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/en' })
    jest.useFakeTimers({ now: 1_010_000 })
    const { flush, root } = await import('../src/runtime')

    try {
      const { relativeTime } = await import('../src/runtime/i18n.client')

      document.body.innerHTML = '<script type="application/json" data-kay-i18n>{"locale":"en","messages":{},"now":1000000}</script>'

      const counts: number[] = []
      const [stopFirst, stopSecond] = [0, 1].map(() => root((dispose) => {
        relativeTime(() => 970_000)()
        flush()

        return dispose
      }))

      counts.push(jest.getTimerCount())
      jest.advanceTimersByTime(1000)
      stopFirst!()
      counts.push(jest.getTimerCount())
      stopSecond!()
      counts.push(jest.getTimerCount())
      expect(counts).toEqual([1, 1, 0])
    }
    finally {
      flush()
      jest.useRealTimers()
      await GlobalRegistrator.unregister()
    }
  })
})

// CI installs Chromium for this: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('an island in a browser', () => {
  it('hydrates T\'s blocks and fills them again when a placeholder changes, its links in the page\'s locale', async () => {
    const site = await testSite({ routes, i18n, browser: { path: chrome } })

    try {
      const page = await site.open('/en')

      expect(await page.text('p.rich')).toBe('Read our story, 0, or the docs of 0.')
      await page.click('button')
      expect(await page.text('p.rich')).toBe('Read our story, 1, or the docs of 1.')
      expect(await page.text('p.rich em')).toBe('the docs of 1')
      expect(await page.evaluate(() => [document.querySelector('a.island')!.getAttribute('href'), document.querySelector('a.later')!.getAttribute('href')])).toEqual(['/en/about', '/en/blog/new'])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe('localized seo defaults', () => {
  const seoApp = async () => new Elysia().use(await pages({
    routes,
    prebuilt: false,
    security: false,
    site: SITE,
    i18n,
    seo: { name: { fr: 'Le site', en: 'The site' }, titleTemplate: { fr: '%s | Le site', en: '%s | The site' }, description: { fr: 'Ce que fait le site', en: 'What the site does' }, image: { fr: '/fr.png', en: '/en.png' }, imageAlt: { fr: 'Le logo', en: 'The logo' }, locale: { fr: 'fr_FR' } },
  }))

  // One app for every request, as the head of each locale is built once and kept.
  const shared = seoApp()

  async function head(path: string): Promise<string> {
    return (await (await shared).handle(new Request(`http://localhost${path}`))).text()
  }

  it('gives each locale its own name, description and title template, a locale the record lacks reading the default\'s', async () => {
    const fr = await head('/')
    const en = await head('/en')

    expect(fr).toContain('<meta name="description" content="Ce que fait le site">')
    expect(fr).toContain('<meta property="og:site_name" content="Le site">')
    expect(fr).toContain('<meta property="og:locale" content="fr_FR">')
    expect(en).toContain('<meta name="description" content="What the site does">')
    expect(en).toContain('<meta property="og:site_name" content="The site">')
    expect(en).toContain('<meta property="og:locale" content="fr_FR">')
    expect(fr).toContain('/fr.png')
    expect(fr).toContain('content="Le logo"')
    expect(en).toContain('/en.png')
    expect(en).toContain('content="The logo"')
    expect(await head('/')).toBe(fr)
    expect(await head('/en')).toBe(en)
  })

  it('titles the one OpenAPI document with the default locale\'s name, whatever locale asked', async () => {
    const server = new Elysia().use(await pages({ routes, api: 'tests/fixtures/openapi/src/api', prebuilt: false, security: false, site: SITE, i18n, openapi: true, seo: { name: { en: 'The site', fr: 'Le site' } } }))

    const response = await server.handle(new Request('http://localhost/api/openapi.json', { headers: { 'x-key': 'open', 'accept-language': 'en' } }))

    expect((await response.json() as { info: { title: string } }).info.title).toBe('Le site')
  })

  it('leaves a manifest link of the app\'s own head alone in every locale', async () => {
    const server = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: SITE, i18n, favicon: false, head: [{ tag: 'link', props: { rel: 'manifest', href: '/my-app.json' } }], seo: { name: { fr: 'Le site', en: 'The site' } } }))

    for (const path of ['/', '/en'])
      expect(await (await server.handle(new Request(`http://localhost${path}`))).text()).toContain('<link rel="manifest" href="/my-app.json">')
  })

  it('links the manifest of the page\'s locale, the default locale\'s at the usual path and each other locale\'s beside it', async () => {
    const server = await shared
    const manifest = async (path: string) => (await server.handle(new Request(`http://localhost${path}`))).json() as Promise<{ name: string, description: string }>

    expect(await head('/')).toContain('<link rel="manifest" href="/manifest.webmanifest">')
    expect(await head('/en')).toContain('<link rel="manifest" href="/manifest.en.webmanifest">')
    expect(await manifest('/manifest.webmanifest')).toMatchObject({ name: 'Le site', description: 'Ce que fait le site' })
    expect(await manifest('/manifest.en.webmanifest')).toMatchObject({ name: 'The site', description: 'What the site does' })
    expect((await server.handle(new Request('http://localhost/manifest.fr.webmanifest'))).status).toBe(404)
  })

  it('serves and links no locale manifest while the app serves the default one itself', async () => {
    const publicDir = await scratchDir('manifest-')

    await Bun.write(join(publicDir, 'manifest.webmanifest'), '{"name":"Mine"}')

    const server = new Elysia().use(await pages({ routes, publicDir, prebuilt: false, security: false, site: SITE, i18n, seo: { name: { fr: 'Le site', en: 'The site' } } }))
    const html = await (await server.handle(new Request('http://localhost/en'))).text()

    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">')
    expect((await server.handle(new Request('http://localhost/manifest.en.webmanifest'))).status).toBe(404)
    expect(await (await server.handle(new Request('http://localhost/manifest.webmanifest'))).text()).toBe('{"name":"Mine"}')
  })

  it('serves one manifest while the texts are written once or the other locale reads the default\'s, whatever base and trailingSlash', async () => {
    for (const seo of [{ name: 'The site' }, { name: { fr: 'Le site' }, description: { fr: 'Ce que fait le site' } }]) {
      for (const variant of [{}, { base: '/docs', trailingSlash: 'always' as const }]) {
        const server = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: SITE, i18n, seo, ...variant }))
        const html = await (await server.handle(new Request(`http://localhost/en${'base' in variant ? '/' : ''}`))).text()

        expect(html).toContain(`<link rel="manifest" href="${'base' in variant ? '/docs' : ''}/manifest.webmanifest">`)
        expect((await server.handle(new Request('http://localhost/manifest.en.webmanifest'))).status).toBe(404)
        expect((await server.handle(new Request('http://localhost/manifest.webmanifest'))).status).toBe(200)
      }
    }
  })

  it('links the manifest of another locale under base, which its icons and start page go under too', async () => {
    const server = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: SITE, i18n, base: '/docs', trailingSlash: 'always', seo: { name: { fr: 'Le site', en: 'The site' } } }))
    const html = await (await server.handle(new Request('http://localhost/en/'))).text()
    const manifest = await (await server.handle(new Request('http://localhost/manifest.en.webmanifest'))).json() as { name: string, start_url: string, icons: { src: string }[] }

    expect(html).toContain('<link rel="manifest" href="/docs/manifest.en.webmanifest">')
    expect(manifest.name).toBe('The site')
    expect(manifest.start_url).toBe('/docs/')
    expect(manifest.icons[0]!.src).toBe('/docs/icon-192.png')
  })
})
