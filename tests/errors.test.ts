import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { KayCompileError } from '../src/build/transform'
import { codeFrame } from '../src/compiler/frame'
import { offsetAt } from '../src/compiler/mapping'
import { buildClient } from '../src/server/client'

describe('compile errors', () => {
  it('frames the line at fault under the two before it, carets clipped to the line', () => {
    const source = 'a\nb\nc\np {user.nam}\nd'
    const start = source.indexOf('nam')

    expect(codeFrame(source, start, start + 3)).toBe('2 | b\n3 | c\n4 | p {user.nam}\n  |         ^^^')
    expect(codeFrame(source, 0, source.length)).toBe('1 | a\n  | ^')
  })

  it('reads a column past the end of its line as that end, line breaks of either kind', () => {
    expect(offsetAt('ab\ncd', { line: 1, column: 9 })).toBe(2)
    expect(offsetAt('ab\r\ncd', { line: 1, column: 9 })).toBe(2)
    expect(offsetAt('ab\ncd', { line: 2, column: 9 })).toBe(5)
    expect(offsetAt('ab\ncd', { line: 2, column: 2 })).toBe(4)
  })

  it('reports every broken component of a project at once, before bundling anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-errors-'))

    try {
      await Bun.write(join(root, 'src/a.kay'), 'for t of list\n  li x\n')
      await Bun.write(join(root, 'src/b.kay'), 'p ok\nelse\n  p no\n')
      let error: unknown

      try {
        await buildClient(root)
      }
      catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(KayCompileError)
      const { diagnostics, message } = error as KayCompileError

      expect(diagnostics.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.message])).toEqual([
        ['src/a.kay', expect.stringContaining('needs a key')],
        ['src/b.kay', expect.stringContaining('must directly follow')],
      ])
      expect(message).toContain('a.kay:1:1 - ')
      expect(message).toContain('1 | for t of list\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
