import { describe, expect, it } from 'bun:test'
import { compileKay, componentName } from '../src/compiler'

function tsx(source: string): string {
  const result = compileKay(source, 'test.kay')

  expect(result.diagnostics.map(d => d.message)).toEqual([])

  return result.tsx
}

function errors(source: string): string[] {
  return compileKay(source, 'test.kay').diagnostics.map(d => d.message)
}

// The returned JSX alone, which is where most assertions look.
function jsx(source: string): string {
  const code = tsx(source)

  return code.slice(code.indexOf('return ') + 7, code.lastIndexOf('\n}'))
}

describe('component shell', () => {
  it('hoists imports and types above the component and keeps the rest in its body', () => {
    const code = tsx('---\nimport { format } from \'./format\'\ntype Size = \'sm\' | \'md\'\nconst label = format(1)\n---\np {label}')

    expect(code).toStartWith('import { format } from \'./format\'\ntype Size = \'sm\' | \'md\'\n')
    expect(code).toContain('export default function Test() {')
    expect(code).toContain('const label = format(1)')
  })

  it('wraps an interactive component as an island', () => {
    const reactive = tsx('---\nimport { signal } from \'kay\'\nconst count = signal(0)\n---\np {count()}')

    expect(reactive).toContain('import { island as KayIsland } from \'kay/island\'')
    expect(reactive).toContain('\nfunction Test() {')
    expect(reactive).toEndWith('export default KayIsland("test.kay", Test)\n')
    expect(tsx('button(onClick={go}) Go')).toContain('export default KayIsland(')
    expect(tsx('input(bind:value={name})')).toContain('export default KayIsland(')
    expect(tsx('---\nimport type { Accessor } from \'solid-js\'\n---\np x')).toContain('export default function Test()')
  })

  it('names the component after its file', () => {
    expect(componentName('/app/src/todo-item.kay')).toBe('TodoItem')
    expect(componentName('_404.kay')).toBe('Page404')
  })

  it('renames the component when its script already uses the name, so an import of the same name is not shadowed', () => {
    const code = compileKay('---\nimport Table from \'./components/table.kay\'\n---\nTable', 'table.kay').tsx

    expect(code).toContain('export default function TablePage()')
    expect(code).toContain('return <Table />')
    expect(compileKay('--- server\nconst Table = 1\nconst TablePage = 2\n---\np {Table + TablePage}', 'table.kay').tsx).toContain('function TablePagePage(')
  })

  it('wraps several root nodes in a fragment', () => {
    expect(jsx('h1 a\np b')).toBe('<><h1>a</h1><p>b</p></>')
  })
})

describe('props', () => {
  it('types the component from props<T>() and reads destructured names off the props object', () => {
    const code = tsx('---\nconst { title, count } = props<{ title: string, count: number }>()\nconst label = () => `${title}: ${count}`\n---\np {label()} {title}')

    expect(code).toContain('export default function Test(__props: { title: string, count: number }) {')
    expect(code).toContain('const label = () => `${__props.title}: ${__props.count}`')
    expect(code).toContain('<p>{label()} {__props.title}</p>')
    expect(code).not.toContain('} = __props')
  })

  it('applies defaults on every read and handles renames, quoted keys and the rest', () => {
    const code = tsx('---\nconst { size = \'md\', label: text, \'aria-label\': aria, ...rest } = props<{ size?: string, label: string, \'aria-label\'?: string, id?: string }>()\n---\nbutton(aria-label={aria} {...rest}) {size} {text}')

    expect(code).toContain('const __default_0 = (): Exclude<(typeof __props)["size"], undefined> => (\'md\');')
    expect(code).toContain('const rest = KayOmit(__props, "size", "label", "aria-label");')
    expect(code).toContain('aria-label={__props["aria-label"]}')
    expect(code).toContain('{(__props.size !== undefined ? __props.size : __default_0())} {__props.label}')
  })

  it('leaves shadowing names alone', () => {
    const code = tsx('---\nconst { item } = props<{ item: string }>()\nconst upper = (item: string) => item.toUpperCase()\n---\np {upper(item)}')

    expect(code).toContain('const upper = (item: string) => item.toUpperCase()')
    expect(code).toContain('{upper(__props.item)}')
  })

  it('spells out shorthand properties', () => {
    expect(tsx('---\nconst { id } = props<{ id: number }>()\nconst payload = { id }\n---\np x')).toContain('const payload = { id: __props.id }')
  })

  it('keeps a named props object as is', () => {
    expect(tsx('---\nconst p = props<{ a: number }>()\n---\np {p.a}')).toContain('const p = __props;')
  })

  it('rejects writes to props and misplaced props() calls', () => {
    expect(errors('---\nconst { a } = props<{ a: number }>()\na = 2\n---\np x')).toEqual([expect.stringContaining('props are read-only')])
    expect(errors('---\nconst f = () => props<{ a: number }>()\n---\np x')).toEqual([expect.stringContaining('only valid as')])
    expect(errors('---\nconst { a } = props()\n---\np x')).toEqual([expect.stringContaining('needs the props type')])
  })

  it('allows only type exports', () => {
    expect(tsx('---\nexport type Props = { a: number }\n---\np x')).toStartWith('export type Props')
    expect(errors('---\nexport const a = 1\n---\np x')).toEqual([expect.stringContaining('exports only types')])
  })
})

