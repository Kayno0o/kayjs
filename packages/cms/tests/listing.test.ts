import type { CollectionInfo, EntryFilter, SourceEntry } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { bulkDeleteMessage } from '../src/bulk-message'
import { collectionTitle, entryPath, fold, groupCollections, newEntryPath, onPagePath, PAGE_SIZE, pageOf, pageRows, problemId, rowsOf, searchRows, statusOf, statusParam, viewHref } from '../src/listing'
import { contentVersion } from '../src/version'

const posts: CollectionInfo = {
  name: 'posts',
  kind: 'folder',
  localized: false,
  components: [],
  schema: { properties: { published: { type: 'boolean' }, title: { type: 'string' }, summary: { type: 'string' } } },
}

describe('collectionTitle', () => {
  it('is the collection\'s own title, else its name humanized', () => {
    expect(collectionTitle({ name: 'produits', title: 'Produits' })).toBe('Produits')
    expect(collectionTitle({ name: 'blogPosts' })).toBe('Blog posts')
  })
})

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
  const none = async () => undefined

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
    const listed = await pageRows({ ...posts, count: 120 }, '', 9, read, none)

    expect([listed.page, listed.pages, listed.rows.map(row => row.slug), asked]).toEqual([3, 3, stock.slice(100).map(entry => entry.slug), [{ offset: 100, limit: PAGE_SIZE }]])
  })

  it('reads and pages by the size it is given', async () => {
    const { asked, read } = reader()
    const listed = await pageRows({ ...posts, count: 120 }, '', 2, read, none, 25)

    expect([listed.page, listed.pages, listed.rows.map(row => row.slug).slice(0, 2), asked]).toEqual([2, 5, ['post-25', 'post-26'], [{ offset: 25, limit: 25 }]])
    expect((await pageRows({ ...posts, count: 120 }, 'post', 3, read, none, 40)).pages).toBe(3)
  })

  it('reads every entry to search their titles, and none of a collection that cannot be read', async () => {
    const { asked, read } = reader()

    expect((await pageRows({ ...posts, count: 120 }, 'post 11', 1, read, none)).rows.map(row => row.slug)).toEqual(['post-11', 'post-110', 'post-111', 'post-112', 'post-113', 'post-114', 'post-115', 'post-116', 'post-117', 'post-118', 'post-119'])
    expect(await pageRows({ ...posts, problem: 'gone' }, '', 1, read, none)).toEqual({ rows: [], page: 1, pages: 1, total: 0 })
    expect(asked).toEqual([{}])
  })
})

