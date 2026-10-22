import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from './shared-pages'

const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages') }
const MARKED = /<a class="(\w+)"[^>]*? aria-current="(page|true)"/g

// The classes of the links a page marks, each with its mark.
async function marks(site: Elysia, path: string): Promise<string[]> {
  const html = await (await site.handle(new Request(`http://localhost${path}`))).text()

  return [...html.matchAll(MARKED)].map(([, name, mark]) => `${name}:${mark}`)
}

describe('a link marked section', () => {
  it('is marked true on the pages below it, never the home link, nor one that only starts like it, and a link merely pointing up is not', async () => {
    const site = new Elysia().use(await pages({ root: 'tests/fixtures/current-section', prebuilt: false, security: false }))

    expect(await marks(site, '/')).toEqual(['home:page'])
    expect(await (await site.handle(new Request('http://localhost/docs/guide'))).text()).not.toContain('section')
    expect(await marks(site, '/docs')).toEqual(['docs:page', 'up:page', 'on:page', 'off:page'])
    expect(await marks(site, '/docs/guide')).toEqual(['docs:true', 'guide:page', 'on:true'])
    expect(await marks(site, '/docs-old')).toEqual(['old:page'])
  })

  it('holds under a base, with a trailing slash either way', async () => {
    for (const trailingSlash of ['always', 'never'] as const) {
      const site = new Elysia().use(await pages({ root: 'tests/fixtures/current-section', prebuilt: false, security: false, base: '/repo', trailingSlash }))
      const slash = trailingSlash === 'always' ? '/' : ''

      expect(await marks(site, `/docs/guide${slash}`)).toEqual(['docs:true', 'guide:page', 'on:true'])
      expect(await marks(site, `/docs${slash}`)).toEqual(['docs:page', 'up:page', 'on:page', 'off:page'])
      expect(await marks(site, '/')).toEqual(['home:page'])
      expect(await (await site.handle(new Request('http://localhost/docs/guide'))).text()).not.toContain('section')
    }
  })

  it('holds under a locale prefix, whose own home is not a section', async () => {
    for (const prefixDefault of [true, false]) {
      const site = new Elysia().use(await pages({ root: 'tests/fixtures/current-section', prebuilt: false, security: false, i18n: { ...i18n, prefixDefault } }))
      const french = prefixDefault ? '/fr' : ''

      expect(await marks(site, `${french}/docs/guide`)).toEqual(['docs:true', 'guide:page', 'on:true'])
      expect(await marks(site, `${french}/docs`)).toEqual(['docs:page', 'up:page', 'on:page', 'off:page'])
      expect(await marks(site, '/en/docs/guide')).toEqual(['docs:true', 'guide:page', 'on:true'])
      expect(await marks(site, '/en/docs-old')).toEqual(['old:page'])
      expect(await marks(site, '/en/docs')).toEqual(['docs:page', 'up:page', 'on:page', 'off:page'])
      expect(await marks(site, '/en')).toEqual(['home:page'])
    }
  })

  it('holds under a base and a locale prefix together', async () => {
    const site = new Elysia().use(await pages({ root: 'tests/fixtures/current-section', prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true }, base: '/repo', trailingSlash: 'always' }))

    expect(await marks(site, '/en/docs/guide/')).toEqual(['docs:true', 'guide:page', 'on:true'])
    expect(await marks(site, '/en/')).toEqual(['home:page'])
    expect(await marks(site, '/fr/docs/')).toEqual(['docs:page', 'up:page', 'on:page', 'off:page'])
  })
})
