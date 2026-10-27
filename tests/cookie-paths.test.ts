import type { Action } from '../src/runtime'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { testSite } from '../src/test'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/cookie-paths'
const I18N = 'tests/fixtures/i18n'
const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages') }
const sites = {
  root: await testSite({ root: ROOT, islands: false }),
  mounted: await testSite({ root: ROOT, islands: false, base: '/blog' }),
  strict: await testSite({ root: ROOT, islands: false, base: '/blog', trailingSlash: 'always' }),
}
const { save } = await import(join(import.meta.dir, 'fixtures/cookie-paths/src/routes/index.kay')) as { save: Action<Record<never, never>, string> }

afterAll(async () => {
  await Promise.all(Object.values(sites).map(async site => site.close()))
})

// The Set-Cookie headers of a plain form post, before the browser follows its redirect.
async function posted(site: typeof sites.root, from: string): Promise<string[]> {
  const page = await site.fetch(from)
  const response = await site.fetch(save.url, { method: 'POST', headers: { origin: 'http://localhost', referer: new URL(from, 'http://localhost').href }, body: new FormData() })

  expect(page.status).toBe(200)

  return response.headers.getSetCookie()
}

describe('the flash cookie', () => {
  it('is set for the whole host at the root, and for the base under one', async () => {
    expect((await posted(sites.root, '/'))[0]).toMatch(/^kay_flash=.*; Path=\/; /)
    expect((await posted(sites.mounted, '/blog'))[0]).toMatch(/^kay_flash=.*; Path=\/blog; /)
    expect((await posted(sites.strict, '/blog/'))[0]).toMatch(/^kay_flash=.*; Path=\/blog; /)
  })

  it('is read once on the page the browser goes back to and cleared at the path it was set at', async () => {
    for (const [site, path] of [[sites.root, '/'], [sites.mounted, '/blog'], [sites.strict, '/blog/']] as const) {
      const visit = await site.submit(save, {}, { from: path })

      expect(visit.find('.done')[0]?.text).toBe('saved')
      expect(site.cookies.has('kay_flash')).toBe(false)
      // Deleted where it was set: a delete at another path would leave it for the next page.
      expect((await site.visit(path)).find('.done')).toEqual([])
    }
  })
})

describe('the flash cookie against a request for another page', () => {
  it('is left for the page it goes back to, whatever fetched another page meanwhile', async () => {
    for (const [site, path, other] of [[sites.root, '/', '/other'], [sites.mounted, '/blog', '/blog/other']] as const) {
      const header = (await posted(site, path))[0]!
      const cookie = header.slice(0, header.indexOf(';'))
      const elsewhere = await site.fetch(other, { headers: { cookie } })

      expect(elsewhere.status).toBe(200)
      expect(elsewhere.headers.getSetCookie().join()).not.toContain('kay_flash')

      const back = await site.fetch(path, { headers: { cookie } })

      expect(await back.text()).toContain('saved')
      expect(back.headers.getSetCookie().join()).toContain('kay_flash=;')
    }
  })
})

describe('the locale cookie', () => {
  const get = async (served: Elysia, path: string, headers: Record<string, string>) => served.handle(new Request(`http://localhost${path}`, { headers }))
  const followed = { 'sec-fetch-site': 'same-origin' }

  it('is named kay_locale like the others, at the root or at the base', async () => {
    const root = new Elysia().use(await pages({ root: I18N, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true } }))
    const mounted = new Elysia().use(await pages({ root: I18N, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true }, base: '/docs', trailingSlash: 'always' }))

    expect((await get(root, '/fr/about', followed)).headers.get('set-cookie')).toBe('kay_locale=fr; Path=/; Max-Age=31536000; SameSite=Lax')
    expect((await get(mounted, '/fr/about/', followed)).headers.get('set-cookie')).toBe('kay_locale=fr; Path=/docs; Max-Age=31536000; SameSite=Lax')
  })

  it('reads the name an older kay set, the new one first, and sets no cookie for the locale it holds', async () => {
    const served = new Elysia().use(await pages({ root: I18N, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true } }))
    const redirect = async (cookie: string) => (await get(served, '/about', { 'accept-language': 'en', cookie })).headers.get('location')

    expect(await redirect('kay-locale=fr')).toBe('/fr/about')
    expect(await redirect('kay_locale=fr')).toBe('/fr/about')
    expect(await redirect('kay-locale=fr; kay_locale=en')).toBe('/en/about')
    expect(await redirect('kay-locale=de')).toBe('/en/about')
    expect((await get(served, '/fr/about', { ...followed, cookie: 'kay-locale=fr' })).headers.get('set-cookie')).toBeNull()
    expect((await get(served, '/fr/about', { ...followed, cookie: 'kay-locale=en' })).headers.get('set-cookie')).toStartWith('kay_locale=fr;')
  })
})

