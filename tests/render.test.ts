import type { Todo } from './fixtures/app/src/todo'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { renderToString } from '@solidjs/web'
import { plugin } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { mapStack } from '../src/build/sourcemap'
import { transformKay } from '../src/build/transform'
import { staticFor } from '../src/runtime/static'

plugin(kay())

interface TodoListModule {
  default: (props: { todos: Todo[], title?: string }) => unknown
}

// Hydratable markup separates dynamic text with comment markers; the assertions read the text alone.
const MARKERS = /<!--[$/]-->/g
const HYDRATION_KEY = / _hk=\w+/g

const { default: TodoList } = await import(join(import.meta.dir, 'fixtures/app/src/todo-list.kay')) as TodoListModule

const todos: Todo[] = [
  { id: 1, title: 'Write the compiler', done: true },
  { id: 2, title: 'Ship <it>', done: false },
]

describe('server rendering through the Bun plugin', () => {
  it('renders a .kay tree with props, defaults, loops and child components', () => {
    const html = renderToString(() => TodoList({ todos })).replace(MARKERS, '')

    expect(html).toContain('<h1>Todos</h1>')
    expect(html).toContain('placeholder="Filter"')
    expect(html).toContain('class="todo done"')
    expect(html).toContain('1. Write the compiler')
    expect(html).toContain('2. Ship &lt;it>')
    expect(html).not.toContain('Nothing matches')
  })

  it('renders the for fallback and an overridden default', () => {
    const html = renderToString(() => TodoList({ todos: [], title: 'Empty' })).replace(MARKERS, '')

    expect(html).toContain('<h1>Empty</h1>')
    expect(html).toContain('Nothing matches')
  })
})

describe('staticFor', () => {
  it('renders each row once with the index for loops keyed by position, an accessor otherwise, and the fallback when empty', () => {
    const row = (item: () => string, index: unknown) => typeof index === 'function' ? `${item()}@${(index as () => number)()}()` : `${item()}@${String(index)}`

    expect(staticFor(['a', 'b'], row, true)).toEqual(['a@0', 'b@1'])
    expect(staticFor(['a', 'b'], row, false)).toEqual(['a@0()', 'b@1()'])
    expect(staticFor(null, row, false, () => 'none')).toBe('none')
    expect(staticFor(false, row, false)).toBeNull()
    expect(staticFor([], row, true, () => 'none')).toBe('none')
  })
})

interface InlineModule {
  default: (props: Record<string, unknown>) => unknown
  load?: (context: unknown) => Promise<Record<string, unknown>>
}

const scratch = await mkdtemp(join(import.meta.dir, '.render-'))
let cases = 0

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

// Writes the component into the project so its imports resolve, runs a `--- server` fence's load, and renders the result.
async function renderKay(source: string, props: Record<string, unknown> = {}, directory = scratch): Promise<string> {
  const file = join(directory, `case-${cases++}.kay`)

  await Bun.write(file, source)

  const module = await import(file) as InlineModule
  const data = module.load ? { ...props, ...await module.load({ params: {} }) } : props

  return renderToString(() => module.default(data)).replace(MARKERS, '')
}

describe('server fence declarations', () => {
  it('render when a declaration carries a type annotation', async () => {
    expect(await renderKay('--- server\nconst title: string = \'T\'\nlet count: number = 3\n---\nh1 {title} {count}')).toBe('<h1 _hk=0>T 3</h1>')
  })

  it('render enums, repeated var declarations and ambient declarations', async () => {
    expect(await renderKay('--- server\nenum Color { Red = \'red\' }\nvar x = 1\nvar x = 2\ndeclare const dd: number\nnamespace Util { export const one = 1 }\n---\np {Color.Red} {x} {Util.one}')).toBe('<p _hk=0>red 2 1</p>')
  })

  it('render when both fences import the same names', async () => {
    await Bun.write(join(scratch, 'fmt.ts'), 'export const fmt = (n: number) => `#${n}`\nexport type Row = { id: number }\n')

    const html = await renderKay('--- server\nimport { fmt } from \'./fmt\'\nimport type { Row } from \'./fmt\'\nconst a = fmt(1)\nconst row = { id: 2 } as Row\n---\n---\nimport { fmt } from \'./fmt\'\nimport type { Row } from \'./fmt\'\nconst b = fmt(row.id)\n---\np {a} {b}')

    expect(html).toBe('<p _hk=0>#1 #2</p>')
  })
})

