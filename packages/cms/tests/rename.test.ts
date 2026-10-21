import type { FileSaver } from '../src/files'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { blocks, collection, reference, unique } from 'kay/content'
import { removeRuntimeRedirect, runtimeRedirects } from 'kay/library'
import { scratchDir } from 'kay/test'
import { registerCollections, registerEditSite } from '../../../src/content/edit'
import { contentPlace, setContentPlace } from '../../../src/content/load'
import { knowRuntimeRules } from '../../../src/server/runtime-redirect-api'
import { fileVersion, SaveConflict, workingTree } from '../src/files'
import { sqliteLoader } from '../src/loaders/sqlite'
import { revisionsOf } from '../src/revisions'
import { configure } from '../src/settings'
import { deleteEntry, entryOf, renameEntry, saveEntry } from '../src/store'
import { trashOf } from '../src/trash'

const schema = s.Object({ title: s.String(), code: s.Optional(unique(s.String())), author: s.Optional(reference('authors')), note: s.Optional(reference('notes')), book: s.Optional(reference('books')) })
const articleSchema = s.Object({ title: s.String(), editors: s.Optional(s.Array(reference('authors'))), credit: s.Optional(s.Object({ by: reference('authors') })), sections: s.Optional(blocks({ team: s.Object({ member: reference('authors') }), text: s.Object({ body: s.String() }) })) })
const spotSchema = s.Object({ title: s.String(), translationKey: s.Optional(s.String()) })
const visitSchema = s.Object({ title: s.String(), spot: s.Optional(reference('spots')) })
let count = 0
let dir: string
let restore: ReturnType<typeof registerCollections>
let registered: Parameters<typeof registerCollections>[0]
const original = contentPlace()

const redirects = () => runtimeRedirects().filter(row => row.from.includes('rn-')).map(row => [row.from, row.to]).sort()