describe('control flow', () => {
  it('keys a for loop by an expression and reads the item through an accessor', () => {
    const out = jsx('ul\n  for todo, i of todos key={todo.id}\n    li(data-i={i}) {todo.title}')

    expect(out).toBe('<ul><KayFor each={todos} keyed={(todo) => (todo.id)}>{(todo, i) => <li data-i={i()}>{todo().title}</li>}</KayFor></ul>')
  })

  it('matches rows by position when the key is the index', () => {
    expect(jsx('for row, i of rows key={i}\n  p {i}: {row}')).toBe('<><KayFor each={rows} keyed={false}>{(row, i) => <p>{i}: {row()}</p>}</KayFor></>')
  })

  it('renders the loops of a page on the server without Solid\'s For, which only islands and browsers need', () => {
    const page = '--- server\nconst rows = [1]\n---\nul\n  for row, i of rows key={row}\n    li {i}: {row}\n  else\n    li none'
    const server = compileKay(page, 'src/routes/index.kay', { includeServer: true }).tsx

    expect(server).toContain('{KayStaticFor(__props.rows, (row, i) => <li>{i()}: {row()}</li>, false, () => <li>none</li>)}')
    expect(server).not.toContain('KayFor ')
    expect(compileKay(page, 'src/routes/index.kay', { includeServer: false }).tsx).toContain('<KayFor each={__props.rows}')
    expect(compileKay(page, 'src/routes/index.kay', { check: true }).tsx).toContain('<KayFor each={__props.rows}')
  })

  it('renders a for fallback', () => {
    expect(jsx('for t of list key={t}\n  p {t}\nelse\n  p none')).toContain('fallback={<p>none</p>}')
  })

  it('chains if branches as conditionals', () => {
    expect(jsx('if a\n  p a\nelse if b\n  p b\nelse\n  p c')).toBe('<>{(a) ? <p>a</p> : (b) ? <p>b</p> : <p>c</p>}</>')
  })

  it('narrows an aliased if through Show', () => {
    expect(jsx('if user() as u\n  p {u.name}\nelse\n  p anon')).toBe('<>{<KayShow when={user()} fallback={<p>anon</p>}>{(u) => <p>{u().name}</p>}</KayShow>}</>')
  })

  it('rejects writes to loop items', () => {
    expect(errors('for t of list key={t}\n  button(onClick={() => { t = 1 }}) x')).toEqual([expect.stringContaining('read-only')])
  })
})

