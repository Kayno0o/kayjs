import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { descendants, HEAVY_MB, regressions } from '../scripts/test-memory'

const ROOT = join(import.meta.dir, '..')

describe('the kept peak memory of the test files', () => {
  it('names test files that exist, each with a figure in MB', async () => {
    const { files } = await Bun.file(join(ROOT, 'tests', 'memory.json')).json() as { files: Record<string, number> }

    expect(Object.keys(files).filter(file => !existsSync(join(ROOT, file)))).toEqual([])
    expect(Object.values(files).filter(mb => !Number.isFinite(mb) || mb <= 0)).toEqual([])
  })

  it('shows a file that grew by a quarter and 50 MB, and nothing else', () => {
    const kept = { 'tests/a.test.ts': 200, 'tests/b.test.ts': 200, 'tests/c.test.ts': 20 }

    expect(regressions(kept, { 'tests/a.test.ts': 320, 'tests/b.test.ts': 240, 'tests/c.test.ts': 45, 'tests/new.test.ts': 900 })).toEqual([{ file: 'tests/a.test.ts', was: 200, now: 320 }])
    expect(HEAVY_MB).toBe(500)
  })

  it('follows the children of a process to any depth', () => {
    const parents = new Map([[2, 1], [3, 2], [4, 3], [5, 9]])

    expect(descendants(1, parents)).toEqual([1, 2, 3, 4])
  })
})
