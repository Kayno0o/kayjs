import { chmodSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { replaceFile } from '../src/build/files'
import { scratchDir } from './scratch'

it('replaces a file by moving a finished one over it, keeping its mode, and leaves no draft', async () => {
  const dir = await scratchDir('replace-file-')
  const path = join(dir, '.env')

  await Bun.write(path, 'A=1\n')
  chmodSync(path, 0o600)

  const before = statSync(path).ino

  await replaceFile(path, 'A=2\n')

  expect(await Bun.file(path).text()).toBe('A=2\n')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  // A new inode: a reader met the old file whole or the new one whole, never a half-written one.
  expect(statSync(path).ino).not.toBe(before)
  expect(readdirSync(dir)).toEqual(['.env'])
})

it('gives a new file the mode asked for', async () => {
  const dir = await scratchDir('replace-file-')

  await replaceFile(join(dir, '.env'), 'A=1\n', 0o600)

  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
})
