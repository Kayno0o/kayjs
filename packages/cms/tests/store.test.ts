import type { FileChange } from '../src/files'
import type * as Content from '../src/kay/content'
import type { CollectionInfo, SourceEntry } from '../src/kay/contract'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { configure } from '../src/settings'

const posts: CollectionInfo = { name: 'posts', kind: 'folder', dir: 'content/posts', schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' } } }, components: [], localized: false, draftField: 'draft' }
const outside: CollectionInfo = { ...posts, name: 'outside', dir: undefined }
const products: CollectionInfo = { name: 'products', kind: 'loaded', schema: { type: 'object', properties: { name: { type: 'string' } } }, components: [], localized: false }

const TAKEN = 'names an entry the collection already holds'
const MISSING = 'names no entry of the collection'

let saved: FileChange[]
let loaded: { slug: string, data: unknown }[]
let removed: string[]
let stored: Record<string, SourceEntry[]>

// kay's content API, answering from `stored` and recording what a loader was handed.
const content: typeof Content = {
  collections: async () => [posts, products, outside],
  entries: async collection => stored[collection] ?? [],
  entrySource: async (collection, slug, data, options) => options?.create && stored[collection]?.some(entry => entry.slug === slug)
    ? { issues: [{ collection, slug, path: '', key: 'slug', message: TAKEN }] }
    : (data as Record<string, unknown>).title === ''
      ? { issues: [{ collection, slug, path: 'title', message: 'Required' }] }
      : { file: { path: `${slug}.md`, absolute: `/site/content/${collection}/${slug}.md`, repoPath: `content/${collection}/${slug}.md`, text: `${JSON.stringify(data)}\n${options?.body ?? ''}` } },
  saveEntry: async (collection, entry, options) => {
    if (options?.create && stored[collection]?.some(stock => stock.slug === entry.slug))
      return { issues: [{ collection, slug: entry.slug, path: '', key: 'slug', message: TAKEN }] }

    loaded.push(entry)

    return {}
  },
  entryFile: async (collection, slug) => {
    const path = stored[collection]?.find(entry => entry.slug === slug)?.path

    return path === undefined ? { issues: [{ collection, slug, path: '', key: 'slug', message: MISSING }] } : { file: { path, absolute: `/site/${path}`, repoPath: path } }
  },
  removeEntry: async (collection, slug) => {
    if (!stored[collection]?.some(entry => entry.slug === slug))
      return { issues: [{ collection, slug, path: '', key: 'slug', message: MISSING }] }

    removed.push(slug)

    return {}
  },
}

void mock.module('../src/kay/content', () => content)

// Imported once the mock is in place, so the store reads it.
const { deleteEntry, publishEntry, saveEntry, UnknownCollection } = await import('../src/store')

beforeEach(() => {
  saved = []
  loaded = []
  removed = []
  stored = { posts: [{ slug: 'hello', path: 'content/posts/hello.md', data: { title: 'Hello', draft: true }, body: 'Hi', draft: true }], products: [{ slug: 'mug', data: { name: 'Mug' }, draft: false }] }
  configure({ files: { save: async (change) => {
    saved.push(change)

    return { sha: 'abc' }
  } } })
})

describe('saveEntry', () => {
  test('commits a folder entry\'s file, named by what kay wrote', async () => {
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi there' }, body: 'Body' })).toEqual({ saved: true, commit: { sha: 'abc' } })
    expect(saved).toEqual([{ repoPath: 'content/posts/hello.md', absolute: '/site/content/posts/hello.md', text: '{"title":"Hi there"}\nBody', message: 'content(posts): update hello' }])
  })

  test('passes on the schema\'s issues and writes nothing', async () => {
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: '' } })).toEqual({ issues: [{ collection: 'posts', slug: 'hello', path: 'title', message: 'Required' }] })
    expect(saved).toEqual([])
  })

  test('creates through kay, which refuses a slug already taken', async () => {
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Again' } }, { create: true })).toHaveProperty('issues.0.message', TAKEN)
    expect(await saveEntry({ collection: 'products', slug: 'mug', data: { name: 'Mug' } }, { create: true })).toHaveProperty('issues.0.key', 'slug')
    expect(await saveEntry({ collection: 'posts', slug: 'notes/new', data: { title: 'New' } }, { create: true })).toHaveProperty('saved', true)
    expect(saved.map(change => change.message)).toEqual(['content(posts): add notes/new'])
  })

  test('hands a loaded entry to its collection\'s loader', async () => {
    expect(await saveEntry({ collection: 'products', slug: 'mug', data: { name: 'Big mug' } })).toEqual({ saved: true })
    expect(loaded).toEqual([{ slug: 'mug', data: { name: 'Big mug' } }])
    expect(saved).toEqual([])
  })

  test('throws for a collection kay does not list', async () => {
    await expect(saveEntry({ collection: 'nope', slug: 'a', data: {} })).rejects.toBeInstanceOf(UnknownCollection)
  })
})

