import { describe, expect, it } from 'bun:test'
import { pages } from './shared-pages'

const FIXTURE = 'tests/fixtures/library-chrome'
// A base path is stripped by the proxy in front of kay, so requests carry none.
// One library whose layout starts its own chain, mounted under a folder the app has a layout over, and one whose layout leaves the chain alone.
const OWN = { name: 'own', routes: { dir: `${FIXTURE}/lib/own`, prefix: '/studio/admin' } }
const SHARED = { name: 'shared', routes: { dir: `${FIXTURE}/lib/shared`, prefix: '/plain' } }
const I18N = { locales: ['en', 'fr'], defaultLocale: 'en', messages: `${FIXTURE}/src/messages` }

interface Variant { base: string, dev: boolean, locale: boolean }

const variants: Variant[] = [false, true].flatMap(dev => ['', '/repo'].flatMap(base => [false, true].map(locale => ({ dev, base, locale }))))

// One app per variant and security setting, served for every request of the file: a request changes nothing a later one reads.
const apps = new Map<string, ReturnType<typeof pages>>()

async function get(variant: Variant, path: string, security = false): Promise<{ status: number, html: string, headers: Headers }> {
  const key = JSON.stringify([variant, security])
  let held = apps.get(key)

  if (!held) {
    held = pages({ routes: `${FIXTURE}/src/routes`, extensions: [OWN, SHARED], prebuilt: false, security: security ? undefined : false, inlineStyles: false, site: 'https://site.example', dev: variant.dev, base: variant.base || undefined, i18n: variant.locale ? I18N : undefined })
    apps.set(key, held)
  }

  const app = await held
  const response = await app.handle(new Request(`http://localhost${variant.locale ? '/fr' : ''}${path}`))

  return { status: response.status, html: await response.text(), headers: response.headers }
}

describe('a library layout setting layouts: false', () => {
  for (const variant of variants) {
    const label = `${variant.dev ? 'dev' : 'production'}, base ${variant.base || 'unset'}, ${variant.locale ? 'locale prefix' : 'no locale'}`

    it(`drops the root layout and the app's nested layout over its prefix, keeps the app's own pages wrapped, ${label}`, async () => {
      const screen = await get(variant, '/studio/admin')

      expect(screen.status).toBe(200)
      expect(screen.html).toContain('lib-chrome')
      expect(screen.html).toContain('class="screen"')
      expect(screen.html).toContain('name="lib-head"')

      for (const left of ['site-header', 'site-footer', 'studio-wrap', 'name="app-head"'])
        expect(screen.html).not.toContain(left)

      const shop = await get(variant, '/shop')

      expect(shop.html).toContain('site-header')
      expect(shop.html).toContain('shop-wrap')
      expect(shop.html).toContain('name="app-head"')
      expect(shop.html).not.toContain('lib-chrome')
    })

    it(`leaves a library whose layout does not say so inside the app's, ${label}`, async () => {
      const { html } = await get(variant, '/plain')

      expect(html).toContain('site-header')
      expect(html).toContain('lib-plain')
    })
  }

  it('still gets the document-wide headers of the app, the content security policy included', async () => {
    const { headers, status } = await get({ base: '', dev: false, locale: false }, '/studio/admin', true)

    expect(status).toBe(200)
    expect(headers.get('content-security-policy')).toBeTruthy()
  })
})