beforeEach(async () => {
  dir = await scratchDir('rename-')
  await mkdir(join(dir, 'posts'), { recursive: true })
  await mkdir(join(dir, 'pages/en'), { recursive: true })
  await mkdir(join(dir, 'pages/fr'), { recursive: true })
  await mkdir(join(dir, 'authors'), { recursive: true })
  await mkdir(join(dir, 'books'), { recursive: true })
  await mkdir(join(dir, 'articles'), { recursive: true })
  await mkdir(join(dir, 'spots/en'), { recursive: true })
  await mkdir(join(dir, 'spots/fr'), { recursive: true })
  await mkdir(join(dir, 'visits'), { recursive: true })
  await mkdir(join(dir, 'guides/en'), { recursive: true })
  await mkdir(join(dir, 'guides/fr'), { recursive: true })
  setContentPlace(dir, dir)
  registerEditSite({ urls: async () => undefined, locales: ['en', 'fr'], defaultLocale: 'en' })

  const table = `notes_${++count}`

  registered = [
    ['posts', collection(join(dir, 'posts'), { schema, url: entry => `/rn-blog/${entry.slug}` })],
    ['pages', collection(join(dir, 'pages'), { schema, localized: true, url: entry => `/${entry.locale}/rn-p/${entry.slug}` })],
    ['authors', collection(join(dir, 'authors'), { schema })],
    ['books', collection(join(dir, 'books'), { schema })],
    ['articles', collection(join(dir, 'articles'), { schema: articleSchema })],
    ['spots', collection(join(dir, 'spots'), { schema: spotSchema, localized: true })],
    ['visits', collection(join(dir, 'visits'), { schema: visitSchema })],
    ['guides', collection(join(dir, 'guides'), { schema: s.Object({ title: s.String(), spot: s.Optional(reference('spots')) }), localized: true })],
    ['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table }), { schema, url: entry => `/rn-notes/${entry.slug}` })],
  ]
  restore = registerCollections(registered)
  configure({ files: workingTree() })
})

afterEach(() => {
  registerCollections(restore)
  setContentPlace(original.root, original.base)
  registerEditSite(undefined)
  knowRuntimeRules({ redirects: {} })

  for (const row of redirects())
    removeRuntimeRedirect(row[0]!)
})

async function make(collectionName: string, slug: string, data: Record<string, unknown> = { title: slug }, locale?: string, body?: string) {
  await saveEntry({ collection: collectionName, slug, locale, data, body }, { create: true })
}

describe('renaming a folder entry', () => {
  test('moves the file, keeps its format and body, and redirects the old page to the new one', async () => {
    await make('posts', 'first', { title: 'First' }, undefined, 'Hello.')

    const version = (await entryOf({ collection: 'posts', slug: 'first' }))?.version
    const outcome = await renameEntry({ collection: 'posts', slug: 'first' }, 'second', { version, required: true })

    expect(outcome).toMatchObject({ saved: true, slug: 'second' })
    expect(await Bun.file(join(dir, 'posts/first.md')).exists()).toBe(false)
    expect(await Bun.file(join(dir, 'posts/second.md')).text()).toContain('Hello.')
    expect(await entryOf({ collection: 'posts', slug: 'second' })).toMatchObject({ data: { title: 'First' } })
    expect(redirects()).toEqual([['/rn-blog/first', '/rn-blog/second']])
    expect('version' in outcome && outcome.version).toBe(fileVersion(await Bun.file(join(dir, 'posts/second.md')).text()))
  })

  test('renames a localized entry in its locale alone, redirecting that locale\'s page', async () => {
    await make('pages', 'about', { title: 'About' }, 'en')
    await make('pages', 'a-propos', { title: 'A propos' }, 'fr')

    expect(await renameEntry({ collection: 'pages', slug: 'about', locale: 'en' }, 'about-us')).toMatchObject({ saved: true })
    expect(await Bun.file(join(dir, 'pages/en/about-us.md')).exists() || await Bun.file(join(dir, 'pages/en/about-us.json')).exists()).toBe(true)
    expect(await Bun.file(join(dir, 'pages/fr/a-propos.md')).exists() || await Bun.file(join(dir, 'pages/fr/a-propos.json')).exists()).toBe(true)
    expect(redirects()).toEqual([['/en/rn-p/about', '/en/rn-p/about-us']])
  })

  test('takes the base off both pages, as the server routes know them', async () => {
    knowRuntimeRules({ redirects: {}, base: '/site' })
    registerCollections([['posts', collection(join(dir, 'posts'), { schema, url: entry => `/site/rn-blog/${entry.slug}` })]])
    await make('posts', 'first')
    await renameEntry({ collection: 'posts', slug: 'first' }, 'second')

    expect(redirects()).toEqual([['/rn-blog/first', '/rn-blog/second']])
  })

  test('refuses a taken slug, the same slug, a missing entry and a stale version, writing nothing', async () => {
    await make('posts', 'first')
    await make('posts', 'second')

    const ref = { collection: 'posts', slug: 'first' }

    expect(await renameEntry(ref, 'second')).toMatchObject({ issues: [{ message: expect.stringContaining('already holds') }] })
    expect(await renameEntry(ref, 'first')).toMatchObject({ issues: [{ key: 'slug' }] })
    expect(await renameEntry({ collection: 'posts', slug: 'none' }, 'x')).toMatchObject({ issues: [{ key: 'slug' }] })
    expect(await renameEntry(ref, 'third', { version: 'stale' })).toMatchObject({ issues: expect.any(Array), conflict: { version: expect.any(String) } })
    expect(await Bun.file(join(dir, 'posts/first.md')).exists() || await Bun.file(join(dir, 'posts/first.json')).exists()).toBe(true)
    expect(redirects()).toEqual([])
  })

  test('refuses a slug naming another place, and writes nothing outside the folder', async () => {
    await make('posts', 'first')

    for (const slug of ['..', 'a/../../b', '../escape', '/abs', 'a\\b', '', '.hidden', 'a//b', 'x\u0000y']) {
      const outcome = await renameEntry({ collection: 'posts', slug: 'first' }, slug)

      expect(outcome, slug).toHaveProperty('issues')
    }

    expect(redirects()).toEqual([])
    expect(await Bun.file(join(dir, 'escape.md')).exists()).toBe(false)
  })

  test('keeps an encoded slug as the plain name it is, and its redirect stays on the site', async () => {
    await make('posts', 'first')

    expect(await renameEntry({ collection: 'posts', slug: 'first' }, '%2e%2e')).toMatchObject({ saved: true })
    expect(await Bun.file(join(dir, 'posts/%2e%2e.json')).exists()).toBe(true)
    expect(redirects().every(([, to]) => to!.startsWith('/'))).toBe(true)
  })

  test('does not count the entry\'s own unique value as taken by the old slug', async () => {
    await make('posts', 'first', { title: 'First', code: 'ABC' })
    await make('posts', 'other', { title: 'Other', code: 'XYZ' })

    expect(await renameEntry({ collection: 'posts', slug: 'first' }, 'second')).toMatchObject({ saved: true })
    expect(await entryOf({ collection: 'posts', slug: 'second' })).toMatchObject({ data: { code: 'ABC' } })
  })

  test('requires the version of a folder entry when the editor is meant to name one', async () => {
    await make('posts', 'first')

    expect(await renameEntry({ collection: 'posts', slug: 'first' }, 'second', { required: true })).toMatchObject({ issues: [{ message: expect.stringContaining('older than the server') }] })
    expect(redirects()).toEqual([])
  })

  test('refuses a rename whose page no redirect can name, without losing the rename', async () => {
    await make('posts', 'first')

    expect(await renameEntry({ collection: 'posts', slug: 'first' }, '*')).toMatchObject({ saved: true })
    expect(redirects()).toEqual([])
  })

  test('refuses a saver that cannot move files', async () => {
    await make('posts', 'first')
    configure({ files: { save: workingTree().save } })

    expect(await renameEntry({ collection: 'posts', slug: 'first' }, 'second')).toMatchObject({ issues: [{ message: expect.stringContaining('cannot rename') }] })
  })

  test('a chain of two renames redirects both old pages at the last, one hop each', async () => {
    await make('posts', 'a')
    await renameEntry({ collection: 'posts', slug: 'a' }, 'b')
    await renameEntry({ collection: 'posts', slug: 'b' }, 'c')

    expect(redirects()).toEqual([['/rn-blog/a', '/rn-blog/c'], ['/rn-blog/b', '/rn-blog/c']])
  })

  test('an accented slug chains and goes back like any other', async () => {
    await make('posts', 'café')
    await renameEntry({ collection: 'posts', slug: 'café' }, 'thé')
    await renameEntry({ collection: 'posts', slug: 'thé' }, 'lait')
    expect(redirects()).toEqual([['/rn-blog/caf%C3%A9', '/rn-blog/lait'], ['/rn-blog/th%C3%A9', '/rn-blog/lait']])

    expect(await renameEntry({ collection: 'posts', slug: 'lait' }, 'café')).toMatchObject({ saved: true })
    expect(redirects()).toEqual([['/rn-blog/lait', '/rn-blog/caf%C3%A9'], ['/rn-blog/th%C3%A9', '/rn-blog/caf%C3%A9']])
  })

  test('a rename back to the old slug leaves no redirect loop', async () => {
    await make('posts', 'a')
    await renameEntry({ collection: 'posts', slug: 'a' }, 'b')
    expect(await renameEntry({ collection: 'posts', slug: 'b' }, 'a')).toMatchObject({ saved: true })

    expect(redirects()).toEqual([['/rn-blog/b', '/rn-blog/a']])
  })

  test('tells onSave the rename with the slug it had', async () => {
    const events: unknown[] = []

    configure({ files: workingTree(), onSave: event => void events.push(event) })
    await make('posts', 'a')
    await renameEntry({ collection: 'posts', slug: 'a' }, 'b')

    expect(events.at(-1)).toMatchObject({ collection: 'posts', slug: 'b', from: 'a', verb: 'rename' })
  })
})

describe('renaming a loaded entry', () => {
  test('keeps its history, adds nothing to the trash, and redirects', async () => {
    await make('notes', 'first', { title: 'One' })
    await saveEntry({ collection: 'notes', slug: 'first', data: { title: 'Two' } }, {})

    const before = await revisionsOf({ collection: 'notes', slug: 'first' })

    expect(before.length).toBeGreaterThan(1)

    expect(await renameEntry({ collection: 'notes', slug: 'first' }, 'second')).toMatchObject({ saved: true, slug: 'second' })
    expect(await entryOf({ collection: 'notes', slug: 'first' })).toBeUndefined()
    expect(await entryOf({ collection: 'notes', slug: 'second' })).toMatchObject({ data: { title: 'Two' } })
    expect((await revisionsOf({ collection: 'notes', slug: 'second' })).map(revision => [revision.at, revision.verb])).toEqual(before.map(revision => [revision.at, revision.verb]))
    expect(await revisionsOf({ collection: 'notes', slug: 'first' })).toEqual([])
    expect(await trashOf('notes')).toEqual([])
    expect(redirects()).toEqual([['/rn-notes/first', '/rn-notes/second']])
  })

  test('a deletion after a rename trashes the entry under its new slug', async () => {
    await make('notes', 'first')
    await renameEntry({ collection: 'notes', slug: 'first' }, 'second')
    await deleteEntry({ collection: 'notes', slug: 'second' })

    expect((await trashOf('notes')).map(row => row.slug === undefined ? undefined : row.slug)).toHaveLength(1)
    expect((await trashOf('notes'))[0]).toMatchObject({ data: { title: 'first' } })
  })

  test('refuses a taken slug and a stale version, leaving the entry', async () => {
    await make('notes', 'first')
    await make('notes', 'second')

    expect(await renameEntry({ collection: 'notes', slug: 'first' }, 'second')).toHaveProperty('issues')
    expect(await renameEntry({ collection: 'notes', slug: 'first' }, 'third', { version: 'stale' })).toHaveProperty('conflict')
    expect(await entryOf({ collection: 'notes', slug: 'first' })).toBeDefined()
    expect(redirects()).toEqual([])
  })
})

const ADA = { collection: 'authors', slug: 'ada' }
const dataOf = async (collectionName: string, slug: string, locale?: string) => (await entryOf({ collection: collectionName, slug, locale }))?.data

describe('renaming an entry other entries refer to', () => {
  test('points a reference field, a list, a group and a block at the new slug, and leaves other references alone', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    await make('authors', 'bob', { title: 'Bob' })
    await make('books', 'engine', { title: 'Engine', author: 'ada' })
    await make('books', 'other', { title: 'Other', author: 'bob' })
    await make('articles', 'a', { title: 'A', editors: ['bob', 'ada'], credit: { by: 'ada' }, sections: [{ type: 'text', body: 'ada' }, { type: 'team', member: 'ada' }, { type: 'team', member: 'bob' }] })

    expect(await renameEntry(ADA, 'lovelace')).toMatchObject({ saved: true, slug: 'lovelace' })
    expect(await dataOf('books', 'engine')).toMatchObject({ author: 'lovelace' })
    expect(await dataOf('books', 'other')).toMatchObject({ author: 'bob' })
    expect(await dataOf('articles', 'a')).toEqual({ title: 'A', editors: ['bob', 'lovelace'], credit: { by: 'lovelace' }, sections: [{ type: 'text', body: 'ada' }, { type: 'team', member: 'lovelace' }, { type: 'team', member: 'bob' }] })
  })

  test('points the references of every locale of a localized collection, each file on its own', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    await make('pages', 'about', { title: 'About', author: 'ada' }, 'en')
    await make('pages', 'a-propos', { title: 'A propos', author: 'ada' }, 'fr')

    await renameEntry(ADA, 'lovelace')
    expect(await dataOf('pages', 'about', 'en')).toMatchObject({ author: 'lovelace' })
    expect(await dataOf('pages', 'a-propos', 'fr')).toMatchObject({ author: 'lovelace' })
  })

  test('points a loaded collection\'s entries too, with the save in their history', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    await make('notes', 'n', { title: 'N', author: 'ada' })

    const before = (await revisionsOf({ collection: 'notes', slug: 'n' })).length

    expect(await renameEntry(ADA, 'lovelace')).toMatchObject({ saved: true })
    expect(await dataOf('notes', 'n')).toMatchObject({ author: 'lovelace' })
    expect((await revisionsOf({ collection: 'notes', slug: 'n' })).length).toBe(before + 1)
  })

  test('points the entries naming a loaded entry, a folder one among them', async () => {
    await make('notes', 'first', { title: 'First' })
    await make('notes', 'friend', { title: 'Friend', note: 'first' })
    await make('posts', 'p', { title: 'P', note: 'first' })

    expect(await renameEntry({ collection: 'notes', slug: 'first' }, 'second')).toMatchObject({ saved: true })
    expect(await dataOf('notes', 'friend')).toMatchObject({ note: 'second' })
    expect(await dataOf('posts', 'p')).toMatchObject({ note: 'second' })
  })

  test('points the renamed entry\'s reference to itself and leaves its other references', async () => {
    await make('books', 'engine', { title: 'Engine' })
    await make('books', 'loop', { title: 'Loop', book: 'engine' })
    await saveEntry({ collection: 'books', slug: 'engine', data: { title: 'Engine', book: 'engine' } }, {})

    expect(await renameEntry({ collection: 'books', slug: 'engine' }, 'machine')).toMatchObject({ saved: true })
    expect(await dataOf('books', 'machine')).toMatchObject({ book: 'machine' })
    expect(await dataOf('books', 'loop')).toMatchObject({ book: 'machine' })
  })

  test('points every entry naming it, even two of one title', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    await make('books', 'one', { title: 'Same', author: 'ada' })
    await make('books', 'two', { title: 'Same', author: 'ada' })

    await renameEntry(ADA, 'lovelace')
    expect(await dataOf('books', 'one')).toMatchObject({ author: 'lovelace' })
    expect(await dataOf('books', 'two')).toMatchObject({ author: 'lovelace' })
  })

  test('tells onSave each entry it pointed, as an update', async () => {
    const events: { collection: string, slug: string, verb: string }[] = []

    configure({ files: workingTree(), onSave: event => void events.push(event) })
    await make('authors', 'ada', { title: 'Ada' })
    await make('books', 'engine', { title: 'Engine', author: 'ada' })
    events.length = 0
    await renameEntry(ADA, 'lovelace')
    expect(events.map(event => [event.collection, event.slug, event.verb])).toEqual([['books', 'engine', 'update'], ['authors', 'lovelace', 'rename']])
  })

  test('refuses the rename, writing nothing, when an entry naming this one was saved meanwhile', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    await make('books', 'engine', { title: 'Engine', author: 'ada' })

    const tree = workingTree()
    const racing: FileSaver = {
      ...tree,
      async move(move) {
        await Bun.write(join(dir, 'books/engine.json'), JSON.stringify({ title: 'Edited', author: 'ada' }))

        return tree.move!(move)
      },
    }

    configure({ files: racing })

    const outcome = await renameEntry(ADA, 'lovelace')

    expect(outcome).toHaveProperty('issues')
    expect(outcome).not.toHaveProperty('conflict')
    expect(await dataOf('authors', 'ada')).toBeDefined()
    expect(await dataOf('books', 'engine')).toMatchObject({ title: 'Edited', author: 'ada' })
    expect(redirects()).toEqual([])
  })

  test('saves the entries one by one after the move for a saver that cannot commit them together', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    await make('books', 'engine', { title: 'Engine', author: 'ada' })

    const tree = workingTree()

    configure({ files: { save: tree.save, move: tree.move } })
    expect(await renameEntry(ADA, 'lovelace')).toMatchObject({ saved: true })
    expect(await dataOf('books', 'engine')).toMatchObject({ author: 'lovelace' })
  })

  test('names the entries it could not point, the rename standing', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    await make('books', 'engine', { title: 'Engine', author: 'ada' })
    await make('books', 'plain', { title: 'Plain', author: 'ada' })

    const tree = workingTree()

    configure({
      files: {
        move: tree.move,
        async save(change) {
          if (change.repoPath.includes('engine'))
            throw new SaveConflict('other')

          return tree.save(change)
        },
      },
    })

    const outcome = await renameEntry(ADA, 'lovelace')

    expect(outcome).toMatchObject({ saved: true, slug: 'lovelace', unpointed: ['Books: Engine'] })
    expect(await dataOf('books', 'plain')).toMatchObject({ author: 'lovelace' })
    expect(await dataOf('books', 'engine')).toMatchObject({ author: 'ada' })
  })

  test('refuses the rename when a referring folder lies outside the repository, writing nothing', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cms-outside-'))

    try {
      await Bun.write(join(outside, 'engine.json'), JSON.stringify({ title: 'Engine', author: 'ada' }))
      registerCollections([...registered, ['shelf', collection(outside, { schema })]])
      await make('authors', 'ada', { title: 'Ada' })

      const outcome = await renameEntry(ADA, 'lovelace')

      expect(outcome).toMatchObject({ issues: [{ key: 'slug', message: expect.stringContaining('Shelf') }] })
      expect(await dataOf('authors', 'ada')).toBeDefined()
      expect(await dataOf('authors', 'lovelace')).toBeUndefined()
      expect(redirects()).toEqual([])
    }
    finally {
      registerCollections(registered)
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('refuses the rename, writing nothing, when a referring collection fails to read', async () => {
    let down = false

    registerCollections([...registered, ['shelf', collection({ name: 'shelf', load: async () => down ? Promise.reject(new Error('database down')) : [] }, { schema })]])
    await make('authors', 'ada', { title: 'Ada' })
    await make('books', 'engine', { title: 'Engine', author: 'ada' })
    down = true

    try {
      const outcome = await renameEntry(ADA, 'lovelace')

      expect(outcome).toMatchObject({ issues: [{ key: 'slug', message: expect.stringContaining('Shelf') }] })
      expect(await dataOf('authors', 'ada')).toBeDefined()
      expect(await dataOf('authors', 'lovelace')).toBeUndefined()
      expect(await dataOf('books', 'engine')).toMatchObject({ author: 'ada' })
    }
    finally {
      registerCollections(registered)
    }
  })

  test('a rename with no referrer reports none unpointed', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    expect(await renameEntry(ADA, 'lovelace')).not.toHaveProperty('unpointed')
  })
})

