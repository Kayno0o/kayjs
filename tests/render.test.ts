import type { JSX } from '../src/runtime/jsx'
import type { Todo } from './fixtures/app/src/todo'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { mapStack } from '../src/build/sourcemap'
import { transformKay } from '../src/build/transform'
import { UNCHECKED_TYPES, UNREQUIRABLE_TYPES } from '../src/compiler/ast'
import { collectHead } from '../src/runtime/head'
import { child, UNREQUIRABLE_TYPES as RUNTIME_UNREQUIRABLE, UNDESCRIBED_TYPES } from '../src/runtime/html'
import { renderLocale, renderToString } from '../src/server/string'
import { scratchDir } from './scratch'

await plugin(kay())

// An island's hydratable markup separates dynamic text with comment markers; the assertions read the text alone.
const MARKERS = /<!--[[\]]-->/g

interface TodoListModule {
  default: (props: { todos: Todo[], title?: string }) => unknown
}

const { default: TodoList } = await import(join(import.meta.dir, 'fixtures/app/src/todo-list.kay')) as TodoListModule

const todos: Todo[] = [
  { id: 1, title: 'Write the compiler', done: true },
  { id: 2, title: 'Ship <it>', done: false },
]

describe('server rendering through the Bun plugin', () => {
  it('renders a .kay tree with props, defaults, loops and child components', () => {
    const html = child(TodoList({ todos })).replace(MARKERS, '')

    expect(html).toContain('<h1>Todos</h1>')
    expect(html).toContain('placeholder="Filter"')
    expect(html).toContain('class="todo done"')
    expect(html).toContain('1. Write the compiler')
    expect(html).toContain('2. Ship &lt;it>')
    expect(html).not.toContain('Nothing matches')
  })

  it('renders the for fallback and an overridden default', () => {
    const html = child(TodoList({ todos: [], title: 'Empty' })).replace(MARKERS, '')

    expect(html).toContain('<h1>Empty</h1>')
    expect(html).toContain('Nothing matches')
  })
})

interface InlineModule {
  default: (props: Record<string, unknown>) => unknown
  load?: (context: unknown) => Promise<Record<string, unknown>>
}

const scratch = await scratchDir('render-')
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

  return child(module.default(data))
}

describe('images', () => {
  it('load lazily and decode off the main thread unless the template says otherwise, a spread carrying its own', async () => {
    const html = await renderKay('---\nconst own = { loading: "eager" }\n---\nimg(src="/a.png" alt="")\nimg(src="/b.png" alt="" fetchpriority="high")\nimg(src="/c.png" alt="" loading="eager" decoding="sync")\nimg(src="/d.png" alt="" {...own})')

    expect(html).toBe('<img src="/a.png" alt loading="lazy" decoding="async"><img src="/b.png" alt fetchpriority="high" decoding="async"><img src="/c.png" alt loading="eager" decoding="sync"><img decoding="async" src="/d.png" alt loading="eager">')
  })
})

