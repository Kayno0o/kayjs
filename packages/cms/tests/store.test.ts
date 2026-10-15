import type { FileChange } from '../src/files'
import type * as Content from '../src/kay/content'
import type { CollectionInfo, SourceEntry } from '../src/kay/contract'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { bodyHtml, MarkdownError } from 'kay/content'
import { scratchDir } from 'kay/test'
import { fileVersion, ForgeError, SaveConflict } from '../src/files'
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
let infoCalls: unknown[]
let failing = false

// kay's content API, answering from `stored` and recording what a loader was handed.
const content: typeof Content = {
  bodyHtml,
  MarkdownError,
  collections: async () => [posts, products, outside],
  collectionInfo: async (name, options) => {
    infoCalls.push([name, options])

    return [posts, products, outside].find(collection => collection.name === name)
  },
  entries: async (collection, filter) => failing ? Promise.reject(new Error('kay: products\'s load threw: password for db.internal')) : (stored[collection] ?? []).filter(entry => (filter?.slug === undefined || entry.slug === filter.slug) && (filter?.locale === undefined || entry.locale === filter.locale)),
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

    return path === undefined ? { issues: [{ collection, slug, path: '', key: 'slug', message: MISSING }] } : { file: { path, absolute: path.startsWith('/') ? path : `/site/${path}`, repoPath: path } }
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
const { deleteEntry, entryOf, entryScreen, publishEntry, saveEntry, UnknownCollection } = await import('../src/store')

beforeEach(() => {
  saved = []
  loaded = []
  removed = []
  infoCalls = []
  failing = false
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
    expect(await entryScreen({ collection: 'products', slug: 'mug' })).toEqual({ collection: products, entry: stored.products![0] })
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
