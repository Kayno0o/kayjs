import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ANY, propsWritten, specializedSource, usesNames } from '../src/build/variants'
import { scratchDir } from './scratch'

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

describe('specializedSource around else and the text', () => {
  it('leaves an else after a blanked if and an else if with a call', () => {
    const out = specializedSource('---\n---\nif uses(\'a\') && p\n  b one\nelse if uses(\'b\') && q\n  b two\nelse\n  b three', new Set()).split('\n')

    expect(out).toEqual(['---', '---', 'if false', '', 'else if false', '', 'else', '  b three'])
  })

  it('leaves a call in a comment or a string, and a method of that name', () => {
    const out = specializedSource('const a = uses(\'x\')\n// uses(\'x\')\nconst b = \'uses(\\\'x\\\')\'\nconst c = other.uses(\'x\')\n---\n', new Set(['x']))

    expect(out).toBe('const a = true\n// uses(\'x\')\nconst b = \'uses(\\\'x\\\')\'\nconst c = other.uses(\'x\')\n---\n')
  })

  it('leaves a call in a comment or a template literal over several lines', () => {
    const text = '/* one\n uses(\'x\') */\nconst a = `\nuses(\'x\')`\nconst b = uses(\'x\')\n---\n'

    expect(specializedSource(text, new Set()).split('\n')).toEqual(['/* one', ' uses(\'x\') */', 'const a = `', 'uses(\'x\')`', 'const b = false', '---', ''])
  })

  it('reads a call in a template literal hole, and skips a regular expression holding a quote', () => {
    const text = 'const a = `x ${uses(\'x\') ? `${uses(\'y\')}` : 1} uses(\'x\')`\nconst b = /it\'s uses(\'x\')/.test(s) && uses(\'x\')\nconst c = a / 2 + uses(\'y\')\n---\n'

    expect(specializedSource(text, new Set(['x']))).toBe('const a = `x ${true ? `${false}` : 1} uses(\'x\')`\nconst b = /it\'s uses(\'x\')/.test(s) && true\nconst c = a / 2 + false\n---\n')
  })

  it('leaves the file of an app whose own uses is not the marker', async () => {
    const dir = await scratchDir('variants-')
    const file = join(dir, 'own.kay')
    const text = 'import { uses } from \'./uses\'\nconst on = uses(\'x\')\n---\n'

    await Bun.write(join(dir, 'uses.ts'), 'export const uses = (name: string) => name === \'x\'\n')
    expect(specializedSource(text, new Set(), file)).toBe(text)
    expect(usesNames(text, file)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('propsWritten', () => {
  const head = 'import Table from \'./table.kay\'\n---\n'

  it('collects attributes, slots and children of each call site', () => {
    const written = propsWritten(`${head}Table(rows={r} selectable)\nTable(pageSize={5})\n  @footer\n    p x`, ['Table'])

    expect([...written.get('Table') as Set<string>].sort()).toEqual(['footer', 'pageSize', 'rows', 'selectable'])
  })

  it('leaves out a component called with a spread or read as a value', () => {
    expect(propsWritten(`${head}Table({...rest})`, ['Table']).get('Table')).toBe(ANY)
    expect(propsWritten(`${head}const keep = Table\nTable(rows={r})`, ['Table']).get('Table')).toBe(ANY)
  })
})
