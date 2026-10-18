import type { LocaleState } from '../src/runtime/locale-state'
import { expect, it } from 'bun:test'
import { runInLocale } from '../src/runtime/locale-state'
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

it('turns the //host a locale on its own host gives into a full URL, and only for the app\'s own hosts', () => {
  const state = { settings: { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false, hosts: { en: 'example.com', fr: 'exemple.fr' } } } as unknown as LocaleState
  const { redirect } = stoppers(new Request('https://example.com/pricing'))
  const to = (location: string): string => {
    try {
      return runInLocale(state, () => redirect(location))
    }
    catch (error) {
      return error instanceof Redirect ? error.location : String(error)
    }
  }

  expect(to('//exemple.fr/tarifs')).toBe('https://exemple.fr/tarifs')
  expect(to('//exemple.fr')).toBe('https://exemple.fr')
  expect(to('//evil.example/x')).toContain('which a browser reads as another site')
  expect(to('//exemple.fr.evil.example/x')).toContain('which a browser reads as another site')
})
