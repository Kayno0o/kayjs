import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection, reference } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { activityOf } from '../src/activity'
import { hiddenOf } from '../src/hidden'
import { sqliteLoader } from '../src/loaders/sqlite'
import { restoreTrashed } from '../src/restore'
import { activityScreen } from '../src/screens'
import { configure } from '../src/settings'
import { deleteEntry, publishEntry, renameEntry, saveEntry } from '../src/store'
import { trashOf } from '../src/trash'

const schema = s.Object({ title: s.String(), draft: s.Optional(s.Boolean()) })
let count = 0
let restore: ReturnType<typeof registerCollections>

function sites(): void {
  const table = `activity_${++count}`
  const make = (name: string): [string, ReturnType<typeof collection>] => [name, collection(sqliteLoader({ name, database: ':memory:', table: `${table}_${name}` }), { schema, draft: 'draft' })]

  restore = registerCollections([make('notes'), make('posts'), ['plain', collection({ name: 'plain', load: () => [{ slug: 'a', data: { title: 'A' } }], save: () => undefined }, { schema })]])
}

beforeEach(() => {
  configure({})
})

afterEach(() => {
  registerCollections(restore)
})

const ref = { collection: 'notes', slug: 'first' }
const ada = { name: 'Ada', email: 'ada@example.com' }

describe('activity', () => {
  test('lists who saved, published, deleted, restored and renamed what, newest first', async () => {
    sites()
    await saveEntry({ ...ref, data: { title: 'One', draft: true } }, { create: true, author: ada })
    await saveEntry({ ...ref, data: { title: 'Two', draft: true } })
    await publishEntry(ref, ada)
    await renameEntry(ref, 'second', { author: ada })
    await deleteEntry({ ...ref, slug: 'second' }, ada)
    await restoreTrashed('notes', (await trashOf('notes'))[0]!.id, ada)

    expect((await activityOf('notes')).map(event => [event.verb, event.slug, event.from, event.author])).toEqual([
      ['restore', 'second', undefined, 'Ada'],
      ['delete', 'second', undefined, 'Ada'],
      ['rename', 'second', 'first', 'Ada'],
      ['publish', 'first', undefined, 'Ada'],
      ['update', 'first', undefined, undefined],
      ['add', 'first', undefined, 'Ada'],
    ])
  })

  test('keeps nothing for a reorder, a folder collection, a collection that opts out or when the history is off', async () => {
    sites()
    configure({ collections: { posts: { history: false } } })
    await saveEntry({ collection: 'posts', slug: 'a', data: { title: 'A' } }, { create: true })
    await saveEntry({ collection: 'plain', slug: 'a', data: { title: 'B' } })
    expect(await activityOf('posts')).toEqual([])
    expect(await activityOf('plain')).toEqual([])
    expect((await activityScreen(1))?.rows).toEqual([])

    configure({ history: false })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    expect(await activityOf('notes')).toEqual([])
    expect(await activityScreen(1)).toBeUndefined()
  })

  test('is one screen over the collections, paged', async () => {
    sites()
    configure({ pageSize: 2 })
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ collection: 'posts', slug: 'p', data: { title: 'P' } }, { create: true })
    await saveEntry({ ...ref, data: { title: 'Two' } })

    const first = await activityScreen(1)
    const last = await activityScreen(2)

    expect([first?.pages, first?.rows.map(row => [row.title, row.verb])]).toEqual([2, [['Notes', 'update'], ['Posts', 'add']]])
    expect(last?.rows.map(row => [row.title, row.verb, row.href])).toEqual([['Notes', 'add', '/admin/collections/notes/first']])
    expect((await activityScreen(9))?.page).toBe(2)
  })

  test('links no screen for a deleted entry', async () => {
    sites()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref)
    expect((await activityScreen(1))?.rows.map(row => [row.verb, row.href])).toEqual([['delete', undefined], ['add', undefined]])
  })

  test('links a row only while its entry holds that slug', async () => {
    sites()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await renameEntry(ref, 'second')

    const hrefs = async () => (await activityScreen(1))?.rows.map(row => [row.verb, row.slug, row.href])

    // The add row names a slug the entry no longer holds.
    expect(await hrefs()).toEqual([['rename', 'second', '/admin/collections/notes/second'], ['add', 'first', undefined]])

    await deleteEntry({ ...ref, slug: 'second' })
    // In the trash, nothing is at either slug.
    expect(await hrefs()).toEqual([['delete', 'second', undefined], ['rename', 'second', undefined], ['add', 'first', undefined]])

    await restoreTrashed('notes', (await trashOf('notes'))[0]!.id)
    expect(await hrefs()).toEqual([['restore', 'second', '/admin/collections/notes/second'], ['delete', 'second', '/admin/collections/notes/second'], ['rename', 'second', '/admin/collections/notes/second'], ['add', 'first', undefined]])
  })

  test('records the rename above the updates it caused to the entries naming it', async () => {
    restore = registerCollections([
      ['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table: `activity_${++count}_n` }), { schema, draft: 'draft' })],
      ['posts', collection(sqliteLoader({ name: 'posts', database: ':memory:', table: `activity_${count}_p` }), { schema: s.Object({ title: s.String(), note: reference('notes') }) })],
    ])
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await saveEntry({ collection: 'posts', slug: 'p', data: { title: 'P', note: 'first' } }, { create: true })
    await renameEntry(ref, 'second')
    expect((await activityScreen(1))?.rows.slice(0, 2).map(row => [row.collection, row.verb])).toEqual([['posts', 'update'], ['notes', 'rename']])
  })

  test('keeps the last 500 events of a collection, trimming once read', async () => {
    sites()
    await saveEntry({ ...ref, data: { title: '0' } }, { create: true })

    for (let n = 1; n <= 504; n++)
      await saveEntry({ ...ref, data: { title: String(n) } })

    const stored = async () => (await hiddenOf('notes', 'activity')!.load({ preview: true })).length

    expect(await stored()).toBe(505)

    const hidden = hiddenOf('notes', 'activity')!
    const remove = hidden.remove!
    let removals = 0

    hidden.remove = async (...args) => {
      removals++
      await remove.apply(hidden, args)
    }
    // Two reads over the cap trim the same rows once.
    expect((await Promise.all([activityOf('notes'), activityOf('notes')])).map(events => events.length)).toEqual([500, 500])
    await Bun.sleep(100)
    expect(removals).toBe(5)
    expect(await stored()).toBe(500)
  })

  test('skips rows another kind left in the same store, and the trash skips the activity', async () => {
    const store = new Map<string, { slug: string, data: unknown, body?: string | undefined }>()
    const inner = sqliteLoader({ name: 'notes', database: ':memory:', table: `activity_${++count}_mixed` })

    restore = registerCollections([['notes', collection({ ...inner, sibling: (kind) => {
      return kind === 'history'
        ? sqliteLoader({ name: 'notes', database: ':memory:', table: `activity_${count}_h` })
        : {
          name: 'mixed',
          load: () => [...store.values()],
          get: (place: string) => store.get(place),
          save: (entry: { slug: string, data: unknown, body?: string | undefined }) => void store.set(entry.slug, entry),
          remove: ({ slug }: { slug: string }) => void store.delete(slug),
        }
    } }, { schema })]])
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    expect(await trashOf('notes')).toEqual([])
    await deleteEntry(ref)
    expect((await trashOf('notes')).map(item => item.slug)).toEqual(['first'])
    expect((await activityOf('notes')).map(event => event.verb)).toEqual(['delete', 'add'])
  })
})
