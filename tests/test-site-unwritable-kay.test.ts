import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { assertKayWritable } from '../src/test/writable'
import { scratchDir } from './scratch'

it('names the folder and the way out when .kay cannot be written, and passes one that can', async () => {
  const blocked = await scratchDir('test-site-unwritable-kay-')
  const open = await scratchDir('test-site-writable-kay-')

  await Bun.write(join(blocked, '.kay'), 'a file, not a folder')

  expect(() => assertKayWritable(blocked)).toThrow(`${join(blocked, '.kay')}, which cannot be written`)
  expect(() => assertKayWritable(blocked)).toThrow('islands: false')
  expect(() => assertKayWritable(open)).not.toThrow()
})