describe('component tags', () => {
  const Icon = (props: { n?: string }) => `<i>${props.n}</i>`
  const Wrap = (props: { children?: unknown }) => props.children

  it('render a prop as the component, children included', async () => {
    const html = await renderKay('---\nconst { Icon, Wrap, label } = props<{ Icon: unknown, Wrap: unknown, label: string }>()\n---\nIcon(n="x")\nWrap\n  p {label}', { Icon, Wrap, label: 'L' })

    expect(html).toBe('&lt;i>x&lt;/i><p _hk=0>L</p>')
  })

  it('render each loop item as the component', async () => {
    const html = await renderKay('---\nconst { comps } = props<{ comps: unknown[] }>()\n---\nfor C of comps key={C}\n  C(n="1")\n    p child', { comps: [Icon, Wrap] })

    expect(html).toContain('&lt;i>1&lt;/i>')
    expect(html).toContain('<p _hk=')
  })

  it('render a prop default as the component', async () => {
    const html = await renderKay('---\nconst { Icon = Fallback } = props<{ Icon?: unknown }>()\nconst Fallback = (props: { n?: string }) => `fallback ${props.n}`\n---\nIcon(n="1")')

    expect(html).toBe('fallback 1')
  })
})

describe('component function names', () => {
  it('leave the globals a template reads alone', async () => {
    const directory = join(scratch, 'names')

    await Bun.write(join(directory, 'date.kay'), '---\nconst { ts } = props<{ ts: number }>()\n---\np {new Date(ts).getUTCFullYear()}\n')

    const module = await import(join(directory, 'date.kay')) as InlineModule

    expect(renderToString(() => module.default({ ts: 0 })).replace(MARKERS, '')).toBe('<p _hk=0>1970</p>')
  })
})

describe('prop defaults', () => {
  const source = '---\nconst { size = \'md\', opts = make(), label = \'x\' } = props<{ size?: string, opts?: { n: number }, label?: string | null }>()\nfunction make() {\n  calls.push(1)\n\n  return { n: 7 }\n}\n---\np {size} {opts.n} {label}'
  const calls: number[] = []

  it('apply to undefined only, and a null stays null', async () => {
    Object.assign(globalThis, { calls })

    expect(await renderKay(source, { size: 'lg', opts: { n: 1 }, label: null })).toBe('<p _hk=0>lg 1 </p>')
    expect(await renderKay(source, {})).toBe('<p _hk=0>md 7 x</p>')
  })

  it('run only for the props that are not passed', async () => {
    Object.assign(globalThis, { calls })
    calls.length = 0
    await renderKay(source, { opts: { n: 1 } })

    expect(calls).toEqual([])
  })

  it('run once per component, however often the prop is read, keeping one value', async () => {
    Object.assign(globalThis, { calls })
    calls.length = 0

    expect(await renderKay('---\nconst { opts = make() } = props<{ opts?: { n: number } }>()\nfunction make() {\n  calls.push(1)\n\n  return { n: 7 }\n}\n---\np {opts.n} {String(opts === opts)}', {})).toBe('<p _hk=0>7 true</p>')
    expect(calls).toEqual([1])
  })

  it('are read where the prop is read, not once up front', async () => {
    let reads = 0
    const props = { get size() {
      return reads++ === 0 ? undefined : 'lg'
    } }

    expect(await renderKay('---\nconst { size = \'md\' } = props<{ size?: string }>()\n---\np {size} {size}', props)).toBe('<p _hk=0>md lg</p>')
  })
})

