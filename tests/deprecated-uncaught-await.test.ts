import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

// The lint's reports for a file, each with the source its safe fix leaves.
function found(source: string) {
  const diagnostics = compileKay(source, 'thing.kay', { check: true }).diagnostics

  expect(diagnostics.filter(d => d.code === 'unknown-lint')).toEqual([])

  return diagnostics.filter(d => d.code === 'deprecated-uncaught-await').map((d) => {
    const fix = d.fixes?.[0]

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed: fix && [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source) }
  })
}

const AWAIT = 'await comments then list\n  p {list.length}\n'

describe('deprecated-uncaught-await', () => {
  it('removes a comment alone on its line', () => {
    expect(found(`// kay-allow uncaught-await\n${AWAIT}`)).toEqual([{ at: 'uncaught-await', safe: true, fixed: AWAIT }])
    expect(found(`// kay-allow uncaught-await -- streamed on purpose\n${AWAIT}`)).toEqual([{ at: 'uncaught-await', safe: true, fixed: AWAIT }])
  })

  it('removes a comment ending a line of code, and its name from a list', () => {
    expect(found('p x // kay-allow uncaught-await\np y\n')[0]?.fixed).toBe('p x\np y\n')
    expect(found(`// kay-allow uncaught-await, missing-alt\n${AWAIT}`)[0]?.fixed).toBe(`// kay-allow missing-alt\n${AWAIT}`)
    expect(found(`// kay-allow missing-alt, uncaught-await\n${AWAIT}`)[0]?.fixed).toBe(`// kay-allow missing-alt\n${AWAIT}`)
  })

  it('reports nothing for an await with no catch, which renders an alert', () => {
    expect(found(AWAIT)).toEqual([])
    expect(compileKay(AWAIT, 'thing.kay', { check: true }).diagnostics).toEqual([])
  })
})
