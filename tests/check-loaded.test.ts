import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'
import { expect, test } from 'bun:test'
import { loadedFiles, MAX_ENTRIES, stampOf } from '../src/check/loaded'
import { scratchDir } from './scratch'

const LOADED = join(import.meta.dir, '..', 'src', 'check', 'loaded')

test('listing the loaded files does not load the parser', async () => {
  const script = `import '${LOADED}'; console.log(Object.keys(require.cache).some(path => path.includes('@babel/parser')))`
  const dir = await scratchDir('loaded-parser-')

  await writeFile(join(dir, 'probe.ts'), script)

  expect((await $`bun probe.ts`.cwd(dir).quiet().text()).trim()).toBe('false')
})

test('a root that cannot be resolved is listed without throwing', () => {
  expect(loadedFiles('/kay-no-such-root', []).some(path => path.endsWith('kay.config.ts'))).toBe(true)
})

test('a stamp walks a folder of entries but not git, build output or dependencies', async () => {
  const dir = await scratchDir('loaded-skipped-')

  for (const folder of ['cards', '.git', 'dist', 'node_modules', '.next'])
    await mkdir(join(dir, folder), { recursive: true })

  await writeFile(join(dir, 'cards/a.ts'), 'a')

  const before = stampOf([dir]).stamp

  for (const folder of ['.git', 'dist', 'node_modules', '.next'])
    await writeFile(join(dir, folder, 'x'), 'x')

  expect(stampOf([dir]).stamp).toBe(before)

  await writeFile(join(dir, 'cards/b.ts'), 'b')
  expect(stampOf([dir]).stamp).not.toBe(before)
})

test('a walk past the cap is never equal to another and counts as newest', async () => {
  const dir = await scratchDir('loaded-cap-')

  await Promise.all(Array.from({ length: MAX_ENTRIES + 5 }, async (_, index) => writeFile(join(dir, `f${index}`), '')))

  const first = stampOf([dir])

  expect(first.newest).toBe(Number.POSITIVE_INFINITY)
  expect(stampOf([dir]).stamp).not.toBe(first.stamp)
}, 60_000)