describe('describeField', () => {
  beforeAll(async () => {
    await Bun.write(join(scratch, 'describe-field.ts'), 'import { describeField } from \'kay\'\n\nexport const describe = (ids: string) => describeField(ids)\n')
    await Bun.write(join(scratch, 'describe-required.ts'), 'import { describeField } from \'kay\'\n\nexport const describe = (ids: string, required: boolean | \'all\') => describeField(ids, { required })\n')
    await Bun.write(join(scratch, 'described-required.kay'), '---\nimport { describe } from \'./describe-required\'\n\nconst { ids, required } = props<{ ids: string, required: boolean | \'all\' }>()\n\ndescribe(ids, required)\n---\nlabel\n  slot\n')
    await Bun.write(join(scratch, 'described.kay'), '---\nimport { describe } from \'./describe-field\'\n\nconst { ids } = props<{ ids: string }>()\n\ndescribe(ids)\n---\nlabel\n  slot\n')
  })

  // The compiler decides a written type, the runtime one an expression or a spread gives.
  it('skips the same input types on the compiled path as at render time', () => {
    expect([...UNDESCRIBED_TYPES]).toEqual([...UNCHECKED_TYPES])
    expect([...RUNTIME_UNREQUIRABLE]).toEqual([...UNREQUIRABLE_TYPES])
  })

  it('hands the first described field its component renders the ids, beside its own, whether written out or spread', async () => {
    const html = await renderKay('---\nimport Described from \'./described.kay\'\n\nconst spread = { name: \'s\' }\n---\nDescribed(ids="hint")\n  input(type="hidden" name="x")\n  input(name="a" aria-describedby="own")\n  input(name="b")\nDescribed(ids="hint issues")\n  select({...spread})\nDescribed(ids="")\n  textarea(name="t")\ninput(name="outside")')

    expect(html).toBe('<label><input type="hidden" name="x"><input name="a" aria-describedby="own hint"><input name="b"></label><label><select name="s" aria-describedby="hint issues"></select></label><label><textarea name="t"></textarea></label><input name="outside">')
  })

  it('gives the first described field aria-required, or each field with all, unless a hidden or button field or the field itself says otherwise', async () => {
    const html = await renderKay('---\nimport Required from \'./described-required.kay\'\n\nconst spread = { name: \'s\' }\nconst text = \'text\'\nconst radio = \'radio\'\nconst none: string | undefined = undefined\nconst given: string | undefined = \'false\'\n---\nRequired(ids="hint" required={true})\n  input(type="hidden" name="x")\n  input(name="a")\n  input(name="b")\nRequired(ids="" required="all")\n  input(type="checkbox" name="c")\n  button(type="button") Pick\n  input(type={text} name="d")\n  select({...spread})\n  input(name="e" aria-required="false")\n  input(name="i" aria-required={none})\n  input(name="j" aria-required={given})\n  input(type="radio" name="g")\n  input(type={radio} name="h")\nRequired(ids="hint" required={false})\n  input(name="f")\ninput(name="outside")')

    expect(html).toBe('<label><input type="hidden" name="x"><input name="a" aria-describedby="hint" aria-required="true"><input name="b"></label><label><input type="checkbox" name="c" aria-required="true"><button type="button">Pick</button><input type="text" name="d" aria-required="true"><select name="s" aria-required="true"></select><input name="e" aria-required="false"><input name="i" aria-required="true"><input name="j" aria-required="false"><input type="radio" name="g"><input type="radio" name="h"></label><label><input name="f" aria-describedby="hint"></label><input name="outside">')
  })

  // A signal makes the page an island, whose server render writes its fields through the same helpers.
  it.each([['a static component', ''], ['an island', 'import { signal } from \'kay\'\n\nconst n = signal(0)\n']])('skips a field a type expression makes hidden or a button and keeps a bare description of the field\'s own, in %s', async (_name, island) => {
    const template = `---\n${island}import Described from './described.kay'\n\nconst hidden = 'hidden'\nconst text = 'text'\nconst submit = 'SUBMIT'\nconst bare = { 'name': 'p', 'aria-describedby': '' }\n---\nDescribed(ids="hint")\n  input(type={hidden} name="h")\n  input(type={text} name="t")\nDescribed(ids="more")\n  input(type={submit} name="s" aria-describedby="own")\n  input(name="b" aria-describedby)\ninput(name="o" aria-describedby)\ninput({...bare})\n${island ? 'button(onClick={() => n.set(1)}) {n()}\n' : ''}`
    const html = (await renderKay(template)).replace(MARKERS, '')

    expect(html).toContain('<label><input type="hidden" name="h"><input type="text" name="t" aria-describedby="hint"></label><label><input type="SUBMIT" name="s" aria-describedby="own"><input name="b" aria-describedby="more"></label><input name="o" aria-describedby=""><input name="p" aria-describedby="">')
  })
})

