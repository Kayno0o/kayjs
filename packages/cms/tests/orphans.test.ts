import type * as Content from '../src/kay/content'
import type { CollectionInfo, SourceEntry } from '../src/kay/contract'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test'
import { files, memoryFiles } from 'kay/server'
import { scratchDir } from 'kay/test'
import { encodePng } from '../../../src/server/png'
import { setupStorage } from '../../../src/server/storage'

const shape = { schema: { type: 'object' }, components: [], localized: false } satisfies Omit<CollectionInfo, 'name' | 'kind'>
const posts: CollectionInfo = { ...shape, name: 'posts', kind: 'folder', localized: true }
const products: CollectionInfo = { ...shape, name: 'products', kind: 'loaded' }

let listed: CollectionInfo[]
let stored: Record<string, SourceEntry[]>
let infoCalls: unknown[]
let reads: string[]

const content: Partial<typeof Content> = {
  ...await import('kay/content'),
  collections: async (options) => {
    infoCalls.push(options)

    return listed
  },
  entries: async (collection) => {
    reads.push(collection)

    const entries = stored[collection]

    if (!entries)
      throw new Error('the database is down')

    return entries
  },
}

void mock.module('../src/kay/content', () => content)

const { deleteUnusedUploads, libraryUploads, unusedUploads } = await import('../src/orphans')
const { mediaIndex, storeUpload } = await import('../src/media')

const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
const upload = async (folder: string) => files.put(new File([PIXEL], 'pixel.png', { type: 'image/png' }), { folder })
const DAY = 24 * 60 * 60 * 1000
// Time moves on, so what was just uploaded is old enough to be listed.
const aged = () => setSystemTime(new Date(Date.now() + 2 * DAY))
const entry = (slug: string, data: SourceEntry['data'], extra: Partial<SourceEntry> = {}): SourceEntry => ({ slug, data, draft: false, ...extra })

async function unusedKeys(): Promise<string[]> {
  const scan = await unusedUploads()

  if ('blocked' in scan)
    throw new Error(scan.blocked.join('; '))

  return scan.unused.map(found => found.key)
}

afterEach(() => {
  setSystemTime()
})

beforeEach(async () => {
  setupStorage(memoryFiles(), '/nonexistent', undefined)
  listed = [posts, products]
  infoCalls = []
  reads = []
  stored = { posts: [], products: [] }
})

test('lists the uploads of the collections\' folders that no entry mentions, whatever the URL around the key', async () => {
  const [inData, inBody, inLocale, inDraft, onCdn, unused, bigint] = await Promise.all(Array.from({ length: 7 }, async () => upload('posts')))
  const elsewhere = await upload('avatars')
  const nested = await upload('posts/2026')
  const privateKey = await files.put(new File([PIXEL], 'pixel.png', { type: 'image/png' }), { private: true })

  stored = {
    posts: [
      entry('a', { photo: files.url(inData!), nested: { gallery: [{ src: `/base${files.url(onCdn!)}?x=1` }] } }, { body: `![](${files.url(inBody!)})` }),
      entry('b', { photo: files.url(inLocale!) }, { locale: 'fr' }),
      entry('c', { photo: files.url(inDraft!) }, { draft: true }),
      entry('d', { count: 1n as unknown as number, note: `https://CDN.example/${bigint!.toUpperCase()}` }),
    ],
    products: [],
  }

  aged()
  expect(await unusedKeys()).toEqual([unused!])
  expect(await unusedKeys()).not.toContain(nested)
  expect(await unusedKeys()).not.toContain(elsewhere)
  expect(await unusedKeys()).not.toContain(privateKey)
})

test('lists a loaded collection\'s uploads too, and the variants an unused one has', async () => {
  const kept = await upload('products')
  const stray = await upload('products')

  stored = { posts: [], products: [entry('mug', { photo: files.url(kept) })] }

  aged()
  expect(await unusedUploads()).toEqual({ unused: [{ key: stray, url: files.url(stray), variants: [] }] })
})

