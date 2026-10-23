import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { files, memoryFiles } from 'kay/server'
import { registerCollections } from '../../../src/content/edit'
import { setupStorage } from '../../../src/server/storage'
import * as hidden from '../src/hidden'
import { sqliteLoader } from '../src/loaders/sqlite'
import { storeUpload } from '../src/media'
import { deleteUnusedUploads, libraryUploads, unusedUploads } from '../src/orphans'
import { restoreRevision, restoreTrashed } from '../src/restore'
import { revisionsOf } from '../src/revisions'
import { configure } from '../src/settings'
import { deleteEntry, entryOf, saveEntry } from '../src/store'
import { trashOf } from '../src/trash'

const schema = s.Object({ title: s.String(), photo: s.Optional(s.String()) })
const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
const DAY = 24 * 60 * 60 * 1000
const ref = { collection: 'notes', slug: 'first' }
let restore: ReturnType<typeof registerCollections>
let count = 0

const png = () => new File([PIXEL], 'pixel.png', { type: 'image/png' })
const aged = () => setSystemTime(new Date(Date.now() + 2 * DAY))

async function unusedKeys(): Promise<string[]> {
  const scan = await unusedUploads()

  if ('blocked' in scan)
    throw new Error(scan.blocked.join('; '))

  return scan.unused.map(found => found.key)
}

beforeEach(() => {
  setupStorage(memoryFiles(), '/nonexistent', undefined)
  configure({})
  restore = registerCollections([['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table: `notes_${++count}` }), { schema })]])
})

afterEach(() => {
  setSystemTime()
  registerCollections(restore)
})

test('keeps an upload that only a revision mentions, and a restored revision still serves its image', async () => {
  const key = await storeUpload(png())

  await saveEntry({ ...ref, data: { title: 'One', photo: files.url(key) } }, { create: true })
  await saveEntry({ ...ref, data: { title: 'Two' } })
  aged()

  expect(await unusedKeys()).toEqual([])
  expect(await deleteUnusedUploads([key])).toEqual({ deleted: [], kept: [key] })

  const first = (await revisionsOf(ref)).find(revision => revision.data.title === 'One')!

  expect(await restoreRevision(ref, first.at, undefined, { version: (await entryOf(ref))?.version })).toHaveProperty('saved', true)
  expect(await files.get(key)).toBeDefined()
  expect((await entryOf(ref))?.data).toMatchObject({ photo: files.url(key) })
})

test('keeps an upload that only a trashed entry mentions, until the trash lets it go', async () => {
  const key = await storeUpload(png())

  await saveEntry({ ...ref, data: { title: 'One', photo: files.url(key) } }, { create: true })
  expect(await deleteEntry(ref)).toHaveProperty('saved', true)
  aged()

  expect(await unusedKeys()).toEqual([])

  const library = await libraryUploads()

  expect('uploads' in library && library.uploads.find(upload => upload.key === key)).toMatchObject({ deletable: false, held: true })

  const [item] = await trashOf('notes')

  expect(await restoreTrashed('notes', item!.id)).toHaveProperty('saved', true)
  expect(await files.get(key)).toBeDefined()
})

test('lists an upload no entry, revision or trashed entry mentions', async () => {
  const stray = await storeUpload(png())

  aged()
  expect(await unusedKeys()).toEqual([stray])
})

test('sending the same bytes again refreshes the grace of an old upload', async () => {
  const key = await storeUpload(png())

  aged()
  expect(await unusedKeys()).toEqual([key])
  expect(await storeUpload(png())).toBe(key)
  expect(await unusedKeys()).toEqual([])
})

test('an unreadable history blocks the cleanup and makes the library delete nothing', async () => {
  await storeUpload(png())
  aged()

  const before = await libraryUploads()

  expect('uploads' in before && before.uploads.some(upload => upload.deletable && upload.held === false)).toBe(true)

  const spy = spyOn(hidden, 'hiddenOf').mockImplementation(() => ({ name: 'x', load: async () => {
    throw new Error('down')
  } }))

  try {
    expect('blocked' in await unusedUploads()).toBe(true)

    const library = await libraryUploads()

    expect('blocked' in library).toBe(false)
    expect('uploads' in library && library.uploads.length > 0 && library.uploads.every(upload => !upload.deletable && upload.held === undefined)).toBe(true)
  }
  finally {
    spy.mockRestore()
  }
})

test('does not take the sweep marker for a revision that holds an upload', async () => {
  const key = await storeUpload(png())

  await saveEntry({ ...ref, data: { title: 'One' } }, { create: true })
  await hidden.hiddenOf('notes', 'history')!.save!({ slug: hidden.SWEEP_MARKER, data: { full: 0, trash: { oldest: 0, slugs: '', places: [key] } } })
  aged()

  expect(await unusedKeys()).toEqual([key])
})
