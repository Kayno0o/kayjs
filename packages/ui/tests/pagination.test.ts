import { describe, expect, test } from 'bun:test'
import { currentPage, offsetHref, openSteps, pageHref, pageItems } from '../src/pagination'

describe('pageItems', () => {
  test('shows the first and last pages and the current one\'s neighbours, a gap for the pages left out', () => {
    expect(pageItems(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20])
    expect(pageItems(1, 20)).toEqual([1, 2, 'gap', 20])
    expect(pageItems(20, 20, 2)).toEqual([1, 'gap', 18, 19, 20])
  })

  test('shows a page a gap would hide alone, and every page of a short list', () => {
    expect(pageItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(pageItems(1, 3)).toEqual([1, 2, 3])
    expect(pageItems(1, 1)).toEqual([1])
  })
})

describe('currentPage', () => {
  test('reads any page a query gives as one that exists', () => {
    expect(currentPage(Number('abc'), 20)).toBe(1)
    expect(currentPage(2.5, 20)).toBe(2)
    expect(currentPage(50, 20)).toBe(20)
    expect(currentPage(-3, 20)).toBe(1)
    expect(currentPage(4, 0)).toBe(1)
  })

  test('shows no neighbour with siblings at 0', () => {
    expect(pageItems(5, 9, 0)).toEqual([1, 'gap', 5, 'gap', 9])
  })
})

describe('pageHref', () => {
  test('sets the page in the query, keeping the rest, and leaves it out for the first page', () => {
    expect(pageHref('/posts?tag=kay', 3)).toBe('/posts?tag=kay&page=3')
    expect(pageHref(new URL('https://example.com/posts?page=3&tag=kay'), 1)).toBe('/posts?tag=kay')
    expect(pageHref('/posts', 2, 'p')).toBe('/posts?p=2')
  })
})

describe('offsetHref', () => {
  test('sets the offset in the query, keeping the rest, and leaves it out at 0', () => {
    expect(offsetHref('/gallery?tag=kay', 20)).toBe('/gallery?tag=kay&offset=20')
    expect(offsetHref('/gallery?offset=20', 0)).toBe('/gallery')
    expect(offsetHref('/gallery', 40, 'from')).toBe('/gallery?from=40')
  })
})

describe('openSteps', () => {
  test('links the page before past the first, and the page after while there is more', () => {
    expect(openSteps({ page: 1 }, true, '/gallery')).toEqual({ previous: undefined, next: '/gallery?page=2' })
    expect(openSteps({ page: 3 }, false, '/gallery?page=3')).toEqual({ previous: '/gallery?page=2', next: undefined })
  })

  test('steps an offset by the page\'s length, never below the start', () => {
    expect(openSteps({ offset: 10, limit: 20 }, true, '/gallery?offset=10')).toEqual({ previous: '/gallery', next: '/gallery?offset=30' })
    expect(openSteps({ offset: 0, limit: 20 }, false, '/gallery')).toEqual({ previous: undefined, next: undefined })
  })

  test('reads a position that is no whole number as the start', () => {
    expect(openSteps({ offset: Number.NaN, limit: 20 }, true, '/gallery')).toEqual({ previous: undefined, next: '/gallery?offset=20' })
    expect(openSteps({ page: Number.NaN }, false, '/gallery')).toEqual({ previous: undefined, next: undefined })
  })
})
