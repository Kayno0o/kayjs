import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { dropStaleLintCache } from '../src/commands/lint-cache'
import { scratchDir } from './scratch'

it('drops the ESLint cache once the tsconfig or a shadow type changes, and keeps it otherwise', async () => {
  const root = await scratchDir('kay-lint-cache-')
  const cache = join(root, '.eslintcache')

  await mkdir(join(root, '.kay/types/src'), { recursive: true })
  await Bun.write(join(root, 'tsconfig.json'), '{ "extends": "kay/tsconfig.json" }')
  await Bun.write(join(root, '.kay/types/src/a.kay.tsx'), 'export {}')

  await dropStaleLintCache(root, [], root)
  await Bun.write(cache, 'parsing error')

  expect(await dropStaleLintCache(root, [], root)).toBe(false)
  expect(await Bun.file(cache).exists()).toBe(true)

  await Bun.write(join(root, 'tsconfig.json'), '{ "extends": "kay/tsconfig.json", "include": ["scripts"] }')

  expect(await dropStaleLintCache(root, [], root)).toBe(true)
  expect(await Bun.file(cache).exists()).toBe(false)

  await Bun.write(cache, 'again')
  await Bun.write(join(root, '.kay/types/src/a.kay.tsx'), 'export const a = 1')

  expect(await dropStaleLintCache(root, [], root)).toBe(true)
  expect(await Bun.file(cache).exists()).toBe(false)
})

it('follows --cache-location, and leaves a folder location alone', async () => {
  const root = await scratchDir('kay-lint-cache-')

  await Bun.write(join(root, 'tsconfig.json'), '{}')
  await dropStaleLintCache(root, [], root)
  await Bun.write(join(root, 'tsconfig.json'), '{ "include": [] }')
  await Bun.write(join(root, 'elsewhere'), 'x')

  expect(await dropStaleLintCache(root, ['--cache', '--cache-location', 'elsewhere'], root)).toBe(true)
  expect(await Bun.file(join(root, 'elsewhere')).exists()).toBe(false)

  await Bun.write(join(root, 'tsconfig.json'), '{ "include": ["x"] }')

  expect(await dropStaleLintCache(root, ['--cache-location=.cache/'], root)).toBe(false)
})
