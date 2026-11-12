import { describe, expect, it } from 'bun:test'
import { propsWritten, specializedSource, usesNames } from '../src/build/variants'

const CHILD = [
  '---',
  'const on = uses(\'a\') ? 1 : 0',
  '---',
  'div',
  '  if uses(\'a\') && a',
  '    span one',
  '    em two',
  '  if uses(\'b\') || uses(\'c\')',
  '    b three',
  '  if x ? uses(\'a\') && y : z',
  '    i four',
  'p tail',
].join('\n')

describe('specializedSource', () => {
  it('names the features a component declares', () => {
    expect(usesNames(CHILD).sort()).toEqual(['a', 'b', 'c'])
  })

  it('replaces the calls and blanks the template blocks that cannot hold, keeping the line count', () => {
    const out = specializedSource(CHILD, new Set(['a']))
    const lines = out.split('\n')

    expect(lines).toHaveLength(CHILD.split('\n').length)
    // The script keeps its code, with the call as a literal.
    expect(lines[1]).toBe('const on = true ? 1 : 0')
    expect(lines[4]).toBe('  if true && a')
    expect(lines[5]).toBe('    span one')
    // Neither b nor c is present: the block is false and its lines are empty.
    expect(lines[7]).toBe('  if false')
    expect(lines[8]).toBe('')
    // A condition holding a `?` is left to the minifier.
    expect(lines[9]).toBe('  if x ? true && y : z')
    expect(lines[11]).toBe('p tail')
  })

  it('blanks a block whose every `||` term has a false factor, and keeps one with a term that may hold', () => {
    const out = specializedSource('---\n---\nif uses(\'a\') && p || q\n  b one\nif uses(\'a\') && p || uses(\'b\') && q\n  b two', new Set())

    expect(out.split('\n')[2]).toBe('if false && p || q')
    expect(out.split('\n')[3]).toBe('  b one')
    expect(out.split('\n')[4]).toBe('if false')
    expect(out.split('\n')[5]).toBe('')
  })
})

describe('propsWritten', () => {
  const head = 'import Table from \'./table.kay\'\n---\n'

  it('collects attributes, slots and children of each call site', () => {
    const written = propsWritten(`${head}Table(rows={r} selectable)\nTable(pageSize={5})\n  @footer\n    p x`, ['Table'])

    expect([...written.get('Table')!].sort()).toEqual(['footer', 'pageSize', 'rows', 'selectable'])
  })

  it('leaves out a component called with a spread or read as a value', () => {
    expect(propsWritten(`${head}Table({...rest})`, ['Table']).has('Table')).toBe(false)
    expect(propsWritten(`${head}const keep = Table\nTable(rows={r})`, ['Table']).has('Table')).toBe(false)
  })
})