describe('server fence declarations', () => {
  it('render when a declaration carries a type annotation', async () => {
    expect(await renderKay('--- server\nconst title: string = \'T\'\nlet count: number = 3\n---\nh1 {title} {count}')).toBe('<h1>T 3</h1>')
  })

  it('render enums, repeated var declarations and ambient declarations', async () => {
    expect(await renderKay('--- server\nenum Color { Red = \'red\' }\nvar x = 1\nvar x = 2\ndeclare const dd: number\nnamespace Util { export const one = 1 }\n---\np {Color.Red} {x} {Util.one}')).toBe('<p>red 2 1</p>')
  })

  it('render when both fences import the same names', async () => {
    await Bun.write(join(scratch, 'fmt.ts'), 'export const fmt = (n: number) => `#${n}`\nexport type Row = { id: number }\n')

    const html = await renderKay('--- server\nimport { fmt } from \'./fmt\'\nimport type { Row } from \'./fmt\'\nconst a = fmt(1)\nconst row = { id: 2 } as Row\n---\n---\nimport { fmt } from \'./fmt\'\nimport type { Row } from \'./fmt\'\nconst b = fmt(row.id)\n---\np {a} {b}')

    expect(html).toBe('<p>#1 #2</p>')
  })
})

describe('component tags', () => {
  const Icon = (props: { n?: string }) => `<i>${props.n}</i>`
  const Wrap = (props: { children?: unknown }) => props.children

  it('render a prop as the component, children included', async () => {
    const html = await renderKay('---\nconst { Icon, Wrap, label } = props<{ Icon: unknown, Wrap: unknown, label: string }>()\n---\nIcon(n="x")\nWrap\n  p {label}', { Icon, Wrap, label: 'L' })

    expect(html).toBe('&lt;i>x&lt;/i><p>L</p>')
  })

  it('render each loop item as the component', async () => {
    const html = await renderKay('---\nconst { comps } = props<{ comps: unknown[] }>()\n---\nfor C of comps key={C}\n  C(n="1")\n    p child', { comps: [Icon, Wrap] })

    expect(html).toContain('&lt;i>1&lt;/i>')
    expect(html).toContain('<p>child</p>')
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

    expect(child(module.default({ ts: 0 }))).toBe('<p>1970</p>')
  })
})

describe('prop defaults', () => {
  const source = '---\nconst { size = \'md\', opts = make(), label = \'x\' } = props<{ size?: string, opts?: { n: number }, label?: string | null }>()\nfunction make() {\n  calls.push(1)\n\n  return { n: 7 }\n}\n---\np {size} {opts.n} {label}'
  const calls: number[] = []

  it('apply to undefined only, and a null stays null', async () => {
    Object.assign(globalThis, { calls })

    expect(await renderKay(source, { size: 'lg', opts: { n: 1 }, label: null })).toBe('<p>lg 1 </p>')
    expect(await renderKay(source, {})).toBe('<p>md 7 x</p>')
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

    expect(await renderKay('---\nconst { opts = make() } = props<{ opts?: { n: number } }>()\nfunction make() {\n  calls.push(1)\n\n  return { n: 7 }\n}\n---\np {opts.n} {String(opts === opts)}', {})).toBe('<p>7 true</p>')
    expect(calls).toEqual([1])
  })

  it('are read where the prop is read, not once up front', async () => {
    let reads = 0
    const props = { get size() {
      return reads++ === 0 ? undefined : 'lg'
    } }

    expect(await renderKay('---\nconst { size = \'md\' } = props<{ size?: string }>()\n---\np {size} {size}', props)).toBe('<p>md lg</p>')
  })
})

describe('props read off the props object', () => {
  it('apply a default to a renamed and a quoted key, and hand the rest on', async () => {
    const source = '---\nconst { size = \'md\', label: text = \'x\', \'aria-label\': aria = \'y\', ...rest } = props<{ size?: string, label?: string, \'aria-label\'?: string, id?: string }>()\n---\np(aria-label={aria} {...rest}) {size} {text}'

    expect(await renderKay(source, {})).toBe('<p aria-label="y">md x</p>')
    expect(await renderKay(source, { 'size': 'lg', 'label': 'L', 'aria-label': 'A', 'id': 'i' })).toBe('<p aria-label="A" id="i">lg L</p>')
  })

  it('leave a name that shadows a prop alone, spell out a shorthand property and keep a named props object', async () => {
    expect(await renderKay('---\nconst { item } = props<{ item: string }>()\nconst upper = (item: string) => item.toUpperCase()\n---\np {upper(item)} {item}', { item: 'a' })).toBe('<p>A a</p>')
    expect(await renderKay('---\nconst { id } = props<{ id: number }>()\nconst payload = { id }\n---\np {payload.id}', { id: 4 })).toBe('<p>4</p>')
    expect(await renderKay('---\nconst p = props<{ a: number }>()\n---\np {p.a}', { a: 5 })).toBe('<p>5</p>')
  })

  it('write the id shorthand beside classes', async () => {
    expect(await renderKay('#main.x')).toBe('<div id="main" class="x"></div>')
  })
})

