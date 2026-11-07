import { join } from 'node:path'
import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { ISLAND } from '../src/runtime/markers'

const SRC = join(import.meta.dir, '../src')
// Served as they are written, so they import nothing and keep a copy; and the lazy chunk of a form's fields, whose import of it would make the eager chunk export it.
const STANDALONE = new Set(['runtime/dev-inspector.ts', 'runtime/dev-patch.ts', 'runtime/form-protect.ts'])

describe('markers', () => {
  it('writes the island selector in markers.ts alone, and the standalone dev scripts copy it as it is', async () => {
    const copies: string[] = []

    for await (const file of new Glob('**/*.ts').scan(SRC)) {
      if (file !== 'runtime/markers.ts' && (await Bun.file(join(SRC, file)).text()).includes(ISLAND))
        copies.push(file)
    }

    expect(copies.sort()).toEqual([...STANDALONE].sort())
  })
})
