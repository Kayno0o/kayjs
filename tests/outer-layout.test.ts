import { describe, expect, it } from 'bun:test'
import { routeMounts, scanRoutes } from '../src/server/routes'
import { pages } from './shared-pages'

const FIXTURE = 'tests/fixtures/outer-layout'
const OUTER = { name: 'outer', layout: `${FIXTURE}/lib/outer/_layout.kay` }
const OWN = { name: 'own', routes: { dir: `${FIXTURE}/lib/own`, prefix: '/own' } }

interface Variant { base: string, dev: boolean, locale: boolean }

const variants: Variant[] = [false, true].flatMap(dev => ['', '/repo'].flatMap(base => [false, true].map(locale => ({ dev, base, locale }))))

async function get(variant: Variant, path: string): Promise<{ status: number, html: string }> {
  const app = await pages({ routes: `${FIXTURE}/src/routes`, extensions: [OUTER, OWN], prebuilt: false, security: false, inlineStyles: false, site: 'https://site.example', dev: variant.dev, base: variant.base || undefined, i18n: variant.locale ? { locales: ['en', 'fr'], defaultLocale: 'en', messages: `${FIXTURE}/src/messages` } : undefined })
  const response = await app.handle(new Request(`http://localhost${variant.locale ? '/fr' : ''}${variant.locale && path === '/' ? '' : path}`))

  return { status: response.status, html: await response.text() }
}

describe('an extension layout wrapping every page', () => {
  for (const variant of variants) {
    const label = `${variant.dev ? 'dev' : 'production'}, base ${variant.base || 'unset'}, ${variant.locale ? 'locale prefix' : 'no locale'}`

    it(`renders after the app's layouts on a page and on the not found page, ${label}`, async () => {
      for (const [path, status] of [['/', 200], ['/missing', 404]] as const) {
        const { html, status: got } = await get(variant, path)

        expect(got).toBe(status)
        expect(html.indexOf('site-header')).toBeGreaterThan(-1)
        expect(html.indexOf('outer-tail')).toBeGreaterThan(html.indexOf('site-header'))
      }
    })

    it(`leaves a screen starting its own chain bare, ${label}`, async () => {
      const { html } = await get(variant, '/own')

      expect(html).toContain('own-chrome')
      expect(html).not.toContain('outer-tail')
      expect(html).not.toContain('site-header')
    })
  }

  it('serves no page of its own and the app\'s layout leads the chain', async () => {
    const routes = await scanRoutes(`${FIXTURE}/src/routes`, routeMounts(process.cwd(), [OUTER, OWN]))

    expect(routes.map(route => route.pattern).sort()).toEqual(['/', '/own'])
    expect(routes.find(route => route.pattern === '/')!.layouts.map(file => file.split('/').slice(-3).join('/'))).toEqual(['outer/_layout.kay', 'routes/_layout.kay'].map(name => name.startsWith('outer') ? `lib/${name}` : `src/${name}`))
  })
})
