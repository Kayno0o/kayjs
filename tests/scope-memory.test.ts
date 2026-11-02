import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { describeSamples, sampleScope } from '../scripts/scope-memory'
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
  expect(describeSamples({ peak, samples })).toStartWith('memory.current by second: 0s=100 ')
})

test('the sampler is off where memory.current is not readable', async () => {
  const folder = await scratchDir('scope-memory-')

  expect(sampleScope(10, join(folder, 'missing'))).toBeUndefined()
})
