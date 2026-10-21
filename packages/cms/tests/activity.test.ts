import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { activityOf } from '../src/activity'
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
    expect((await activityScreen(1))?.rows.map(row => [row.verb, row.href])).toEqual([['delete', undefined], ['add', '/admin/collections/notes/first']])
  })
})
