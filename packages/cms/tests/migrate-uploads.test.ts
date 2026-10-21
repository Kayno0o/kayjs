import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { s } from 'kay'
import { blocks, collection } from 'kay/content'
import { files, memoryFiles } from 'kay/server'
import { scratchDir } from 'kay/test'
import { registerCollections, registerEditSite } from '../../../src/content/edit'
import { contentPlace, setContentPlace } from '../../../src/content/load'
import { encodePng } from '../../../src/server/png'
import { setupStorage } from '../../../src/server/storage'
import { SaveConflict, workingTree } from '../src/files'
import { sqliteLoader } from '../src/loaders/sqlite'
import { MEDIA_FOLDER, mediaIndex, renameUpload } from '../src/media'
import { migrateUploads } from '../src/migrate-uploads'
import { libraryUploads } from '../src/orphans'
import { configure } from '../src/settings'
import { entryOf, saveEntry } from '../src/store'

const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
const other = new Uint8Array(encodePng(new Uint8Array(4 * 4).fill(255), 2, 2))
const png = (bytes: Uint8Array<ArrayBuffer> = PIXEL) => new File([bytes], 'photo.png', { type: 'image/png' })
const schema = s.Object({ title: s.String(), photo: s.Optional(s.String()), gallery: s.Optional(s.Array(s.String())), sections: s.Optional(blocks({ image: s.Object({ src: s.String() }), text: s.Object({ body: s.String() }) })) })
let count = 0
let dir: string
let restore: ReturnType<typeof registerCollections>
const original = contentPlace()

beforeEach(async () => {
  dir = await scratchDir('migrate-uploads-')
  await mkdir(join(dir, 'posts'), { recursive: true })
  await mkdir(join(dir, 'pages/en'), { recursive: true })
  await mkdir(join(dir, 'pages/fr'), { recursive: true })
  setContentPlace(dir, dir)
  registerEditSite({ urls: async () => undefined, locales: ['en', 'fr'], defaultLocale: 'en' })
  setupStorage(memoryFiles(), '/nonexistent', undefined)
  restore = registerCollections([
    ['posts', collection(join(dir, 'posts'), { schema })],
    ['pages', collection(join(dir, 'pages'), { schema, localized: true })],
    ['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table: `notes_${++count}` }), { schema })],
  ])
  configure({ files: workingTree() })
})

afterEach(() => {
  registerCollections(restore)
  setContentPlace(original.root, original.base)
  registerEditSite(undefined)
})

const make = async (collectionName: string, slug: string, data: Record<string, unknown>, locale?: string, body?: string) => saveEntry({ collection: collectionName, slug, locale, data, body }, { create: true })
const dataOf = async (collectionName: string, slug: string, locale?: string) => (await entryOf({ collection: collectionName, slug, locale }))?.data

test('an upload named in a field, a list, a block, a body and a localized entry moves to the shared folder and every entry points at it', async () => {
  const old = await files.put(png(), { folder: 'posts' })

  await make('posts', 'a', { title: 'A', photo: files.url(old), gallery: [files.url(old), 'https://example.com/x.png'], sections: [{ type: 'image', src: files.url(old) }] }, undefined, `![](${files.url(old)})`)
  await make('pages', 'home', { title: 'Home', photo: `/blog${files.url(old)}` }, 'fr')

  const result = await migrateUploads()
  const key = (await files.list({ folder: MEDIA_FOLDER }))[0]!.key

  expect(result).toEqual({ moved: 1, pending: 0 })
  expect(key).toMatch(/^cms-media\/[\da-f]{20}\.1x1(?:-[\da-f]{6})?\.png$/)
  expect(await dataOf('posts', 'a')).toMatchObject({ photo: files.url(key), gallery: [files.url(key), 'https://example.com/x.png'], sections: [{ type: 'image', src: files.url(key) }] })
  expect((await entryOf({ collection: 'posts', slug: 'a' }))?.body).toContain(files.url(key))
  expect(await dataOf('pages', 'home', 'fr')).toMatchObject({ photo: `/blog${files.url(key)}` })
  expect(await files.get(old)).toBeDefined()
})

test('a rerun writes nothing, and the old file is hidden from the library while its copy shows with the name it was given', async () => {
  const old = await files.put(png(), { folder: 'posts' })

  await make('posts', 'a', { title: 'A', photo: files.url(old) })
  await renameUpload(old, 'Team.png')
  expect(await migrateUploads()).toEqual({ moved: 1, pending: 0 })

  const text = await Bun.file(join(dir, 'posts/a.json')).text()

  expect(await migrateUploads()).toEqual({ moved: 0, pending: 0 })
  expect(await Bun.file(join(dir, 'posts/a.json')).text()).toBe(text)

  const library = await libraryUploads()
  const key = (await files.list({ folder: MEDIA_FOLDER }))[0]!.key

  expect('uploads' in library && library.uploads.map(each => [each.key, each.name, each.usedIn.length])).toEqual([[key, 'Team.png', 1]])
  expect((await mediaIndex())[key]?.from).toEqual([old])
})

test('two older files with the same bytes become one copy, and a file two entries name is pointed at in both', async () => {
  const first = await files.put(png(), { folder: 'posts' })
  const second = await files.put(png(), { folder: 'pages' })
  const different = await files.put(png(other), { folder: 'posts' })

  await make('posts', 'a', { title: 'A', photo: files.url(first) })
  await make('posts', 'b', { title: 'B', photo: files.url(first), gallery: [files.url(different)] })
  await make('pages', 'c', { title: 'C', photo: files.url(second) }, 'en')

  expect(await migrateUploads()).toEqual({ moved: 3, pending: 0 })

  const copies = await files.list({ folder: MEDIA_FOLDER })

  expect(copies).toHaveLength(2)

  const a = (await dataOf('posts', 'a'))?.photo
  const c = (await dataOf('pages', 'c', 'en'))?.photo

  expect(a).toBe(c)
  expect((await dataOf('posts', 'b'))?.photo).toBe(a)
  expect(copies.map(copy => files.url(copy.key))).toContain(((await dataOf('posts', 'b'))?.gallery as string[])[0]!)
})

test('an upload no entry names stays where it is, and a loaded collection\'s entry is pointed too', async () => {
  const unused = await files.put(png(other), { folder: 'posts' })
  const used = await files.put(png(), { folder: 'notes' })

  await make('notes', 'n', { title: 'N', photo: files.url(used) })
  expect(await migrateUploads()).toEqual({ moved: 1, pending: 0 })
  expect(await files.get(unused)).toBeDefined()
  expect((await files.list({ folder: MEDIA_FOLDER })).map(file => files.url(file.key))).toEqual([(await dataOf('notes', 'n'))?.photo as string])
})

test('an entry changed since it was read keeps its older upload pending, and the next run finishes it', async () => {
  const old = await files.put(png(), { folder: 'posts' })

  await make('posts', 'a', { title: 'A', photo: files.url(old) })

  const saver = workingTree()
  let refuse = true

  configure({ files: { ...saver, save: async (change) => {
    if (refuse) {
      refuse = false

      throw new SaveConflict('0'.repeat(40))
    }

    return saver.save(change)
  } } })

  expect(await migrateUploads()).toEqual({ moved: 0, pending: 1 })
  expect((await dataOf('posts', 'a'))?.photo).toBe(files.url(old))
  expect(await libraryUploads()).toMatchObject({ total: 2 })
  expect(await migrateUploads()).toEqual({ moved: 1, pending: 0 })
  expect(await libraryUploads()).toMatchObject({ total: 1 })
})
