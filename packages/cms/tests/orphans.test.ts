import type * as Content from '../src/kay/content'
import type { CollectionInfo, SourceEntry } from '../src/kay/contract'
import { beforeEach, expect, mock, test } from 'bun:test'
import { files } from 'kay/server'

const shape = { schema: { type: 'object' }, components: [], localized: false } satisfies Omit<CollectionInfo, 'name' | 'kind'>
const posts: CollectionInfo = { ...shape, name: 'posts', kind: 'folder', localized: true }
const products: CollectionInfo = { ...shape, name: 'products', kind: 'loaded' }

let listed: CollectionInfo[]
let stored: Record<string, SourceEntry[]>

const content: Partial<typeof Content> = {
  collections: async () => listed,
  entries: async (collection) => {
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
const entry = (slug: string, data: SourceEntry['data'], extra: Partial<SourceEntry> = {}): SourceEntry => ({ slug, data, draft: false, ...extra })

async function unusedKeys(): Promise<string[]> {
  const scan = await unusedUploads()

  if ('blocked' in scan)
    throw new Error(scan.blocked.join('; '))

  return scan.unused.map(found => found.key)
}

beforeEach(async () => {
  listed = [posts, products]
  stored = { posts: [], products: [] }

  for (const key of await files.list())
    await files.delete(key)
})

test('lists the uploads of the collections\' folders that no entry mentions, whatever the URL around the key', async () => {
  const [inData, inBody, inLocale, inDraft, onCdn, unused, bigint] = await Promise.all(Array.from({ length: 7 }, async () => upload('posts')))
  const elsewhere = await upload('avatars')
  const privateKey = await files.put(new File([PIXEL], 'pixel.png', { type: 'image/png' }), { private: true })

  stored = {
    posts: [
      entry('a', { photo: files.url(inData!), nested: { gallery: [{ src: `/base${files.url(onCdn!)}?x=1` }] } }, { body: `![](${files.url(inBody!)})` }),
      entry('b', { photo: files.url(inLocale!) }, { locale: 'fr' }),
      entry('c', { photo: files.url(inDraft!) }, { draft: true }),
      entry('d', { count: 1n as unknown as number, note: `https://cdn.example/${bigint}` }),
    ],
    products: [],
  }

  expect(await unusedKeys()).toEqual([unused!])
  expect(await unusedKeys()).not.toContain(elsewhere)
  expect(await unusedKeys()).not.toContain(privateKey)
})

test('lists a loaded collection\'s uploads too, and the variants an unused one has', async () => {
  const kept = await upload('products')
  const stray = await upload('products')

  stored = { posts: [], products: [entry('mug', { photo: files.url(kept) })] }

  const scan = await unusedUploads()

  expect(scan).toEqual({ unused: [{ key: stray, url: files.url(stray), variants: [] }] })
})

test('lists nothing while a collection or an entry cannot be read, since it may use any upload', async () => {
  await upload('posts')
  stored = { posts: [entry('broken', undefined, { problem: 'does not parse' })], products: [] }
  expect(await unusedUploads()).toEqual({ blocked: ['posts/broken does not parse'] })

  stored = { posts: [] }
  expect(await unusedUploads()).toEqual({ blocked: ['products cannot be read'] })

  listed = [posts, { ...products, problem: 'failed to read' }]
  stored = { posts: [], products: [] }
  expect(await unusedUploads()).toEqual({ blocked: ['products cannot be read'] })
})

test('deletes only the uploads still unused, and refuses to delete while the entries cannot be read', async () => {
  const stray = await upload('posts')
  const used = await upload('posts')
  const elsewhere = await upload('avatars')

  stored = { posts: [entry('a', { photo: files.url(used) })], products: [] }

  expect(await deleteUnusedUploads([stray, used, elsewhere, 'posts/0123456789abcdef0123.png', stray])).toEqual({ deleted: [stray], kept: [used, elsewhere, 'posts/0123456789abcdef0123.png'] })
  expect((await files.list()).toSorted()).toEqual([elsewhere, used].toSorted())

  stored = { posts: [] }
  expect(await deleteUnusedUploads([used])).toEqual({ blocked: ['products cannot be read'] })
  expect(await files.get(used)).toBeDefined()
})