test('shows the variants an unused upload has, read from the variants directory once', async () => {
  const variants = await scratchDir('variants-')

  setupStorage(memoryFiles(), '/nonexistent', variants)

  const stray = await upload('posts')
  const other = await upload('posts')

  try {
    await writeFile(join(variants, `stored-${Bun.hash(stray).toString(36)}-abc-640.webp`), 'x')
    await writeFile(join(variants, `stored-${Bun.hash(stray).toString(36)}-card-def.jpg`), 'x')
    aged()

    const scan = await unusedUploads()

    expect('unused' in scan && scan.unused.find(found => found.key === stray)?.variants).toHaveLength(2)
    expect('unused' in scan && scan.unused.find(found => found.key === other)?.variants).toEqual([])
  }
  finally {
    await rm(variants, { recursive: true, force: true })
  }
})

test('holds back an upload under a day old, and one the store gives no date', async () => {
  const fresh = await upload('posts')

  expect(await unusedKeys()).toEqual([])
  setSystemTime(new Date(Date.now() + DAY - 1000))
  expect(await unusedKeys()).toEqual([])
  setSystemTime(new Date(Date.now() + 2000))
  expect(await unusedKeys()).toEqual([fresh])

  const store = memoryFiles()
  const undated = { ...store, list: async (prefix?: string) => (await store.list!(prefix)).map(({ key }) => ({ key })) }

  setSystemTime()
  setupStorage(undated, '/nonexistent', undefined)

  const old = await upload('posts')

  aged()
  expect(await unusedKeys()).toEqual([])
  expect(await deleteUnusedUploads([old])).toEqual({ deleted: [], kept: [old] })
})

test('lists nothing while a collection or an entry cannot be read, since it may use any upload', async () => {
  await upload('posts')
  stored = { posts: [entry('broken', undefined, { problem: 'does not parse' })], products: [] }
  expect(await unusedUploads()).toEqual({ blocked: ['posts/broken does not parse'] })

  stored = { posts: [] }
  expect(await unusedUploads()).toEqual({ blocked: ['products cannot be read'] })
})

test('deletes only the uploads still unused, and refuses to delete while the entries cannot be read', async () => {
  const stray = await upload('posts')
  const used = await upload('posts')
  const elsewhere = await upload('avatars')

  aged()
  const nested = await upload('posts/2026')

  stored = { posts: [entry('a', { photo: files.url(used) })], products: [] }

  expect(await deleteUnusedUploads([stray, used, elsewhere, 'posts/0123456789abcdef0123.png', stray])).toEqual({ deleted: [stray], kept: [used, elsewhere, 'posts/0123456789abcdef0123.png'] })
  expect((await files.list()).map(file => file.key).toSorted()).toEqual([elsewhere, nested, used].toSorted())

  stored = { posts: [] }
  expect(await deleteUnusedUploads([used])).toEqual({ blocked: ['products cannot be read'] })
  expect(await files.get(used)).toBeDefined()
})

