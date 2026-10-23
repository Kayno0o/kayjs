import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { activityOf } from '../src/activity'
import * as activity from '../src/activity'
import { hiddenOf, SWEEP_MARKER } from '../src/hidden'
import { sqliteLoader } from '../src/loaders/sqlite'
import { restoreTrashed } from '../src/restore'
import { eraseHistory, forgetEditor, startSweeping, sweepHistory } from '../src/retention'
import * as revisions from '../src/revisions'
import { revisionsOf } from '../src/revisions'
import { configure } from '../src/settings'
import { deleteEntry, saveEntry } from '../src/store'
import * as trash from '../src/trash'
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
  return (await hiddenOf('notes', kind, { anyway: true })!.load({ preview: true })).filter(row => !row.slug.startsWith('\u0002')).length
}

// How many times the trash and the activity log were read from now on.
function spyOnLoads(): () => { trash: number, activity: number } {
  const reads = { trash: 0, activity: 0 }

  for (const kind of ['trash', 'activity'] as const) {
    const hidden = hiddenOf('notes', kind, { anyway: true })!
    const load = hidden.load.bind(hidden)

    hidden.load = async (context) => {
      reads[kind]++

      return load(context)
    }
  }

  return () => ({ ...reads })
}

beforeEach(() => {
  configure({})
  notes()
})

afterEach(() => {
  mock.restore()
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

  test('reads only the indexes of the entries it holds on a light sweep, so a revision left out of an index waits for the full one', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })

    const history = hiddenOf('notes', 'history', { anyway: true })!
    const place = (await history.load({ preview: true })).find(row => !row.slug.includes('\u0001'))!.slug

    await history.save!({ slug: `${place}\u00011000`, data: { verb: 'update', title: 'Lost' } })
    setSystemTime(new Date(Date.now() + 400 * DAY))
    await saveEntry({ ...ref, data: { title: 'Three' } })

    await sweepHistory({ full: false })
    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['Three'])
    expect((await history.load({ preview: true })).some(row => row.slug.endsWith('\u00011000'))).toBe(true)
    await sweepHistory()
    expect((await history.load({ preview: true })).some(row => row.slug.endsWith('\u00011000'))).toBe(false)
  })

  test('sweeps the revisions of an entry in the trash on a light sweep too', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })
    await saveEntry({ ...ref, data: { title: 'Three' } })
    await deleteEntry(ref, ada)
    configure({ history: { trash: '800d' } })
    setSystemTime(new Date(Date.now() + 400 * DAY))
    await sweepHistory({ full: false })

    expect(await rowCount('trash')).toBe(1)
    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['Three'])
  })

  test('reads neither the activity nor a row of the trash on a light sweep before a row of theirs can expire, also the first after a restart', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true, author: ada })
    await deleteEntry(ref, ada)
    await sweepHistory()

    const loads = spyOnLoads()

    // Another process, a restart: the sweep knows only what the history store marked.
    await sweepHistory()
    await sweepHistory({ full: false })
    expect(loads()).toEqual({ trash: 0, activity: 0 })
    expect(await rowCount('trash')).toBe(1)
  })

  test('reads the trash and the activity on a light sweep once a row of theirs can have expired, and when the trash changed', async () => {
    configure({ history: { trash: '2h' } })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref, ada)
    await sweepHistory()

    const loads = spyOnLoads()

    await saveEntry({ ...ref, slug: 'second', data: { title: 'Two' } }, { create: true })
    await deleteEntry({ ...ref, slug: 'second' }, ada)
    await sweepHistory()
    expect(loads().trash).toBeGreaterThan(0)
    expect(await rowCount('trash')).toBe(2)

    setSystemTime(new Date(Date.now() + 3 * 60 * 60 * 1000))
    await sweepHistory()
    expect(await rowCount('trash')).toBe(0)
  })

  test('reads every history row once a day, whichever process swept last', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })
    await sweepHistory()

    const history = hiddenOf('notes', 'history', { anyway: true })!
    const place = (await history.load({ preview: true })).find(row => !row.slug.includes('\u0001') && Array.isArray((row.data as { ats?: unknown }).ats))!.slug

    await history.save!({ slug: `${place}\u00011000`, data: { verb: 'update', title: 'Lost' } })
    setSystemTime(new Date(Date.now() + 60 * 60 * 1000))
    await sweepHistory()
    expect((await history.load({ preview: true })).some(row => row.slug.endsWith('\u00011000'))).toBe(true)
    setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000))
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

