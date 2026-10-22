import { SQL } from 'bun'
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { pgLoader } from '../src/loaders/pg'
import { restoreRevision, restoreTrashed } from '../src/restore'
import { revisionsOf } from '../src/revisions'
import { configure } from '../src/settings'
import { deleteEntry, entryOf, saveEntry } from '../src/store'
import { trashOf } from '../src/trash'

// The same revision and trash flow as revisions.test.ts, on the loader that keeps hidden rows in Postgres, skipped without TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL ?? ''
const skip = url === ''
const admin = skip ? undefined : new SQL(Object.assign(new URL(url), { pathname: '/postgres' }).href)
const database = `kay_cms_history_${process.pid}`
const postgresTest = test.skipIf(skip)
const schema = s.Object({ title: s.String() })
const ref = { collection: 'notes', slug: 'first' }
let shared: SQL | undefined
let count = 0
let restore: ReturnType<typeof registerCollections> | undefined

if (admin !== undefined) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${database}`)
}

function notes(): void {
  shared ??= new SQL(Object.assign(new URL(url), { pathname: `/${database}` }).href, { max: 4 })
  restore = registerCollections([['notes', collection(pgLoader({ name: 'notes', sql: shared, table: `notes_${++count}` }), { schema })]])
}

beforeEach(() => {
  configure({})
})

afterEach(() => {
  if (restore !== undefined)
    registerCollections(restore)
})

afterAll(async () => {
  await shared?.close()
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin?.close()
})

describe('history on pgLoader', () => {
  postgresTest('keeps the last saves and restores one as a new save', async () => {
    notes()
    configure({ history: { revisions: 3 } })
    await saveEntry({ ...ref, data: { title: '0' } }, { create: true })

    for (let n = 1; n <= 4; n++)
      await saveEntry({ ...ref, data: { title: String(n) } })

    const revisions = await revisionsOf(ref)

    expect(revisions.map(revision => revision.data.title)).toEqual(['2', '3', '4'])
    expect(await restoreRevision(ref, revisions[0]!.at, undefined, { version: (await entryOf(ref))?.version })).toMatchObject({ saved: true })
    expect((await entryOf(ref))?.data).toEqual({ title: '2' })
    expect((await revisionsOf(ref)).map(revision => [revision.verb, revision.data.title])).toEqual([['update', '3'], ['update', '4'], ['restore', '2']])
  })

  postgresTest('keeps a deleted entry in the trash with its history, restores it, and drops what expired', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    expect(await deleteEntry(ref, { name: 'Ada', email: 'ada@example.com' })).toMatchObject({ saved: true })
    expect(await entryOf(ref)).toBeUndefined()

    const [item] = await trashOf('notes')

    expect(item).toMatchObject({ slug: 'first', author: 'Ada', data: { title: 'One' } })
    expect(await restoreTrashed('notes', item!.id)).toMatchObject({ saved: true })
    expect((await entryOf(ref))?.data).toEqual({ title: 'One' })
    expect(await trashOf('notes')).toEqual([])
    expect((await revisionsOf(ref)).map(revision => revision.verb)).toEqual(['add'])

    await deleteEntry(ref)

    const now = Date.now()
    const clock = spyOn(Date, 'now').mockReturnValue(now + 31 * 86_400_000)

    try {
      expect(await trashOf('notes')).toEqual([])
      expect(await revisionsOf(ref)).toEqual([])
    }
    finally {
      clock.mockRestore()
    }
  })

  postgresTest('a refused restore over a slug made since leaves it in the trash', async () => {
    notes()
    await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
    await deleteEntry(ref)
    await saveEntry({ ...ref, data: { title: 'New' } }, { create: true })

    const [item] = await trashOf('notes')

    expect(await restoreTrashed('notes', item!.id)).toHaveProperty('issues')
    expect(await trashOf('notes')).toHaveLength(1)
  })
})