describe('elements', () => {
  it('merges shorthand classes with the class attribute', () => {
    expect(jsx('p.a.md:b')).toBe('<p class="a md:b" />')
    expect(jsx('p.a(class="b")')).toBe('<p class="a b" />')
    expect(jsx('p.a(class={{ on: on() }})')).toBe('<p class={["a", ({ on: on() })]} />')
    expect(errors('p(class="a" class="b")')).toEqual([expect.stringContaining('one `class`')])
  })

  it('writes the id shorthand', () => {
    expect(jsx('#main.x')).toBe('<div id="main" class="x" />')
  })

  it('binds inputs both ways, with the right event and value type', () => {
    expect(jsx('input(bind:value={name})')).toBe('<input value={(name)()} onInput={(kayEvent) => (name).set(kayEvent.currentTarget.value)} />')
    expect(jsx('input(type="number" bind:value={n})')).toContain('{ const kayValue = kayEvent.currentTarget.valueAsNumber; if (!Number.isNaN(kayValue)) (n).set(kayValue) }')
    expect(jsx('input(type="checkbox" bind:checked={on})')).toContain('checked={(on)()} onChange=')
    expect(jsx('select(bind:value={v})')).toContain('onChange=')
    expect(errors('Field(bind:value={v})')).toEqual([expect.stringContaining('`bind:` works on')])
    expect(errors('input(bind:value={v} onInput={f})')).toEqual([expect.stringContaining('already handles')])
  })

  it('escapes text JSX would read as code', () => {
    expect(jsx('p a < b > c } \\{d')).toBe('<p>a {\'<\'} b {\'>\'} c {\'}\'} {\'{\'}d</p>')
  })

  it('passes slots as component props and rejects them elsewhere', () => {
    expect(jsx('Card\n  @header\n    h2 Title\n  p body')).toBe('<Card header={<h2>Title</h2>}><p>body</p></Card>')
    expect(errors('div\n  @header\n    h2 Title')).toEqual([expect.stringContaining('directly under a component')])
  })

  it('quotes static values JSX could not hold', () => {
    expect(jsx('p(title=\'say "hi"\')')).toBe('<p title=\'say "hi"\' />')
  })
})

describe('islands', () => {
  it('rejects hydrate inside an island, which hydrates as a whole', () => {
    expect(errors('---\nimport { signal } from "kay"\nimport Counter from "./counter.kay"\n---\nCounter(hydrate="visible")')).toEqual([expect.stringContaining('`hydrate` has no effect inside an island')])
    expect(errors('---\nimport Counter from "./counter.kay"\n---\nCounter(hydrate="visible")')).toEqual([])
  })
})

describe('head', () => {
  it('registers the head tags before rendering and leaves them out of the template', () => {
    const code = tsx('---\nconst { name } = props<{ name: string }>()\n---\nhead\n  title {name} | Docs\n  meta(name="description" content={name} data-x)\nh1 {name}')

    expect(code).toContain('import { useHead as KayUseHead } from \'@solidjs/web\'')
    expect(code).toContain('KayUseHead([{ tag: "title", props: { "children": "" + (__props.name) + " | Docs" } }, { tag: "meta", props: { "name": "description", "content": (__props.name), "data-x": true,  } }, ]);\n\nreturn <h1>{__props.name}</h1>')
  })

  it('types the head tags as elements when checking', () => {
    const checked = compileKay('head\n  link(rel="icon" href={icon})\np x', 'test.kay', { check: true }).tsx

    expect(checked).toContain('void (<><link rel="icon" href={icon} /></>);')
    expect(checked).not.toContain('KayUseHead')
  })

  it('rejects head blocks an island, a nested element or a second block holds, and content the head cannot', () => {
    expect(errors('---\nimport { signal } from "kay"\n---\nhead\n  title x\np')).toEqual([expect.stringContaining('An island also renders in the browser')])
    expect(errors('head\n  title a\nhead\n  title b')).toEqual(['A template has one `head` block'])
    expect(errors('div\n  head\n    title a')).toEqual(['A `head` block sits at the top level of a template'])
    expect(errors('head\n  div x\n  if a\n    title a')).toEqual([expect.stringContaining('holds `title`'), expect.stringContaining('holds `title`')])
    expect(errors('head\n  title Read #[b this]')).toEqual(['`title` holds text only'])
  })
})

describe('check-only assertions', () => {
  const source = '---\nimport Island from \'./island.kay\'\n---\na(href=\'/docs\') Docs\nform(action={save})\n  input(name=\'title\')\nIsland(when={today})'

  it('checks links, form fields and island props in type-checking output', () => {
    const checked = compileKay(source, 'test.kay', { check: true }).tsx

    expect(checked).toContain('<a href={KayHref("/docs")}>')
    expect(checked).toContain('<input name={KayField((save), "title")} />')
    expect(checked).toContain('<Island when={KayProp(Island)((today))} />')
  })

  it('keeps them out of the code that ships', () => {
    const built = compileKay(source, 'test.kay').tsx

    expect(built).toContain('<a href="/docs">')
    expect(built).toContain('<input name="title" />')
    expect(built).toContain('<Island when={today} />')
    expect(built).toContain('<form action={KayFormAction((save))} method="post" enctype="multipart/form-data">')
  })
})

