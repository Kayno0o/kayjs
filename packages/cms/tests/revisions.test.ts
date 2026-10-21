import type { ContentLoader } from 'kay/content'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { s } from 'kay'
import { collection, entries } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { changesBetween } from '../src/changes'
import { editedMoment } from '../src/datetime'
import { historyPath } from '../src/listing'
import { sqliteLoader } from '../src/loaders/sqlite'
import { restoreRevision, restoreTrashed } from '../src/restore'
import { revisionsOf } from '../src/revisions'
import { historyScreen, trashScreen } from '../src/screens'
import { configure } from '../src/settings'
import { deleteEntry, entryOf, findCollection, publishEntry, saveEntry } from '../src/store'
import { trashOf } from '../src/trash'

const schema = s.Object({ title: s.String(), draft: s.Optional(s.Boolean()) })
let count = 0
let restore: ReturnType<typeof registerCollections>

// A fresh in-memory table each test, so no test sees another's rows.
function notes(seed?: { slug: string, data: Record<string, unknown> }[]): void {
  const table = `notes_${++count}`

  restore = registerCollections([
    ['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table, seed }), { schema, draft: 'draft' })],
    ['plain', collection({ name: 'plain', load: () => [{ slug: 'a', data: { title: 'A' } }], save: () => undefined }, { schema })],
  ])
}

beforeEach(() => {
  configure({})
})

afterEach(() => {
  registerCollections(restore)
})

const ref = { collection: 'notes', slug: 'first' }
const ada = { name: 'Ada', email: 'ada@example.com' }

describe('revisions', () => {
  test('keeps each save of a loaded entry, oldest first, with who saved it and how', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true, author: ada })
    await saveEntry({ ...ref, data: { title: 'Two' } }, { author: ada })
    await saveEntry({ ...ref, data: { title: 'Three' }, body: 'Text' })

    const revisions = await revisionsOf(ref)

    expect(revisions.map(revision => [revision.verb, revision.data.title, revision.author, revision.body])).toEqual([['add', 'One', 'Ada', undefined], ['update', 'Two', 'Ada', undefined], ['update', 'Three', undefined, 'Text']])
    expect(revisions.map(revision => revision.at)).toEqual(revisions.map(revision => revision.at).sort((a, b) => a - b))
  })

  test('keeps an entry as it stood before its first recorded save', async () => {
    notes([{ slug: 'first', data: { title: 'Seeded' } }])
    await saveEntry({ ...ref, data: { title: 'Edited' } })
    expect((await revisionsOf(ref)).map(revision => [revision.at, revision.verb, revision.data.title])).toEqual([[0, 'original', 'Seeded'], [expect.any(Number), 'update', 'Edited']])
  })

  test('skips a save that changes nothing, and keeps publishes and unpublishes', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One', draft: true } }, { create: true })
    await saveEntry({ ...ref, data: { draft: true, title: 'One' } })
    await publishEntry(ref)
    expect((await revisionsOf(ref)).map(revision => revision.verb)).toEqual(['add', 'publish'])
  })

  test('keeps the last 50 saves by default and as many as cms({ history: { revisions } }) says', async () => {
    notes()
    configure({ history: { revisions: 3 } })
    await saveEntry({ ...ref, data: { title: '0' } }, { create: true })

    for (let n = 1; n <= 4; n++)
      await saveEntry({ ...ref, data: { title: String(n) } })

    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['2', '3', '4'])
    expect(() => configure({ history: { revisions: 0 } })).toThrow('positive whole number')
  })

  test('keeps nothing when the history is off, and leaves the collection unmarked', async () => {
    notes()
    configure({ history: false })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    expect(await revisionsOf(ref)).toEqual([])
    expect((await findCollection('notes'))?.history).toBeUndefined()
  })

  test('keeps nothing for a collection whose layout says history: false, and the others go on', async () => {
    notes()
    configure({ collections: { notes: { history: false } } })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })
    await deleteEntry(ref)
    expect(await revisionsOf(ref)).toEqual([])
    expect(await trashOf('notes')).toEqual([])
    const found = await findCollection('notes')

    expect([found?.history, found?.trash]).toEqual([undefined, undefined])
    expect(() => configure({ collections: { notes: { history: true } } } as never)).toThrow('takes `false`')
  })

  test('marks the collections whose loader can keep it, and no other', async () => {
    notes()
    expect((await findCollection('notes'))?.history).toBe(true)
    expect((await findCollection('plain'))?.history).toBeUndefined()
    expect(await saveEntry({ collection: 'plain', slug: 'a', data: { title: 'B' } })).toMatchObject({ saved: true })
    expect(await revisionsOf({ collection: 'plain', slug: 'a' })).toEqual([])
  })

  test('shows in no list of the collection', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    expect((await entries('notes')).map(entry => entry.slug)).toEqual(['first'])
  })

  test('survives a delete, and a saved entry keeps its own history apart from another with the same slug in a locale', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref)
    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['One'])
    expect(await revisionsOf({ ...ref, locale: 'fr' })).toEqual([])
  })

  test('a save that does not go through leaves no revision', async () => {
    notes()
    expect(await saveEntry({ ...ref, data: { title: 7 } }, { create: true })).toHaveProperty('issues')
    expect(await revisionsOf(ref)).toEqual([])
  })
})

