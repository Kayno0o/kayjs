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

    expect(code).toContain('const __default_0 = (\'md\');')
    expect(code).toContain('const rest = KayOmit(__props, "size", "label", "aria-label");')
    expect(code).toContain('aria-label={__props["aria-label"]}')
    expect(code).toContain('{(__props.size ?? __default_0)} {__props.label}')
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
    expect(jsx('input(type="number" bind:value={n})')).toContain('kayEvent.currentTarget.valueAsNumber')
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
})
