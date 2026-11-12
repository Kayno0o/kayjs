import { describe, expect, test } from 'bun:test'
import { navAddresses, navMark } from '../src/nav-current'

const entries = (...hrefs: string[]) => navAddresses(hrefs.map(href => ({ href, label: href })))
const links = entries('/settings', '/settings?tab=billing', '/settings?tab=profile', '/docs', '/')

describe('navMark', () => {
  test('marks the page, a section holding it, and the home page only on itself', () => {
    expect(navMark('/docs', '/docs')).toBe('page')
    expect(navMark('/docs', new URL('http://x/docs/guide'))).toBe('true')
    expect(navMark('/', '/docs')).toBeUndefined()
    expect(navMark('/docs/', '/docs')).toBe('page')
  })

  test('marks a link with a query only when its query matches, a URL or a string alike, the most specific link winning', () => {
    for (const current of [new URL('http://x/settings?tab=billing'), '/settings?tab=billing']) {
      expect(navMark('/settings', current, links)).toBeUndefined()
      expect(navMark('/settings?tab=billing', current, links)).toBe('page')
      expect(navMark('/settings?tab=profile', current, links)).toBeUndefined()
    }
  })

  test('marks the plain link when no sibling names the query, and when there is no query', () => {
    expect(navMark('/settings', new URL('http://x/settings?tab=other'), links)).toBe('page')
    expect(navMark('/settings', '/settings?tab=billing', entries('/settings'))).toBe('page')
    expect(navMark('/settings', '/settings', links)).toBe('page')
    expect(navMark('/settings?tab=billing', '/settings', links)).toBeUndefined()
  })

  test('takes every param of a link, any order, one more param on the page being fine', () => {
    const both = entries('/a', '/a?x=1', '/a?x=1&y=2')

    expect(navMark('/a?y=2&x=1', '/a?x=1&y=2&z=3', both)).toBe('page')
    expect(navMark('/a?x=1', '/a?x=1&y=2&z=3', both)).toBeUndefined()
    expect(navMark('/a?x=1', '/a?x=1', both)).toBe('page')
  })

  test('never takes a link with a query for a section', () => {
    expect(navMark('/docs?x=1', '/docs/guide')).toBeUndefined()
  })

  test('never marks a link to another origin, even on the same path, and reads a relative href as currentTab does', () => {
    const page = new URL('http://x/settings')

    expect(navMark('https://other.com/settings', page)).toBeUndefined()
    expect(navMark('https://other.com/settings', '/settings')).toBeUndefined()
    expect(navMark('https://other.com/docs', new URL('http://x/docs/guide'))).toBeUndefined()
    expect(navMark('http://x/settings', page)).toBe('page')
    expect(navMark('settings', page)).toBe('page')
    expect(navMark('docs', new URL('http://x/a/docs'))).toBeUndefined()
    expect(navMark('/settings', page, entries('https://other.com/settings?tab=1'))).toBe('page')
  })

  test('never marks a malformed href', () => {
    expect(navMark('http://', '/')).toBeUndefined()
    expect(navMark('http://', new URL('http://x/'))).toBeUndefined()
  })
})

test('navAddresses lists every enabled, well-formed link and the children under them', () => {
  const found = navAddresses([{ href: '/a', label: 'A', children: [{ href: '/a?x=1', label: 'X' }] }, { href: '/b', label: 'B', disabled: true }, { href: 'http://', label: 'C' }])

  expect(found.map(url => url.pathname + url.search)).toEqual(['/a', '/a?x=1'])
})

describe('addresses on the page\'s own host', () => {
  test('a protocol-relative link takes the page\'s scheme, an absolute own-origin link is read as written, base path included', () => {
    const page = new URL('https://example.com/x')

    expect(navMark('//example.com/x', page)).toBe('page')
    expect(navMark('//other.com/x', page)).toBeUndefined()

    const based = new URL('https://example.com/base/settings')

    expect(navMark('https://example.com/base/settings', based)).toBe('page')
    expect(navMark('https://example.com/base/settings', new URL('https://example.com/settings'))).toBeUndefined()
    expect(navMark('https://example.com/base', based)).toBe('true')
  })
})
