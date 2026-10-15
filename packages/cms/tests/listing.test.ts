import type { CollectionInfo, EntryFilter, SourceEntry } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { entryPath, newEntryPath, onPagePath, PAGE_SIZE, pageOf, pageRows, problemId, rowsOf, searchRows } from '../src/listing'

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

describe('pageRows', () => {
  const stock: SourceEntry[] = Array.from({ length: 120 }, (_, i) => ({ slug: `post-${i}`, data: { title: `Post ${i}` }, draft: false }))

  // Reads as kay does, keeping what each read asked for.
  function reader() {
    const asked: EntryFilter[] = []

    return { asked, read: async (filter: EntryFilter) => {
      asked.push(filter)

      return stock.slice(filter.offset ?? 0, filter.limit === undefined ? undefined : (filter.offset ?? 0) + filter.limit)
    } }
  }

  it('reads the entries of the page asked for alone, the count giving the pages', async () => {
    const { asked, read } = reader()
    const listed = await pageRows({ ...posts, count: 120 }, '', 9, read)

    expect([listed.page, listed.pages, listed.rows.map(row => row.slug), asked]).toEqual([3, 3, stock.slice(100).map(entry => entry.slug), [{ offset: 100, limit: PAGE_SIZE }]])
  })

  it('reads every entry to search their titles, and none of a collection that cannot be read', async () => {
    const { asked, read } = reader()

    expect((await pageRows({ ...posts, count: 120 }, 'post 11', 1, read)).rows.map(row => row.slug)).toEqual(['post-11', 'post-110', 'post-111', 'post-112', 'post-113', 'post-114', 'post-115', 'post-116', 'post-117', 'post-118', 'post-119'])
    expect(await pageRows({ ...posts, problem: 'gone' }, '', 1, read)).toEqual({ rows: [], page: 1, pages: 1 })
    expect(asked).toEqual([{}])
  })
})

describe('pageRows versions', () => {
  it('gives each row of a folder collection the version its file had as listed, and a loaded one none', async () => {
    const stock: SourceEntry[] = [{ slug: 'a', data: { title: 'A' }, draft: false, path: 'content/a.md' }, { slug: 'b', data: { title: 'B' }, draft: false, path: 'content/b.md' }]
    const read = async () => stock
    const asked: string[] = []
    const versionOf = async (ref: { slug: string }) => {
      asked.push(ref.slug)

      return `v-${ref.slug}`
    }

    expect((await pageRows({ ...posts, count: 2 }, '', 1, read, versionOf)).rows.map(row => row.version)).toEqual(['v-a', 'v-b'])
    expect((await pageRows({ ...posts, kind: 'loaded', count: 2 }, '', 1, read, versionOf)).rows.map(row => row.version)).toEqual([undefined, undefined])
    expect(asked).toEqual(['a', 'b'])
  })
})

describe('paths', () => {
  it('encodes each segment of a nested slug, and the locale as a query', () => {
    expect(entryPath('/admin', { collection: 'docs', slug: 'guides/a b', locale: 'fr' })).toBe('/admin/collections/docs/guides/a%20b?locale=fr')
    expect(newEntryPath('/admin', 'posts')).toBe('/admin/new/posts')
    expect(onPagePath('/admin', '/blog/hello?x=1')).toBe('/admin/page?path=%2Fblog%2Fhello%3Fx%3D1')
  })

  it('draws a problem id with no space nor slash, two keys never meeting', () => {
    expect(problemId('posts')).toBe('kcms-problem-posts')
    expect(problemId('docs', 'guides/a b@fr')).toBe('kcms-problem-docs-guides_2f_a_20_b_40_fr')
    expect(problemId('docs', 'a_20_b')).not.toBe(problemId('docs', 'a b'))
    expect(problemId('a-b', 'c')).not.toBe(problemId('a', 'b-c'))
  })
})
