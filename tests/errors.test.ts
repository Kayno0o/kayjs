import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { KayCompileError } from '../src/build/transform'
import { formatDiagnostic } from '../src/compiler'
import { codeFrame, formatReport } from '../src/compiler/frame'
import { offsetAt } from '../src/compiler/mapping'

describe('compile errors', () => {
  it('frames the line at fault under the two before it, carets clipped to the line', () => {
    const source = 'a\nb\nc\np {user.nam}\nd'
    const start = source.indexOf('nam')

    expect(codeFrame(source, start, start + 3)).toBe('2 | b\n3 | c\n4 | p {user.nam}\n  |         ^^^')
    expect(codeFrame(source, 0, source.length)).toBe('1 | a\n  | ^')
  })

  it('prints a diagnostic as rustc does: heading, location, the lines its spans cover, each labelled, then its note and help', () => {
    const source = 'Card\n  @a\n    p x\n  p y\n  p z\n  p w\n  @a\n    p v'
    const second = source.lastIndexOf('@a') + 1
    const first = source.indexOf('@a') + 1

    expect(formatDiagnostic(source, 'card.kay', { start: second, end: second + 1, message: '`a` is passed twice', label: 'passed again here', related: [{ start: first, end: first + 1, label: 'passed by this `@a`' }], note: 'each prop is passed once', help: 'drop one of them' })).toBe([
      'error: `a` is passed twice',
      ' --> card.kay:7:4',
      '  |',
      '2 |   @a',
      '  |    - passed by this `@a`',
      '...',
      '5 |   p z',
      '6 |   p w',
      '7 |   @a',
      '  |    ^ passed again here',
      '  |',
      '  = note: each prop is passed once',
      '  = help: drop one of them',
    ].join('\n'))
  })

  it('names a lint in its heading, and prints only the location of a report with no source', () => {
    expect(formatReport({ severity: 'warning', code: 'positional-key', message: 'm', file: 'a.kay', line: 12, column: 3 })).toBe('warning[positional-key]: m\n  --> a.kay:12:3')
    expect(formatReport({ code: 'TS2322', message: 'm', file: 'a.ts', line: 1, column: 1, help: 'h' }, (styles, text) => `<${styles.join(' ')}>${text}`)).toBe('<bold red>error[TS2322]<bold>: m\n <bold blue>--> a.ts:1:1\n<bold blue>  |\n  <bold blue>= <bold>help: h')
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
      await Bun.write(join(root, 'src/a.kay'), 'for of list\n  li x\n')
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
        ['src/a.kay', 'Malformed `for`'],
        ['src/b.kay', expect.stringContaining('must directly follow')],
      ])
      expect(message).toContain('error: Malformed `for`\n --> ')
      expect(message).toContain('src/a.kay:1:1\n  |\n1 | for of list\n  | ^^^^^^^^^^^\n  |\n')
      expect(message).toContain('  = help: `for <item> of <list>`')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
