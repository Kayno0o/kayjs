import { expect, test } from 'bun:test'
import { files, memoryFiles } from 'kay/server'
import { setupStorage } from '../../../src/server/storage'
import { forgetUploads, isUploadKey, MEDIA_FOLDER, mediaIndex, NAME_LENGTH, renameUpload, storeUpload } from '../src/media'
import { uploadFolders } from '../src/uploads'

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
const png = (name: string) => new File([PNG], name, { type: 'image/png' })

test('a file sent twice is stored once under its hash, in the folder every collection shares', async () => {
  setupStorage(memoryFiles(), '.kay/cache')

  const first = await storeUpload(png('first.png'), 'Ada')
  const again = await storeUpload(png('copy.png'), 'Grace')

  expect(first).toMatch(new RegExp(`^${MEDIA_FOLDER}/[\\da-f]{20}\\.1x1(?:-[\\da-f]{6})?\\.png$`))
  expect(again).toBe(first)
  expect(await files.list({ folder: MEDIA_FOLDER })).toHaveLength(1)
  expect((await mediaIndex())[first]).toMatchObject({ name: 'first.png', by: 'Ada', size: PNG.length })
})

test('different bytes get different keys, and the index keeps every upload', async () => {
  setupStorage(memoryFiles(), '.kay/cache')

  const [a, b] = await Promise.all([storeUpload(png('a.png')), storeUpload(new File([new Uint8Array([...PNG, 0])], 'b.png', { type: 'image/png' }))])

  expect(a).not.toBe(b)
  expect(Object.keys(await mediaIndex()).toSorted()).toEqual([a, b].toSorted())
})

test('a rename changes the name shown, a legacy upload with no record included, and forgetting drops the record', async () => {
  setupStorage(memoryFiles(), '.kay/cache')

  const legacy = await files.put(png('old.png'), { folder: 'posts' })
  const key = await storeUpload(png('a.png'))

  expect(await renameUpload(key, 'Team photo.png')).toBe(true)
  expect(await renameUpload(legacy, 'Old.png')).toBe(true)
  expect(await renameUpload('posts/aaaaaaaaaaaaaaaaaaaa.png', 'None.png')).toBe(false)
  expect(await mediaIndex()).toMatchObject({ [key]: { name: 'Team photo.png' }, [legacy]: { name: 'Old.png' } })

  await forgetUploads([key])

  expect(Object.keys(await mediaIndex())).toEqual([legacy])
})

test('a collection looks in the shared folder first, then its own', () => {
  expect(uploadFolders('blog-posts')).toEqual([MEDIA_FOLDER, 'blog-posts'])
})

test('a failed read of the index never wipes the records on the next write', async () => {
  setupStorage(memoryFiles(), '.kay/cache')

  const key = await storeUpload(png('a.png'), 'Ada')
  const real = files.get.bind(files)

  files.get = async () => {
    throw new Error('storage is down')
  }

  try {
    expect(await mediaIndex()).toEqual({})
    await expect(renameUpload(key, 'b.png')).rejects.toThrow('storage is down')
  }
  finally {
    files.get = real
  }

  expect((await mediaIndex())[key]).toMatchObject({ name: 'a.png', by: 'Ada' })

  await files.put(new Blob(['not json'], { type: 'application/json' }), { private: true, id: 'cms-media-index' })
  await expect(storeUpload(png('c.png'))).resolves.toMatch(/^cms-media\//)
  expect(await (await files.get('private/cms-media-index.json'))?.text()).toBe('not json')
})

test('a long name is cut, and a collection named like the shared folder lists it once', async () => {
  setupStorage(memoryFiles(), '.kay/cache')

  const key = await storeUpload(png(`${'n'.repeat(500)}.png`))

  expect((await mediaIndex())[key]!.name).toHaveLength(NAME_LENGTH)
  expect(uploadFolders(MEDIA_FOLDER)).toEqual([MEDIA_FOLDER])
})

test('a missing or unreadable index reads as empty', async () => {
  setupStorage(memoryFiles(), '.kay/cache')

  expect(await mediaIndex()).toEqual({})

  await files.put(new Blob(['not json'], { type: 'application/json' }), { private: true, id: 'cms-media-index' })

  expect(await mediaIndex()).toEqual({})
})

test('a rename takes only a key of the CMS folders', async () => {
  setupStorage(memoryFiles(), '.kay/cache')

  const secret = await files.put(png('s.png'), { private: true })

  expect(isUploadKey(secret)).toBe(false)
  expect(isUploadKey('Private/aaaaaaaaaaaaaaaaaaaa.png')).toBe(false)
  expect(isUploadKey('../aaaaaaaaaaaaaaaaaaaa.png')).toBe(false)
  expect(isUploadKey('posts/2026/aaaaaaaaaaaaaaaaaaaa.1x1-000000.png')).toBe(true)
  expect(await renameUpload(secret, 'x')).toBe(false)
  expect(await renameUpload('../x', 'x')).toBe(false)
})