describe('restoreRevision', () => {
  test('saves an older version again as a new one', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })

    const [first] = await revisionsOf(ref)
    const version = (await entryOf(ref))?.version

    expect(await restoreRevision(ref, first!.at, ada, { version })).toMatchObject({ saved: true })
    expect((await entryOf(ref))?.data).toEqual({ title: 'One' })
    expect((await revisionsOf(ref)).map(revision => [revision.verb, revision.data.title])).toEqual([['add', 'One'], ['update', 'Two'], ['restore', 'One']])
  })

  test('is refused over a save made since the editor opened the entry, and for a version that is gone', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })

    const [first] = await revisionsOf(ref)
    const stale = (await entryOf(ref))?.version

    await saveEntry({ ...ref, data: { title: 'Two' } })
    expect(await restoreRevision(ref, first!.at, undefined, { version: stale })).toMatchObject({ issues: [{ message: expect.stringContaining('changed') }], conflict: expect.anything() })
    expect(await restoreRevision(ref, 123, undefined, { version: (await entryOf(ref))?.version })).toMatchObject({ issues: [{ message: 'That version is not kept any more' }] })
  })

  test('leaves the draft flag as it is for a role that may not publish', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One', draft: false } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two', draft: true } })

    const [first] = await revisionsOf(ref)

    await restoreRevision(ref, first!.at, undefined, { version: (await entryOf(ref))?.version, restrained: true })
    expect((await entryOf(ref))?.data).toEqual({ title: 'One', draft: true })
  })
})

describe('historyScreen', () => {
  test('lists the versions newest first, what each changed and which is current', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })

    const screen = await historyScreen(ref)

    expect(screen?.rows.map(row => [row.verb, row.current, row.changes])).toEqual([['update', true, [{ key: 'title', label: 'Title', before: 'One', after: 'Two' }]], ['add', false, []]])
  })

  test('is none for a missing entry or a collection that keeps no history', async () => {
    notes()
    expect(await historyScreen(ref)).toBeUndefined()
    expect(await historyScreen({ collection: 'plain', slug: 'a' })).toBeUndefined()
  })
})

