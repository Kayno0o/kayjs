import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { dropStaleLintCache } from '../scripts/lint-cache'
import { scratchDir } from './scratch'

async function project() {
  const root = await scratchDir('lint-cache-')

  await writeFile(join(root, 'package.json'), '{}')
  await mkdir(join(root, 'bench/apps/solid'), { recursive: true })
  await writeFile(join(root, 'bench/apps/solid/package.json'), '{}')
  await writeFile(join(root, 'bun.lock'), 'one')

  return root
}

it('keeps the cache while the install is the same, and drops it once a bench app\'s dependencies are installed or the lockfile changes', async () => {
  const root = await project()
  const cache = join(root, '.eslintcache-0')

  expect(await dropStaleLintCache(root)).toBe(true)
  await writeFile(cache, 'errors from before the install')

  expect(await dropStaleLintCache(root)).toBe(false)
  expect(await Bun.file(cache).exists()).toBe(true)

  await mkdir(join(root, 'bench/apps/solid/node_modules'))

  expect(await dropStaleLintCache(root)).toBe(true)
  expect(await Bun.file(cache).exists()).toBe(false)

  await writeFile(cache, 'again')
  await utimes(join(root, 'bench/apps/solid/node_modules'), new Date(1000), new Date(1000))

  expect(await dropStaleLintCache(root)).toBe(true)
  expect(await Bun.file(cache).exists()).toBe(false)

  await writeFile(cache, 'again')
  await writeFile(join(root, 'bun.lock'), 'two')

  expect(await dropStaleLintCache(root)).toBe(true)
  expect(await Bun.file(cache).exists()).toBe(false)
  expect(await dropStaleLintCache(root)).toBe(false)
})

it('drops a library folder\'s cache by the repo\'s install, and keeps it otherwise', async () => {
  const root = await project()
  const library = join(root, 'packages/ui')
  const cache = join(library, '.eslintcache')

  await mkdir(library, { recursive: true })
  await writeFile(join(library, 'package.json'), '{}')

  expect(await dropStaleLintCache(root, library)).toBe(true)
  await writeFile(cache, 'errors from before the install')

  expect(await dropStaleLintCache(root, library)).toBe(false)
  expect(await Bun.file(cache).exists()).toBe(true)

  await mkdir(join(root, 'node_modules'))

  expect(await dropStaleLintCache(root, library)).toBe(true)
  expect(await Bun.file(cache).exists()).toBe(false)
  expect(await Bun.file(join(root, '.eslintcache-state')).exists()).toBe(false)
})
