import type { FileChange } from '../src/files'
import type * as Content from '../src/kay/content'
import type { CollectionInfo, SourceEntry } from '../src/kay/contract'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { bodyHtml, MarkdownError } from 'kay/content'
import { scratchDir } from 'kay/test'
import { countEntries } from '../src/counts'
import { fileVersion, ForgeError, SaveConflict } from '../src/files'
import { configure } from '../src/settings'
import { contentVersion } from '../src/version'

const posts: CollectionInfo = { name: 'posts', kind: 'folder', dir: 'content/posts', schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' } } }, components: [], localized: false, draftField: 'draft' }
const outside: CollectionInfo = { ...posts, name: 'outside', dir: undefined }
const products: CollectionInfo = { name: 'products', kind: 'loaded', schema: { type: 'object', properties: { name: { type: 'string' } } }, components: [], localized: false }

const shelf: CollectionInfo = { ...posts, name: 'shelf', dir: 'content/shelf', orderField: 'order' }
const catalog: CollectionInfo = { ...products, name: 'catalog', orderField: 'order' }
const home: CollectionInfo = { ...posts, name: 'home', dir: 'content/home', single: true }
const publishedOn = (format: string): CollectionInfo['schema'] => ({ type: 'object', properties: { title: { type: 'string' }, publishAt: { type: 'string', format } } })
const stamped: CollectionInfo = { ...posts, name: 'stamped', dir: 'content/stamped', draftField: undefined, publishField: 'publishAt', schema: publishedOn('date-time') }
const dated: CollectionInfo = { ...stamped, name: 'dated', dir: 'content/dated', schema: publishedOn('date') }
const collectionList = [posts, products, outside, shelf, catalog, home, stamped, dated]

const TAKEN = 'names an entry the collection already holds'
const MISSING = 'names no entry of the collection'

function validSource(collection: string, slug: string, data: unknown, body: string | undefined) {
  if ((data as Record<string, unknown>).title === '')
    return { issues: [{ collection, slug, path: 'title', message: 'Required' }] }

  return { file: { path: `${slug}.md`, absolute: `/site/content/${collection}/${slug}.md`, repoPath: `content/${collection}/${slug}.md`, text: `${JSON.stringify(data)}\n${body ?? ''}` } }
}

let saved: FileChange[]
let loaded: { slug: string, locale?: string | undefined, data: unknown }[]
let removed: string[]
// The sizes of the batches a loaded collection was handed whole.
let batches: number[]
let stored: Record<string, SourceEntry[]>
let infoCalls: unknown[]
let failing = false
// Whether the loader keeps what it is handed, as a database would.
let keeping = false

// kay's content API, answering from `stored` and recording what a loader was handed.
const content: typeof Content = {
  bodyHtml,
  MarkdownError,
  collectionLoader: () => undefined,
  collections: async () => collectionList,
  collectionInfo: async (name, options) => {
    infoCalls.push([name, options])

    return collectionList.find(collection => collection.name === name)
  },
  translations: async () => new Map(),
  entries: async (collection, filter) => failing ? Promise.reject(new Error('kay: products\'s load threw: password for db.internal')) : (stored[collection] ?? []).filter(entry => (filter?.slug === undefined || entry.slug === filter.slug) && (filter?.locale === undefined || entry.locale === filter.locale)),
  entrySource: async (collection, slug, data, options) => options?.create && stored[collection]?.some(entry => entry.slug === slug)
    ? { issues: [{ collection, slug, path: '', key: 'slug', message: TAKEN }] }
    : validSource(collection, slug, data, options?.body),
  saveEntry: async (collection, entry, options) => {
    if (options?.create && stored[collection]?.some(stock => stock.slug === entry.slug))
      return { issues: [{ collection, slug: entry.slug, path: '', key: 'slug', message: TAKEN }] }

    loaded.push(entry)

    if (keeping) {
      const rows = stored[collection] ?? []
      const row = rows.find(each => each.slug === entry.slug)
      const kept: SourceEntry = { slug: entry.slug, data: entry.data as SourceEntry['data'], body: entry.body, draft: false }

      stored[collection] = row ? rows.map(each => each === row ? kept : each) : [...rows, kept]
    }

    return {}
  },
  saveEntries: async (_collection, entries) => {
    batches.push(entries.length)
    loaded.push(...entries)

    return {}
  },
  entryFile: async (collection, slug) => {
    if (collectionList.find(each => each.name === collection)?.kind === 'loaded')
      throw new Error(`kay: entryFile() gives a folder collection's files, and ${collection} is loaded`)

    const path = stored[collection]?.find(entry => entry.slug === slug)?.path

    return path === undefined ? { issues: [{ collection, slug, path: '', key: 'slug', message: MISSING }] } : { file: { path, absolute: path.startsWith('/') ? path : `/site/${path}`, repoPath: path } }
  },
  removeEntry: async (collection, slug) => {
    if (!stored[collection]?.some(entry => entry.slug === slug))
      return { issues: [{ collection, slug, path: '', key: 'slug', message: MISSING }] }

    removed.push(slug)

    if (keeping)
      stored[collection] = stored[collection].filter(entry => entry.slug !== slug)

    return {}
  },
}

void mock.module('../src/kay/content', () => content)

// Imported once the mock is in place, so the store reads it.
const { default: entriesApi } = await import('../src/api/entries')
const { leavesPublication } = await import('../src/publishing')
const { copySlug, deleteEntry, duplicateEntry, entryOf, entryScreen, moveEntry, publishEntry, saveEntry, UnknownCollection } = await import('../src/store')

beforeEach(() => {
  saved = []
  loaded = []
  removed = []
  batches = []
  infoCalls = []
  failing = false
  keeping = false
  stored = { posts: [{ slug: 'hello', path: 'content/posts/hello.md', data: { title: 'Hello', draft: true }, body: 'Hi', draft: true }], products: [{ slug: 'mug', data: { name: 'Mug' }, draft: false }] }
  configure({ files: { save: async (change) => {
    saved.push(change)

    return { sha: 'abc' }
  } } })
})

describe('saveEntry', () => {
  test('commits a folder entry\'s file, named by what kay wrote', async () => {
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi there' }, body: 'Body' })).toEqual({ saved: true, commit: { sha: 'abc' }, version: fileVersion('{"title":"Hi there"}\nBody') })
    expect(saved).toEqual([{ repoPath: 'content/posts/hello.md', absolute: '/site/content/posts/hello.md', text: '{"title":"Hi there"}\nBody', message: 'content(posts): update hello' }])
  })

  test('commits as the author the guard found, on saves, publishes and deletes', async () => {
    const author = { name: 'Ada', email: 'ada@example.com' }

    await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' } }, { author })
    await publishEntry({ collection: 'posts', slug: 'hello' }, author)
    await deleteEntry({ collection: 'posts', slug: 'hello' }, author)
    expect(saved.map(change => change.author)).toEqual([author, author, author])
  })

  test('refuses a body that would run as the site, unless its collection takes raw HTML, and publishes one already stored', async () => {
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' }, body: '<div onclick="steal()">x</div>' })).toEqual({ issues: [{ collection: 'posts', slug: 'hello', locale: undefined, path: '', body: true, message: 'The text holds the attribute onclick, which would run as the site: write it as Markdown, or list posts in cms({ rawHtml })' }] })
    expect(saved).toEqual([])

    stored.posts![0]!.body = '<script>trusted()</script>'
    expect(await publishEntry({ collection: 'posts', slug: 'hello' })).toHaveProperty('saved', true)

    configure({ files: { save: async change => void saved.push(change) }, rawHtml: ['posts'] })
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' }, body: '<script>trusted()</script>' })).toHaveProperty('saved', true)
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

  test('names the version the editor opened, a new entry\'s as none', async () => {
    await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' } }, { version: 'b10b' })
    await saveEntry({ collection: 'posts', slug: 'fresh', data: { title: 'Fresh' } }, { create: true, version: 'ignored' })
    expect(saved.map(change => change.base)).toEqual(['b10b', null])
  })

  test('refuses a save over someone else\'s, and one the forge failed, as an issue the editor shows', async () => {
    configure({ files: { save: async () => {
      throw new SaveConflict()
    } } })
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' } }, { version: 'old' })).toHaveProperty('issues.0.message', new SaveConflict().message)

    configure({ files: { save: async () => {
      throw new ForgeError(504, 'Forgejo did not answer within 15 s')
    } } })
    expect(await deleteEntry({ collection: 'posts', slug: 'hello' })).toHaveProperty('issues.0.message', 'Forgejo did not answer within 15 s')
  })

  test('hands the editor the version another save left, to write over it, but none for a new entry whose slug is taken', async () => {
    configure({ files: { save: async () => {
      throw new SaveConflict('f00d')
    } } })
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' } }, { version: 'old' })).toMatchObject({ conflict: { version: 'f00d' } })

    configure({ files: { save: async () => {
      throw new SaveConflict('f00d', true)
    } } })
    expect(await saveEntry({ collection: 'posts', slug: 'fresh', data: { title: 'Hi' } }, { create: true })).not.toHaveProperty('conflict')
  })

  test('refuses a save or a delete naming no version of a file the server holds, when the editor must name one', async () => {
    const dir = await scratchDir('store-')
    const path = join(dir, 'hello.md')

    try {
      await Bun.write(path, 'hello')
      stored.posts = [{ slug: 'hello', path, data: { title: 'Hello' }, draft: false }]

      const older = 'This editor is older than the server: copy your changes, reload the page, then make them again'

      expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' } }, { required: true })).toHaveProperty('issues.0.message', older)

      // A delete naming none also comes from edits kept over a deleted file made again since, whose editor is not older.
      expect(await deleteEntry({ collection: 'posts', slug: 'hello' }, undefined, { required: true })).toHaveProperty('issues.0.message', 'This editor has not shown the file as it is now, so it will not delete it: reload the page to see it, then delete again')
      expect(saved).toEqual([])

      await deleteEntry({ collection: 'posts', slug: 'hello' }, undefined, { version: fileVersion('hello'), required: true })
      expect(saved.map(change => change.base)).toEqual([fileVersion('hello')])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('hands a loaded entry to its collection\'s loader', async () => {
    expect(await saveEntry({ collection: 'products', slug: 'mug', data: { name: 'Big mug' } })).toEqual({ saved: true })
    expect(loaded).toEqual([{ slug: 'mug', data: { name: 'Big mug' } }])
    expect(saved).toEqual([])
  })

  test('asks for the collection without its counts, which a loaded one\'s loader is run to tell', async () => {
    await saveEntry({ collection: 'products', slug: 'mug', data: { name: 'Big mug' } })
    await deleteEntry({ collection: 'products', slug: 'mug' })
    expect(infoCalls).toEqual([['products', { counts: false }], ['products', { counts: false }]])
  })

  test('reads an entry screen\'s collection and entry together, the collection with its counts once', async () => {
    expect(await entryScreen({ collection: 'products', slug: 'mug' })).toEqual({ collection: products, entry: { ...stored.products![0]!, version: contentVersion(stored.products![0]!) } })
    expect(infoCalls).toEqual([['products', { counts: false }], ['products', undefined]])
    expect(await entryScreen({ collection: 'nothing', slug: 'x' })).toBeUndefined()
  })

  test('shows a loaded collection whose entry fails to read as unreadable, without the loader\'s message', async () => {
    failing = true

    const screen = await entryScreen({ collection: 'products', slug: 'mug' })

    expect(screen?.entry).toBeUndefined()
    expect(screen?.collection.problem).toBe('kay: products\'s entries failed to read; the server\'s log says why')
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

describe('a single collection', () => {
  test('refuses a second entry, whatever its slug, and creates the first', async () => {
    const entry = { collection: 'home', slug: 'index', data: { title: 'Hi' } }

    expect(await saveEntry(entry, { create: true })).toHaveProperty('saved', true)

    stored.home = [{ slug: 'index', data: { title: 'Hi' }, draft: false }]

    expect(await saveEntry(entry, { create: true })).toHaveProperty('issues.0.message', 'Home holds one entry, which is written already')
    expect(saved).toHaveLength(1)
  })

  test('refuses a first entry under another slug, with a message that names no field', async () => {
    const outcome = await saveEntry({ collection: 'home', slug: 'other', data: { title: 'Hi' } }, { create: true })

    expect(outcome).toHaveProperty('issues.0.message', 'Home holds one entry, written as index')
    expect(outcome).not.toHaveProperty('issues.0.key')
    expect(saved).toEqual([])
  })

  test('saves changes to its entry', async () => {
    stored.home = [{ slug: 'index', data: { title: 'Hi' }, draft: false }]

    expect(await saveEntry({ collection: 'home', slug: 'index', data: { title: 'Hello' } })).toHaveProperty('saved', true)
  })

  test('refuses a delete, its entry staying', async () => {
    stored.home = [{ slug: 'index', data: { title: 'Hi' }, draft: false }]

    expect(await deleteEntry({ collection: 'home', slug: 'index' })).toHaveProperty('issues.0.message', 'Home holds one entry, which cannot be deleted')
    expect(saved).toEqual([])
  })
})

describe('entryOf', () => {
  test('asks kay for the entry of that slug and locale alone', async () => {
    stored.posts = [{ slug: 'hello', locale: 'en', data: { title: 'Hello' }, draft: false }, { slug: 'hello', locale: 'fr', data: { title: 'Bonjour' }, draft: false }]

    expect((await entryOf({ collection: 'posts', slug: 'hello', locale: 'fr' }))?.data).toEqual({ title: 'Bonjour' })
    expect(await entryOf({ collection: 'posts', slug: 'gone' })).toBeUndefined()
  })

  test('gives a folder entry\'s file version, which publishing names', async () => {
    const dir = await scratchDir('store-')
    const path = join(dir, 'hello.md')

    try {
      await Bun.write(path, 'as on disk')
      stored.posts = [{ slug: 'hello', path, data: { title: 'Hello', draft: true }, draft: true }]

      expect(await entryOf({ collection: 'posts', slug: 'hello' })).toHaveProperty('version', fileVersion('as on disk'))
      await publishEntry({ collection: 'posts', slug: 'hello' })
      expect(saved.map(change => change.base)).toEqual([fileVersion('as on disk')])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a loaded entry\'s version', () => {
  const mug = { collection: 'products', slug: 'mug' }
  const named = (name: string) => ({ ...mug, data: { name } })
  const opened = async () => (await entryOf(mug))!.version!

  beforeEach(() => {
    keeping = true
  })

  test('is a hash of what the loader gave, the same for the same content whatever the key order', async () => {
    const first = await opened()

    stored.products = [{ slug: 'mug', data: { size: 1, name: 'Mug' }, draft: false }]

    const second = await opened()

    stored.products = [{ slug: 'mug', data: { name: 'Mug', size: 1 }, draft: false }]

    expect(await opened()).toBe(second)
    expect(first).toBe(contentVersion({ data: { name: 'Mug' } }))
  })

  test('leaves out what the schema does not declare, so a loader adding computed or changing fields causes no conflict', async () => {
    let reads = 0
    const read = async () => {
      stored.products = [{ slug: 'mug', data: { name: 'Mug', readAt: ++reads, url: '/mug/' }, draft: false }]

      return opened()
    }
    const version = await read()

    expect(await read()).toBe(version)
    expect(await saveEntry(named('Mug 2'), { version, required: true })).toHaveProperty('saved', true)

    stored.products = [{ slug: 'mug', data: { name: 'Other', readAt: 1 }, draft: false }]
    expect(await saveEntry(named('Mug 3'), { version, required: true })).toHaveProperty('conflict')
  })

  test('hashes every field when the schema declares none', () => {
    expect(contentVersion({ data: { a: 1 } }, { type: 'object' })).not.toBe(contentVersion({ data: { a: 2 } }, { type: 'object' }))
    expect(contentVersion({ data: { a: 1, b: 1 } }, products.schema)).toBe(contentVersion({ data: { a: 2, b: 2 } }, products.schema))
  })

  test('hashes the values JSON cannot hold, telling different ones apart', () => {
    const version = (value: unknown) => contentVersion({ data: { value } })

    expect(version(1n)).not.toBe(version(2n))
    expect(version(new Date(0))).not.toBe(version(new Date(1000)))
    expect(version({ toJSON: () => 'a' })).not.toBe(version({ toJSON: () => 'b' }))
    expect(version(new Map([['a', 1]]))).not.toBe(version(new Map([['a', 2]])))
    expect(version({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(version({ a: [{ c: 2, d: 1 }], b: 1 }))
  })

  test('gives a folder entry outside the repository no content version', async () => {
    stored.outside = [{ slug: 'x', data: { title: 'X' }, draft: false }]

    expect(await entryOf({ collection: 'outside', slug: 'x' })).not.toHaveProperty('version')
  })

  test('runs two saves of one collection one after the other, the second checked after the first', async () => {
    const version = await opened()
    const [first, second] = await Promise.all([saveEntry(named('From A'), { version, required: true }), saveEntry(named('From B'), { version, required: true })])

    expect(first).toHaveProperty('saved', true)
    expect(second).toHaveProperty('conflict')
    expect(loaded.map(entry => entry.data)).toEqual([{ name: 'From A' }])
  })

  test('answers the version of the row the loader keeps, which may differ from what was typed', async () => {
    const version = await opened()
    const saved = await saveEntry(named('typed'), { version, required: true }) as { version: string }

    stored.products = [{ slug: 'mug', data: { name: 'TYPED' }, draft: false }]
    expect(saved.version).not.toBe(await opened())
    expect(await saveEntry(named('again'), { version: await opened(), required: true })).toHaveProperty('saved', true)
  })

  test('publishes a loaded entry through the versioned path', async () => {
    stored.products = [{ slug: 'mug', data: { name: 'Mug', live: false }, draft: true }]
    collectionList[1] = { ...products, draftField: 'live' }

    try {
      expect(await publishEntry({ collection: 'products', slug: 'mug' })).toHaveProperty('saved', true)
      expect(loaded.map(entry => entry.data)).toEqual([{ name: 'Mug', live: false }])
    }
    finally {
      collectionList[1] = products
    }
  })

  test('refuses the save of the editor that saves second, naming the version the first left', async () => {
    const [a, b] = [await opened(), await opened()]
    const first = await saveEntry(named('From A'), { version: a, required: true })

    expect(first).toEqual({ saved: true, version: contentVersion({ data: { name: 'From A' } }) })

    const second = await saveEntry(named('From B'), { version: b, required: true })

    expect(second).toMatchObject({ issues: [{ message: 'This entry was changed since you opened it, by another editor or by the app' }], conflict: { version: contentVersion({ data: { name: 'From A' } }) } })
    expect(loaded.map(entry => entry.data)).toEqual([{ name: 'From A' }])
  })

  test('lets the editor that keeps its edits over the conflict save over it', async () => {
    const b = await opened()

    await saveEntry(named('From A'), { version: b, required: true })

    const refused = await saveEntry(named('From B'), { version: b, required: true })
    const conflict = (refused as { conflict: { version: string } }).conflict.version

    expect(await saveEntry(named('From B'), { version: conflict, required: true })).toHaveProperty('saved', true)
    expect(loaded.map(entry => entry.data)).toEqual([{ name: 'From A' }, { name: 'From B' }])
  })

  test('does not conflict with the same editor saving twice, each save naming the version the one before returned', async () => {
    const first = await saveEntry(named('One'), { version: await opened(), required: true }) as { version: string }
    const second = await saveEntry(named('Two'), { version: first.version, required: true })

    expect(second).toHaveProperty('saved', true)
    expect(loaded).toHaveLength(2)
  })

  test('does not conflict when the other saves left the entry as the editor saw it', async () => {
    const version = await opened()

    await saveEntry(named('Other'), { version, required: true })
    await saveEntry(named('Mug'), { version: contentVersion({ data: { name: 'Other' } }), required: true })

    expect(await saveEntry(named('Mine'), { version, required: true })).toHaveProperty('saved', true)
  })

  test('refuses a save of an entry deleted since, naming no version, so the editor writes it again as new', async () => {
    const version = await opened()

    await deleteEntry(mug, undefined, { version, required: true })
    expect(await saveEntry(named('Late'), { version, required: true })).toMatchObject({ conflict: { version: null } })
    expect(loaded).toEqual([])
    expect(await saveEntry(named('Late'), { create: true, version: undefined, required: true })).toHaveProperty('saved', true)
  })

  test('refuses a delete of an entry saved since, and deletes one that is as the editor saw it', async () => {
    const version = await opened()

    await saveEntry(named('Saved'), { version, required: true })
    expect(await deleteEntry(mug, undefined, { version, required: true })).toMatchObject({ issues: [{ message: 'This entry was changed since you opened it, by another editor or by the app' }], conflict: { version: contentVersion({ data: { name: 'Saved' } }) } })
    expect(removed).toEqual([])
    expect(await deleteEntry(mug, undefined, { version: contentVersion({ data: { name: 'Saved' } }), required: true })).toEqual({ saved: true })
    expect(removed).toEqual(['mug'])
  })

  test('refuses a delete of an entry already deleted', async () => {
    const version = await opened()

    await deleteEntry(mug, undefined, { version, required: true })
    expect(await deleteEntry(mug, undefined, { version, required: true })).toMatchObject({ conflict: { version: null } })
  })

  test('refuses a save or a delete naming no version of an entry the loader holds, when the editor must name one', async () => {
    expect(await saveEntry(named('Old editor'), { required: true })).toHaveProperty('issues.0.message', expect.stringContaining('older than the server'))
    expect(await deleteEntry(mug, undefined, { required: true })).toHaveProperty('issues.0.message', expect.stringContaining('reload the page'))
    expect(loaded).toEqual([])
    expect(removed).toEqual([])
  })

  test('saves and deletes without reading the loader again when no version is asked for', async () => {
    const read = spyOn(content, 'entries')

    expect(await saveEntry(named('Plain'))).toEqual({ saved: true })
    expect(await deleteEntry(mug)).toEqual({ saved: true })
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
  })

  test('hands a new entry the version it was saved at', async () => {
    expect(await saveEntry({ ...mug, slug: 'cup', data: { name: 'Cup' } }, { create: true, required: true })).toHaveProperty('version', contentVersion({ data: { name: 'Cup' } }))
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

describe('moveEntry', () => {
  const place = (collection: string, slug: string, order: number | undefined, extra: Record<string, unknown> = {}): SourceEntry => ({ slug, path: collection === 'shelf' ? `content/shelf/${slug}.md` : undefined, data: order === undefined ? { title: slug, ...extra } : { title: slug, order, ...extra }, body: collection === 'shelf' ? `about ${slug}` : undefined, draft: false })

  test('swaps the order values of two neighbours and commits both files, keeping their bodies', async () => {
    stored.shelf = [place('shelf', 'a', 10), place('shelf', 'b', 20), place('shelf', 'c', 30)]

    expect(await moveEntry({ collection: 'shelf', slug: 'c' }, 'up')).toHaveProperty('saved', true)
    expect(saved.map(change => [change.repoPath, change.text, change.message])).toEqual([
      ['content/shelf/c.md', '{"title":"c","order":20}\nabout c', 'content(shelf): move c'],
      ['content/shelf/b.md', '{"title":"b","order":30}\nabout b', 'content(shelf): move b'],
    ])
  })

  test('numbers the entries from 1 when the values repeat, sending a loaded collection through its loader', async () => {
    stored.catalog = [place('catalog', 'a', 1), place('catalog', 'b', 1), place('catalog', 'c', undefined)]

    expect(await moveEntry({ collection: 'catalog', slug: 'c' }, 'up')).toHaveProperty('saved', true)
    expect(loaded.map(entry => [entry.slug, (entry.data as { order: number }).order])).toEqual([['c', 2], ['b', 3]])
    expect(batches).toEqual([2])
  })

  test('writes nothing for an entry at the end it moves toward', async () => {
    stored.shelf = [place('shelf', 'a', 1), place('shelf', 'b', 2)]

    expect(await moveEntry({ collection: 'shelf', slug: 'a' }, 'up')).toHaveProperty('saved', true)
    expect(saved).toEqual([])
  })

  test('moves among the entries of its own locale, passing over a broken file', async () => {
    stored.catalog = [{ ...place('catalog', 'a', 1), locale: 'fr' }, { ...place('catalog', 'a', 1), locale: 'en' }, { slug: 'x', locale: 'fr', data: undefined, problem: 'bad', draft: false }, { ...place('catalog', 'b', 2), locale: 'fr' }]

    expect(await moveEntry({ collection: 'catalog', slug: 'b', locale: 'fr' }, 'up')).toHaveProperty('saved', true)
    expect(loaded.map(entry => [entry.slug, entry.locale])).toEqual([['b', 'fr'], ['a', 'fr']])
  })

  test('stops at the first save that is refused', async () => {
    stored.shelf = [place('shelf', 'a', 1), place('shelf', 'b', 2)]
    configure({ files: { save: async () => {
      throw new SaveConflict('f00d')
    } } })

    expect(await moveEntry({ collection: 'shelf', slug: 'b' }, 'up')).toHaveProperty('issues.0.message')
  })

  test('refuses a collection with no order field, and an entry it does not hold', async () => {
    expect(await moveEntry({ collection: 'posts', slug: 'hello' }, 'up')).toHaveProperty('issues.0.message', 'posts names no order field to move entries by')
    expect(await moveEntry({ collection: 'shelf', slug: 'gone' }, 'up')).toHaveProperty('issues.0.message', 'gone does not exist')
  })
})

describe('copySlug', () => {
  test('is the slug with -copy, then -copy-2 and on, the first that is free', () => {
    expect(copySlug('a', new Set(['a']))).toBe('a-copy')
    expect(copySlug('a', new Set(['a', 'a-copy']))).toBe('a-copy-2')
    expect(copySlug('notes/a', new Set(['notes/a-copy', 'notes/a-copy-2']))).toBe('notes/a-copy-3')
  })
})

describe('references on save', () => {
  const notes: CollectionInfo = { ...posts, name: 'notes', dir: 'content/notes', schema: { type: 'object', properties: { title: { type: 'string' }, post: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'posts' } } } } }

  test('refuses a reference to an entry the target lacks, and saves one that exists', async () => {
    collectionList.push(notes)

    try {
      expect(await saveEntry({ collection: 'notes', slug: 'n', data: { title: 'N', post: 'ghost' } })).toEqual({ issues: [{ collection: 'notes', slug: 'n', locale: undefined, path: 'post', message: 'No entry ghost in posts' }] })
      expect(saved).toEqual([])
      expect(await saveEntry({ collection: 'notes', slug: 'n', data: { title: 'N', post: 'hello' } })).toHaveProperty('saved', true)
    }
    finally {
      collectionList.pop()
    }
  })
})

describe('counts of the content list', () => {
  test('a save or a delete drops the kept counts, so the list shows it at once', async () => {
    let reads = 0
    const read = async () => {
      reads++

      return []
    }

    await countEntries(posts, read)
    await countEntries(posts, read)
    expect(reads).toBe(1)

    await saveEntry({ collection: 'posts', slug: 'x', data: { title: 'X' } })
    await countEntries(posts, read)
    expect(reads).toBe(2)

    stored.posts = [{ slug: 'x', path: 'content/posts/x.md', data: { title: 'X' }, draft: false }]
    await deleteEntry({ collection: 'posts', slug: 'x' })
    await countEntries(posts, read)
    expect(reads).toBe(3)
  })
})

// The data the fake validator wrote as the first line of a saved file.
const frontmatter = (change: FileChange) => JSON.parse(change.text!.slice(0, change.text!.indexOf('\n'))) as Record<string, unknown>

describe('duplicateEntry', () => {
  test('saves a draft copy of the entry under a free slug and names it', async () => {
    stored.posts = [{ slug: 'hello', path: 'content/posts/hello.md', data: { title: 'Hello', draft: false }, body: 'Hi', draft: false }, { slug: 'hello-copy', path: 'content/posts/hello-copy.md', data: { title: 'Hello', draft: true }, draft: true }]

    expect(await duplicateEntry({ collection: 'posts', slug: 'hello' })).toMatchObject({ saved: true, slug: 'hello-copy-2' })
    expect(saved.map(change => [change.repoPath, change.message, change.text])).toEqual([['content/posts/hello-copy-2.md', 'content(posts): duplicate hello-copy-2', '{"title":"Hello","draft":true}\nHi']])
  })

  test('puts the copy last in an ordered collection, in its own locale', async () => {
    stored.shelf = [
      { slug: 'a', path: 'content/shelf/a.md', data: { title: 'A', order: 1 }, draft: false },
      { slug: 'b', path: 'content/shelf/b.md', data: { title: 'B', order: 4 }, draft: false },
    ]

    expect(await duplicateEntry({ collection: 'shelf', slug: 'a' })).toMatchObject({ saved: true, slug: 'a-copy' })
    expect(frontmatter(saved[0]!)).toEqual({ title: 'A', order: 5, draft: true })
  })

  test('leaves the copy unnumbered when no sibling holds a number, rather than ahead of them', async () => {
    stored.shelf = [{ slug: 'a', path: 'content/shelf/a.md', data: { title: 'A', order: 'x' }, draft: false }]

    await duplicateEntry({ collection: 'shelf', slug: 'a' })
    expect(frontmatter(saved[0]!)).toEqual({ title: 'A', draft: true })
  })

  test('holds the copy of an entry with only a publish date back, so it does not go live at once, in the format of the field', async () => {
    stored.stamped = [
      { slug: 'past', path: 'content/stamped/past.md', data: { title: 'P', publishAt: '2020-01-01T00:00:00.000Z' }, draft: false },
      { slug: 'plain', path: 'content/stamped/plain.md', data: { title: 'N' }, draft: false },
      { slug: 'soon', path: 'content/stamped/soon.md', data: { title: 'S', publishAt: '2999-01-01T00:00:00.000Z' }, draft: false },
    ]
    stored.dated = [
      { slug: 'past', path: 'content/dated/past.md', data: { title: 'P', publishAt: '2020-01-01' }, draft: false },
      { slug: 'plain', path: 'content/dated/plain.md', data: { title: 'N' }, draft: false },
    ]

    for (const collection of ['stamped', 'dated']) {
      for (const slug of collection === 'stamped' ? ['past', 'plain', 'soon'] : ['past', 'plain'])
        await duplicateEntry({ collection, slug })
    }

    expect(saved.map(change => frontmatter(change).publishAt)).toEqual(['9999-12-31T00:00:00.000Z', '9999-12-31T00:00:00.000Z', '2999-01-01T00:00:00.000Z', '9999-12-31', '9999-12-31'])
  })

  test('refuses an entry that does not exist and a single collection', async () => {
    expect(await duplicateEntry({ collection: 'posts', slug: 'nope' })).toHaveProperty('issues.0.key', 'slug')
    expect(await duplicateEntry({ collection: 'home', slug: 'index' })).toHaveProperty('issues.0.message', 'Home holds one entry, which cannot be duplicated')
    expect(saved).toEqual([])
  })
})

describe('a new entry saved by a role that may not publish, through the entries route', () => {
  test.each([['stamped', '9999-12-31T00:00:00.000Z'], ['dated', '9999-12-31']])('is held back by a date in the format of the %s collection\'s publish field', async (collection, held) => {
    const path = `/${collection}/new`
    const request = new Request(`http://site.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { title: 'New' }, create: true }) })

    expect(await leavesPublication(request, `/api/cms/entries${path}`)).toBe(true)
    expect(await (await entriesApi.handle(request)).json()).toMatchObject({ saved: true })
    expect(frontmatter(saved[0]!)).toEqual({ title: 'New', publishAt: held })
  })
})

describe('cms({ onSave })', () => {
  const author = { name: 'Ada', email: 'ada@example.com' }
  let events: unknown[]

  beforeEach(() => {
    events = []
    configure({ onSave: (event) => {
      events.push(event)
    }, files: { save: async () => ({ sha: 'abc' }) } })
  })

  test('hears each save, publish, duplicate and delete that went through, with the commit of a folder entry', async () => {
    await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' } }, { author })
    await saveEntry({ collection: 'posts', slug: 'new', data: { title: 'New' }, locale: 'fr' }, { create: true })
    await publishEntry({ collection: 'posts', slug: 'hello' })
    await deleteEntry({ collection: 'posts', slug: 'hello' })
    expect(events).toEqual([
      { collection: 'posts', slug: 'hello', verb: 'update', author, commit: { sha: 'abc' } },
      { collection: 'posts', slug: 'new', locale: 'fr', verb: 'add', commit: { sha: 'abc' } },
      { collection: 'posts', slug: 'hello', verb: 'publish', commit: { sha: 'abc' } },
      { collection: 'posts', slug: 'hello', verb: 'delete', commit: { sha: 'abc' } },
    ])
  })

  test('hears a loaded entry\'s save and delete, and each entry of a reorder', async () => {
    stored.catalog = [{ slug: 'a', data: { title: 'a', order: 1 }, draft: false }, { slug: 'b', data: { title: 'b', order: 2 }, draft: false }]
    await saveEntry({ collection: 'products', slug: 'mug', data: { name: 'Mug' } })
    await deleteEntry({ collection: 'products', slug: 'mug' })
    await moveEntry({ collection: 'catalog', slug: 'b' }, 'up')
    expect(events).toEqual([
      { collection: 'products', slug: 'mug', verb: 'update' },
      { collection: 'products', slug: 'mug', verb: 'delete' },
      { collection: 'catalog', slug: 'b', verb: 'move' },
      { collection: 'catalog', slug: 'a', verb: 'move' },
    ])
  })

  test('hears nothing of a save that was refused, and a throw does not undo the save', async () => {
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: '' } })).toHaveProperty('issues')
    expect(events).toEqual([])

    configure({ onSave: () => {
      throw new Error('hook down')
    }, files: { save: async () => ({ sha: 'abc' }) } })
    expect(await saveEntry({ collection: 'posts', slug: 'hello', data: { title: 'Hi' } })).toHaveProperty('saved', true)
  })
})

describe('heldDate', () => {
  test('is a far date in the format the publish field takes', async () => {
    const { heldDate } = await import('../src/store')
    const held = (format: string) => heldDate({ publishField: 'at', schema: { type: 'object', properties: { at: { type: 'string', format } } } })

    expect(held('date')).toBe('9999-12-31')
    expect(held('date-time')).toBe('9999-12-31T00:00:00.000Z')
  })
})