describe('the trash', () => {
  test('keeps a deleted loaded entry with who deleted it, and restores it under its slug with its history', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' }, body: 'Text' }, { create: true })
    expect(await deleteEntry(ref, ada)).toMatchObject({ saved: true })
    expect(await entryOf(ref)).toBeUndefined()

    const [item] = await trashOf('notes')

    expect(item).toMatchObject({ slug: 'first', author: 'Ada', data: { title: 'One' }, body: 'Text' })
    expect(await restoreTrashed('notes', item!.id, ada)).toMatchObject({ saved: true })
    expect((await entryOf(ref))?.data).toEqual({ title: 'One' })
    expect(await trashOf('notes')).toEqual([])
    // The restored content is the last version's, which is not kept twice.
    expect((await revisionsOf(ref)).map(revision => revision.verb)).toEqual(['add'])
  })

  test('refuses a restore over a slug made since, leaving it in the trash', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref)
    await saveEntry({ ...ref, data: { title: 'New' } }, { create: true })

    const [item] = await trashOf('notes')

    expect(await restoreTrashed('notes', item!.id)).toHaveProperty('issues')
    expect(await trashOf('notes')).toHaveLength(1)
    expect((await entryOf(ref))?.data).toEqual({ title: 'New' })
  })

  test('says so for an entry that is not in the trash', async () => {
    notes()
    expect(await restoreTrashed('notes', '1')).toMatchObject({ issues: [{ message: 'That entry is not in the trash any more' }] })
  })

  test('forgets what has been in the trash longer than 30 days, and the history of an entry never made again', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref)

    const now = Date.now()
    const clock = spyOn(Date, 'now').mockReturnValue(now + 29 * 86_400_000)

    expect(await trashOf('notes')).toHaveLength(1)
    clock.mockReturnValue(now + 31 * 86_400_000)
    expect(await trashOf('notes')).toEqual([])
    expect(await revisionsOf(ref)).toEqual([])
    clock.mockRestore()
  })

  test('is kept as long as cms({ history: { trash } }) says, and not at all with false', async () => {
    notes()
    configure({ history: { trash: false } })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref)
    expect(await trashOf('notes')).toEqual([])
    expect((await findCollection('notes'))?.trash).toBeUndefined()
    expect((await findCollection('notes'))?.history).toBe(true)
    expect(() => configure({ history: { trash: '0s' } })).toThrow('positive duration')
  })

  test('keeps nothing for a delete that was refused, and restores a draft for a role that may not publish', async () => {
    notes()
    expect(await deleteEntry(ref)).toHaveProperty('issues')
    expect(await trashOf('notes')).toEqual([])
    await saveEntry({ ...ref, data: { title: 'One', draft: false } }, { create: true })
    await deleteEntry(ref)

    const [item] = await trashOf('notes')

    await restoreTrashed('notes', item!.id, undefined, { restrained: true })
    expect((await entryOf(ref))?.data).toEqual({ title: 'One', draft: true })
  })

  test('is read by the trash screen, newest first, with each entry\'s title', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ collection: 'notes', slug: 'second', data: { title: 'Two' } }, { create: true })
    await deleteEntry(ref)
    await deleteEntry({ collection: 'notes', slug: 'second' })
    expect((await trashScreen('notes'))?.rows.map(row => [row.slug, row.title])).toEqual([['second', 'Two'], ['first', 'One']])
    expect(await trashScreen('plain')).toBeUndefined()
  })
})

describe('history details', () => {
  test('starts a fresh history for a new entry under the slug of a deleted one', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'Old' } }, { create: true })
    await deleteEntry(ref)
    await saveEntry({ ...ref, data: { title: 'New' } }, { create: true })
    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['New'])
  })

  test('compares an entry with its defaults filled in, so a save that changes nothing adds nothing', async () => {
    const withDefault = s.Object({ title: s.String(), tone: s.String({ default: 'calm' }) })
    const table = `notes_${++count}`

    restore = registerCollections([['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table }), { schema: withDefault })]])
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'One', tone: 'calm' } })
    expect((await revisionsOf(ref)).length).toBe(1)
  })

  test('renders a history path, the changes between two versions and a save moment', () => {
    expect(historyPath('/admin', { collection: 'notes', slug: 'a/b' })).toBe('/admin/history/notes/a/b')
    expect(changesBetween(schema, { data: { title: 'A' } }, { data: { title: 'B' }, body: 'x' }).map(change => [change.key, change.before, change.after])).toEqual([['title', 'A', 'B'], ['\u0001body', '', 'x']])
    expect(editedMoment(Date.UTC(2026, 9, 21, 14, 5))).toBe('2026-10-21 14:05 UTC')
    expect(editedMoment(Date.UTC(2026, 9, 21, 14, 5), 'Not/AZone')).toBe('2026-10-21 14:05 UTC')
  })
})

