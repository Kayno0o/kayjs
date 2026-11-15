import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { storeMs } from '../src/check/store-ms'
import { scratchDir } from './scratch'

describe('deprecated-store-ms', () => {
  it('writes the milliseconds of a kv ttl with their unit, on a chained call and on a bound name', async () => {
    const root = await scratchDir('store-ms-')
    const source = [
      'import { kv } from \'kay/server\'',
      '',
      'const marks = kv(\'sweep\')',
      'export const a = await kv(\'a\').once(\'nightly\', 60_000)',
      'export const b = await marks.set(\'k\', \'v\', 2 * 60_000)',
      'export const c = await marks.once(\'k\', \'5m\')',
      'export const d = await marks.set(\'k\', \'v\')',
      'export const e = await marks.once(\'k\', held)',
      'export const f = await other.once(\'k\', 1000)',
      '',
    ].join('\n')

    try {
      await Bun.write(join(root, 'src/a.ts'), source)

      const found = await storeMs(root, {})

      expect(found).toHaveLength(2)
      expect(found.every(one => one.code === 'deprecated-store-ms' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/a.ts')).text()).toBe(source.replace('60_000)\n', '\'60000ms\')\n').replace('2 * 60_000', '\'120000ms\''))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
