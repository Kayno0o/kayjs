import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { describeSamples, heldBytes, sampleScope, scopeLimit, sizeForScope } from '../scripts/scope-memory'
import { scratchDir } from './scratch'

const MB = 1024 * 1024

test('the sampler keeps the highest memory.current it saw and every sample', async () => {
  const folder = await scratchDir('scope-memory-')
  const file = join(folder, 'memory.current')

  await writeFile(file, String(100 * MB))
  const sampler = sampleScope(10, folder)

  expect(sampler).toBeDefined()
  await writeFile(file, String(300 * MB))
  await Bun.sleep(50)
  await writeFile(file, String(200 * MB))
  await Bun.sleep(50)

  const { peak, samples } = sampler!.stop()

  expect(peak).toBe(300 * MB)
  expect(samples.length).toBeGreaterThan(2)
  expect(samples[0]![1]).toBe(100 * MB)
  expect(samples.at(-1)![1]).toBe(200 * MB)
  expect(describeSamples({ peak, held: 0, samples })).toStartWith('memory.current by second: 0s=100 ')
})

test('the sampler is off where memory.current is not readable', async () => {
  const folder = await scratchDir('scope-memory-')

  expect(sampleScope(10, join(folder, 'missing'))).toBeUndefined()
})

test('the sampler keeps the highest anon, shmem and kernel memory as the held memory, not the page cache', async () => {
  const folder = await scratchDir('scope-memory-')

  await writeFile(join(folder, 'memory.current'), String(900 * MB))
  await writeFile(join(folder, 'memory.stat'), `anon ${100 * MB}\nfile ${700 * MB}\nkernel ${20 * MB}\nshmem ${30 * MB}\n`)

  const sampler = sampleScope(10, folder)

  await writeFile(join(folder, 'memory.stat'), `anon ${50 * MB}\nfile ${800 * MB}\nkernel ${20 * MB}\nshmem ${30 * MB}\n`)
  await Bun.sleep(50)

  const { peak, held } = sampler!.stop()

  expect(peak).toBe(900 * MB)
  expect(held).toBe(150 * MB)
  expect(heldBytes(undefined)).toBeUndefined()
})

test('a scope under 16 GB gets fewer workers and four runs, a larger or unlimited one keeps the defaults', async () => {
  const GB = 1024 * MB
  const folder = await scratchDir('scope-memory-')

  expect(sizeForScope(8 * GB)).toEqual({ workers: 3, shards: 4 })
  expect(sizeForScope(4 * GB)).toEqual({ workers: 1, shards: 4 })
  expect(sizeForScope(GB)).toEqual({ workers: 1, shards: 4 })
  expect(sizeForScope(16 * GB)).toBeUndefined()
  expect(sizeForScope(undefined)).toBeUndefined()

  await writeFile(join(folder, 'memory.max'), `${8 * GB}\n`)
  expect(scopeLimit(folder)).toBe(8 * GB)
  await writeFile(join(folder, 'memory.max'), 'max\n')
  expect(scopeLimit(folder)).toBeUndefined()
  expect(scopeLimit(join(folder, 'missing'))).toBeUndefined()
})