describe('deleteEntry', () => {
  test('commits a folder entry\'s file away', async () => {
    expect(await deleteEntry({ collection: 'posts', slug: 'hello' })).toEqual({ saved: true, commit: { sha: 'abc' } })
    expect(saved).toEqual([{ repoPath: 'content/posts/hello.md', absolute: '/site/content/posts/hello.md', text: undefined, message: 'content(posts): delete hello' }])
  })

  test('passes on kay\'s issue for an entry that does not exist', async () => {
    expect(await deleteEntry({ collection: 'posts', slug: 'nope' })).toHaveProperty('issues.0.message', MISSING)
  })

  test('commits away the file of an entry that no longer parses, as kay finds it', async () => {
    stored.posts = [{ slug: 'broken', path: 'content/posts/broken.md', data: undefined, problem: 'bad YAML', draft: false }]

    expect(await deleteEntry({ collection: 'posts', slug: 'broken' })).toHaveProperty('saved', true)
    expect(saved.map(change => [change.repoPath, change.absolute])).toEqual([['content/posts/broken.md', '/site/content/posts/broken.md']])
  })

  test('refuses an entry of a folder outside the repository', async () => {
    stored.outside = [{ slug: 'hello', data: { title: 'Hello' }, draft: false }]

    expect(await deleteEntry({ collection: 'outside', slug: 'hello' })).toHaveProperty('issues.0.message', 'outside\'s folder lies outside the repository, so its files cannot be committed')
    expect(saved).toEqual([])
  })

  test('removes a loaded entry through its loader, or passes on why kay would not', async () => {
    expect(await deleteEntry({ collection: 'products', slug: 'mug' })).toEqual({ saved: true })
    expect(await deleteEntry({ collection: 'products', slug: 'nope' })).toHaveProperty('issues.0.key', 'slug')
    expect(removed).toEqual(['mug'])
  })
})

describe('publishEntry', () => {
  test('saves the entry as it was with its draft field off', async () => {
    expect(await publishEntry({ collection: 'posts', slug: 'hello' })).toHaveProperty('saved', true)
    expect(saved.map(change => [change.text, change.message])).toEqual([['{"title":"Hello","draft":false}\nHi', 'content(posts): publish hello']])
  })

  test('refuses an entry whose file does not parse', async () => {
    stored.posts = [{ slug: 'broken', path: 'content/posts/broken.md', data: undefined, problem: 'bad YAML', draft: false }]

    expect(await publishEntry({ collection: 'posts', slug: 'broken' })).toHaveProperty('issues.0.message', 'broken\'s file does not parse: bad YAML')
    expect(saved).toEqual([])
  })

  test('refuses a collection without a draft field', async () => {
    expect(await publishEntry({ collection: 'products', slug: 'mug' })).toHaveProperty('issues.0.message', 'products names no draft field to publish by')
  })
})