// The non-island render (no signal in the component), whose first render parity.test.ts only holds as an island.
describe('slots, template consts and match', () => {
  const rows = '--- <T>\nimport type { JSX } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: (item: T, index: number) => JSX.Element }>()\n---\nul\n  for item, i of items key={i}\n    | {row(item, i)}\n'
  const card = '---\nimport type { JSX } from \'kay\'\n\nconst { items, actions, row } = props<{ items: string[], actions?: JSX.Element, row?: (item: string, index: number) => JSX.Element }>()\n---\nheader\n  slot actions\n    | No actions\nul\n  for item, i of items key={i}\n    slot row(item, i)\n      li {item}\nslot\n  p Empty\n'
  const box = '---\nimport type { JSX } from \'kay\'\n\nconst { children } = props<{ children: JSX.Element }>()\n---\ndiv.box\n  slot\n'
  const status = '---\nconst { status } = props<{ status: string }>()\n---\nmatch status\n  when \'draft\'\n    p Draft\n  when \'published\', \'scheduled\'\n    p Live\n  else\n    p Unknown'
  const consts = '---\nimport Box from \'./box.kay\'\n\nconst { products } = props<{ products: { name: string, cents: number, stock: number }[] }>()\n---\nconst count = products.length\np {count} products\nfor product of products\n  const price = (product.cents / 100).toFixed(2)\n  const { name, stock: left = 0 } = product\n  li(title={price}) {name}: {price}\n    if left < 3 as low\n      const label = \'only \' + low\n      b {label}\nBox\n  const total = products.reduce((sum, product) => sum + product.cents, 0)\n  | {total}\ntry\n  const twice = count * 2\n  i {twice}'
  const siblings = '---\nconst { n } = props<{ n: number }>()\n---\nconst double = n * 2\nbutton#up {double}\ndiv\n  p\n    const label = \'p\' + n\n    b {label}\n    i(title={label}) {double}\n  span\n    const label = \'s\' + double\n    | {label}\nif n > 1\n  const { big } = { big: n * 10 }\n  em {big}'
  const products = [{ name: 'Tea', cents: 250, stock: 1 }, { name: 'Mug', cents: 900, stock: 8 }]

  const table: [string, string, Record<string, unknown>, string][] = [
    ['a slot called once per item with its arguments', '---\nimport Rows from \'./rows.kay\'\nconst { names } = props<{ names: string[] }>()\n---\nRows(items={names})\n  @row(name, i)\n    li {i}: {name}', { names: ['a', 'b'] }, '<ul><li>0: a</li><li>1: b</li></ul>'],
    ['named slots given', '---\nimport Card from \'./card.kay\'\n---\nCard(items={[\'a\', \'b\']})\n  @actions\n    button Add\n  @row(name, i)\n    li {i}: {name}\n  p Body', {}, '<header><button>Add</button></header><ul><li>0: a</li><li>1: b</li></ul><p>Body</p>'],
    ['named slots left to their fallbacks', '---\nimport Card from \'./card.kay\'\n---\nCard(items={[\'a\']})', {}, '<header>No actions</header><ul><li>a</li></ul><p>Empty</p>'],
    ['template consts per block, in a slot and in a try', consts, { products }, '<p>2 products</p><li title="2.50">Tea: 2.50<b>only true</b></li><li title="9.00">Mug: 9.00</li><div class="box">1150</div><i>4</i>'],
    ['same-named consts in sibling elements, one in an if', siblings, { n: 1 }, '<button id="up">2</button><div><p><b>p1</b><i title="p1">2</i></p><span>s2</span></div>'],
    ['same-named consts with the if present', siblings, { n: 2 }, '<button id="up">4</button><div><p><b>p2</b><i title="p2">4</i></p><span>s4</span></div><em>20</em>'],
    ['match on a list of whens', status, { status: 'scheduled' }, '<p>Live</p>'],
    ['match falling to its else', status, { status: 'gone' }, '<p>Unknown</p>'],
  ]

  it.each(table)('render %s', async (_name, source, props, expected) => {
    await Bun.write(join(scratch, 'rows.kay'), rows)
    await Bun.write(join(scratch, 'card.kay'), card)
    await Bun.write(join(scratch, 'box.kay'), box)

    expect(await renderKay(source, props)).toBe(expected)
  })
})

