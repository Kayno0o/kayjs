import { describe, expect, test } from 'bun:test'
import { pageHref, pageItems } from '../src/pagination'

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

describe('pageHref', () => {
  test('sets the page in the query, keeping the rest, and leaves it out for the first page', () => {
    expect(pageHref('/posts?tag=kay', 3)).toBe('/posts?tag=kay&page=3')
    expect(pageHref(new URL('https://example.com/posts?page=3&tag=kay'), 1)).toBe('/posts?tag=kay')
    expect(pageHref('/posts', 2, 'p')).toBe('/posts?p=2')
  })
})
