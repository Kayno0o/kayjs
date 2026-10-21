import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection, entries } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { sqliteLoader } from '../src/loaders/sqlite'
import { restoreRevision } from '../src/restore'
import { revisionsOf } from '../src/revisions'
import { historyScreen } from '../src/screens'
import { configure } from '../src/settings'
import { deleteEntry, entryOf, findCollection, publishEntry, saveEntry } from '../src/store'

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

    expect(screen?.rows.map(row => [row.verb, row.current, row.changes])).toEqual([['update', true, [{ label: 'Title', before: 'One', after: 'Two' }]], ['add', false, []]])
  })

  test('is none for a missing entry or a collection that keeps no history', async () => {
    notes()
    expect(await historyScreen(ref)).toBeUndefined()
    expect(await historyScreen({ collection: 'plain', slug: 'a' })).toBeUndefined()
  })
})
