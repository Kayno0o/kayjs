import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { activityOf } from '../src/activity'
import { hiddenOf } from '../src/hidden'
import { sqliteLoader } from '../src/loaders/sqlite'
import { eraseHistory, forgetEditor, sweepHistory } from '../src/retention'
import { revisionsOf } from '../src/revisions'
import { configure } from '../src/settings'
import { deleteEntry, saveEntry } from '../src/store'
import { trashOf } from '../src/trash'

const schema = s.Object({ title: s.String() })
const DAY = 24 * 60 * 60 * 1000
const ref = { collection: 'notes', slug: 'first' }
const ada = { name: 'Ada', email: 'ada@example.com' }
let count = 0
let restore: ReturnType<typeof registerCollections>

function notes(): void {
  restore = registerCollections([['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table: `notes_${++count}` }), { schema })]])
}

async function rowCount(kind: 'history' | 'trash' | 'activity'): Promise<number> {
  return (await hiddenOf('notes', kind, { anyway: true })!.load({ preview: true })).length
}

beforeEach(() => {
  configure({})
  notes()
})

afterEach(() => {
  setSystemTime()
  registerCollections(restore)
})

describe('sweepHistory', () => {
  test('empties the trash of what expired without the trash screen being opened', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref, ada)
    expect(await rowCount('trash')).toBe(1)

    setSystemTime(new Date(Date.now() + 31 * DAY))
    await sweepHistory()
    expect(await rowCount('trash')).toBe(0)
  })

  test('drops revisions and activity older than a year, keeping the newest revision', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true, author: ada })
    await saveEntry({ ...ref, data: { title: 'Two' } }, { author: ada })

    setSystemTime(new Date(Date.now() + 400 * DAY))
    await saveEntry({ ...ref, data: { title: 'Three' } }, { author: ada })
    await sweepHistory()

    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['Three'])
    expect((await activityOf('notes')).map(event => event.verb)).toEqual(['update'])
  })

  test('keeps the newest revision of an entry nobody has saved for years', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })
    setSystemTime(new Date(Date.now() + 800 * DAY))
    await sweepHistory()

    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['Two'])
    expect(await activityOf('notes')).toEqual([])
  })

  test('drops a revision a save left out of its index', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })

    const history = hiddenOf('notes', 'history', { anyway: true })!
    const place = (await history.load({ preview: true })).find(row => !row.slug.includes('\u0001'))!.slug

    await history.save!({ slug: `${place}\u00011000`, data: { verb: 'update', title: 'Lost' } })
    setSystemTime(new Date(Date.now() + 400 * DAY))
    await saveEntry({ ...ref, data: { title: 'Three' } })
    await sweepHistory()

    expect((await history.load({ preview: true })).some(row => row.slug.endsWith('\u00011000'))).toBe(false)
  })

  test('keeps everything when maxAge is false', async () => {
    configure({ history: { maxAge: false } })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })
    setSystemTime(new Date(Date.now() + 800 * DAY))
    await sweepHistory()

    expect(await revisionsOf(ref)).toHaveLength(2)
    expect(await activityOf('notes')).toHaveLength(2)
  })

  test('takes a duration for maxAge and refuses nonsense', () => {
    expect(() => configure({ history: { maxAge: '90d' } })).not.toThrow()
    expect(() => configure({ history: { maxAge: 'soon' as never } })).toThrow()
  })
})

describe('eraseHistory', () => {
  test('removes an entry from the trash, the revisions and the activity log, and nobody else\'s', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true, author: ada })
    await saveEntry({ ...ref, slug: 'other', data: { title: 'Other' } }, { create: true })
    await deleteEntry(ref, ada)

    expect(await eraseHistory(ref)).toBeGreaterThan(0)
    expect(await trashOf('notes')).toEqual([])
    expect(await revisionsOf(ref)).toEqual([])
    expect((await activityOf('notes')).map(event => event.slug)).toEqual(['other'])
    expect(await revisionsOf({ ...ref, slug: 'other' })).toHaveLength(1)
  })

  test('keeps the history of a new entry that took the slug', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref)
    await saveEntry({ ...ref, data: { title: 'Again' } }, { create: true })

    await eraseHistory(ref)
    expect(await trashOf('notes')).toEqual([])
    expect(await revisionsOf(ref)).toHaveLength(1)
    expect((await activityOf('notes')).map(event => event.slug)).toContain('first')
  })

  test('reaches what a history turned off left in the store', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref)
    configure({ history: false })

    expect(await eraseHistory(ref)).toBeGreaterThan(0)
    expect(await rowCount('trash')).toBe(0)
    expect(await rowCount('history')).toBe(0)
    expect(await rowCount('activity')).toBe(0)
  })
})

describe('forgetEditor', () => {
  test('rewrites an editor\'s name in the trash, the revisions and the activity log, and leaves the others', async () => {
    const grace = { name: 'Grace', email: 'grace@example.com' }

    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true, author: ada })
    await saveEntry({ ...ref, data: { title: 'Two' } }, { author: grace })
    await deleteEntry(ref, ada)

    expect(await forgetEditor('Ada')).toBeGreaterThanOrEqual(3)
    expect((await trashOf('notes')).map(item => item.author)).toEqual(['Former editor'])
    expect((await revisionsOf(ref)).map(revision => revision.author)).toEqual(['Former editor', 'Grace'])
    expect((await activityOf('notes')).map(event => event.author).toSorted()).toEqual(['Former editor', 'Former editor', 'Grace'])
    expect(await forgetEditor('Ada')).toBe(0)
  })

  test('leaves a row of another kind with an author field alone', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true, author: ada })

    const stray = { slug: 'stray', data: { author: 'Ada', title: 'Blog' } }

    await hiddenOf('notes', 'history', { anyway: true })!.save!(stray)
    await hiddenOf('notes', 'trash', { anyway: true })!.save!(stray)
    await hiddenOf('notes', 'activity', { anyway: true })!.save!(stray)

    await forgetEditor('Ada')

    for (const kind of ['history', 'trash', 'activity'] as const) {
      const row = (await hiddenOf('notes', kind, { anyway: true })!.load({ preview: true })).find(item => item.slug === 'stray')

      expect((row!.data as { author: string }).author).toBe('Ada')
    }
  })
})
