import { describe, expect, test } from 'bun:test'
import { navHrefs, navMark } from '../src/nav-current'

const links = ['/settings', '/settings?tab=billing', '/settings?tab=profile', '/docs', '/']

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
    expect(navMark('/settings', '/settings?tab=billing', ['/settings'])).toBe('page')
    expect(navMark('/settings', '/settings', links)).toBe('page')
    expect(navMark('/settings?tab=billing', '/settings', links)).toBeUndefined()
  })

  test('takes every param of a link, any order, one more param on the page being fine', () => {
    const both = ['/a', '/a?x=1', '/a?x=1&y=2']

    expect(navMark('/a?y=2&x=1', '/a?x=1&y=2&z=3', both)).toBe('page')
    expect(navMark('/a?x=1', '/a?x=1&y=2&z=3', both)).toBeUndefined()
    expect(navMark('/a?x=1', '/a?x=1', both)).toBe('page')
  })

  test('never takes a link with a query for a section', () => {
    expect(navMark('/docs?x=1', '/docs/guide')).toBeUndefined()
  })
})

test('navHrefs lists every enabled link and the children under them', () => {
  expect(navHrefs([{ href: '/a', label: 'A', children: [{ href: '/a?x=1', label: 'X' }] }, { href: '/b', label: 'B', disabled: true }])).toEqual(['/a', '/a?x=1'])
})