describe('source mapping', () => {
  it('maps template expressions back to their exact source offsets', () => {
    const source = '---\nconst { todo } = props<{ todo: { title: string } }>()\n---\np {todo.title}'
    const { tsx: code, map } = compileKay(source, 'test.kay')
    const generated = code.indexOf('title}')

    expect(map.toSource(generated)).toBe(source.lastIndexOf('title'))
    expect(map.toGenerated(source.lastIndexOf('title'))).toBe(generated)
  })

  it('finds every copy of a name, and no run that merely ends where it starts', () => {
    const source = '---\nconst { title } = props<{ title: string }>()\n---\nul\n  for row of [title] key={row}\n    li {row && title}\n'
    const { tsx, map } = compileKay(source, 'test.kay', { check: true })
    const copies = (offset: number) => map.toGeneratedAll(offset).map(generated => tsx.slice(generated, generated + 3))

    // A loop's item goes into its key function and its row.
    expect(copies(source.indexOf('row of'))).toEqual(['row', 'row'])
    // `title` becomes `__props.title`, right after the run copying `row && `.
    expect(copies(source.lastIndexOf('title'))).toEqual(['tit'])
    expect(copies(source.indexOf('title'))).toEqual(['tit'])
  })
})

describe('server fence names', () => {
  const rewritten = (source: string) => compileKay(source, 'test.kay', { includeServer: true })

  it('keeps every rewrite when a declaration carries a type annotation', () => {
    const result = rewritten('--- server\nconst title: string = \'T\'\nlet count: number\nconst { a }: { a: number } = { a: 1 }\n---\nh1 {title} {count} {a}')

    expect(result.diagnostics).toEqual([])
    expect(result.tsx).toContain('return { title, count, a }')
    expect(result.tsx).toContain('<h1>{__props.title} {__props.count} {__props.a}</h1>')
  })

  it('hands on enums, once each name, and leaves ambient declarations and namespaces at module level', () => {
    const result = rewritten('--- server\nenum Color { Red = \'red\' }\nvar x = 1\nvar x = 2\ndeclare const dd: number\nnamespace Util { export const one = 1 }\ndeclare function ambient(): void\n---\np {Color.Red} {x} {Util.one}')
    const [module, load] = result.tsx.split('export async function load')

    expect(result.diagnostics).toEqual([])
    expect(load).toContain('return { Color, x }')
    expect(load).toContain('enum Color')
    expect(module).toContain('declare const dd: number')
    expect(module).toContain('namespace Util')
    expect(module).toContain('declare function ambient(): void')
    expect(load).not.toContain('namespace')
    expect(load).not.toContain('declare')
  })
})

describe('imports in both fences', () => {
  const both = (server: string, script: string) => compileKay(`--- server\n${server}\n---\n---\n${script}\n---\np x`, 'test.kay', { includeServer: true })

  it('declares an import both fences make once', () => {
    const result = both('import { fmt } from \'./fmt\'\nconst a = fmt(1)', 'import { fmt } from \'./fmt\'\nconst b = fmt(2)')

    expect(result.diagnostics).toEqual([])
    expect(result.tsx.match(/import \{ fmt \}/g)).toHaveLength(1)
    expect(both('import type { Row } from \'./fmt\'', 'import type { Row } from \'./fmt\'').tsx.match(/import type \{ Row \}/g)).toHaveLength(1)
  })

  it('leaves out only the names already imported, and the commas around them', () => {
    const result = both('import def, { a, b, c } from \'./m\'', 'import def, { b } from \'./m\'')

    expect(result.diagnostics).toEqual([])
    expect(result.tsx).toContain('import def, { b } from \'./m\'\nimport { a, c } from \'./m\'')
    expect(both('import { a, b } from \'./m\'', 'import { a } from \'./m\'').tsx).toContain('import { b } from \'./m\'')
  })

  it('reports a name imported two different ways', () => {
    expect(both('import { fmt } from \'./other\'', 'import { fmt } from \'./fmt\'').diagnostics.map(d => d.message)).toEqual([expect.stringContaining('`fmt` is imported twice')])
    expect(both('import { fmt as other } from \'./fmt\'', 'import { other } from \'./fmt\'').diagnostics).toHaveLength(1)
    expect(both('import { Row } from \'./fmt\'', 'import type { Row } from \'./fmt\'').diagnostics).toHaveLength(1)
  })
})