describe('renaming one locale of a translated entry', () => {
  test('keeps the translations paired by writing the old slug as the translationKey', async () => {
    await make('spots', 'about', { title: 'About' }, 'en')
    await make('spots', 'about', { title: 'A propos' }, 'fr')

    expect(await renameEntry({ collection: 'spots', slug: 'about', locale: 'en' }, 'about-us')).toMatchObject({ saved: true })
    expect(await dataOf('spots', 'about-us', 'en')).toMatchObject({ translationKey: 'about' })
    expect(await dataOf('spots', 'about', 'fr')).toEqual({ title: 'A propos' })
  })

  test('writes no key for an entry with no translation, or one that pairs by a key already', async () => {
    await make('spots', 'alone', { title: 'Alone' }, 'en')
    await make('spots', 'keyed', { title: 'Keyed', translationKey: 'k' }, 'en')
    await make('spots', 'keyed', { title: 'Cle' }, 'fr')

    await renameEntry({ collection: 'spots', slug: 'alone', locale: 'en' }, 'lonely')
    await renameEntry({ collection: 'spots', slug: 'keyed', locale: 'en' }, 'clef')
    expect(await dataOf('spots', 'lonely', 'en')).toEqual({ title: 'Alone' })
    expect(await dataOf('spots', 'clef', 'en')).toMatchObject({ translationKey: 'k' })
  })

  test('points the references of its locale, and of an entry with no locale only while no other locale holds the old slug', async () => {
    await make('spots', 'about', { title: 'About' }, 'en')
    await make('spots', 'about', { title: 'A propos' }, 'fr')
    await make('guides', 'g', { title: 'G', spot: 'about' }, 'en')
    await make('guides', 'g', { title: 'G fr', spot: 'about' }, 'fr')
    await make('visits', 'v', { title: 'V', spot: 'about' })

    await renameEntry({ collection: 'spots', slug: 'about', locale: 'en' }, 'about-us')
    expect(await dataOf('guides', 'g', 'en')).toMatchObject({ spot: 'about-us' })
    expect(await dataOf('guides', 'g', 'fr')).toMatchObject({ spot: 'about' })
    expect(await dataOf('visits', 'v')).toMatchObject({ spot: 'about' })

    await renameEntry({ collection: 'spots', slug: 'about', locale: 'fr' }, 'a-propos')
    expect(await dataOf('guides', 'g', 'fr')).toMatchObject({ spot: 'a-propos' })
    expect(await dataOf('visits', 'v')).toMatchObject({ spot: 'a-propos' })
  })

  test('keeps them paired when each locale is renamed in turn', async () => {
    await make('spots', 'about', { title: 'About' }, 'en')
    await make('spots', 'about', { title: 'A propos' }, 'fr')

    await renameEntry({ collection: 'spots', slug: 'about', locale: 'en' }, 'about-us')
    await renameEntry({ collection: 'spots', slug: 'about', locale: 'fr' }, 'a-propos')
    expect(await dataOf('spots', 'a-propos', 'fr')).toMatchObject({ translationKey: 'about' })
    expect(await dataOf('spots', 'about-us', 'en')).toMatchObject({ translationKey: 'about' })
  })
})