describe('pageRows versions', () => {
  it('gives each row of a folder collection the version its file had as listed, and a loaded one a hash of its entry as read', async () => {
    const stock: SourceEntry[] = [{ slug: 'a', data: { title: 'A' }, draft: false, path: 'content/a.md' }, { slug: 'b', data: { title: 'B' }, draft: false, path: 'content/b.md' }]
    const read = async () => stock
    const asked: string[] = []
    const versionOf = async (ref: { slug: string }) => {
      asked.push(ref.slug)

      return `v-${ref.slug}`
    }

    expect((await pageRows({ ...posts, count: 2 }, '', 1, read, versionOf)).rows.map(row => row.version)).toEqual(['v-a', 'v-b'])
    expect((await pageRows({ ...posts, kind: 'loaded', count: 2 }, '', 1, read, versionOf)).rows.map(row => row.version)).toEqual([contentVersion(stock[0]!, posts.schema), contentVersion(stock[1]!, posts.schema)])
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

describe('pageRows of an ordered collection', () => {
  const shelf: CollectionInfo = { ...posts, orderField: 'order' }
  const entry = (slug: string, order: number | undefined, locale?: string): SourceEntry => ({ slug, locale, data: order === undefined ? { title: slug } : { title: slug, order }, draft: false })
  const none = async () => undefined
  const stock = [entry('c', 3), entry('a', 1), entry('b', 2), entry('z', undefined), { slug: 'bad', data: undefined, problem: 'bad', draft: false }]
  const read = async () => stock

  it('lists the entries by their order, each saying which way it can move, a broken one none', async () => {
    const listed = await pageRows({ ...shelf, count: 5 }, '', 1, read, none)

    expect(listed.rows.map(row => [row.slug, row.move])).toEqual([['a', { up: false, down: true }], ['b', { up: true, down: true }], ['c', { up: true, down: true }], ['z', { up: true, down: false }], ['bad', undefined]])
  })

  it('pages the ordered rows and offers no move while a search narrows them', async () => {
    expect((await pageRows({ ...shelf, count: 5 }, '', 2, read, none, 2)).rows.map(row => row.slug)).toEqual(['c', 'z'])
    expect((await pageRows({ ...shelf, count: 5 }, 'b', 1, read, none)).rows.map(row => [row.slug, row.move])).toEqual([['b', undefined], ['bad', undefined]])
  })

  it('orders each locale apart', async () => {
    const localized = async () => [entry('a', 2, 'fr'), entry('a', 1, 'en'), entry('b', 1, 'fr')]
    const listed = await pageRows({ ...shelf, localized: true, count: 3 }, '', 1, localized, none)

    expect(listed.rows.map(row => [row.slug, row.locale, row.move?.up, row.move?.down])).toEqual([['a', 'en', false, false], ['b', 'fr', false, true], ['a', 'fr', true, false]])
  })
})

describe('search', () => {
  const shop: CollectionInfo = { ...posts, draftField: 'draft', publishField: 'publishAt', schema: { properties: { title: { type: 'string' }, summary: { type: 'string' }, draft: { type: 'boolean' } } } }
  const stock: SourceEntry[] = [
    { slug: 'creme', data: { title: 'Crème brûlée', summary: 'A dessert' }, body: 'Vanilla and sugar', draft: false },
    { slug: 'tarte', data: { title: 'Tarte', summary: 'Aux pommes' }, draft: true },
  ]
  const none = async () => undefined
  const read = async () => stock

  it('ignores accents and case, in the title, the other text fields and the body', async () => {
    const find = async (q: string) => (await pageRows({ ...shop, count: 2 }, q, 1, read, none)).rows.map(row => row.slug)

    expect(fold('Crème BRÛLÉE')).toBe('creme brulee')
    expect(await find('CREME brulee')).toEqual(['creme'])
    expect(await find('dessert')).toEqual(['creme'])
    expect(await find('vanilla')).toEqual(['creme'])
    expect(await find('pomme')).toEqual(['tarte'])
    expect(await find('vanilla pomme')).toEqual([])
  })

  it('searches rows alone by title and slug', () => {
    expect(searchRows(rowsOf(posts, stock), 'ÉCR')).toEqual([])
    expect(searchRows(rowsOf(posts, stock), 'tart').map(row => row.slug)).toEqual(['tarte'])
  })

  it('counts every entry the search keeps across the pages', async () => {
    const many: SourceEntry[] = Array.from({ length: 120 }, (_, i) => ({ slug: `p-${i}`, data: { title: `Post ${i}` }, draft: false }))
    const listed = await pageRows({ ...posts, count: 120 }, 'post 1', 2, async () => many, none, 10)

    expect([listed.total, listed.pages, listed.rows.length]).toEqual([39, 4, 10])
  })
})

describe('status', () => {
  const shop: CollectionInfo = { ...posts, draftField: 'draft', publishField: 'publishAt' }
  const now = Date.now()
  const future = new Date(now + 86_400_000).toISOString()
  const stock: SourceEntry[] = [
    { slug: 'a', data: { title: 'A', publishAt: future }, draft: false },
    { slug: 'b', data: { title: 'B' }, draft: true },
    { slug: 'c', data: { title: 'C' }, draft: false },
  ]
  const none = async () => undefined
  const read = async () => stock

  it('tells draft, scheduled and published apart, and filters on it', async () => {
    expect(rowsOf(shop, stock).map(statusOf)).toEqual(['scheduled', 'draft', 'published'])
    expect((await pageRows({ ...shop, count: 3 }, '', 1, read, none, 50, { status: 'draft' })).rows.map(row => row.slug)).toEqual(['b'])
    expect((await pageRows({ ...shop, count: 3 }, '', 1, read, none, 50, { status: 'scheduled' })).rows.map(row => row.slug)).toEqual(['a'])
    expect((await pageRows({ ...shop, count: 3 }, 'c', 1, read, none, 50, { status: 'published' })).total).toBe(1)
  })

  it('reads a status param, none for anything else', () => {
    expect(statusParam('draft')).toBe('draft')
    expect(statusParam('Draft')).toBeUndefined()
    expect(statusParam(undefined)).toBeUndefined()
  })
})

describe('sort', () => {
  const priced: CollectionInfo = { ...posts, draftField: 'draft', layout: undefined, schema: { properties: { title: { type: 'string' }, price: { type: 'number' }, draft: { type: 'boolean' } } } } as CollectionInfo
  const shop = { ...priced, layout: { list: { columns: ['price'] } }, count: 4 }
  const stock: SourceEntry[] = [
    { slug: 'a', data: { title: 'éclair', price: 10 }, draft: false },
    { slug: 'b', data: { title: 'Brioche', price: 9 }, draft: true },
    { slug: 'c', data: { title: 'Cake' }, draft: false },
    { slug: 'd', data: { title: 'Ananas', price: 100 }, draft: false },
  ]
  const none = async () => undefined
  const read = async () => stock
  const order = async (sort: string, direction: 'asc' | 'desc') => (await pageRows(shop, '', 1, read, none, 50, { sort, direction })).rows.map(row => row.slug)

  it('orders every entry, not the page, by title regardless of accents and case', async () => {
    expect(await order('title', 'asc')).toEqual(['d', 'b', 'c', 'a'])
    expect(await order('title', 'desc')).toEqual(['a', 'c', 'b', 'd'])
  })

  it('orders a number column by value and leaves an empty cell last either way', async () => {
    expect(await order('cell:price', 'asc')).toEqual(['b', 'a', 'd', 'c'])
    expect(await order('cell:price', 'desc')).toEqual(['d', 'a', 'b', 'c'])
  })

  it('orders by status, and sorts across pages', async () => {
    expect((await order('draft', 'asc'))[0]).toBe('b')

    const second = await pageRows(shop, '', 2, read, none, 2, { sort: 'title', direction: 'asc' })

    expect(second.rows.map(row => row.slug)).toEqual(['c', 'a'])
  })

  it('keeps the order of a key no column has', async () => {
    expect(await order('nope', 'asc')).toEqual(['a', 'b', 'c', 'd'])
    expect(await order('cell:summary', 'asc')).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('viewHref', () => {
  it('sets or drops the params it is given, and goes back to the first page', () => {
    expect(viewHref(new URL('http://x/admin/collections/posts?q=a&page=3&status=draft'), { status: undefined })).toBe('/admin/collections/posts?q=a')
    expect(viewHref('http://x/admin/collections/posts?page=2', { status: 'draft', q: 'é' })).toBe('/admin/collections/posts?status=draft&q=%C3%A9')
  })
})

describe('groupCollections', () => {
  const layouts: Record<string, { group?: string, order?: number }> = { a: { group: 'Blog' }, b: {}, c: { group: 'Shop', order: 1 }, d: { group: 'Blog', order: 0 } }
  const groups = groupCollections(['a', 'b', 'c', 'd'], name => layouts[name])

  it('puts the ungrouped first, then each group in the order it first appears, its collections by order then by the site\'s', () => {
    expect(groups.map(group => [group.name, group.collections])).toEqual([[undefined, ['b']], ['Blog', ['d', 'a']], ['Shop', ['c']]])
  })
})

describe('bulkDeleteMessage', () => {
  it('counts the entries and names those referring to any of them once', () => {
    expect(bulkDeleteMessage([{}])).toBe('Delete 1 entry? This cannot be undone.')
    expect(bulkDeleteMessage([{ referencedBy: ['Posts: A'] }, { referencedBy: ['Posts: A', 'Posts: B'] }])).toBe('Delete 2 entries? This cannot be undone. Referenced by Posts: A, Posts: B.')
  })
})