describe('component names', () => {
  it('takes a prop, a server value or a loop item as the component tag, opening and closing alike', () => {
    const code = tsx('---\nconst { Icon, Wrap, items } = props<{ Icon: unknown, Wrap: unknown, items: unknown[] }>()\n---\nIcon(n="x")\nWrap\n  p a\nfor Item of items key={Item}\n  Item(x="1")\n    p b')

    expect(code).toContain('<__props.Icon n="x" />')
    expect(code).toContain('<__props.Wrap><p>a</p></__props.Wrap>')
    expect(code).toContain('{(Item) => <KayDynamic component={Item()} x="1"><p>b</p></KayDynamic>}')
    expect(code).toContain('import { Dynamic as KayDynamic } from \'@solidjs/web\'')
  })

  it('reads a component prop with a default through Dynamic as well', () => {
    const code = tsx('---\nconst { Icon = Fallback } = props<{ Icon?: unknown }>()\nconst Fallback = () => null\n---\nIcon\n  p a')

    expect(code).toContain('<KayDynamic component={(__props.Icon !== undefined ? __props.Icon : __default_0())}><p>a</p></KayDynamic>')
  })

  it('renames the function when the template reads a global of its name', () => {
    expect(compileKay('---\nconst { ts } = props<{ ts: number }>()\n---\np {new Date(ts).getFullYear()}', 'date.kay').tsx).toContain('export default function DatePage(')
    expect(compileKay('p {Date.now()}', 'date.kay').tsx).toContain('export default function DatePage(')
    expect(compileKay('p {Date.now()}', 'other.kay').tsx).toContain('export default function Other(')
  })

  it('keeps the name for a template that renders the component itself', () => {
    expect(compileKay('---\nconst { n } = props<{ n: number }>()\n---\nif n > 0\n  Tree(n={n - 1})', 'tree.kay').tsx).toContain('export default function Tree(')
    expect(compileKay('---\nimport { signal } from \'kay\'\n---\np {Counter}', 'counter.kay').tsx).toContain('\nfunction CounterPage(')
  })
})

describe('prop defaults', () => {
  it('reads a default only for an undefined prop and runs it only then', () => {
    const code = tsx('---\nconst { opts = {}, fmt = (v: number) => String(v) } = props<{ opts?: { a?: number }, fmt?: (v: number) => string }>()\n---\np {opts.a} {fmt(1)}')

    expect(code).toContain('const __default_0 = (): Exclude<(typeof __props)["opts"], undefined> => ({});')
    expect(code).toContain('(__props.opts !== undefined ? __props.opts : __default_0()).a')
    expect(code).not.toContain('??')
  })

  it('applies a default to a renamed and a quoted key too', () => {
    const code = tsx('---\nconst { label: text = \'x\', \'aria-label\': aria = \'y\' } = props<{ label?: string, \'aria-label\'?: string }>()\n---\np {text} {aria}')

    expect(code).toContain('(__props.label !== undefined ? __props.label : __default_0())')
    expect(code).toContain('(__props["aria-label"] !== undefined ? __props["aria-label"] : __default_1())')
  })
})

describe('types in the component script', () => {
  it('keeps a type of a script name in the body, and the types built from it', () => {
    const code = tsx('---\nimport type { Foo } from \'./foo\'\nconst { a } = props<{ a: string }>()\nconst rows = [{ id: 1 }]\ntype Row = typeof rows[number]\ntype Rows = Row[]\ntype A = typeof a\ntype Plain = { id: number }\ninterface Shape { row: Row }\n---\np x')
    const [module, body] = code.split('export default function')

    expect(module).toContain('import type { Foo }')
    expect(module).toContain('type Plain = { id: number }')
    for (const text of ['type Row = typeof rows[number]', 'type Rows = Row[]', 'type A = typeof __props.a', 'interface Shape'])
      expect(body).toContain(text)

    expect(module).not.toContain('type Row')
  })

  it('keeps a type of a name the server fence hands on in the body', () => {
    const code = compileKay('--- server\nconst rows = [1]\ntype Row = typeof rows[number]\n---\n---\ntype Same = typeof rows\ntype Plain = string\n---\np x', 'test.kay', { includeServer: true }).tsx
    const load = code.slice(code.indexOf('export async function load'), code.indexOf('export default function'))

    expect(load).toContain('type Row = typeof rows[number]')
    expect(code.slice(code.indexOf('export default function'))).toContain('type Same = typeof __props.rows')
    expect(code.slice(0, code.indexOf('export async function load'))).toContain('type Plain = string')
  })

  it('reports an exported type that needs a script name', () => {
    expect(errors('---\nconst rows = [1]\nexport type Row = typeof rows[number]\n---\np x')).toEqual([expect.stringContaining('`Row` is exported')])
  })
})

