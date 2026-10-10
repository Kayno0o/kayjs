import { describe, expect, it } from 'bun:test'
import { compileKay, componentName } from '../src/compiler'
import { moduleSignals } from '../src/compiler/module-signals'

function tsx(source: string): string {
  const result = compileKay(source, 'test.kay')

  expect(result.diagnostics.map(d => d.message)).toEqual([])

  return result.tsx
}

function errors(source: string): string[] {
  return compileKay(source, 'test.kay').diagnostics.map(d => d.message)
}

// Each diagnostic as rustc would print its parts: the message, the text it and each related span cover, and the help.
function reports(source: string) {
  return compileKay(source, 'test.kay').diagnostics.map(d => ({ message: d.message, at: source.slice(d.start, d.end), ...d.label !== undefined && d.label !== '' && { label: d.label }, ...d.related && { related: d.related.map(span => [source.slice(span.start, span.end), span.label]) }, ...d.note !== undefined && d.note !== '' && { note: d.note }, ...d.help !== undefined && d.help !== '' && { help: d.help } }))
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
    expect(tsx('---\nimport type { JSX } from \'kay\'\n---\np x')).toContain('export default function Test()')
    // Pure helpers, the same on both sides.
    expect(tsx('---\nimport { sanitizeHtml, trustHtml, uid } from \'kay\'\nconst { a, b } = props<{ a: string, b: string }>()\n---\ndiv(id={uid()} innerHTML={trustHtml(a)})\ndiv(innerHTML={sanitizeHtml(b)})')).not.toContain('KayIsland')
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

describe('translations', () => {
  it('imports t from kay/i18n for a component reading it unimported, and leaves a t it declares or imports alone', () => {
    const translation = 'import { t } from \'kay/i18n\''

    expect(tsx('p {t(\'hello\')}')).toContain(translation)
    expect(tsx('---\nconst label = t(\'hello\')\n---\np {label}')).toContain(translation)
    expect(tsx('for t of [1]\n  p {t}')).not.toContain('kay/i18n')
    expect(tsx('---\nimport { t } from \'./words\'\n---\np {t(\'x\')}')).not.toContain('kay/i18n')
    expect(tsx('---\nconst t = (key: string) => key\n---\np {t(\'x\')}')).not.toContain('kay/i18n')
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

  it('applies defaults where the prop is read and handles renames, quoted keys and the rest', () => {
    const code = tsx('---\nconst { size = \'md\', label: text, \'aria-label\': aria, ...rest } = props<{ size?: string, label: string, \'aria-label\'?: string, id?: string }>()\n---\nbutton(aria-label={aria} {...rest}) {size} {text}')

    expect(code).toContain('const __default_0 = (): Exclude<(typeof __props)["size"], undefined> => (__default_0_made ??= { value: (\'md\') }).value;')
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
  it('keys a for loop by an expression, the type checker reading the item as a value it narrows', () => {
    const out = jsx('ul\n  for todo, i of todos key={todo.id}\n    li(data-i={i}) {todo.title}')

    expect(out).toBe('<ul><KayLoopFor each={todos} keyed={(todo) => (todo.id)}>{(todo, i) => <li data-i={i}>{todo.title}</li>}</KayLoopFor></ul>')
  })

  it('matches rows by position when the key is the index', () => {
    expect(jsx('for row, i of rows key={i}\n  p {i}: {row}')).toBe('<><KayLoopFor each={rows} keyed={false}>{(row, i) => <p>{i}: {row}</p>}</KayLoopFor></>')
  })

  it('hands the rows of a page\'s loops their items, since only islands and browsers update rows', () => {
    const page = '--- server\nconst rows = [1]\n---\nul\n  for row, i of rows key={row}\n    li {i}: {row}\n  else\n    li none'
    const server = compileKay(page, 'src/routes/index.kay', { includeServer: true }).tsx

    expect(server).toContain('{KayStaticFor(__props.rows, (row, i) => <li>{i}: {row}</li>, () => <li>none</li>)}')
    expect(server).not.toContain('KayLoopFor ')
    expect(compileKay(page, 'src/routes/index.kay', { includeServer: false }).tsx).toContain('<KayLoopFor each={__props.rows}')
    expect(compileKay(page, 'src/routes/index.kay', { check: true }).tsx).toContain('<KayLoopFor each={__props.rows}')
  })

  it('types a page\'s load with its query schema and keeps the schema out of a browser build\'s action stubs', () => {
    const page = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const query = t.Object({ q: t.String() })\nexport const add = action(t.Object({}), () => 1)\n\nconst q = ctx.query.q\n---\np {q}'

    expect(compileKay(page, 'src/routes/index.kay', { includeServer: true }).tsx).toContain('export async function load(ctx: KayPageContext<Record<string, string>, KayQueryOf<typeof query>>)')
    expect(compileKay(page, 'src/routes/index.kay', { includeServer: false }).tsx).toContain('export const add = KayActionStub(')
    expect(compileKay(page, 'src/routes/index.kay', { includeServer: false }).tsx).not.toContain('export const query')
  })

  it('renders a for fallback', () => {
    expect(jsx('for t of list key={t}\n  p {t}\nelse\n  p none')).toContain('fallback={<p>none</p>}')
  })

  it('chains if branches as conditionals', () => {
    expect(jsx('if a\n  p a\nelse if b\n  p b\nelse\n  p c')).toBe('<>{(a) ? <p>a</p> : (b) ? <p>b</p> : <p>c</p>}</>')
  })

  it('writes a match as a switch, so kay check narrows its subject per branch', () => {
    expect(jsx('match s.kind\n  when \'a\', \'b\'\n    p ab\n  else\n    p other')).toBe('<>{(() => { switch (s.kind) { case \'a\': case \'b\': return (<p>ab</p>); default: return (<p>other</p>); } })()}</>')
    expect(jsx('match s\n  when 1\n    p one')).toBe('<>{(() => { switch (s) { case 1: return (<p>one</p>); } return null })()}</>')
  })

  it('narrows an aliased if through Show', () => {
    expect(jsx('if user() as u\n  p {u.name}\nelse\n  p anon')).toBe('<>{<KayShow when={user()} fallback={<p>anon</p>}>{(u) => <p>{u.name}</p>}</KayShow>}</>')
  })

  it('reads a keyed row\'s key untracked, since a row keeps its key for life, and leaves a write or a call through it as written', () => {
    const dom = compileKay('ul\n  for todo of todos key={todo.id}\n    li(onClick={() => todo.id++}) {todo.id}: {todo.title} {todo.id.toFixed()}', 'test.kay', { output: 'dom' }).tsx

    expect(dom).toContain('KayUntrack(() => todo().id)')
    expect(dom).toContain('KayUntrack(() => todo().id).toFixed()')
    expect(dom).toContain('todo().title')
    expect(dom).toContain('todo().id++')
    expect(compileKay('for row of rows key={row}\n  p {row}', 'test.kay', { output: 'dom' }).tsx).toContain('KayUntrack(() => row())')
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

  it('keeps a transition on an element, its phases named as they are, and refuses one on a component', () => {
    expect(jsx('p(transition="fade" transition:leave-to="opacity-0") x')).toBe('<p transition="fade" transition:leave-to="opacity-0">x</p>')
    expect(errors('Card(transition="fade")')).toEqual(['`transition` animates an element, not a component'])
    expect(errors('p(transition:out="fade") x')).toEqual(['`transition:out` is no phase of a transition'])
  })

  it('escapes text JSX would read as code, and runs of spaces it would collapse', () => {
    expect(jsx('p a < b > c } \\{d')).toBe('<p>a {"<"} b {">"} c {"}"} {"{"}d</p>')
    expect(jsx('p a   b')).toBe('<p>a{"   "}b</p>')
  })

  it('passes slots as component props and rejects them elsewhere', () => {
    expect(jsx('Card\n  @header\n    h2 Title\n  p body')).toBe('<Card header={<h2>Title</h2>}><p>body</p></Card>')
    expect(errors('div\n  @header\n    h2 Title')).toEqual([expect.stringContaining('directly under a component')])
  })

  it('passes a slot with parameters as a function of them, checked like a function attribute', () => {
    expect(jsx('List(items={todos})\n  @row(todo, i)\n    li {i}. {todo.title}\n  @empty\n    p none')).toBe('<List items={todos} row={(todo, i) => <li>{i}. {todo.title}</li>} empty={<p>none</p>} />')
    expect(jsx('List\n  @row()\n    li x')).toBe('<List row={() => <li>x</li>} />')

    const source = '---\nimport List from \'./list.kay\'\n---\nList(items={[1]})\n  @row(n)\n    li {n}'

    expect(compileKay(source, '_layout.kay', { check: true }).tsx).toContain('<List items={KayProp(List)(([1]))} {...KayFunctionProp(List)(0)} row={(n) => <li>{n}</li>} />')
    // A component renders as an island in its place should List be one, so what it passes is not sent as it is.
    expect(compileKay(source, 'test.kay', { check: true }).tsx).toContain('<List items={[1]} row={(n) => <li>{n}</li>} />')
  })

  it('renders a block prop through a named slot, the lines under a slot standing in when there is none', () => {
    expect(jsx('---\nconst { row } = props<{ row?: (n: number) => string }>()\n---\nul\n  slot row(1)\n    li none\n  slot')).toBe('<ul>{__props.row?.(1) ?? <li>none</li>}{__props.children}</ul>')
    expect(errors('slot actions extra')).toEqual(['Nothing may follow a slot name on its line'])
    expect(errors('slot.x')).toEqual(['`slot` takes no attributes'])
  })

  it('reports a prop a slot passes a second time', () => {
    expect(reports('Card\n  @a\n    p x\n  @a\n    p y')).toEqual([{ message: '`a` is passed twice', at: 'a', label: 'passed again here', related: [['a', 'passed by this `@a`']] }])
    expect(reports('Card(a="1")\n  @a\n    p x')).toEqual([{ message: '`a` is passed twice', at: 'a', label: 'passed again here', related: [['a', 'passed by this attribute']] }])
    expect(reports('Card\n  @children\n    p x\n  p y')).toEqual([{ message: '`children` is passed twice', at: 'children', label: 'passed again here', related: [['p y', 'passed by the lines under the tag']] }])
    expect(errors('Card\n  @a\n    p x\n  @b\n    p y\n  p z')).toEqual([])
  })

  it('quotes static values JSX could not hold', () => {
    expect(jsx('p(title=\'say "hi"\')')).toBe('<p title=\'say "hi"\' />')
  })
})

describe('islands', () => {
  it('rejects hydrate inside an island, which hydrates as a whole', () => {
    expect(errors('---\nimport { signal } from "kay"\nimport Counter from "./counter.kay"\n---\nCounter(hydrate="visible")')).toEqual([expect.stringContaining('`hydrate` has no effect inside an island')])
    expect(errors('---\nimport { signal } from "kay"\nimport Counter from "./counter.kay"\n---\nCounter(persist)')).toEqual([expect.stringContaining('`persist` has no effect inside an island')])
    expect(errors('---\nimport Counter from "./counter.kay"\n---\nCounter(hydrate="visible")')).toEqual([])
  })

  it('imports what the fences use of kay unimported, which makes the component an island', () => {
    const source = '--- server\nexport const add = action(s.Object({}), async () => 1)\n---\n---\nconst count = signal(0)\nconst double = memo(() => count() * 2)\n---\nbutton(onClick={() => count.set(c => c + 1)}) {double()}\n'

    expect(tsx(source)).toStartWith('import { signal, memo, action } from \'kay\'\n')
    expect(compileKay(source, 'test.kay').island).toBe('test.kay')
    expect(compileKay('---\nconst label = \'signal\'\n---\np {label}\n', 'test.kay').island).toBeUndefined()
  })

  it('reads a signal by name through optional chaining, a shorthand property and await blocks', () => {
    const code = tsx('---\nconst user = signal<{ name: string }>()\nconst count = memo(() => 1)\nconst later = Promise.resolve(2)\n---\np(title={JSON.stringify({ count })}) {user?.name}\nawait later\n  p {count}\nthen value\n  p {count + value}\n')

    expect(code).toContain('user()?.name')
    expect(code).toContain('{ count: count() }')
    expect(code.match(/count\(\)/g)).toHaveLength(3)
  })

  it('leaves a name the file declares or imports itself', () => {
    expect(tsx('---\nfunction signal(value: number) {\n  return value\n}\n\nconst one = signal(1)\n---\np {one}\n')).not.toContain('from \'kay\'')
    expect(tsx('--- server\nimport { signal } from \'kay\'\n\nconst one = 1\n---\n---\nconst count = signal(one)\n---\np {count()}\n').match(/import \{ signal \} from 'kay'/g)).toHaveLength(1)
  })
})

describe('fences', () => {
  it('report markup as belonging in the template, a fence holding TypeScript only', () => {
    expect(reports('---\nconst el = <p>x</p>\n---\np x')).toEqual([{ message: 'A fence holds TypeScript, never JSX', at: '<p>x</p>', help: 'put markup in the template, or in a component of its own' }])
    expect(errors('--- server\nconst el = <><b /></>\n---\np x')).toEqual(['A fence holds TypeScript, never JSX'])
    expect(errors('---\nconst x = 1 +\n---\np x')).toEqual(['Unexpected token'])
  })
})

describe('head', () => {
  it('registers the head tags before rendering and leaves them out of the template', () => {
    const code = tsx('---\nconst { name } = props<{ name: string }>()\n---\nhead\n  title {name} | Docs\n  meta(name="description" content={name} data-x)\nh1 {name}')

    expect(code).toContain('declare const KayUseHead: KayTemplateHelpers["head"]')
    expect(code).toContain('KayUseHead([{ tag: "title", props: { "children": "" + (__props.name) + " | Docs" } }, { tag: "meta", props: { "name": "description", "content": (__props.name), "data-x": true,  } }, ]);\n\nreturn <h1>{__props.name}</h1>')
  })

  it('types the head tags as elements when checking', () => {
    const checked = compileKay('head\n  link(rel="icon" href={icon})\np x', 'test.kay', { check: true }).tsx

    expect(checked).toContain('void (<><link rel="icon" href={icon} /></>);')
    expect(checked).not.toContain('KayUseHead')
  })

  it('rejects head blocks an island, a nested element or a second block holds, and content the head cannot', () => {
    expect(errors('---\nimport { signal } from "kay"\n---\nhead\n  title x\np')).toEqual(['An island cannot set the document head'])
    expect(reports('head\n  title a\nhead\n  title b')).toEqual([{ message: 'A template has one `head` block', at: 'head', related: [['head', 'the first one']] }])
    expect(errors('div\n  head\n    title a')).toEqual(['A `head` block sits at the top level of a template'])
    expect(errors('head\n  div x\n  if a\n    title a')).toEqual([expect.stringContaining('holds `title`'), expect.stringContaining('holds `title`')])
    expect(errors('head\n  title Read #[b this]')).toEqual(['`title` holds text only'])
  })
})

describe('check-only assertions', () => {
  const source = '---\nimport Island from \'./island.kay\'\n---\na(href=\'/docs\') Docs\nform(action={save})\n  input(name=\'title\')\nIsland(when={today})\nIsland({...rest})'

  it('checks links, form fields and island props in type-checking output', () => {
    const checked = compileKay(source, 'test.kay', { check: true }).tsx

    expect(checked).toContain('<a href={KayHref("/docs")}>')
    expect(checked).toContain('<input name={KayField((save), "title")} />')
    expect(checked).toContain('<Island when={KayProp(Island)((today))} />')
    expect(checked).toContain('<Island {...KayProp(Island)((rest))} />')
  })

  it('keeps them out of the code that ships', () => {
    const built = compileKay(source, 'test.kay').tsx

    expect(built).toContain('<a href="/docs">')
    expect(built).toContain('<input name="title" />')
    expect(built).toContain('<Island when={today} />')
    expect(built).toContain('<Island {...rest} />')
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

  it('declares what an action reads at module level, through one another, the template still reading it', () => {
    const result = rewritten('--- server\nimport { action } from \'kay\'\n\nconst LIMIT = 3\nconst max = () => LIMIT * 2\nexport const add = action(schema, () => max())\nconst todos = await list()\n---\np {LIMIT} {todos}')
    const [module, load] = result.tsx.split('export async function load')

    expect(result.diagnostics).toEqual([])
    expect(module).toContain('const LIMIT = 3\nconst max = () => LIMIT * 2\nexport const add')
    expect(load).toContain('const todos = await list()')
    expect(load).not.toContain('LIMIT =')
    expect(load).toContain('return { LIMIT, max, todos }')
  })

  it('leaves a name an action only shadows in the load', () => {
    const result = rewritten('--- server\nimport { action } from \'kay\'\n\nconst todos = await list()\nexport const add = action(schema, ({ todos }) => todos.length)\n---\np {todos}')

    expect(result.diagnostics).toEqual([])
    expect(result.tsx.slice(result.tsx.indexOf('export async function load'))).toContain('const todos = await list()')
  })

  it('reports an action reading what is computed per request, through another name too', () => {
    const at = (server: string) => {
      const source = `--- server\nimport { action } from 'kay'\n\n${server}\n---\np x`

      return compileKay(source, 'test.kay', { includeServer: true }).diagnostics.map(d => ({ message: d.message, text: source.slice(d.start, d.end) }))
    }

    expect(at('const id = ctx.params.id\nexport const add = action(schema, () => id)')).toEqual([{ message: expect.stringContaining('`id` is computed per request, in the page\'s load, since it reads `ctx`'), text: 'id' }])
    expect(at('const todos = await list()\nexport const add = action(schema, () => todos)')).toEqual([{ message: expect.stringContaining('since it awaits'), text: 'todos' }])
    expect(at('const todos = await list()\nconst count = () => todos.length\nexport const add = action(schema, () => count())')).toEqual([{ message: expect.stringContaining('since it reads `todos`, which is computed per request'), text: 'count' }])
    expect(at('const fetchAll = async () => await list()\nexport const add = action(schema, () => fetchAll())')).toEqual([])
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
    expect(code).toContain('{(Item) => <KayDynamic component={Item} x="1"><p>b</p></KayDynamic>}')
    expect(code).toContain('declare const KayDynamic: KayTemplateHelpers["Dynamic"]')
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

    expect(code).toContain('const __default_0 = (): Exclude<(typeof __props)["opts"], undefined> => (__default_0_made ??= { value: ({}) }).value;')
    expect(code).toContain('(__props.opts !== undefined ? __props.opts : __default_0()).a')
    expect(code).not.toContain('?? __default')
  })

  it('applies a default to a renamed and a quoted key too', () => {
    const code = tsx('---\nconst { label: text = \'x\', \'aria-label\': aria = \'y\' } = props<{ label?: string, \'aria-label\'?: string }>()\n---\np {text} {aria}')

    expect(code).toContain('(__props.label !== undefined ? __props.label : __default_0())')
    expect(code).toContain('(__props["aria-label"] !== undefined ? __props["aria-label"] : __default_1())')
  })
})

describe('generic components', () => {
  it('declares the type parameters of the script fence on the component function', () => {
    const code = tsx('--- <T extends { id: number }, const K extends keyof T = keyof T>\nconst { items } = props<{ items: T[], key?: K }>()\n---\np {items.length}')

    expect(code).toContain('export default function Test<T extends { id: number }, const K extends keyof T = keyof T>(__props: { items: T[], key?: K })')
  })

  it('keeps an island generic, instantiated per use, with hydrate', () => {
    const code = tsx('--- <T extends Record<string, (a: number) => void>, U>\nimport { signal } from \'kay\'\n\nconst { items } = props<{ items: T[], other: U }>()\nconst n = signal(0)\n---\nbutton(onClick={() => n.set(1)}) {items.length}')

    expect(code).toContain('function Test<T extends Record<string, (a: number) => void>, U>(')
    expect(code).toContain('export default KayIsland("test.kay", Test as never) as unknown as KayIslandBrand & (<T extends Record<string, (a: number) => void>, U>(props: Parameters<typeof Test<T, U>>[0] & KayIslandOptions) => ReturnType<typeof Test>)')
  })

  it('refuses type parameters on a page', () => {
    expect(errors('--- server\nconst a = 1\n---\n--- <T>\n---\np {a}')).toEqual(['A page has no type parameters'])
  })

  it('leaves a function given to a component unwrapped in check output, so a generic one types its parameters', () => {
    const code = compileKay('---\nimport List from \'./list.kay\'\n---\nList(items={[1]} show={n => String(n)})', '_layout.kay', { check: true }).tsx

    expect(code).toContain('<List items={KayProp(List)(([1]))} {...KayFunctionProp(List)(0)} show={n => String(n)} />')
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
    expect(errors('---\nconst rows = [1]\nexport type Row = typeof rows[number]\n---\np x')).toEqual(['`Row` cannot refer to the script\'s own names'])
  })
})

describe('invalid code', () => {
  const at = (source: string) => compileKay(source, 'test.kay').diagnostics.map(d => ({ message: d.message, text: source.slice(d.start, d.start + 5) }))

  it('reports template expressions that do not parse at their position in the source', () => {
    expect(at('p {x +}')).toEqual([{ message: expect.stringContaining('Unexpected token'), text: '}' }])
    expect(at('---\nconst p = 1\n---\np {await p}')).toEqual([{ message: expect.stringContaining('\'await\''), text: 'await' }])
    expect(compileKay('---\nconst p = 1\n---\np {await p}', 'test.kay').diagnostics[0]?.help).toBe('read async data in the `--- server` fence')
  })

  it('reports code that does not parse in a fence at its position, with no position of its own in the message', () => {
    expect(at('---\nconst a = 1 2\n---\np {a}')).toEqual([{ message: 'Missing semicolon.', text: ' 2\n--' }])
    expect(at('--- server\nconst a = \n---\np {a}')).toEqual([{ message: 'Unexpected token', text: '---\np' }])
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

describe('signal writes', () => {
  it('assign a signal through .set, a compound one or ++ through an updater', () => {
    const code = tsx('---\nconst count = signal(0)\nconst open = signal(false)\nfunction f() {\n  count=count() + 1\n  count *= 2\n  --count\n}\n---\nbutton(onClick={() => { count++; open = !open }}) {count}')

    expect(code).toContain('count.set(count() + 1)\n  count.set((KayCurrent) => KayCurrent * (2))\n  count.set((KayCurrent) => KayCurrent - 1)')
    expect(code).toContain('count.set((KayCurrent) => KayCurrent + 1); open.set(!open())')
  })

  it('read and write by name a prop typed Signal, inline or through a type of the script, and a signal a module exports', () => {
    const typed = '---\nimport type { Signal as S } from \'kay\'\ninterface Props { open: S<boolean>, label: string }\nconst { open, label } = props<Props>()\n---\nbutton(onClick={() => open = false}) {open} {label}'

    expect(jsx(typed)).toBe('<button onClick={() => __props.open.set(false)}>{__props.open()} {__props.label}</button>')

    const imported = compileKay('---\nimport { accent as tone } from \'./theme\'\n---\nbutton(onClick={() => tone += \'!\'}) {tone}', 'test.kay', { importedSignals: { './theme': { accent: 'signal' } } })

    expect(imported.tsx).toContain('<button onClick={() => tone.set((KayCurrent) => KayCurrent + (\'!\'))}>{tone()}</button>')
  })

  it('reject a write to a memo, a signal written by destructuring and a name kay cannot tell is a signal', () => {
    const source = '---\nimport { other, loud } from \'./theme\'\nconst count = signal(0)\nconst double = memo(() => count() * 2)\nconst plain = 1\nlet free = 0\nfunction f() {\n  double = 3\n  loud++\n  other = 2\n  plain += 1\n  free++\n  ;[count] = [signal(1)]\n}\n---\np x'
    const found = compileKay(source, 'test.kay', { importedSignals: { './theme': { loud: 'memo' } } }).diagnostics.map(d => [source.slice(d.start, d.end), d.message])

    expect(found).toEqual([
      ['double', '`double` is a memo, which cannot be written'],
      ['loud', '`loud` is a memo, which cannot be written'],
      ['other', '`other` is not a signal kay can tell, so it cannot be assigned'],
      ['plain', '`plain` is not a signal kay can tell, so it cannot be assigned'],
      ['count', '`count` is a signal, written by assigning its name'],
    ])
  })
})

describe('module signals', () => {
  it('finds the signals and memos a module exports as export const, made by kay\'s functions', () => {
    expect(moduleSignals('import { signal as s, memo, persisted } from \'kay\'\nimport { linked } from \'other\'\n\nexport const a = s(1), b = memo(() => a())\nexport const c = persisted(\'c\', 0)\nexport const d = linked(() => 1)\nconst e = s(2)\nexport let f = s(3)\nexport { e }\n')).toEqual({ a: 'signal', b: 'memo', c: 'signal' })
    expect(moduleSignals('export const a = signal(1)\n')).toEqual({})
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
    expect(reports('button(onclick={go}) x')).toEqual([{ message: '`onclick` does not attach a handler', at: 'onclick', note: 'events are written in camelCase', help: '`onClick`' }])
    expect(errors('button(on:click={go}) x')).toEqual(['`on:click` does not attach a handler'])
    expect(compileKay('input(onkeydown={go} ondblclick={go})', 'test.kay').diagnostics.map(d => d.help)).toEqual(['`onKeyDown`', '`onDblClick`'])
    expect(compileKay('button(on:click={go}) x', 'test.kay').diagnostics[0]?.fixes).toEqual([{ title: 'Write `onClick`', edits: [{ start: 7, end: 15, text: 'onClick' }], safe: true }])
  })

  it('leaves components, strings and the camelCase form alone', () => {
    expect(errors('Card(onclick={go})')).toEqual([])
    expect(errors('button(onclick="go()") x')).toEqual([])
    expect(errors('button(onClick={go}) x')).toEqual([])
  })
})

describe('accessibility checks', () => {
  const checked = (source: string) => compileKay(source, 'test.kay', { check: true }).diagnostics.map(d => d.message)

  it('ask an img for alt and an iframe for a title, alt="" marking decoration', () => {
    expect(checked('img(src="/a.png")\niframe(src="/map")')).toEqual([
      'An `img` needs `alt`',
      'An `iframe` needs a `title`',
    ])
    expect(checked('img(src="/a.png" alt="")\niframe(src="/map" title="Map")')).toEqual([])
    expect(checked('input(type="image" src="/go.png")\ninput(type="image" src="/go.png" alt="Search")')).toEqual(['An image button needs `alt`'])
  })

  it('report a click handler on an element the keyboard never reaches, unless it has a role', () => {
    const click = 'onClick={() => undefined}'

    expect(checked(`.card(${click})\nli(${click}) x\nbutton(${click}) ok\na(href="/" ${click}) ok`)).toEqual([
      'This `div` reacts to `onClick` but is out of reach of the keyboard and screen readers',
      'This `li` reacts to `onClick` but is out of reach of the keyboard and screen readers',
    ])
    expect(checked(`li(role="option" ${click}) x`)).toEqual([])
  })

  it('ask a field for a label, one around it, pointing at its id or written as an attribute', () => {
    expect(checked('input(name="email")\nselect(name="size")\ntextarea#bio\ninput(id="age")')).toEqual([
      'This `input` has no label',
      'This `select` has no label',
      'This `textarea` has no label',
      'This `input` has no label',
    ])
    expect(checked([
      'label Email\n  input(name="email")',
      'label(for="bio") Bio\ntextarea#bio',
      'input(id="age")\nlabel(for="age") Age',
      'input(aria-label="Search")\ninput(placeholder="Search")\ninput(title="Search")\ninput(aria-labelledby="heading")',
      'input(type="hidden" name="id")\ninput(type="submit" value="Send")\ninput(type="button" value="Go")',
      'input(name="website" aria-hidden="true" tabindex="-1")\n.trap(hidden)\n  input(name="phone")',
    ].join('\n'))).toEqual([])
  })

  it('leave a field whose label may be elsewhere: one with an id written as an expression, or among a component\'s children', () => {
    expect(checked('---\nimport Field from \'./field.kay\'\n\nconst { name } = props<{ name: string }>()\n---\ninput(id={name})\nField(label="Email")\n  input(name="email")')).toEqual([])
  })

  it('ask a button or a link for something to announce, an icon alone not being one', () => {
    expect(checked('button\n  svg\na(href="/")\n  img(src="/logo.png" alt="")\nbutton(type="submit")')).toEqual([
      'This `button` has nothing for a screen reader to announce',
      'This `a` has nothing for a screen reader to announce',
      'This `button` has nothing for a screen reader to announce',
    ])
    expect(checked([
      'button Save',
      'button(aria-label="Close")\n  svg',
      'a(href="/")\n  img(src="/logo.png" alt="Home")',
      'a(name="top")',
    ].join('\n'))).toEqual([])
    expect(checked('---\nconst { count } = props<{ count: number }>()\n---\nbutton {count}')).toEqual([])
  })

  it('report a heading skipping a level, each branch of an if following the heading before it', () => {
    expect(checked('h1 Shop\nh3 Shoes\nh4 Boots\nh2 Hats\nh4 Caps')).toEqual([
      'This `h3` follows an `h1`, skipping a level',
      'This `h4` follows an `h2`, skipping a level',
    ])
    expect(checked('---\nconst { open } = props<{ open: boolean }>()\n---\nh1 Shop\nif open\n  h2 Open\nelse\n  h2 Closed\nh3 Hours')).toEqual([])
  })

  it('leave an element with a spread alone, and never stop a page from running', () => {
    expect(checked('---\nconst { attrs } = props<{ attrs: Record<string, string> }>()\n---\nimg({...attrs})')).toEqual([])
    expect(checked('---\nconst { attrs } = props<{ attrs: Record<string, string> }>()\n---\ninput({...attrs})\nbutton({...attrs})')).toEqual([])
    expect(errors('img(src="/a.png")\n.card(onClick={() => undefined})')).toEqual([])
  })
})
