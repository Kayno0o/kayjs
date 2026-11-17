import type { LocaleState } from '../src/runtime/locale-state'
import { expect, it } from 'bun:test'
import { runInLocale } from '../src/runtime/locale-state'
import { redirectLocation } from '../src/server/redirects'
import { Redirect, stoppers } from '../src/server/signals'

const HOSTILE = [
  '//evil.com',
  '///evil.com',
  '/\\evil.com',
  '\\\\evil.com',
  '\\/evil.com',
  '\\evil.com',
  '/%2F/evil.com',
  '/%2f/evil.com',
  '/%5C/evil.com',
  '/%5c/evil.com',
  '/%252F/evil.com',
  '/.%2f/evil.com',
  ' //evil.com',
  '  /\\evil.com',
  '/%09/evil.com',
  '/%0A/evil.com',
  '/%0d/evil.com',
]

it('refuses a redirect that a browser would read as another host', () => {
  for (const location of HOSTILE)
    expect(() => new Redirect(location, 302), location).toThrow('which a browser reads as another site')
})

it('refuses a tab or line break inside the slashes, which the browser would drop', () => {
  for (const location of ['/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '\t//evil.com'])
    expect(() => new Redirect(location, 302), JSON.stringify(location)).toThrow()
})

it('refuses them from the stopper a guard, a page and an action share, for a read and a post', () => {
  for (const method of ['GET', 'POST']) {
    const { redirect } = stoppers(new Request('http://localhost/', { method }))

    const target = ['//evil.com'][0]!

    expect(() => redirect(target), method).toThrow('which a browser reads as another site')
  }
})

it('keeps the paths of the site, full URLs and a query holding slashes', () => {
  for (const location of ['/', '/account', '/a/b/', '/a\\b', '/search?next=//evil.com', '/search?next=%2F%2Fevil.com', '/a#//b', 'https://example.com/x', 'http://localhost:3000/', 'HTTPS://example.com', '/日本語', 'relative/path', '?page=2', '#top', '/a%2F%2Fb'])
    expect(() => new Redirect(location, 302), location).not.toThrow()
})

it('keeps the //host of a locale on its own host, and refuses every other //', () => {
  const state = { settings: { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false, hosts: { en: 'example.com', fr: 'fr.example.com' } } } as unknown as LocaleState
  const { redirect } = stoppers(new Request('https://example.com/pricing'))
  const to = (location: string): string => {
    try {
      return runInLocale(state, () => redirect(location))
    }
    catch (error) {
      return error instanceof Redirect ? error.location : String(error)
    }
  }

  expect(to('//fr.example.com/tarifs')).toBe('//fr.example.com/tarifs')
  expect(to('//fr.example.com')).toBe('//fr.example.com')
  expect(to('//FR.example.com/x')).toBe('//FR.example.com/x')
  expect(to('//fr.example.com?a=1')).toBe('//fr.example.com?a=1')

  for (const hostile of ['//fr.example.com.evil.com/x', '//fr.example.com@evil.com/x', '//fr.example.com:8080/x', '//evil.com/x', '//fr.example.com\\@evil.com', '//fr.example.com\\evil.com', ' //fr.example.com/x', '///fr.example.com/x'])
    expect(to(hostile), hostile).toContain('which a browser reads as another site')
})

it('refuses every // when the app has no locale hosts', () => {
  const { redirect } = stoppers(new Request('https://example.com/'))
  const state = { settings: { locales: ['en'], defaultLocale: 'en', prefixDefault: false } } as unknown as LocaleState

  expect(() => runInLocale(state, () => redirect(['//fr.example.com/x'][0]!))).toThrow('which a browser reads as another site')
})

it('ignores an empty configured host, so ///evil.com is refused', () => {
  const { redirect } = stoppers(new Request('https://example.com/'))
  const state = { settings: { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false, hosts: { en: 'example.com', fr: '' } } } as unknown as LocaleState

  for (const location of ['///evil.com', '//?x', '//'])
    expect(() => runInLocale(state, () => redirect(location)), location).toThrow('which a browser reads as another site')
})

it('carries the request query before the target fragment, merged into a query of the target\'s own', () => {
  expect(redirectLocation('/new#top', '?utm=1')).toBe('/new?utm=1#top')
  expect(redirectLocation('/new?a=1#top', '?utm=1')).toBe('/new?a=1&utm=1#top')
  expect(redirectLocation('/?tab=calendar', '?month=2026-11')).toBe('/?tab=calendar&month=2026-11')
  expect(redirectLocation('/?tab=calendar', '?tab=other&month=2026-11')).toBe('/?tab=calendar&month=2026-11')
  expect(redirectLocation('/new?a=1', '?a=2&a=3')).toBe('/new?a=1')
  expect(redirectLocation('/new?a%20b=1', '?a+b=2&c=%2F')).toBe('/new?a%20b=1&c=%2F')
  expect(redirectLocation('/new?', '?utm=1')).toBe('/new?utm=1')
  expect(redirectLocation('/new#a?b', '?utm=1')).toBe('/new?utm=1#a?b')
  expect(redirectLocation('//new#top', '?utm=1')).toBe('/new?utm=1#top')
  expect(redirectLocation('/new#top', '')).toBe('/new#top')
  expect(redirectLocation('https://x.example/p#top', '?utm=1')).toBe('https://x.example/p?utm=1#top')
})

it('keeps a request param whose name is not valid percent-encoding, and does not throw on one', () => {
  expect(redirectLocation('/new?a=1', '?a=%zz')).toBe('/new?a=1')
  expect(redirectLocation('/new?a=1', '?%zz=1&b=2')).toBe('/new?a=1&%zz=1&b=2')
  expect(redirectLocation('/new?%zz=2', '?%zz=1&b=2')).toBe('/new?%zz=2&b=2')
  expect(redirectLocation('/new?%E0=2', '?%E0=1&%E0%A4=3')).toBe('/new?%E0=2&%E0%A4=3')
})