async function marker(): Promise<{ full: number, trash?: { places: string[], rev: string }, activity?: { oldest: number } } | undefined> {
  const row = (await hiddenOf('notes', 'history', { anyway: true })!.load({ preview: true })).find(found => found.slug === SWEEP_MARKER)

  return row?.data as never
}

describe('the sweep marker', () => {
  test('keeps a light sweep from skipping the trash at the edge of the clock skew', async () => {
    configure({ history: { trash: '2h' } })

    const start = Date.now()

    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref, ada)
    await sweepHistory()

    const loads = spyOnLoads()

    // The trashed row is two hours old minus the skew: the sweep still leaves the purge alone.
    setSystemTime(new Date(start + 2 * 60 * 60 * 1000 - 60 * 1000))
    await sweepHistory({ full: false })
    expect(loads().trash).toBe(0)

    setSystemTime(new Date(start + 2 * 60 * 60 * 1000 - 60 * 1000 + 100))
    await sweepHistory({ full: false })
    expect(loads().trash).toBe(1)
  })

  test('prunes the revisions of an entry trashed while another left the trash, the count staying the same', async () => {
    configure({ history: { trash: '800d' } })

    for (const slug of ['one', 'two']) {
      await saveEntry({ collection: 'notes', slug, data: { title: 'A' } }, { create: true })
      await saveEntry({ collection: 'notes', slug, data: { title: 'B' } })
    }

    await deleteEntry({ collection: 'notes', slug: 'one' }, ada)
    await sweepHistory()
    setSystemTime(new Date(Date.now() + 400 * DAY))
    await sweepHistory({ full: false })

    // The entry in the trash is restored while the other is deleted: still one row.
    const [item] = await trashOf('notes')

    await restoreTrashed('notes', item!.id)
    await deleteEntry({ collection: 'notes', slug: 'two' }, ada)
    expect(await rowCount('trash')).toBe(1)
    await sweepHistory({ full: false })

    expect((await revisionsOf({ collection: 'notes', slug: 'two' })).map(revision => revision.data.title)).toEqual(['B'])
  })

  test('does not advance the day of the last full sweep when pruning the revisions failed', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })

    const prune = spyOn(revisions, 'pruneRevisions').mockResolvedValue(false)

    await sweepHistory()
    expect((await marker())?.full).toBe(0)
    prune.mockRestore()
    await sweepHistory()
    expect((await marker())?.full).toBeGreaterThan(0)
  })

  test('keeps the places it read when a light sweep could not purge the trash', async () => {
    configure({ history: { trash: '800d' } })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })
    await saveEntry({ ...ref, data: { title: 'Three' } })
    await deleteEntry(ref, ada)
    await sweepHistory()

    setSystemTime(new Date(Date.now() + 400 * DAY))
    await saveEntry({ ...ref, slug: 'second', data: { title: 'Other' } }, { create: true })
    await deleteEntry({ ...ref, slug: 'second' }, ada)
    spyOn(trash, 'purge').mockResolvedValue(undefined)
    await sweepHistory({ full: false })

    expect((await revisionsOf(ref)).map(revision => revision.data.title)).toEqual(['Three'])
    expect((await marker())?.trash?.places).toHaveLength(1)
  })

  test('leaves the activity unmarked when pruning it answered nothing', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    spyOn(activity, 'pruneActivity').mockResolvedValue(undefined)
    await sweepHistory()

    expect((await marker())?.activity).toBeUndefined()
  })

  test('writes no marker with the history off, and none for activity or the trash without a maxAge or a trash', async () => {
    configure({ history: false })
    await sweepHistory()
    expect(await marker()).toBeUndefined()

    configure({ history: { maxAge: false, trash: false } })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await sweepHistory()
    expect(await marker()).toEqual({ full: expect.any(Number) } as never)
  })

  test('is not an entry, an erasure nor an editor', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true, author: ada })
    await deleteEntry(ref, ada)
    await sweepHistory()

    const before = await marker()

    expect(before).toBeDefined()
    expect(await eraseHistory(ref)).toBeGreaterThan(0)
    expect(await forgetEditor('Ada')).toBeGreaterThanOrEqual(0)
    expect(await marker()).toEqual(before as never)
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

describe('startSweeping', () => {
  test('leaves the first sweep for later, so it is not on the boot path', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref, ada)
    setSystemTime(new Date(Date.now() + 31 * DAY))
    startSweeping()
    await Bun.sleep(30)

    expect(await rowCount('trash')).toBe(1)
  })
})

describe('the trash revision row', () => {
  test('is no trashed entry to restore', async () => {
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref, ada)
    expect(await trash.trashed('notes', '\u0002rev')).toBeUndefined()
  })
})
