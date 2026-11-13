import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from './shared-pages'

interface Variant { name: string, base: string, trailingSlash: 'always' | 'never' | 'ignore', dev: boolean, locale?: string }

const VARIANTS: Variant[] = [
  { name: 'plain', base: '', trailingSlash: 'never', dev: false },
  { name: 'a base and slashes', base: '/shop', trailingSlash: 'always', dev: false },
  { name: 'dev', base: '', trailingSlash: 'ignore', dev: true },
  { name: 'a locale', base: '', trailingSlash: 'never', dev: false, locale: 'fr' },
]

const SLOT = /<slot data-component="[^"]*panel\.kay"/g
const SCRIPT = /<script[^>]*src="[^"]*\/_kay\/(?!dev\/)/
const MARKERS = /<!--.*?-->/g

for (const { name, base, trailingSlash, dev, locale } of VARIANTS) {
  describe(`a use of an island that turns none of its interactive props on, ${name}`, () => {
    const app = (async () => new Elysia().use(await pages({ root: 'tests/fixtures/static-island', prebuilt: false, security: false, base: base || undefined, trailingSlash, dev, i18n: locale === undefined ? undefined : { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } })))()
    const fetched = async (path: string): Promise<string> => (await (await app).handle(new Request(`http://localhost${locale === undefined ? '' : `/${locale}`}${path}${trailingSlash === 'always' ? '/' : ''}`))).text()
    // The markers the server writes for the browser to claim are left out of the markup read.
    const html = async (path: string): Promise<string> => (await fetched(path)).replace(MARKERS, '')
    const islands = (page: string) => page.match(SLOT)?.length ?? 0

    it('renders as markup and loads no script', async () => {
      const page = await html('/static')

      expect(page).toContain('<li>b</li>')
      expect(page).not.toContain('<button')
      expect(islands(page)).toBe(0)
      expect(page).not.toMatch(SCRIPT)
    }, 60_000)

    it('is an island while a prop is on, by its default, by a value or through a spread', async () => {
      for (const path of ['/plain', '/selecting', '/spread']) {
        const page = await html(path)

        expect(islands(page), path).toBe(1)
        expect(page, path).toMatch(SCRIPT)
      }
    }, 60_000)

    it('is an island where the use asks to hydrate', async () => {
      expect(islands(await html('/hydrated'))).toBe(1)
    }, 60_000)

    it('leaves the one that needs the browser its island when it stands beside a static one', async () => {
      const page = await html('/both')

      expect(page).toContain('<li>one</li>')
      expect(islands(page)).toBe(1)
      expect(page).toMatch(SCRIPT)
    }, 60_000)

    it('is the same markup in a navigation swap', async () => {
      const swapped = async (path: string) => (await (await app).handle(new Request(`http://localhost${locale === undefined ? '' : `/${locale}`}${path}${trailingSlash === 'always' ? '/' : ''}`, { headers: { 'x-kay-navigate': '1', 'accept': 'text/html' } }))).text()

      expect(islands(await swapped('/static'))).toBe(0)
      expect(islands(await swapped('/plain'))).toBe(1)
    }, 60_000)

    it('takes the ids of what comes after as an island before it would', async () => {
      const idsOf = (page: string) => [page.match(/<slot data-component="[^"]*field\.kay"[^>]*data-uid="([^"]+)"/)?.[1], page.match(/<input id="([^"]+)"/)?.[1]]
      const [alone, held] = [idsOf(await fetched('/ids-static')), idsOf(await fetched('/ids-island'))]

      expect(alone[0]).toBeDefined()
      expect(alone[1]).toBeDefined()
      expect(alone[0]!.replace(/^[^-]*-/, '')).toBe(held[0]!.replace(/^[^-]*-/, ''))
    }, 60_000)

    it('renders its children in the page and leaves an island inside it an island of its own', async () => {
      const page = await html('/shell')

      expect(page).toContain('<section class="shell"><p>Inside</p>')
      expect(page).not.toMatch(/<slot data-component="[^"]*shell\.kay"/)
      expect(page.match(/<slot data-component="[^"]*field\.kay"/g)?.length).toBe(1)
    }, 60_000)

    it('is refused as the island would for a prop that cannot reach the browser, a promise', async () => {
      expect(await html('/promised')).not.toContain('<section class="shell"')
    }, 60_000)

    it('is part of the island it stands in, with no island of its own', async () => {
      const page = await html('/nested')

      expect(islands(page)).toBe(0)
      expect(page.match(/<slot data-component="[^"]*host\.kay"/g)?.length).toBe(1)
      expect(page).toContain('<li>x</li>')
    }, 60_000)
  })
}
