import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { assertKayWritable } from '../src/test/writable'
import { fixtureCopy, scratchDir } from './scratch'

it('names the folder and the way out when .kay cannot be written, and passes one that can', async () => {
  const blocked = await scratchDir('test-site-unwritable-kay-')
  const open = await scratchDir('test-site-writable-kay-')

  await Bun.write(join(blocked, '.kay'), 'a file, not a folder')

  expect(() => assertKayWritable(blocked)).toThrow(`${join(blocked, '.kay')}, which cannot be written`)
  expect(() => assertKayWritable(blocked)).toThrow('islands: false')
  expect(() => assertKayWritable(open)).not.toThrow()
})

it('refuses testSite() on a .kay that cannot be written, unless it builds no islands', async () => {
  const root = await fixtureCopy('bare')

  await Bun.write(join(root, '.kay'), 'a file, not a folder')

  await expect(testSite({ root })).rejects.toThrow('islands: false')

  const site = await testSite({ root, islands: false })

  expect(site).toBeDefined()
})
