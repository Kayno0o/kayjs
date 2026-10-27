import type { Elysia } from 'elysia'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const HREFS = /<a class="(\w+)" href="([^"]*)"/g

describe('withQuery in a server fence', () => {
  let dir = ''
  let plain: Elysia
  let mounted: Elysia
  let localized: Elysia

  const get = async (server: Elysia, path: string) => {
    const response = await server.handle(new Request(`http://localhost${path}`))

    return { status: response.status, hrefs: Object.fromEntries([...(await response.text()).matchAll(HREFS)].map(([, name, href]) => [name, href!.replaceAll('&amp;', '&')])) as Record<string, string | undefined> }
  }

  beforeAll(async () => {
    dir = await scratchDir('with-query-')
    await Promise.all([
      Bun.write(join(dir, 'routes/shop/index.kay'), '--- server\nconst page = withQuery({ page: 2, sort: \'name\' })\nconst drop = withQuery({ sort: null, page: undefined })\nconst empty = withQuery({ sort: \'\' })\nconst same = withQuery({})\nconst zero = withQuery({ page: 0 })\n---\na.next(href={page}) Next\na.drop(href={drop}) Drop\na.empty(href={empty}) Empty\na.same(href={same}) Same\na.zero(href={zero}) Zero\n'),
      Bun.write(join(dir, 'routes/index.kay'), '--- server\nconst filtered = withQuery({ filter: \'a&b=c\' })\n---\na.filtered(href={filtered}) Filter\n'),
    ])
    plain = await pages({ root: dir, routes: 'routes', prebuilt: false, security: false })
    mounted = await pages({ root: dir, routes: 'routes', prebuilt: false, security: false, base: '/repo', trailingSlash: 'always' })
    localized = await pages({ root: dir, routes: 'routes', prebuilt: false, security: false, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('links to the current page with a param set, and drops a null, undefined or empty one', async () => {
    const { status, hrefs } = await get(plain, '/shop?sort=price&color=red&page=1')

    expect(status).toBe(200)
    expect(hrefs.next).toBe('/shop?sort=name&color=red&page=2')
    expect(hrefs.drop).toBe('/shop?color=red')
    expect(hrefs.empty).toBe('/shop?color=red&page=1')
    expect(hrefs.same).toBe('/shop?sort=price&color=red&page=1')
    expect(hrefs.zero).toBe('/shop?sort=price&color=red&page=0')
  })

  it('adds a param to a page with no query, and gives the bare path when the last one is dropped', async () => {
    expect((await get(plain, '/shop')).hrefs.next).toBe('/shop?page=2&sort=name')
    expect((await get(plain, '/shop?sort=x')).hrefs.drop).toBe('/shop')
  })

  it('replaces every value of a repeated param and encodes the new one', async () => {
    expect((await get(plain, '/shop?sort=a&sort=b')).hrefs.next).toBe('/shop?sort=name&page=2')
    expect((await get(plain, '/?filter=old')).hrefs.filtered).toBe('/?filter=a%26b%3Dc')
  })

  it('keeps the base and the trailing slash of the page', async () => {
    const { hrefs } = await get(mounted, '/shop/?page=1')

    expect(hrefs.next).toBe('/repo/shop/?page=2&sort=name')
    expect(hrefs.drop).toBe('/repo/shop/')
  })

  it('keeps the locale prefix of the page', async () => {
    expect((await get(localized, '/fr/shop?page=1')).hrefs.next).toBe('/fr/shop?page=2&sort=name')
    expect((await get(localized, '/shop?page=1')).hrefs.next).toBe('/shop?page=2&sort=name')
  })

  it('never makes a link to another site of a path starting with two slashes', async () => {
    const response = await plain.handle(new Request('http://localhost//shop?page=1'))
    const hrefs = [...(await response.text()).matchAll(HREFS)].map(([, , href]) => href!)

    for (const href of hrefs)
      expect(href.startsWith('//')).toBeFalse()
  })
})

describe('withQuery in the browser', () => {
  const real = { document: (globalThis as { document?: unknown }).document, location: (globalThis as { location?: unknown }).location }

  afterAll(() => {
    Object.assign(globalThis, real)
  })

  // The mount point is read off the page once, so every address here is under the same one.
  async function linkFrom(href: string, changes: Record<string, string | number | null | undefined>) {
    const url = new URL(href)

    Object.assign(globalThis, { document: { querySelector: () => ({ content: '/repo' }) }, location: { pathname: url.pathname, search: url.search, href: url.href } })

    const { withQuery } = await import('../src/runtime/with-query')

    return withQuery(changes)
  }

  it('reads the address, takes the mount point off and merges as navigate does', async () => {
    expect(await linkFrom('https://example.com/repo/shop?sort=price&page=1', { page: 2, sort: null })).toBe('/shop?page=2')
    expect(await linkFrom('https://example.com/repo/shop?sort=price&page=1#top', { sort: '' })).toBe('/shop?page=1')
  })

  it('keeps the other params and the trailing slash of the path', async () => {
    expect(await linkFrom('https://example.com/repo/shop/?a=1&b=2', { b: 3 })).toBe('/shop/?a=1&b=3')
  })

  it('never returns a path another host would read', async () => {
    expect(await linkFrom('https://example.com//evil.example/x?a=1', { b: 1 })).toBe('/evil.example/x?a=1&b=1')
    expect(await linkFrom('https://example.com//evil.example', {})).toBe('/evil.example')
  })
})
