import type { CollectionInfo } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { entryPath, newEntryPath, onPagePath, pageOf, rowsOf, searchRows } from '../src/listing'

const posts: CollectionInfo = {
  name: 'posts',
  kind: 'folder',
  localized: false,
  components: [],
  schema: { properties: { published: { type: 'boolean' }, title: { type: 'string' }, summary: { type: 'string' } } },
}

describe('rowsOf', () => {
  it('titles each entry by its first text field, else its slug', () => {
    const rows = rowsOf(posts, [
      { slug: 'hello', data: { title: 'Hello world' }, draft: false, url: '/blog/hello' },
      { slug: 'untitled', data: { title: '  ' }, draft: true },
    ])

    expect(rows.map(row => [row.slug, row.title, row.draft, row.url])).toEqual([['hello', 'Hello world', false, '/blog/hello'], ['untitled', 'untitled', true, undefined]])
  })
})

describe('searchRows', () => {
  const rows = rowsOf(posts, [
    { slug: 'kay-release', data: { title: 'Kay 1.38 is out' }, draft: false },
    { slug: 'garden', data: { title: 'Spring Garden' }, draft: false },
  ])

  it('keeps the rows holding every word, in the title or the slug, whatever the case', () => {
    expect(searchRows(rows, 'GARDEN spring').map(row => row.slug)).toEqual(['garden'])
    expect(searchRows(rows, 'release').map(row => row.slug)).toEqual(['kay-release'])
    expect(searchRows(rows, '  ')).toHaveLength(2)
  })
})

describe('pageOf', () => {
  it('cuts the rows into pages, keeping the page asked for within them', () => {
    const rows = Array.from({ length: 5 }, (_, i) => i)

    expect(pageOf(rows, 2, 2)).toEqual({ rows: [2, 3], page: 2, pages: 3 })
    expect(pageOf(rows, 9, 2)).toEqual({ rows: [4], page: 3, pages: 3 })
    expect(pageOf(rows, Number.NaN, 2).page).toBe(1)
    expect(pageOf([], 1)).toEqual({ rows: [], page: 1, pages: 1 })
  })
})

describe('paths', () => {
  it('encodes each segment of a nested slug, and the locale as a query', () => {
    expect(entryPath('/admin', { collection: 'docs', slug: 'guides/a b', locale: 'fr' })).toBe('/admin/collections/docs/guides/a%20b?locale=fr')
    expect(newEntryPath('/admin', 'posts')).toBe('/admin/new/posts')
    expect(onPagePath('/admin', '/blog/hello?x=1')).toBe('/admin/page?path=%2Fblog%2Fhello%3Fx%3D1')
  })
})
