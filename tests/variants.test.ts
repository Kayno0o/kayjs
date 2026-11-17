import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ANY, propsWritten, specializedSource, usesNames, VariantIndex } from '../src/build/variants'
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

  it('tells a division from a regular expression after an operator, a keyword, a string or a template', () => {
    const text = 'const a = () => /\'/.test(s) && uses(\'x\')\nfunction f() { return /`/.test(s) && uses(\'x\') }\nconst b = \'a\' / 2 + uses(\'x\')\nconst c = `${a}/2` + uses(\'x\')\nconst d = b > /\'/.source ? uses(\'x\') : 0\n---\n'

    expect(specializedSource(text, new Set(['x']))).toBe(text.replaceAll('uses(\'x\')', 'true'))
  })

  it('divides after a postfix increment, and reads a regex after await, typeof and a backslash at a line end', () => {
    const text = 'const a = i++ / 2 + uses(\'x\')\nconst b = n-- / 2 / 1 + uses(\'x\')\nasync function f() { return await /\'/.test(s) && uses(\'x\') }\nconst c = typeof /\'/ + uses(\'x\')\nconst d = /a\\\n/ + uses(\'x\')\n---\n'

    expect(specializedSource(text, new Set(['x']))).toBe(text.replaceAll('uses(\'x\')', 'true'))
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

// What follows `?uses=` in a variant's address.
const usesOf = (address: string) => address.slice(address.indexOf('?uses=') + '?uses='.length)

describe('a feature on when the prop is left out', () => {
  const head = 'import Table from \'./table.kay\'\n---\n'

  it('reads the second argument of a call and folds a call in a template line', () => {
    const text = '---\nconst a = uses(\'x\', true)\n---\nspan(data-x={uses(\'x\', true) ? 1 : undefined}) one\n'

    expect(usesNames(text)).toEqual(['x'])
    expect(specializedSource(text, new Set()).split('\n')).toEqual(['---', 'const a = false', '---', 'span(data-x={false ? 1 : undefined}) one', ''])
    expect(specializedSource(text, new Set(['x'])).split('\n')[3]).toBe('span(data-x={true ? 1 : undefined}) one')
  })

  it('marks a call that leaves the prop out, or writes it as anything but a literal false', () => {
    const defaults = new Map([['Table', new Set(['sortable'])]])
    const written = propsWritten(`${head}Table(rows={r})\nTable(rows={r} sortable={false})\nTable(sortable={flag})\nTable(sortable)\nTable(sortable="false")`, ['Table'], defaults)

    expect([...written.get('Table') as Set<string>].sort()).toEqual(['+sortable', 'rows', 'sortable'])
    expect([...propsWritten(`${head}Table(rows={r} sortable={ false })`, ['Table'], defaults).get('Table') as Set<string>].sort()).toEqual(['rows', 'sortable'])
  })

  it('leaves sorting in a variant while one call site of the project may sort, and out when every one writes sortable={false}', async () => {
    const dir = await scratchDir('variants-')
    const table = join(import.meta.dir, '../packages/ui/src/table.kay')
    const call = (props: string) => `---\nimport Table from '${table}'\n---\nTable(columns={[]} rows={[]} rowKey="id" ${props})\n`
    const entry = async (...files: string[]) => {
      const paths = await Promise.all(files.map(async (source, at) => {
        const path = join(dir, `${at}.kay`)

        await Bun.write(path, source)

        return path
      }))

      return new VariantIndex(paths).entry(table)
    }

    const features = (query: string) => usesOf(query).slice(0, usesOf(query).indexOf('~')).split('-')

    expect(features(await entry(call('sortable={false}')))).not.toContain('sortable')
    expect(features(await entry(call('sortable={false}'), call('')))).toContain('sortable')
    expect(features(await entry(call('sortable={false}'), call('sortable={flag}')))).toContain('sortable')
    expect(features(await entry(call('sortable={false} {...rest}')))).toContain('sortable')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('the props a variant knows its call sites write', () => {
  const table = join(import.meta.dir, '../packages/ui/src/table.kay')
  const query = async (...calls: string[]) => {
    const dir = await scratchDir('variants-')
    const paths = await Promise.all(calls.map(async (call, at) => {
      const path = join(dir, `${at}.kay`)

      await Bun.write(path, `---\nimport Table from '${table}'\n---\nTable(${call})\n`)

      return path
    }))
    const entry = await new VariantIndex(paths).entry(table)

    await rm(dir, { recursive: true, force: true })

    return entry
  }

  it('names every prop written at any call site after a tilde, none when a call spreads', async () => {
    expect(usesOf(await query('rows={r} columns={c}', 'rowKey="id" selectable'))).toBe('selectable-sortable~columns-rowKey-rows-selectable')
    expect(usesOf(await query('rows={r}', '{...rest}'))).not.toContain('~')
  })
})
