import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { clearCache } from '../src/build/cache'
import { loadConfig } from '../src/config-loader'
import { libraryCacheSlot, readCacheEntry, writeCacheEntry } from '../src/server/library'
import { scratchDir } from './scratch'

describe('an extension declaring the lints it satisfies', () => {
  test('hands them to the config\'s lints, beside the levels the app set', async () => {
    const root = await scratchDir('extension-satisfies-')

    await Bun.write(join(root, 'kay.config.ts'), 'export default { lints: { a11y: \'warn\' }, extensions: [{ name: \'alt\', satisfies: [\'missing-alt\'] }, { name: \'other\', satisfies: [\'missing-alt\'] }] }\n')
    expect((await loadConfig(root)).lints).toEqual({ a11y: 'warn', satisfied: ['missing-alt'] })
  })

  test('leaves the lints alone when none does', async () => {
    const root = await scratchDir('extension-satisfies-')

    await Bun.write(join(root, 'kay.config.ts'), 'export default { extensions: [{ name: \'plain\' }] }\n')
    expect((await loadConfig(root)).lints).toBeUndefined()
  })
})

describe('a library\'s cache slot', () => {
  test('keeps a value until its inputs change, in a folder of the library', async () => {
    const root = await scratchDir('library-cache-')
    const slot = libraryCacheSlot(root, 'kayjs-ai', 'a1', 'photo\0model')

    expect(slot.file).toBe(join(root, '.kay', 'cache', 'libraries', 'kayjs-ai', 'a1.json'))
    expect(await readCacheEntry(slot)).toBeUndefined()
    await writeCacheEntry(slot, { alt: 'A cat' })
    expect(await readCacheEntry(slot)).toEqual({ alt: 'A cat' })
    expect(await readCacheEntry(libraryCacheSlot(root, 'kayjs-ai', 'a1', 'photo\0other'))).toBeUndefined()
  })
})

test('`--no-cache` empties the build\'s cache but not what a library kept', async () => {
  const root = await scratchDir('library-cache-')
  const cache = join(root, '.kay', 'cache')
  const slot = libraryCacheSlot(root, 'kayjs-ai', 'a1', 'photo')

  await writeCacheEntry(slot, { alt: 'A cat' })
  await Bun.write(join(cache, 'transform', 'x.json'), '{}')
  await clearCache(cache)
  expect(await Bun.file(join(cache, 'transform', 'x.json')).exists()).toBe(false)
  expect(await readCacheEntry(slot)).toEqual({ alt: 'A cat' })
})

test('drops a satisfied list written in the app\'s own lints', async () => {
  const root = await scratchDir('extension-satisfies-')

  await Bun.write(join(root, 'kay.config.ts'), 'export default { lints: { satisfied: [\'missing-alt\'] } as never }\n')
  expect((await loadConfig(root)).lints).toEqual({})
})