describe('the cookies over https', () => {
  const HTTPS = { 'x-forwarded-proto': 'https' }
  const SECURE_FLASH = /^(?:__Host-|__Secure-)kay_flash=([^;]+);/

  // The flash a post over https leaves, as its name and value.
  async function flashed(site: typeof sites.root, from: string): Promise<{ value: string, header: string }> {
    await site.fetch(from)
    const response = await site.fetch(save.url, { method: 'POST', headers: { ...HTTPS, origin: 'http://localhost', referer: new URL(from, 'http://localhost').href }, body: new FormData() })
    const header = response.headers.getSetCookie()[0]!

    return { value: SECURE_FLASH.exec(header)?.[1] ?? '', header }
  }

  async function shown(site: typeof sites.root, path: string, cookie: string): Promise<boolean> {
    return (await (await site.fetch(path, { headers: { ...HTTPS, cookie } })).text()).includes('saved')
  }

  it('names the flash __Host- at the root and __Secure- under a base, and reads only that name', async () => {
    const root = await flashed(sites.root, '/')
    const mounted = await flashed(sites.mounted, '/blog')

    expect(root.header).toStartWith('__Host-kay_flash=')
    expect(root.header).toContain('Path=/;')
    expect(mounted.header).toStartWith('__Secure-kay_flash=')
    expect(mounted.header).toContain('Path=/blog;')
    expect(await shown(sites.root, '/', `__Host-kay_flash=${root.value}`)).toBe(true)
    expect(await shown(sites.mounted, '/blog', `__Secure-kay_flash=${mounted.value}`)).toBe(true)
    // The plain name, which another host of the site may have set, reads as none over https.
    expect(await shown(sites.root, '/', `kay_flash=${root.value}`)).toBe(false)
    expect(await shown(sites.root, '/', `__Secure-kay_flash=${root.value}`)).toBe(false)
  })

  it('opens a flash under the name it was sealed for alone', async () => {
    const mounted = await flashed(sites.mounted, '/blog')

    expect(await shown(sites.root, '/', `__Host-kay_flash=${mounted.value}`)).toBe(false)
  })

  it('names the locale cookie by the same rule, and reads either prefixed name over https and the plain one over http', async () => {
    const root = new Elysia().use(await pages({ root: I18N, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true } }))
    const mounted = new Elysia().use(await pages({ root: I18N, prebuilt: false, security: false, i18n: { ...i18n, prefixDefault: true }, base: '/docs', trailingSlash: 'always' }))
    const get = async (served: Elysia, path: string, headers: Record<string, string>) => served.handle(new Request(`http://localhost${path}`, { headers: { ...HTTPS, 'sec-fetch-site': 'same-origin', ...headers } }))

    expect((await get(root, '/fr/about', {})).headers.get('set-cookie')).toBe('__Host-kay_locale=fr; Path=/; Max-Age=31536000; SameSite=Lax; Secure')
    expect((await get(mounted, '/fr/about/', {})).headers.get('set-cookie')).toBe('__Secure-kay_locale=fr; Path=/docs; Max-Age=31536000; SameSite=Lax; Secure')
    expect((await get(root, '/about', { 'accept-language': 'en', 'cookie': '__Host-kay_locale=fr' })).headers.get('location')).toBe('/fr/about')
    expect((await get(root, '/about', { 'accept-language': 'en', 'cookie': 'kay_locale=fr' })).headers.get('location')).toBe('/en/about')
  })
})
