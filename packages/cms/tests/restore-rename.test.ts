import { beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection, reference } from 'kay/content'
import { registerCollections, registerEditSite } from '../../../src/content/edit'
import { sqliteLoader } from '../src/loaders/sqlite'
import { restoreRevision } from '../src/restore'
import { revisionsOf } from '../src/revisions'
import { configure } from '../src/settings'
import { deleteEntry, entryOf, renameEntry, saveEntry } from '../src/store'

let count = 0

function register(): void {
  const table = (name: string) => sqliteLoader({ name, database: ':memory:', table: `${name}_${++count}` })

  registerEditSite({ urls: async () => undefined, locales: ['en', 'fr'], defaultLocale: 'en' })
  registerCollections([
    ['spots', collection(table('spots'), { schema: s.Object({ title: s.String(), translationKey: s.Optional(s.String()) }), localized: true })],
    ['authors', collection(table('authors'), { schema: s.Object({ title: s.String() }) })],
    ['notes', collection(table('notes'), { schema: s.Object({ title: s.String(), by: s.Optional(reference('authors')) }) })],
  ])
  configure({})
}

beforeEach(register)

async function restoreOldest(ref: { collection: string, slug: string, locale?: string }) {
  const [first] = await revisionsOf(ref)
  const version = (await entryOf(ref))?.version

  return restoreRevision(ref, first!.at, undefined, { version })
}

describe('restoring a version after a rename', () => {
  test('keeps the translationKey the rename set, so the translations stay paired', async () => {
    await saveEntry({ collection: 'spots', slug: 'about', locale: 'en', data: { title: 'About' } }, { create: true })
    await saveEntry({ collection: 'spots', slug: 'about', locale: 'fr', data: { title: 'A propos' } }, { create: true })
    await saveEntry({ collection: 'spots', slug: 'about', locale: 'en', data: { title: 'About v2' } })
    await renameEntry({ collection: 'spots', slug: 'about', locale: 'en' }, 'about-us')

    const en = { collection: 'spots', slug: 'about-us', locale: 'en' }

    expect((await restoreOldest(en)).ok).toBe(true)
    expect((await entryOf(en))?.data).toEqual({ title: 'About', translationKey: 'about' })
  })

  test('leaves an entry that was never paired by a key without one', async () => {
    await saveEntry({ collection: 'spots', slug: 'solo', locale: 'en', data: { title: 'Solo', translationKey: 'old' } }, { create: true })
    await saveEntry({ collection: 'spots', slug: 'solo', locale: 'en', data: { title: 'Solo 2' } })

    const solo = { collection: 'spots', slug: 'solo', locale: 'en' }

    expect((await restoreOldest(solo)).ok).toBe(true)
    expect((await entryOf(solo))?.data).toEqual({ title: 'Solo' })
  })

  test('names the entry a reference was renamed to, through several renames', async () => {
    await saveEntry({ collection: 'authors', slug: 'ada', data: { title: 'Ada' } }, { create: true })
    await saveEntry({ collection: 'notes', slug: 'n', data: { title: 'N', by: 'ada' } }, { create: true })
    await saveEntry({ collection: 'notes', slug: 'n', data: { title: 'N2', by: 'ada' } })
    await renameEntry({ collection: 'authors', slug: 'ada' }, 'lovelace')
    await renameEntry({ collection: 'authors', slug: 'lovelace' }, 'ada-l')

    const note = { collection: 'notes', slug: 'n' }
    const out = await restoreOldest(note)

    expect(out.ok).toBe(true)
    expect((await entryOf(note))?.data).toEqual({ title: 'N', by: 'ada-l' })
  })

  test('still refuses a reference to an entry that was deleted, not renamed', async () => {
    await saveEntry({ collection: 'authors', slug: 'bob', data: { title: 'Bob' } }, { create: true })
    await saveEntry({ collection: 'notes', slug: 'm', data: { title: 'M', by: 'bob' } }, { create: true })
    await saveEntry({ collection: 'notes', slug: 'm', data: { title: 'M2' } })
    await deleteEntry({ collection: 'authors', slug: 'bob' })

    const out = await restoreOldest({ collection: 'notes', slug: 'm' })

    expect(out.ok).toBe(false)
    expect(!out.ok && out.error.message).toBe('No entry bob in authors')
  })
})