describe('the trash, details', () => {
  test('keeps the history of an entry deleted twice while the first deletion expires', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })

    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() - 31 * 24 * 3600 * 1000)

    try {
      await deleteEntry(ref)
    }
    finally {
      clock.mockRestore()
    }

    await saveEntry({ ...ref, data: { title: 'Two' } }, { create: true })
    await deleteEntry(ref)

    const items = await trashOf('notes')

    expect(items.length).toBe(1)
    await restoreTrashed('notes', items[0]!.id)
    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['Two'])
  })

  test('puts a restored entry back without the place it held', async () => {
    const ordered = s.Object({ title: s.String(), position: s.Optional(s.Number()) })
    const table = `notes_${++count}`

    restore = registerCollections([['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table }), { schema: ordered, order: 'position' })]])
    await saveEntry({ ...ref, data: { title: 'One', position: 3 } }, { create: true })
    await deleteEntry(ref)

    const [item] = await trashOf('notes')

    await restoreTrashed('notes', item!.id)
    expect((await entryOf(ref))?.data?.position).toBeUndefined()
  })
})

// A hidden collection answering only load, save and remove, as a minimal loader of one's own would.
function plainHidden(rows: Map<string, { slug: string, data: unknown, body?: string | undefined }>): ContentLoader {
  return {
    name: 'hidden',
    load: () => [...rows.values()],
    save: (entry) => {
      rows.set(entry.slug, { slug: entry.slug, data: entry.data, body: entry.body })
    },
    remove: (entry) => {
      rows.delete(entry.slug)
    },
  }
}

describe('history gaps', () => {
  test('a delete the loader fails leaves nothing in the trash', async () => {
    const table = `notes_${++count}`
    const inner = sqliteLoader({ name: 'notes', database: ':memory:', table })

    restore = registerCollections([['notes', collection({ ...inner, remove: async () => {
      throw new Error('disk full')
    } }, { schema })]])
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await expect(deleteEntry(ref)).rejects.toThrow('disk full')
    expect(await trashOf('notes')).toEqual([])
    expect((await entryOf(ref))?.data).toEqual({ title: 'One' })
  })

  test('a loader with a sibling but no get and no saveMany keeps revisions and a trash, saving the rows in turn', async () => {
    const history = new Map<string, { slug: string, data: unknown, body?: string | undefined }>()
    const trash = new Map<string, { slug: string, data: unknown, body?: string | undefined }>()
    const inner = sqliteLoader({ name: 'notes', database: ':memory:', table: `notes_${++count}` })

    restore = registerCollections([['notes', collection({ ...inner, sibling: kind => plainHidden(kind === 'history' ? history : trash) }, { schema })]])
    configure({ history: { revisions: 2 } })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })
    await saveEntry({ ...ref, data: { title: 'Three' } })
    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['Two', 'Three'])
    // The index and one row per kept revision, the pruned one removed.
    expect(history.size).toBe(3)

    await deleteEntry(ref)

    const [item] = await trashOf('notes')

    expect(item).toMatchObject({ slug: 'first', data: { title: 'Three' } })
    expect(await restoreTrashed('notes', item!.id)).toMatchObject({ saved: true })
    expect(trash.size).toBe(0)
    expect((await entryOf(ref))?.data).toEqual({ title: 'Three' })
  })
})
