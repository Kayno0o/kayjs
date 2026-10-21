import type { LocaleSettings } from '../src/runtime/i18n'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { localize as serverLocalize } from '../src/runtime/i18n.server'
import { runInLocale } from '../src/runtime/locale-state'
import { markdownHtml } from '../src/runtime/markdown.server'
import { setSite } from '../src/runtime/site'
import { localeSettings } from '../src/server/i18n'

const settings: LocaleSettings = { ...localeSettings({ locales: ['fr', 'en'], defaultLocale: 'fr', messages: '' }), pages: ['/note'] }
const PREFIXED = ['/en/note', '/en/note/', '/en', '/en/?a=1#top']

describe('localize() under a base', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/app/en/note' })
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  it('puts the base once on an island\'s path, and does not prefix a path under a locale again', async () => {
    document.head.innerHTML = `<meta name="kay-base" content="/app"><script type="application/json" data-kay-i18n>${JSON.stringify({ locale: 'en', settings, messages: {} })}</script>`

    const { localize } = await import('../src/runtime/i18n.client')

    expect(localize('/note')).toBe('/app/en/note')
    expect(localize('/note/')).toBe('/app/en/note/')

    for (const path of PREFIXED) {
      expect(localize(path), path).toBe(`/app${path}`)
      expect(localize(path, 'fr'), path).toBe(`/app${path}`)
    }
  })

  it('leaves the base to the server\'s output on a page, a prefixed path as written', () => {
    const run = (locale: string, href: string, target?: string) => runInLocale({ locale, messages: new Map(), settings, path: '/' }, () => serverLocalize(href, target))

    expect(run('en', '/note')).toBe('/en/note')
    expect(run('en', '/note/')).toBe('/en/note/')

    for (const path of PREFIXED) {
      expect(run('en', path), path).toBe(path)
      expect(run('fr', path, 'en'), path).toBe(path)
    }
  })
})

describe('markdownHtml on a site with a path', () => {
  afterAll(() => setSite(undefined))

  it('opens an outside link in a new tab and keeps a same-site absolute link, whatever the site URL\'s path', () => {
    for (const site of ['https://x.example/app', 'https://x.example/app/']) {
      setSite(site, 'always')

      const html = markdownHtml('[away](https://other.example/app/a) [same](https://x.example/app/a) [other](https://x.example/elsewhere) [root](/app/a)')

      expect(html, site).toContain('<a href="https://other.example/app/a" target="_blank" rel="nofollow ugc noopener">')
      expect(html, site).toContain('<a href="https://x.example/app/a" rel="nofollow ugc">')
      expect(html, site).toContain('<a href="https://x.example/elsewhere" rel="nofollow ugc">')
      expect(html, site).toContain('<a href="/app/a" rel="nofollow ugc">')
    }
  })
})
