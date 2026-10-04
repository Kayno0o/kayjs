import type { I18nConfig } from '../src/config'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { check } from '../src/check'
import { flattenMessages, translate } from '../src/runtime/i18n'
import { pages } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { acceptedLocale, localeSettings, requestLocale } from '../src/server/i18n'
import { prerenderPages } from '../src/server/prerender'

const FIXTURE = 'tests/fixtures/i18n'
const routes = `${FIXTURE}/src/routes`
const messages = `${FIXTURE}/src/messages`
const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages }
const app = new Elysia().use(await pages({ routes, prebuilt: false, security: false, site: 'https://x.example', i18n }))

async function get(path: string, served: { handle: (request: Request) => Promise<Response> } = app, headers: Record<string, string> = {}): Promise<{ status: number, html: string, location: string | null, cookie: string | null }> {
  const response = await served.handle(new Request(path.startsWith('http') ? path : `http://localhost${path}`, { headers }))

  return { status: response.status, html: await response.text(), location: response.headers.get('location'), cookie: response.headers.get('set-cookie') }
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
    expect(html).toContain('<a class="about" href="/en/about">About</a>')
    expect(html).toContain('<a class="fr" href="/about">FR</a>')
    expect(html).toContain('<a class="en" href="/en/about">EN</a>')
  })

  it('format plurals, numbers and dates through Intl', async () => {
    const french = await get('/')
    const english = await get('/en')

    expect(french.html).toContain('<p class="items">Aucun article / 1 article / 1 234 articles</p>')
    expect(english.html).toContain('<p class="items">No items / 1 item / 1,234 items</p>')
    expect(english.html).toContain('<p class="price">€1,234.50</p>')
    expect(english.html).toContain('<p class="saved">Saved on Oct 4, 2026</p>')
  })

  it('send an island only the messages it uses', async () => {
    const { html } = await get('/en')

    expect(html).toContain('<script type="application/json" data-kay-i18n>{"locale":"en","settings":{"locales":["fr","en"],"defaultLocale":"fr","prefixDefault":false},"messages":{"counter.label":"Counter"}}</script>')
    expect(html).toContain('<button><!--[-->Counter<!--]--> <!--[-->0<!--]--></button>')
  })

  it('list every locale\'s copy of a page in the head and the sitemap', async () => {
    const { html } = await get('/en/about')

    expect(html).toContain('<link rel="canonical" href="https://x.example/en/about">')
    expect(html).toContain('<link rel="alternate" hreflang="fr" href="https://x.example/about">')
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://x.example/en/about">')
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://x.example/about">')

    const sitemap = (await get('/sitemap.xml')).html

    expect(sitemap).toContain('<url><loc>https://x.example/en/about</loc><xhtml:link rel="alternate" hreflang="fr" href="https://x.example/about"/><xhtml:link rel="alternate" hreflang="en" href="https://x.example/en/about"/></url>')
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
    await expect(pages({ routes, prebuilt: false, i18n: { ...i18n, locales: ['fr', 'de'] } })).rejects.toThrow('so its messages go in')
  })
})

describe('the default locale prefixed', () => {
  it('sends an unprefixed path to the visitor\'s locale: their cookie, then their browser\'s languages', async () => {
    const prefixed = new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true } }))

    expect(await get('/about?x=1', prefixed, { 'accept-language': 'en-US,en;q=0.9,fr;q=0.5' })).toMatchObject({ status: 307, location: '/en/about?x=1' })
    expect(await get('/about', prefixed, { 'accept-language': 'en', 'cookie': 'kay-locale=fr' })).toMatchObject({ status: 307, location: '/fr/about' })
    expect(await get('/', prefixed, { 'accept-language': 'de' })).toMatchObject({ status: 307, location: '/fr' })
    expect((await get('/fr/about', prefixed)).cookie).toBe('kay-locale=fr; Path=/; Max-Age=31536000; SameSite=Lax')
    expect((await get('/fr/about', prefixed, { cookie: 'kay-locale=fr' })).cookie).toBeNull()
  })
})