describe('slots with parameters', () => {
  it('render once per call the component makes, with the arguments it passes', async () => {
    await Bun.write(join(scratch, 'rows.kay'), '--- <T>\nimport type { JSX } from \'@solidjs/web\'\n\nconst { items, row } = props<{ items: T[], row: (item: T, index: number) => JSX.Element }>()\n---\nul\n  for item, i of items key={i}\n    | {row(item, i)}\n')

    const html = await renderKay('---\nimport Rows from \'./rows.kay\'\nconst { names } = props<{ names: string[] }>()\n---\nRows(items={names})\n  @row(name, i)\n    li {i}: {name}', { names: ['a', 'b'] })

    expect(html.replaceAll(HYDRATION_KEY, '')).toBe('<ul><li>0: a</li><li>1: b</li></ul>')
  })
})

describe('typeof in a template expression', () => {
  it('reads the type of a loop item, an alias and a prop with a default, which render as values', async () => {
    const source = '---\nconst { rows, size = \'md\' } = props<{ rows: { id: number }[], size?: string }>()\n---\nfor row of rows key={row.id}\n  p {[row.id as typeof row.id, size as typeof size].join()}\nif rows[0] as first\n  p {(first as typeof first).id}'

    expect(await renderKay(source, { rows: [{ id: 1 }] })).toBe('<p _hk=000>1,md</p><p _hk=220>1</p>')
  })
})

describe('class shorthand with a spread', () => {
  const spread = { class: 'FROM', title: 't' }

  it('merges the shorthand, the class attribute and the spread\'s class', async () => {
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a({...sp})', { sp: spread })).toBe('<p _hk=0 title="t" class="a FROM"></p>')
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a({...sp} class="z")', { sp: spread })).toBe('<p _hk=0 title="t" class="a FROM z"></p>')
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a(class="z" title="own" {...sp})', { sp: spread })).toBe('<p _hk=0 title="t" class="a z FROM"></p>')
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a({...sp} title="own")', { sp: spread })).toBe('<p _hk=0 title="own" class="a FROM"></p>')
  })

  it('merges a class attribute with the spread\'s class without the shorthand too', async () => {
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np(class="z" {...sp})', { sp: spread })).toBe('<p _hk=0 title="t" class="z FROM"></p>')
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np({...sp} class={["y", "z"]})', { sp: spread })).toBe('<p _hk=0 title="t" class="FROM y z"></p>')
  })

  it('renders a spread without a class as before', async () => {
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a({...sp})', { sp: { title: 't' } })).toBe('<p _hk=0 title="t" class="a"></p>')
  })
})

describe('text lines', () => {
  it('keep their line breaks', async () => {
    expect(await renderKay('pre\n  | a\n  | b\n  | c')).toBe('<pre _hk=0>a\nb\nc</pre>')
    expect(await renderKay('pre\n  | a\n  |   b {"x"}  c\n  |    d')).toBe('<pre _hk=0>a\n  b x  c\n   d</pre>')
    expect(await renderKay('textarea a   b')).toBe('<textarea _hk=0>a   b</textarea>')
    expect(await renderKay('---\nconst { n } = props<{ n: string }>()\n---\np\n  | line one\n  | line two {n}', { n: 'N' })).toBe('<p _hk=0>line one\nline two N</p>')
  })
})

describe('stack frames', () => {
  it('map to the .kay source when the path holds spaces and parentheses', async () => {
    const directory = join(scratch, 'my dir', 'a (1)')
    const file = join(directory, 'boom.kay')
    const source = '--- server\nconst kaboom = () => {\n  throw new Error(\'boom\')\n}\nkaboom()\n---\np never\n'
    const compiled = transformKay(source, file, { target: 'ssr' })
    const line = compiled.split('\n').findIndex(text => text.includes('throw new Error'))
    const column = compiled.split('\n')[line]!.indexOf('throw') + 1

    expect(mapStack(`    at kaboom (${file}:${line + 1}:${column})`)).toBe(`    at kaboom (${file}:3:3)`)
    expect(mapStack(`    at ${file}:${line + 1}:${column}`)).toBe(`    at ${file}:3:3`)
    expect(mapStack(`    at async <anonymous> (${file}:${line + 1}:${column})\n    at other (/x/y.ts:1:2)`)).toBe(`    at async <anonymous> (${file}:3:3)\n    at other (/x/y.ts:1:2)`)
  })
})
