import { readFileSync } from 'node:fs'
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
    expect(specializedSource(text, new Set()).split('\n')).toEqual(['---', 'const a = false', '---', 'span(data-x={undefined}) one', ''])
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

describe('a bind: written at a call site', () => {
  const head = 'import Table from \'./table.kay\'\n---\n'

  it('writes the prop and the callback the compiler gives it, as written props', () => {
    const written = propsWritten(`${head}Table(rows={r} bind:selected={chosen})`, ['Table']).get('Table') as Set<string>

    expect([...written].sort()).toEqual(['onSelectedChange', 'rows', 'selected'])
  })

  it('leaves the bound feature on in the variant of BarChart and of Table', async () => {
    const dir = await scratchDir('variants-')
    const parts = (query: string): [string, string] => [query.slice(0, query.indexOf('~')), query.slice(query.indexOf('~') + 1)]
    const ui = (name: string) => join(import.meta.dir, `../packages/ui/src/${name}.kay`)
    const entry = async (name: string, call: string) => {
      const path = join(dir, `${name}.kay`)

      await Bun.write(path, `---\nimport Component from '${ui(name)}'\n---\nComponent(${call})\n`)

      return usesOf(await new VariantIndex([path]).entry(ui(name)))
    }

    const [features] = parts(await entry('bar-chart', 'labels={l} series={s} bind:active={at}'))
    const [, props] = parts(await entry('table', 'rows={r} columns={c} rowKey="id" bind:selected={chosen}'))

    expect(features.split('-')).toEqual(expect.arrayContaining(['active', 'onActiveChange']))
    expect(props).toContain('onSelectedChange')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('a variant of Table specialised for a call that uses almost nothing', () => {
  const source = readFileSync(join(import.meta.dir, '../packages/ui/src/table.kay'), 'utf8')

  it('drops the recipe parts and the default wording of the features left out, and keeps them when present', () => {
    const plain = specializedSource(source, new Set())

    expect(plain).not.toMatch(/\.\.\.\(false/)
    expect(plain).not.toContain('ui.table.columns')
    expect(plain).not.toContain('ui.table.filter\'')
    expect(plain).not.toContain('sticky left-0')
    expect(plain).toContain('skeletonCell')

    const full = specializedSource(source, new Set(['columnToggle', 'filter', 'selectable']))

    expect(full).toContain('ui.table.columns')
    expect(full).toContain('sticky left-0')
  })
})

describe('a component imported lazily', () => {
  it('names the variant the call sites need, as a static import does', async () => {
    const dir = await scratchDir('variants-lazy')
    const table = join(import.meta.dir, '../packages/ui/src/table.kay')
    const page = join(dir, 'page.kay')

    await Bun.write(page, `---\nimport Table from '${table}'\n---\nTable(rows={r} columns={c} rowKey="id")\n`)

    const code = `const Table = KayLazy("table-x", () => import("${table}"))\n`
    const out = await new VariantIndex([page]).variantImports(code, page, await Bun.file(page).text())

    expect(out).toMatch(/import\("[^"]+table\.kay\?uses=[^"]+"\)/)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('a component handing its rest props on', () => {
  const dialog = join(import.meta.dir, '../packages/ui/src/dialog.kay')
  const outer = (call: string) => `---\nimport Dialog from '${dialog}'\nconst { level, header, ...rest } = props<{ level?: number, header?: string, [key: string]: unknown }>()\n---\n// A Dialog under it, with what its callers write.\n${call}\n`
  const caller = (props: string) => `---\nimport Outer from './outer.kay'\n---\nOuter(${props})\n`

  // The features of Dialog's variant, and none when the project's call sites leave the props unknown.
  const features = async (files: Record<string, string>) => {
    const dir = await scratchDir('variants-')
    const paths = await Promise.all(Object.entries(files).map(async ([name, source]) => {
      const path = join(dir, name)

      await Bun.write(path, source)

      return path
    }))
    const query = usesOf(await new VariantIndex(paths).entry(dialog))

    await rm(dir, { recursive: true, force: true })

    return query.includes('~') ? query.slice(0, query.indexOf('~')).split('-').filter(Boolean) : undefined
  }

  it('counts what its callers write, and a comment line naming the component is no read of it', async () => {
    const call = 'Dialog({...rest} title="t" level={level} header={header})'

    expect(await features({ 'outer.kay': outer(call), 'page.kay': caller('title="a"') })).toEqual([])
    expect(await features({ 'outer.kay': outer(call), 'page.kay': caller('title="a" level={3}') })).toEqual(['level'])
    expect(await features({ 'outer.kay': outer(call), 'page.kay': caller('title="a" header="h"') })).toEqual(['header'])
  })

  it('counts a prop it takes by name only once a caller writes it, and one with a default always', async () => {
    const named = outer('Dialog({...rest} title="t" level={level})')

    expect(await features({ 'outer.kay': named, 'page.kay': caller('header="h"') })).toEqual([])
    expect(await features({ 'outer.kay': named.replace('level, header', 'level = 2, header'), 'page.kay': caller('title="a"') })).toEqual(['level'])
  })

  it('counts every prop of a spread that is not its own rest props', async () => {
    expect(await features({ 'outer.kay': outer('Dialog({...other} title="t")'), 'page.kay': caller('title="a"') })).toBeUndefined()
  })

  it('counts every prop when no scanned file calls the component that hands them on', async () => {
    expect(await features({ 'outer.kay': outer('Dialog({...rest} title="t" level={level})') })).toBeUndefined()
  })

  it('ends on a cycle of components handing their rest props on, and counts what its callers write', async () => {
    const first = `---\nimport Dialog from '${dialog}'\nimport Second from './second.kay'\nconst { ...rest } = props<{ [key: string]: unknown }>()\n---\nDialog({...rest} title="t")\nSecond({...rest})\n`
    const second = `---\nimport First from './first.kay'\nconst { ...rest } = props<{ [key: string]: unknown }>()\n---\nFirst({...rest})\n`

    expect(await features({ 'first.kay': first, 'second.kay': second, 'page.kay': `---\nimport First from './first.kay'\n---\nFirst(level={3})\n` })).toEqual(['level'])
  })

  it('keeps a default-on feature in the variant of a component handing a spread on, whatever its callers write', async () => {
    const table = join(import.meta.dir, '../packages/ui/src/table.kay')
    const through = `---\nimport Table from '${table}'\nconst { ...rest } = props<{ [key: string]: unknown }>()\n---\nTable({...rest} rows={[]} columns={[]} rowKey="id")\n`
    const page = (props: string) => `---\nimport Through from './through.kay'\n---\nThrough(${props})\n`
    const sortable = async (props: string) => {
      const dir = await scratchDir('variants-')
      const paths = [join(dir, 'through.kay'), join(dir, 'page.kay')]

      await Bun.write(paths[0]!, through)
      await Bun.write(paths[1]!, page(props))

      const query = usesOf(await new VariantIndex(paths).entry(table))

      await rm(dir, { recursive: true, force: true })

      return query.slice(0, query.indexOf('~')).split('-').includes('sortable')
    }

    expect(await sortable('')).toBe(true)
    // A value passed on through the spread is not known to be false, so a caller writing it keeps the feature too.
    expect(await sortable('sortable={false}')).toBe(true)
  })

  it('follows a chain of components handing their rest props on', async () => {
    const middle = `---\nimport Outer from './outer.kay'\nconst { ...rest } = props<{ [key: string]: unknown }>()\n---\nOuter({...rest} title="m")\n`

    expect(await features({ 'outer.kay': outer('Dialog({...rest} title="t" level={level})'), 'middle.kay': middle, 'page.kay': `---\nimport Middle from './middle.kay'\n---\nMiddle(level={4})\n` })).toEqual(['level'])
  })
})
