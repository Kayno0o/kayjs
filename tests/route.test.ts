import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { route } from '../src/runtime/route'
import { pages } from '../src/server'
import { scratchDir } from './scratch'

// Nothing is registered here, so every pattern and params are accepted and the cases are about the string.
describe('route()', () => {
  it('writes a page with no param as it is', () => {
    expect(route('/')).toBe('/')
    expect(route('/about')).toBe('/about')
    expect(route('/a/b/c')).toBe('/a/b/c')
  })

  it('fills the params, strings and numbers', () => {
    expect(route('/smash-or-pass/session/:id', { id: 42 })).toBe('/smash-or-pass/session/42')
    expect(route('/smash-or-pass/session/:id/results', { id: 'abc' })).toBe('/smash-or-pass/session/abc/results')
    expect(route('/users/:user/posts/:post', { user: 'ada', post: 7 })).toBe('/users/ada/posts/7')
  })

  it('leaves an optional param out when it is undefined', () => {
    expect(route('/blog/:page?', {})).toBe('/blog')
    expect(route('/blog/:page?', { page: undefined })).toBe('/blog')
    expect(route('/blog/:page?', { page: 2 })).toBe('/blog/2')
    expect(route('/blog/:page?')).toBe('/blog')
  })

  it('joins a catch-all by its segments', () => {
    expect(route('/docs/*path', { path: 'a/b c' })).toBe('/docs/a/b%20c')
    expect(route('/docs/*path', { path: ['a', 'b/c'] })).toBe('/docs/a/b%2Fc')
    expect(route('/docs/*path', { path: '' })).toBe('/docs/')
    expect(route('/docs/*path', { path: [] })).toBe('/docs/')
  })

  it('reads the options of a page with no param after the params the loose typing asks for', () => {
    expect((route as (...args: unknown[]) => string)('/about', undefined, { query: { a: 1 } })).toBe('/about?a=1')
    expect(route('/about', { query: { a: 1 } })).toBe('/about?a=1')
  })

  it('adds a query and a hash', () => {
    expect(route('/search', { query: { q: 'a b', tag: ['x', 'y'], skip: undefined, none: null, done: true, page: 2 }, hash: 'top' })).toBe('/search?q=a+b&tag=x&tag=y&done=true&page=2#top')
    expect(route('/todos/:id', { id: 1 }, { query: { done: false }, hash: 'a b' })).toBe('/todos/1?done=false#a%20b')
    expect(route('/search', { query: {} })).toBe('/search')
    expect(route('/search', { query: { q: '&=#' } })).toBe('/search?q=%26%3D%23')
  })

  describe('a hostile value', () => {
    const one = (id: string) => route('/items/:id', { id })

    it('cannot leave its segment', () => {
      expect(one('../admin')).toBe('/items/..%2Fadmin')
      expect(one('a/b')).toBe('/items/a%2Fb')
      expect(one('%2F')).toBe('/items/%252F')
      expect(one('50%')).toBe('/items/50%25')
      expect(one('a?b#c')).toBe('/items/a%3Fb%23c')
      expect(one('a\\b')).toBe('/items/a%5Cb')
      expect(one('a b')).toBe('/items/a%20b')
    })

    it('cannot walk up the path as a dot segment, which a browser resolves even as %2E', () => {
      expect(() => one('..')).toThrow('param "id" is ".."')
      expect(() => one('.')).toThrow('param "id" is "."')
      expect(one('...')).toBe('/items/...')
      expect(() => route('/docs/*path', { path: '../etc' })).toThrow('param "path" is ".."')
      expect(() => route('/docs/*path', { path: ['..'] })).toThrow('param "path" is ".."')
    })

    it('is written in unicode as percent-encoded UTF-8', () => {
      expect(one('café')).toBe('/items/caf%C3%A9')
      expect(one('😀')).toBe('/items/%F0%9F%98%80')
    })

    it('refuses what would make another route', () => {
      expect(() => one('')).toThrow('param "id" is ""')
      expect(() => route('/items/:id', {} as never)).toThrow('param "id" is undefined')
      expect(() => route('/items/:id', { id: null } as never)).toThrow('param "id" is null')
      expect(() => route('/items/:id', { id: {} } as never)).toThrow('param "id" is [object Object]')
      expect(() => route('/docs/*path', { path: 'a//b' })).toThrow('param "path" is ""')
      expect(() => one('\uD800')).toThrow('param "id" is not valid text')
      expect(() => route('/items/:id', { id: Number.NaN })).toThrow('param "id" is ""')
      expect(() => route('/docs/*path', { path: '/a' })).toThrow('param "path" is ""')
      expect(() => route('/docs/*path', { path: 'a/' })).toThrow('param "path" is ""')
    })
  })
})

const LINKS = 'a.lit(href="/blog/caf%C3%A9?x=1#top") lit\na.made(href={route(\'/blog/:slug\', { slug: \'café\' }, { query: { x: 1 }, hash: \'top\' })}) made\na.lit(href="/about") lit\na.made(href={route(\'/about\')}) made\na.lit(href="/docs/a/b") lit\na.made(href={route(\'/docs/*path\', { path: \'a/b\' })}) made\na.lit(href="/") lit\na.made(href={route(\'/\')}) made\n'

// A link made by route() is the string a literal one is, so the server puts the mount point and the locale on it as it does on that one.
describe('route() in a page', () => {
  it('renders the URLs a literal href renders, under a base, a trailing slash and locales', async () => {
    const routes = await scratchDir('route-')

    await Promise.all(Object.entries({
      'links.kay': `---\nimport { route } from 'kay'\n---\n${LINKS}`,
      'about.kay': 'p about\n',
      'blog/[slug].kay': 'p post\n',
      'docs/[...path].kay': 'p docs\n',
      'index.kay': 'p home\n',
    }).map(async ([file, source]) => Bun.write(join(routes, file), source)))

    try {
      const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages', paths: { '/about': { en: '/about-us' }, '/blog/:slug': { en: '/articles/:slug' } } }
      const sites = [{}, { base: '/shop' }, { trailingSlash: 'always' as const }, { base: '/shop', trailingSlash: 'always' as const }]

      for (const options of sites) {
        for (const locale of [undefined, i18n, { ...i18n, prefixDefault: true }]) {
          const app = new Elysia().use(await pages({ routes, prebuilt: false, security: false, ...options, ...locale && { i18n: locale } }))

          for (const prefix of locale === undefined ? [''] : ['', '/en']) {
            const html = await (await app.handle(new Request(`http://localhost${prefix}${prefix === '' && (locale !== undefined && 'prefixDefault' in locale) ? '/fr' : ''}/links${options.trailingSlash === 'always' ? '/' : ''}`))).text()
            const hrefs = (name: string) => [...html.matchAll(new RegExp(`<a class="${name}" href="([^"]*)"`, 'g'))].map(match => match[1])

            expect(hrefs('lit')).toHaveLength(4)
            expect(hrefs('made')).toEqual(hrefs('lit'))
          }
        }
      }

      const plain = new Elysia().use(await pages({ routes, prebuilt: false, security: false, base: '/shop', i18n }))
      const english = await (await plain.handle(new Request('http://localhost/en/links'))).text()

      expect(english).toContain('<a class="made" href="/shop/en/articles/caf%C3%A9?x=1#top">')
      expect(english).toContain('<a class="made" href="/shop/en/about-us">')
    }
    finally { await rm(routes, { recursive: true, force: true }) }
  })
})