describe('locales by domain', () => {
  it('serve each host its locale, linking to another locale on its own host', async () => {
    const domains = new Elysia().use(await pages({ routes, prebuilt: false, security: false, i18n: { ...i18n, domains: { fr: 'x.fr', en: 'x.com' } } }))
    const english = await get('http://x.com/about', domains)

    expect(english.html).toContain('<h1>About</h1>')
    expect(english.html).toContain('<a class="fr" href="https://x.fr/about">FR</a>')
    expect(english.html).toContain('<a class="en" href="/about">EN</a>')
    expect((await get('http://x.fr/about', domains)).html).toContain('<h1>À propos</h1>')
    expect((await get('http://elsewhere.example/about', domains)).html).toContain('<h1>À propos</h1>')
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
  })

  it('falls back to the default locale\'s message, and to the key itself', () => {
    const fallback = flattenMessages({ a: 'A', b: { c: 'C {n}' } })
    const translations = { locale: 'en', messages: new Map(), fallback }

    expect(translate(translations, 'b.c', { n: 2 })).toBe('C 2')
    expect(translate(translations, 'missing')).toBe('missing')
  })
})

describe('prerendering', () => {
  it('renders a page once per locale', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      expect(await prerenderPages(root, { routes, i18n }, (await readClient(root))!)).toBe(2)
      expect(await Bun.file(join(root, '.kay/client/pages/index.html')).text()).toContain('<h1>Bonjour Ada</h1>')
      expect(await Bun.file(join(root, '.kay/client/pages/en.html')).text()).toContain('<h1>Hello Ada</h1>')
    }
    finally {
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })
})

describe('kay check', () => {
  it('types t() from the default locale\'s messages and reports a locale that strays from them', async () => {
    expect(await check(FIXTURE, { i18n: { ...i18n, messages: undefined } })).toEqual([])

    const english = join(FIXTURE, 'src/messages/en.ts')
    const page = join(FIXTURE, 'src/routes/typo.kay')
    const source = await Bun.file(english).text()

    try {
      await Bun.write(english, source.replace('  greeting: \'Hello {name}\',\n', '').replace('Saved on {date}', 'Saved on {day}').replace('counter: { label: \'Counter\', more: \'More\' }', 'counter: { label: \'Counter\', more: \'More\', less: \'Less\' }'))
      await Bun.write(page, '--- server\nimport { t } from \'kay/i18n\'\n\nconst a = t(\'nav.hom\')\nconst b = t(\'greeting\')\n---\np {a} {b}\n')

      const diagnostics = (await check(FIXTURE, { i18n: { ...i18n, messages: undefined } })).map(({ file, line, message }) => ({ file: file.slice(file.indexOf(FIXTURE)), line, message }))

      expect(diagnostics).toContainEqual({ file: english, line: 1, message: 'lacks greeting, which src/messages/fr.ts has' })
      expect(diagnostics).toContainEqual({ file: english, line: 7, message: 'gives saved without {date}, which src/messages/fr.ts has' })
      expect(diagnostics).toContainEqual({ file: english, line: 7, message: 'gives saved a {day}, which src/messages/fr.ts has not, so nothing fills it' })
      expect(diagnostics).toContainEqual({ file: english, line: 6, message: 'has counter.less, which src/messages/fr.ts lacks, so no `t()` can name it' })
      expect(diagnostics.filter(diagnostic => diagnostic.file === page).map(diagnostic => diagnostic.line)).toEqual([4, 5])
    }
    finally {
      await Bun.write(english, source)
      await rm(page, { force: true })
    }
  })
})

describe('in the browser', () => {
  it('reads the messages the page sent, those of a streamed part included', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/en/about' })

    try {
      const { alternate, formatNumber, localize, t } = await import('../src/runtime/i18n.client')
      const payload = { locale: 'en', settings: localeSettings(i18n), messages: { 'counter.label': 'Counter' } }

      document.head.innerHTML = `<script type="application/json" data-kay-i18n>${JSON.stringify(payload)}</script>`

      expect(t('counter.label')).toBe('Counter')
      expect(localize('/about')).toBe('/en/about')
      expect(alternate('fr')).toBe('/about')
      expect(formatNumber(1234)).toBe('1,234')

      document.body.innerHTML = '<script type="application/json" data-kay-i18n>{"messages":{"items":{"one":"{count} item","other":"{count} items"}}}</script>'

      expect(t('items', { count: 2 })).toBe('2 items')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})