test('refuses to delete uploads where the app gave cms() no guard', async () => {
  const { configure } = await import('../src/settings')
  const { default: filesApi } = await import('../src/api/files')
  const stray = await upload('posts')

  aged()
  configure({})

  const response = await filesApi.handle(new Request('http://site.test/unused/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: [stray] }) }))

  expect(response.status).toBe(403)
  expect(await files.get(stray)).toBeDefined()
})

test('scans each collection once to delete any number of uploads, listing the collections without their counts', async () => {
  const uploads = await Promise.all(Array.from({ length: 5 }, async () => upload('posts')))

  aged()
  stored = { posts: [], products: [] }
  reads = []

  expect((await deleteUnusedUploads(uploads) as { deleted: string[] }).deleted.toSorted()).toEqual(uploads.toSorted())
  expect(reads).toEqual(['posts', 'products'])
  expect(infoCalls).toEqual([{ counts: false }])
})

test('lists a coloured upload by its key id, used or not', async () => {
  const opaque = () => new File([new Uint8Array(encodePng(new Uint8Array(4 * 4).fill(255), 2, 2))], 'flat.png', { type: 'image/png' })
  const used = await files.put(opaque(), { folder: 'posts' })
  const stray = await files.put(opaque(), { folder: 'posts' })

  expect(used).toMatch(/\.2x2-ffffff\.png$/)
  stored = { posts: [entry('a', { photo: files.url(used) })], products: [] }
  aged()
  expect(await unusedKeys()).toEqual([stray])
})

test('the library lists every upload with the entries using it, its record and whether it may be deleted', async () => {
  const shared = await storeUpload(new File([PIXEL], 'team.png', { type: 'image/png' }), 'Ada')
  const legacy = await upload('posts')

  stored = { posts: [entry('a', { photo: files.url(shared) }), entry('b', {}, { body: `![](${files.url(shared)})` })], products: [] }

  const fresh = await libraryUploads()

  if ('blocked' in fresh)
    throw new Error(fresh.blocked.join('; '))

  expect(fresh.uploads.map(found => found.key).toSorted()).toEqual([shared, legacy].toSorted())
  expect(fresh.uploads.find(found => found.key === shared)).toMatchObject({ name: 'team.png', by: 'Ada', size: PIXEL.length, width: 1, height: 1, usedIn: [{ collection: 'posts', slug: 'a' }, { collection: 'posts', slug: 'b' }], deletable: false })
  expect(fresh.uploads.find(found => found.key === legacy)).toMatchObject({ name: legacy.split('/').at(-1), size: PIXEL.length, usedIn: [], deletable: false })

  aged()

  const old = await libraryUploads()

  expect('uploads' in old && old.uploads.filter(found => found.deletable).map(found => found.key)).toEqual([legacy])

  stored = { posts: [] }
  expect(await libraryUploads()).toEqual({ blocked: ['products cannot be read'] })
})

test('the shared folder\'s uploads are listed when unused, kept when an entry mentions them, and deleting one drops its record', async () => {
  const kept = await storeUpload(new File([PIXEL], 'kept.png', { type: 'image/png' }))
  const stray = await storeUpload(new File([PIXEL, new Uint8Array([9])], 'stray.png', { type: 'image/png' }))

  stored = { posts: [entry('a', { photo: files.url(kept) })], products: [] }
  aged()
  expect(await unusedKeys()).toEqual([stray])
  expect(await deleteUnusedUploads([kept, stray])).toEqual({ deleted: [stray], kept: [kept] })
  expect(Object.keys(await mediaIndex())).toEqual([kept])
})

test('the library pages its uploads, newest first, keeps a search to the page it fills and reads the size of an upload with no record', async () => {
  const legacy = await upload('posts')

  for (let i = 0; i < 49; i++)
    await storeUpload(new File([PIXEL, new Uint8Array([i + 1])], `photo ${i}.png`, { type: 'image/png' }))

  const first = await libraryUploads()
  const second = await libraryUploads({ page: 2 })
  const beyond = await libraryUploads({ page: 99 })

  if ('blocked' in first || 'blocked' in second || 'blocked' in beyond)
    throw new Error('blocked')

  expect([first.uploads.length, first.pages, first.total, second.uploads.length, second.page, beyond.page]).toEqual([48, 2, 50, 2, 2, 2])
  expect(new Set([...first.uploads, ...second.uploads].map(found => found.key)).size).toBe(50)
  expect([...first.uploads, ...second.uploads].find(found => found.key === legacy)?.size).toBe(PIXEL.length)

  const found = await libraryUploads({ q: 'PHOTO 7' })

  expect('uploads' in found && found.uploads.map(each => each.name)).toEqual(['photo 7.png'])
})