describe('invalid code', () => {
  const at = (source: string) => compileKay(source, 'test.kay').diagnostics.map(d => ({ message: d.message, text: source.slice(d.start, d.start + 5) }))

  it('reports template expressions that do not parse at their position in the source', () => {
    expect(at('p {x +}')).toEqual([{ message: expect.stringContaining('Unexpected token'), text: '}' }])
    expect(at('---\nconst p = 1\n---\np {await p}')).toEqual([{ message: expect.stringContaining('read async data in the `--- server` fence'), text: 'await' }])
  })

  it('flags an await in the component script', () => {
    expect(at('---\nconst x = await Promise.resolve(1)\n---\np {x}')).toEqual([{ message: expect.stringContaining('\'await\''), text: 'await' }])
  })

  it('reports a duplicate declaration, which the generated code cannot hold', () => {
    expect(compileKay('--- server\nconst x = 1\n---\n---\nconst x = 2\n---\np {x}', 'test.kay').diagnostics.map(d => d.message)).toEqual([expect.stringContaining('already been declared')])
  })

  it('leaves the fence diagnostics alone when the code does not parse for their reason', () => {
    expect(compileKay('---\nconst x = (\n---\np x', 'test.kay').diagnostics).toHaveLength(1)
  })
})

describe('read-only diagnostics', () => {
  it('point at the name a statement writes, not at the start of the statement', () => {
    const source = '---\nconst { a, b, c, d } = props<{ a: number, b: number, c: number[], d: number }>()\nfunction f() {\n  a = 1\n  ++b\n  ;[d] = [2]\n  for (c of [[1]]) {}\n  ;({ x: a } = { x: 1 })\n}\n---\np x'
    const found = compileKay(source, 'test.kay').diagnostics.map(d => source.slice(d.start, d.end))

    expect(found).toEqual(['a', 'b', 'd', 'c', 'a'])
  })
})

describe('class shorthand', () => {
  it('merges with the class attribute and the class of every spread', () => {
    expect(jsx('p.a({...sp})')).toBe('<p {...sp} class={["a", ((sp) as unknown as { class?: string }).class]} />')
    expect(jsx('p.a({...sp} class="z")')).toBe('<p {...sp} class={["a", ((sp) as unknown as { class?: string }).class, "z"]} />')
    expect(jsx('p.a(class={c} {...sp})')).toBe('<p {...sp} class={["a", (c), ((sp) as unknown as { class?: string }).class]} />')
    expect(jsx('p.a(title="t" {...sp} id="i")')).toBe('<p title="t" {...sp} id="i" class={["a", ((sp) as unknown as { class?: string }).class]} />')
  })

  it('stays where it is without a spread', () => {
    expect(jsx('p.a(title="t" class="b")')).toBe('<p class="a b" title="t" />')
  })
})

describe('text lines', () => {
  it('separates consecutive lines with a line break, and nothing else', () => {
    expect(jsx('p\n  | one\n  | two {x}\n  | three')).toBe('<p>one{"\\n"}two {x}{"\\n"}three</p>')
    expect(jsx('p one\n  | two')).toBe('<p>one{"\\n"}two</p>')
    expect(jsx('p\n  | one\n  b two\n  | three')).toBe('<p>one<b>two</b>three</p>')
  })
})

describe('lowercase events', () => {
  it('suggests the camelCase name', () => {
    expect(errors('button(onclick={go}) x')).toEqual(['`onclick` does not attach a handler: events are written in camelCase, as `onClick`'])
    expect(errors('button(on:click={go}) x')).toEqual(['`on:click` does not attach a handler: events are written in camelCase, as `onClick`'])
    expect(errors('input(onkeydown={go} ondblclick={go})')).toEqual([expect.stringContaining('`onKeyDown`'), expect.stringContaining('`onDblClick`')])
  })

  it('leaves components, strings and the camelCase form alone', () => {
    expect(errors('Card(onclick={go})')).toEqual([])
    expect(errors('button(onclick="go()") x')).toEqual([])
    expect(errors('button(onClick={go}) x')).toEqual([])
  })
})
