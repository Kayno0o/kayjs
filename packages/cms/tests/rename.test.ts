import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection, reference, unique } from 'kay/content'
import { removeRuntimeRedirect, runtimeRedirects } from 'kay/library'
import { scratchDir } from 'kay/test'
import { registerCollections, registerEditSite } from '../../../src/content/edit'
import { contentPlace, setContentPlace } from '../../../src/content/load'
import { knowRuntimeRules } from '../../../src/server/runtime-redirect-api'
import { fileVersion, workingTree } from '../src/files'
import { sqliteLoader } from '../src/loaders/sqlite'
import { revisionsOf } from '../src/revisions'
import { configure } from '../src/settings'
import { deleteEntry, entryOf, renameEntry, saveEntry } from '../src/store'
import { trashOf } from '../src/trash'

const schema = s.Object({ title: s.String(), code: s.Optional(unique(s.String())), author: s.Optional(reference('authors')) })
let count = 0
let dir: string
let restore: ReturnType<typeof registerCollections>
const original = contentPlace()

const redirects = () => runtimeRedirects().filter(row => row.from.includes('rn-')).map(row => [row.from, row.to]).sort()

beforeEach(async () => {
  dir = await scratchDir('rename-')
  await mkdir(join(dir, 'posts'), { recursive: true })
  await mkdir(join(dir, 'pages/en'), { recursive: true })
  await mkdir(join(dir, 'pages/fr'), { recursive: true })
  await mkdir(join(dir, 'authors'), { recursive: true })
  await mkdir(join(dir, 'books'), { recursive: true })
  setContentPlace(dir, dir)
  registerEditSite({ urls: async () => undefined, locales: ['en', 'fr'], defaultLocale: 'en' })

  const table = `notes_${++count}`

  restore = registerCollections([
    ['posts', collection(join(dir, 'posts'), { schema, url: entry => `/rn-blog/${entry.slug}` })],
    ['pages', collection(join(dir, 'pages'), { schema, localized: true, url: entry => `/${entry.locale}/rn-p/${entry.slug}` })],
    ['authors', collection(join(dir, 'authors'), { schema })],
    ['books', collection(join(dir, 'books'), { schema })],
    ['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table }), { schema, url: entry => `/rn-notes/${entry.slug}` })],
  ])
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

  test('is refused while another entry refers to it, naming it', async () => {
    await make('authors', 'ada', { title: 'Ada' })
    await make('books', 'engine', { title: 'Engine', author: 'ada' })

    expect(await renameEntry({ collection: 'authors', slug: 'ada' }, 'lovelace')).toMatchObject({ issues: [{ message: expect.stringContaining('Books: Engine') }] })
    expect(await Bun.file(join(dir, 'authors/ada.md')).exists() || await Bun.file(join(dir, 'authors/ada.json')).exists()).toBe(true)
  })

  test('requires the version of a folder entry when the editor is meant to name one', async () => {
    await make('posts', 'first')

    expect(await renameEntry({ collection: 'posts', slug: 'first' }, 'second', { required: true })).toMatchObject({ issues: [{ message: expect.stringContaining('older than the server') }] })
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
