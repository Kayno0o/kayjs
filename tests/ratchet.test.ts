import type { Rule } from '../eslint.ratchet'
import tsParser from '@typescript-eslint/parser'
import { describe, expect, test } from 'bun:test'
import { Linter } from 'eslint'
import { LIMITS, ratchetRules } from '../eslint.ratchet'
import { reconcile } from '../scripts/ratchet'

// The values of one file, for a baseline made of them.
const values = (lines: number): Record<Rule, number> => ({ 'max-lines': lines, 'max-lines-per-function': 0, 'complexity': 0 })

function lint(source: string, baseline: Parameters<typeof ratchetRules>[1]): string[] {
  const config = [{ files: ['**/*.ts'], languageOptions: { parser: tsParser } }, ...ratchetRules(import.meta.dir.replace(/\/tests$/, ''), baseline)] as never

  return new Linter({ configType: 'flat' }).verify(source, config, 'src/file.ts').map(message => message.ruleId ?? message.message)
}

const lines = (count: number): string => Array.from({ length: count }, (_, index) => `export const a${index} = ${index}`).join('\n')

describe('the size ratchet', () => {
  test('a file past a limit fails unless the baseline records it', () => {
    expect(lint(lines(LIMITS['max-lines'] + 1), {})).toEqual(['max-lines'])
    expect(lint(lines(LIMITS['max-lines'] + 1), { 'src/file.ts': { 'max-lines': LIMITS['max-lines'] + 1 } })).toEqual([])
  })

  test('a baselined file fails as soon as it grows', () => {
    expect(lint(lines(LIMITS['max-lines'] + 2), { 'src/file.ts': { 'max-lines': LIMITS['max-lines'] + 1 } })).toEqual(['max-lines'])
  })

  test('a baselined file keeps the limits of the rules it does not record', () => {
    const long = `export function f() {\n${lines(LIMITS['max-lines-per-function'] + 1)}\n}`

    expect(lint(long, { 'src/file.ts': { 'max-lines': 5000 } })).toEqual(['max-lines-per-function'])
  })

  test('the baseline must follow a file that shrank, and refuses growth and new files', () => {
    const measured = new Map([['src/a.ts', values(900)], ['src/b.ts', values(100)], ['src/c.ts', values(700)]])
    const { next, problems } = reconcile(measured, { 'src/a.ts': { 'max-lines': 1000 }, 'src/b.ts': { 'max-lines': 800 }, 'src/gone.ts': { 'max-lines': 900 } })

    expect(next).toEqual({ 'src/a.ts': { 'max-lines': 900 }, 'src/c.ts': { 'max-lines': 700 } })
    expect(problems).toEqual([
      'src/a.ts: max-lines shrank from 1000 to 900, record it',
      'src/b.ts: max-lines is under its limit of 600 now, drop it from the baseline',
      'src/c.ts: max-lines is 700, past the limit of 600',
      'src/gone.ts: no longer a source, drop it from the baseline',
    ])
    expect(reconcile(new Map([['src/a.ts', values(1100)]]), { 'src/a.ts': { 'max-lines': 1000 } }).problems).toEqual(['src/a.ts: max-lines grew from 1000 to 1100'])
    // Code split out of a file lands in a new one, which is let in at the value it has.
    expect(reconcile(new Map([['src/new.ts', values(700)]]), {}, file => file === 'src/new.ts').problems).toEqual(['src/new.ts: max-lines is 700, past the limit of 600 (new file, recorded by --update)'])
  })
})