describe('named slots', () => {
  it('read a line made of an expression as text', async () => {
    expect(await renderKay('---\nconst { name } = props<{ name: string }>()\n---\np\n  {name} <b>\n  | !', { name: 'kay' })).toBe('<p>kay &lt;b>\n!</p>')
  })
})

describe('match blocks', () => {
  it('render nothing without an else when no when holds the subject, and the innermost match of nested ones', async () => {
    const template = '---\nconst { status } = props<{ status: string }>()\n---\nmatch status\n  when \'draft\'\n    p Draft\n  when \'published\', \'scheduled\'\n    p Live\n'

    expect(await renderKay(template, { status: 'gone' })).toBe('')
    expect(await renderKay(`div\n  match 1\n    when 1\n      match 2\n        when 1\n          p a\n        when 2\n          p b`)).toBe('<div><p>b</p></div>')
  })
})

describe('template consts', () => {
  it('reach the head block when written before it', async () => {
    const file = join(scratch, 'titled.kay')

    await Bun.write(file, 'const name = \'Ada\'\nhead\n  title {name}\np {name}\n')

    const { default: Titled } = await import(file) as { default: () => unknown }
    const { head, result } = collectHead(() => child(Titled()))

    expect([head.html, result]).toEqual(['<title>Ada</title>', '<p>Ada</p>'])
  })

  it('compute their value once, however often the lines after them read it', async () => {
    const source = '---\nlet calls = 0\nconst next = () => ++calls\n---\nconst n = next()\np {n} {n} {n}\np {calls}'

    expect(await renderKay(source)).toBe('<p>1 1 1</p><p>1</p>')
  })
})

describe('typeof in a template expression', () => {
  it('reads the type of a loop item, an alias and a prop with a default, which render as values', async () => {
    const source = '---\nconst { rows, size = \'md\' } = props<{ rows: { id: number }[], size?: string }>()\n---\nfor row of rows key={row.id}\n  p {[row.id as typeof row.id, size as typeof size].join()}\nif rows[0] as first\n  p {(first as typeof first).id}'

    expect(await renderKay(source, { rows: [{ id: 1 }] })).toBe('<p>1,md</p><p>1</p>')
  })
})

describe('class shorthand with a spread', () => {
  const spread = { class: 'FROM', title: 't' }

  it('merges the shorthand, the class attribute and the spread\'s class', async () => {
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a({...sp})', { sp: spread })).toBe('<p title="t" class="a FROM"></p>')
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a({...sp} class="z")', { sp: spread })).toBe('<p title="t" class="a FROM z"></p>')
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a(class="z" title="own" {...sp})', { sp: spread })).toBe('<p title="t" class="a z FROM"></p>')
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a({...sp} title="own")', { sp: spread })).toBe('<p title="own" class="a FROM"></p>')
  })

  it('merges a class attribute with the spread\'s class without the shorthand too', async () => {
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np(class="z" {...sp})', { sp: spread })).toBe('<p title="t" class="z FROM"></p>')
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np({...sp} class={["y", "z"]})', { sp: spread })).toBe('<p title="t" class="FROM y z"></p>')
  })

  it('hands a component the merged class as one string, or none when nothing is set', async () => {
    await Bun.write(join(scratch, 'tagged.kay'), '---\nconst { class: className } = props<{ class?: string }>()\n---\np(title={`[${className}]`})\n')
    const tagged = async (call: string) => renderKay(`---\nimport Tagged from './tagged.kay'\n\nconst { sp, c } = props<{ sp: Record<string, string>, c?: string }>()\n---\n${call}`, { sp: spread, c: 'z' })

    expect(await tagged('Tagged({...sp} class={c})')).toBe('<p title="[FROM z]"></p>')
    expect(await tagged('Tagged.a(class={c})')).toBe('<p title="[a z]"></p>')
    expect(await tagged('Tagged({...sp} class={undefined})')).toBe('<p title="[FROM]"></p>')
    expect(await tagged('Tagged({...{}} class={undefined})')).toBe('<p title="[undefined]"></p>')
    // An element keeps writing what it merges, even empty.
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np({...sp} class={undefined})', { sp: { title: 't' } })).toBe('<p title="t" class=""></p>')
  })

  it('renders a spread without a class as before', async () => {
    expect(await renderKay('---\nconst { sp } = props<{ sp: Record<string, string> }>()\n---\np.a({...sp})', { sp: { title: 't' } })).toBe('<p title="t" class="a"></p>')
  })
})

