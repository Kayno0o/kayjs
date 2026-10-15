import type * as Content from '../src/kay/content'
import type { CollectionInfo, SourceEntry } from '../src/kay/contract'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test'
import { files, memoryFiles } from 'kay/server'
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

const { deleteUnusedUploads, unusedUploads } = await import('../src/orphans')

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
  const variants = await mkdtemp(join(tmpdir(), 'kay-cms-variants-'))

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