describe('text lines', () => {
  it('keep their line breaks', async () => {
    expect(await renderKay('pre\n  | a\n  | b\n  | c')).toBe('<pre>a\nb\nc</pre>')
    expect(await renderKay('pre\n  | a\n  |   b {"x"}  c\n  |    d')).toBe('<pre>a\n  b x  c\n   d</pre>')
    expect(await renderKay('p\n  | one\n  b two\n  | three')).toBe('<p>one<b>two</b>three</p>')
    expect(await renderKay('textarea a   b')).toBe('<textarea>a   b</textarea>')
    expect(await renderKay('---\nconst { n } = props<{ n: string }>()\n---\np\n  | line one\n  | line two {n}', { n: 'N' })).toBe('<p>line one\nline two N</p>')
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

  it('map a static component\'s island twin to its .kay file', () => {
    const file = join(scratch, 'twin.kay')
    const source = '---\nconst kaboom = (): string => {\n  throw new Error(\'boom\')\n}\n---\np {kaboom()}\n'
    const compiled = transformKay(source, `${file}?island`, { target: 'ssr', hydratable: true })
    const line = compiled.split('\n').findIndex(text => text.includes('throw new Error'))
    const column = compiled.split('\n')[line]!.indexOf('throw') + 1

    expect(compiled).toContain('from \'kay/html\'')
    expect(mapStack(`    at kaboom (${file}?island:${line + 1}:${column})`)).toBe(`    at kaboom (${file}:3:3)`)
    expect(mapStack(`Error at ${file}?island:${line + 1}:${column}`)).toBe(`Error at ${file}:3:3`)
  })
})

describe('static server output', () => {
  it('builds markup with kay\'s HTML runtime only', () => {
    const file = join(scratch, 'plain-page.kay')
    const compiled = transformKay('--- server\nconst rows = [1, 2]\n---\nul\n  for row of rows key={row}\n    li {row}\n', file, { target: 'ssr', hydratable: true })

    expect(compiled).not.toContain('solid')
  })

  it('writes attributes as HTML reads them', async () => {
    const source = '---\nconst { off, on, none, cls, css } = props<{ off: boolean, on: boolean, none?: string, cls: unknown, css: Record<string, string | null> }>()\n---\np(title="a &amp; b & c" data-e="" hidden aria-a={off} aria-b={on} aria-c={none} class={cls} style={css})'
    const html = await renderKay(source, { off: false, on: true, cls: ['x', { y: true, z: false }, 0], css: { color: 'red', margin: null } })

    expect(html).toBe('<p title="a &amp; b &amp; c" data-e hidden aria-a="false" aria-b="true" class="0 x y" style="color:red"></p>')
    expect(await renderKay('details(open) more')).toBe('<details open>more</details>')
  })

  it('sets content from innerHTML, textContent and a textarea value, and marks the selected option', async () => {
    const source = '---\nconst { markup, text, choice } = props<{ markup: string, text: string, choice: string }>()\n---\ndiv(innerHTML={markup})\ndiv(textContent={text})\ntextarea(value={text})\nselect(value={choice})\n  option(value="a") A\n  option(value="b") B\n  option C'
    const html = await renderKay(source, { markup: '<b>x</b>', text: '<i>', choice: 'C' })

    expect(html).toBe('<div><b>x</b></div><div>&lt;i></div><textarea>&lt;i></textarea><select value="C"><option value="a">A</option><option value="b">B</option><option selected>C</option></select>')
  })

  it('renders a bound value as the property it binds, read off its signal', async () => {
    const source = '---\nimport { signal } from \'kay\'\n\nconst empty = signal(\'\')\nconst on = signal(true)\nconst text = signal(\'<i>\')\nconst choice = signal(\'b\')\n---\ninput(bind:value={empty})\ninput(type="checkbox" bind:checked={on})\ntextarea(bind:value={text})\nselect(bind:value={choice})\n  option(value="a") A\n  option(value="b") B'
    const html = await renderKay(source)

    expect(html).toEndWith('data-props="[{}]"><input value=""><input type="checkbox" checked><textarea>&lt;i></textarea><select value="b"><option value="a">A</option><option value="b" selected>B</option></select></slot>')
  })

  it('leaves a transition out of the markup, which only an island plays', async () => {
    expect(await renderKay('p(transition="fade" transition:enter="duration-200" class="note") x')).toBe('<p class="note">x</p>')
  })

  it('leaves script and style text unescaped', async () => {
    expect(await renderKay('---\nconst { code } = props<{ code: string }>()\n---\nscript {code}', { code: 'a < b && c' })).toBe('<script>a < b && c</script>')
  })

  it('keeps a value from closing its script or style element, or opening a comment in it', async () => {
    expect(await renderKay('---\nconst { css } = props<{ css: string }>()\n---\nstyle {css}', { css: 'a{}</STYLE><img src=x onerror=alert(1)>' })).toBe('<style>a{}<\\/STYLE><img src=x onerror=alert(1)></style>')
    expect(await renderKay('---\nconst { code } = props<{ code: string }>()\n---\nscript {code}', { code: 'x = "<!--</script>"' })).toBe('<script>x = "<\\!--<\\/script>"</script>')
  })

  it('passes a component its text children and quoted props as JSX would, and renders children only when read', async () => {
    await Bun.write(join(scratch, 'echo.kay'), '---\nconst { label, children } = props<{ label: string, children?: string }>()\n---\nspan(title={children}) {label}\n')
    await Bun.write(join(scratch, 'hidden.kay'), 'p none\n')

    const reads: string[] = []

    Object.assign(globalThis, { reads })

    const html = await renderKay('---\nimport Echo from \'./echo.kay\'\nimport Hidden from \'./hidden.kay\'\nconst mark = () => reads.push(\'read\')\n---\nEcho(label="Tom &amp; Jerry") a &amp; b\nHidden\n  p {mark()}')

    expect(html).toBe('<span title="a &amp; b">Tom &amp; Jerry</span><p>none</p>')
    expect(reads).toEqual([])
  })

  it('renders a tag read off a default as the element it names', async () => {
    expect(await renderKay('---\nconst { Tag = \'section\' } = props<{ Tag?: unknown }>()\n---\nTag(id="x") hi')).toBe('<section id="x">hi</section>')
  })
})

describe('renderToString', () => {
  async function load<P extends object = object>(source: string): Promise<(props: P) => JSX.Element> {
    const file = join(scratch, `case-${cases++}.kay`)

    await Bun.write(file, source)

    return (await import(file) as { default: (props: P) => JSX.Element }).default
  }

  it('renders a component with its props, waiting for its await blocks', async () => {
    const view = await load<{ name: string, rows: Promise<string[]> }>('---\nimport { defer } from \'kay\'\n\nconst { name, rows } = props<{ name: string, rows: Promise<string[]> }>()\nconst list = defer(rows)\n---\np Hello {name}\nawait list\n  p Loading\nthen items\n  ul\n    for item of items\n      li {item}')

    expect(await renderToString(view, { name: 'Ada', rows: Promise.resolve(['one', 'two']) })).toBe('<p>Hello Ada</p><ul><li>one</li><li>two</li></ul>')
  })

  it('renders the catch block of a value that rejects, and fails when there is none', async () => {
    const caught = await load<{ value: Promise<string> }>('---\nimport { defer } from \'kay\'\n\nconst { value } = props<{ value: Promise<string> }>()\nconst shown = defer(value)\n---\nawait shown then text\n  p {text}\ncatch\n  p Unavailable')
    const uncaught = await load<{ value: Promise<string> }>('---\nimport { defer } from \'kay\'\n\nconst { value } = props<{ value: Promise<string> }>()\nconst shown = defer(value)\n---\nawait shown then text\n  p {text}')

    expect(await renderToString(caught, { value: Promise.reject(new Error('down')) })).toBe('<p>Unavailable</p>')
    await expect(renderToString(uncaught, { value: Promise.reject(new Error('down')) })).rejects.toThrow('down')
  })

  it('renders several blocks in place, and one nested in a then block once its own value settles', async () => {
    const view = await load<{ first: Promise<string>, second: Promise<string>, inner: Promise<string> }>('---\nimport { defer } from \'kay\'\n\nconst { first, second, inner } = props<{ first: Promise<string>, second: Promise<string>, inner: Promise<string> }>()\nconst a = defer(first)\nconst b = defer(second)\nconst c = defer(inner)\n---\np start\nawait a then x\n  p {x}\n  await c then y\n    p {y}\np middle\nawait b then z\n  p {z}')

    expect(await renderToString(view, { first: Promise.resolve('one'), second: (async () => {
      await Bun.sleep(5)

      return 'two'
    })(), inner: Promise.resolve('nested') })).toBe('<p>start</p><p>one</p><p>nested</p><p>middle</p><p>two</p>')
  })

  it('imports t for a template and a script reading it unimported, in a project with no i18n settings', async () => {
    const project = join(scratch, 'unimported')

    await Bun.write(join(project, 'src/messages/en.ts'), 'export default { hello: \'Hello {name}\', bye: \'Bye\' }\n')
    const view = await load<{ name: string }>('---\nconst { name } = props<{ name: string }>()\nconst bye = t(\'bye\')\n---\np {t(\'hello\', { name })} {bye}')
    const shadowed = await load('for t of [\'x\']\n  p {t}')
    const saved = process.env.KAY_ROOT

    process.env.KAY_ROOT = project

    try {
      expect(await renderToString(view, { name: 'Ada' })).toBe('<p>Hello Ada Bye</p>')
      expect(await renderToString(shadowed, {})).toBe('<p>x</p>')
    }
    finally {
      if (saved === undefined)
        delete process.env.KAY_ROOT
      else
        process.env.KAY_ROOT = saved
    }
  })

  it('runs t() and the formatters outside a request in the site\'s default locale, or in the one given', async () => {
    const project = join(scratch, 'localized')

    await Promise.all([
      Bun.write(join(project, 'kay.config.ts'), 'export default { i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } }\n'),
      Bun.write(join(project, 'src/messages/en.ts'), 'export default { hello: \'Hello {name}\', only: \'English only\' }\n'),
      Bun.write(join(project, 'src/messages/fr.ts'), 'export default { hello: \'Bonjour {name}\' }\n'),
    ])
    const view = await load<{ name: string }>('---\nimport { formatNumber, locale, t } from \'kay/i18n\'\n\nconst { name } = props<{ name: string }>()\n---\np(lang={locale()}) {t(\'hello\', { name })} {t(\'only\')} {formatNumber(1234.5)}')
    const saved = process.env.KAY_ROOT

    process.env.KAY_ROOT = project

    try {
      expect(await renderToString(view, { name: 'Ada' })).toBe('<p lang="en">Hello Ada English only 1,234.5</p>')
      expect(await renderToString(view, { name: 'Ada' }, { locale: 'fr' })).toBe('<p lang="fr">Bonjour Ada English only 1\u202F234,5</p>')
      expect(await renderLocale()).toBe('en')
      expect(await renderLocale('fr')).toBe('fr')
      await expect(renderLocale('de')).rejects.toThrow('none of the site\'s locales')
      await expect(renderToString(view, { name: 'Ada' }, { locale: 'de' })).rejects.toThrow('renderToString renders in de, which is none of the site\'s locales: en, fr')
    }
    finally {
      if (saved === undefined)
        delete process.env.KAY_ROOT
      else
        process.env.KAY_ROOT = saved
    }
  })

  it('takes no props argument for a component without required props', async () => {
    const view = await load('p Static')

    expect(await renderToString(view)).toBe('<p>Static</p>')
  })
})
