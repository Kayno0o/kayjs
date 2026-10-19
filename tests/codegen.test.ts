import * as parser from '@babel/parser'
import { describe, expect, it, spyOn } from 'bun:test'
import { compileKay, componentName } from '../src/compiler'
import { moduleSignals } from '../src/compiler/module-signals'
import { CURRENT, defaultName, GENERATED_NAME, PROPS } from '../src/compiler/names'

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

  it('wraps an interactive component as an island, and leaves pure helpers and type imports on the server side', () => {
    const reactive = tsx('---\nimport { signal } from \'kay\'\nconst count = signal(0)\n---\np {count()}')

    expect(reactive).toContain('import { island as KayIsland } from \'kay/island\'')
    expect(reactive).toEndWith('export default KayIsland("test.kay", Test)\n')

    const islandOf = (source: string) => compileKay(source, 'test.kay').island !== undefined

    expect(islandOf('button(onClick={go}) Go')).toBe(true)
    expect(islandOf('input(bind:value={name})')).toBe(true)
    expect(islandOf('---\nimport type { JSX } from \'kay\'\n---\np x')).toBe(false)
    // Pure helpers, the same on both sides.
    expect(islandOf('---\nimport { sanitizeHtml, trustHtml, uid } from \'kay\'\nconst { a, b } = props<{ a: string, b: string }>()\n---\ndiv(id={uid()} innerHTML={trustHtml(a)})\ndiv(innerHTML={sanitizeHtml(b)})')).toBe(false)
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
    const page = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const page = { query: t.Object({ q: t.String() }) }\nexport const add = action(t.Object({}), () => 1)\n\nconst q = ctx.query.q\n---\np {q}'

    expect(compileKay(page, 'src/routes/index.kay', { includeServer: true }).tsx).toContain('export async function load(ctx: KayPageContext<Record<string, string>, KayQueryOf<typeof page.query>>)')
    expect(compileKay(page, 'src/routes/index.kay', { check: true }).tsx).toContain('export const page = { query: t.Object({ q: t.String() }) } satisfies KayPageSettings\n')
    expect(compileKay(page, 'src/routes/index.kay', { includeServer: false }).tsx).toContain('export const add = KayActionStub(')
    expect(compileKay(page, 'src/routes/index.kay', { includeServer: false }).tsx).not.toContain('export const page')
  })

  it('has an island typing a prop as an action revive the actions a page passes it, and no other component', () => {
    const island = (imports: string) => `---\n${imports}\nimport { signal } from 'kay'\n\nconst { run } = props<{ run: ${imports.includes('Action') ? 'Action<never, string>' : '() => void'} }>()\nconst count = signal(0)\n---\nbutton(onClick={() => run()}) Go`
    const typed = island('import type { Action } from \'kay\'')
    const untyped = island('import type { Item } from \'./types\'')

    expect(compileKay(typed, 'src/caller.kay', { output: 'dom' }).tsx).toContain('KayReviveActions()')
    expect(compileKay(typed, 'src/caller.kay', { output: 'html' }).tsx).not.toContain('KayReviveActions')
    expect(compileKay(untyped, 'src/caller.kay', { output: 'dom' }).tsx).not.toContain('KayReviveActions')
    // The server lets an island be passed an action only when it types a prop as one.
    expect(compileKay(typed, 'src/caller.kay', { output: 'html' }).tsx).toContain('KayIsland("src/caller.kay", Caller, [], false, undefined, [], true)')
    expect(compileKay(untyped, 'src/caller.kay', { output: 'html' }).tsx).toContain('KayIsland("src/caller.kay", Caller)')
    expect(compileKay(typed, 'src/caller.kay', { output: 'dom' }).tsx).not.toContain('undefined, [], true)')
    expect(compileKay(typed.replace('---\nimport', '--- client\nimport'), 'src/caller.kay', { output: 'html' }).tsx).toContain('KayIsland("src/caller.kay", undefined, [], true, undefined, [], true)')
  })

  it('has a promotable component typing a prop as an action revive the actions in its chunk and take them on the server', () => {
    const source = (type: string) => `---\nimport type { Action } from 'kay'\nimport Pick from './pick.kay'\n\nconst { run } = props<{ run: ${type} }>()\n---\nPick(choose={() => run})`

    expect(compileKay(source('Action<never, string>'), 'src/caller.kay', { output: 'dom' }).tsx).toContain('KayReviveActions()')
    expect(compileKay(source('Action<never, string>'), 'src/caller.kay', { output: 'html', hydratable: true }).tsx).toContain('KayPromote("src/caller.kay", Caller as never, KayHydrated as never, [], true)')
    expect(compileKay(source('() => void').replace('import type { Action } from \'kay\'\n', ''), 'src/caller.kay', { output: 'dom' }).tsx).not.toContain('KayReviveActions')
  })

  it('reports a match with no when line in every output, which once crashed the html one', () => {
    for (const output of ['dom', 'html'] as const)
      expect(compileKay('match s\n', 'test.kay', { output }).diagnostics.map(d => d.message)).toEqual(['`match` has no `when` line'])
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

  it('refuses bind: on a component, and on an element that already handles the event', () => {
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

    expect(compileKay(source, '_layout.kay', { check: true }).tsx).toContain('<List items={[1]} {...KayFunctionProp(List)(0)} row={n => <li>{n}</li>} />')
    // A component renders as an island in its place should List be one, so what it passes is not sent as it is.
    expect(compileKay(source, 'test.kay', { check: true }).tsx).toContain('<List items={[1]} row={n => <li>{n}</li>} />')
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

describe('links from the root', () => {
  const ISLAND = '---\nconst n = signal(0)\n---\n'

  it('leaves a link to another host as written, and reads a path from the root through its entities', () => {
    const html = compileKay('a(href="//cdn.example/x") X\na(href=" /y") Y\na(href="x,/y") Z\na(href="&#47;docs") D\n', 'page.kay', { output: 'html' }).tsx
    const dom = compileKay(`${ISLAND}a(href="//cdn.example/x") X\na(href="&#47;docs") D\nimg(srcset="/a.png 1x, /b.png 2x" alt="")\n`, 'page.kay', { output: 'dom' }).tsx

    expect(html).toContain('<a href=\\"//cdn.example/x\\">X</a>')
    expect(html).toContain('<a href=\\" /y\\">Y</a>')
    expect(html).toContain('<a href=\\"x,/y\\">Z</a>')
    expect(html).toContain('KayAttribute("href", KayLocalHref("/docs"))')
    expect(html).not.toContain('KayLocalHref("//')
    expect(dom).toContain('<a href=\\"//cdn.example/x\\">X</a>')
    expect(dom).toContain('"href", "/docs");')
    expect(dom).toContain('"srcset", "/a.png 1x, /b.png 2x");')
  })
})

describe('a select\'s value', () => {
  it('takes the last of `value` and `bind:value` in the browser, as on the server', () => {
    const select = (attributes: string) => compileKay(`---\nconst b = signal('x')\nconst a = () => 'y'\n---\nselect(${attributes})\n  option x\n`, 'test.kay', { output: 'dom' }).tsx

    expect(select('value={a()} bind:value={b}')).not.toContain('"value", (a())')
    expect(select('bind:value={b} value={a()}')).toContain('"value", (a())')
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

  it('reads a signal by calling it through optional chaining, a property and await blocks', () => {
    const code = tsx('---\nconst user = signal<{ name: string }>()\nconst count = memo(() => 1)\nconst later = Promise.resolve(2)\n---\np(title={JSON.stringify({ count: count() })}) {user()?.name}\nawait later\n  p {count()}\nthen value\n  p {count() + value}\n')

    // Type checking reads each through `__values`, which it narrows.
    expect(code).toContain('const __values = { user: user(), count: count() }')
    expect(code).toContain('(void user, __values.user)?.name')
    expect(code).toContain('{ count: (void count, __values.count) }')
    expect(code.match(/\(void count, __values\.count\)/g)).toHaveLength(3)
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
    expect(compileKay('---\nimport { signal } from \'kay\'\nconst count = signal(0)\nconst el = <p>x</p>\n---\np {count}\n', 'test.kay', { check: true }).diagnostics.map(d => d.message)).toEqual(['A fence holds TypeScript, never JSX'])
    expect(errors('---\nconst x = 1 +\n---\np x')).toEqual(['Unexpected token'])
  })

  it('keep one that fails to parse in the shadow whole, for the editor to complete in while its quote is still open', () => {
    // Each component with how many of its fences fail to parse.
    const components: [string, number][] = [
      ['---\nimport BrandGithub from \'~icons/tabler/brand\n---\np x\n', 1],
      ['---\nimport { signal } from "kay/\nconst count = signal(1)\n---\np {count()}\n', 1],
      ['---\nconst a = \'one\nconst b = "two\n---\np {a}\n', 1],
      ['--- server\nimport { listTodos } from \'../da\nexport const page = {}\n---\n---\nconst label = "x\n---\np x\n', 2],
      ['---\nconst count = 1\nconst label = \'x\n---\np {count}\n', 1],
      ['--- client\nconst label = "x\n---\np x\n', 1],
    ]

    for (const [source, broken] of components) {
      const { tsx, map, diagnostics } = compileKay(source, 'test.kay', { check: true })
      const lines = source.split('\n')
      const fenceLines = lines.slice(0, lines.findLastIndex(line => line.startsWith('---'))).filter(line => !line.startsWith('---'))

      expect(diagnostics.map(d => d.message)).toEqual(Array.from<string>({ length: broken }).fill('Unterminated string constant.'))

      for (const line of fenceLines) {
        const at = map.toGenerated(source.indexOf(`${line}\n`))!

        expect(tsx.slice(at, at + line.length)).toBe(line)
      }
    }
  })

  it('analyse the rest of a fence while one statement of it does not parse, as the editor sees it typed', () => {
    const broken = ['---\nconst count = signal(1)\nconst items = signal([1])\nconst b = count.\nconst c = 1\n---\nfor item of items\n  p {item} {count()}\n', 'const b = count.\n']
    const parsed = broken[0]!.replace(broken[1]!, '')
    const withBroken = compileKay(broken[0]!, 'test.kay', { check: true })
    const without = compileKay(parsed, 'test.kay', { check: true })

    // The same shadow as a fence that parses, the typed statement beside it.
    expect(withBroken.tsx.replace(broken[1]!, '')).toBe(without.tsx)
    expect(withBroken.tsx).toContain('const b = count.\n')
    expect(withBroken.tsx).toContain('import { signal } from \'kay\'')
    expect(withBroken.diagnostics.map(d => d.message)).toEqual(['Missing semicolon.', '`items` is a signal, read by calling it'])
  })

  it('blame the statement left unfinished, not the good one that follows it', () => {
    const imports = compileKay('---\nconst b = items.\n\nconst count = signal(1)\n---\np {count()}\n', 'test.kay', { check: true })
    const rewritten = compileKay('---\nconst items = signal([1])\nconst b = items.\nconst count = signal(1)\n---\np {count}\n', 'test.kay', { check: true })
    const opened = compileKay('---\nconst count = signal(\nconst other = 1\n---\np {other}\n', 'test.kay', { check: true })
    const server = compileKay('--- server\nconst todos = load.\nconst a = 1\n---\np {a}\n', 'test.kay', { check: true })

    expect(imports.tsx).toContain('import { signal } from \'kay\'')
    expect(rewritten.tsx).toContain('count()')
    expect(rewritten.diagnostics.map(d => d.message)).toContain('`count` is a signal, read by calling it')
    expect(opened.tsx).toContain('import { signal } from \'kay\'')
    expect(server.tsx).toContain('return { a }')
  })

  it('read past the comment lines above a statement to tell what the text before it left unfinished', () => {
    for (const comment of ['// what?', '// note', '// a > b', '// a.']) {
      const { tsx, diagnostics } = compileKay(`---\nconst b = signal.\n${comment}\nconst count = signal(1)\n---\np {count}\n`, 'test.kay', { check: true })

      expect(diagnostics.map(d => d.message)).toContain('`count` is a signal, read by calling it')
      expect(tsx).toContain('count()')
    }
  })

  it('blame the last statement of a fence that ends unfinished, whatever it ends with', () => {
    for (const body of ['const a = 1\nconst e = signal(1', 'const d = foo(\n// c\nconst e = signal(1', 'const a = 1\n\nconst e = signal(1\n\n', 'const e = signal(1']) {
      const { tsx } = compileKay(`---\n${body}\n---\np x\n`, 'test.kay', { check: true })

      expect(tsx).toContain('import { signal }')
    }
  })

  it('keep a broken import.meta statement in the body, and read a block comment before a broken import', () => {
    const meta = compileKay('---\nimport.meta.hot.\nconst count = signal(1)\n---\np {count()}\n', 'test.kay', { check: true }).tsx
    const block = compileKay('---\n/* c */ import { a } from \'x\nconst count = signal(1)\n---\np {count()}\n', 'test.kay', { check: true }).tsx
    const multiline = compileKay('---\n/* a\n b */ import { a } from \'x\nconst count = signal(1)\n---\np {count()}\n', 'test.kay', { check: true }).tsx
    const island = (code: string) => code.indexOf('import { island')

    expect(meta.indexOf('import.meta.hot.')).toBeGreaterThan(island(meta))
    expect(block.indexOf('import { a }')).toBeLessThan(island(block))
    expect(multiline.indexOf('import { a }')).toBeLessThan(island(multiline))
  })

  it('count a name of a statement that does not parse as read only where it is code', () => {
    const imported = (body: string) => compileKay(`---\n${body}\n---\np x\n`, 'test.kay', { check: true }).tsx.includes('import { signal }')

    expect(imported('const d = \'signal(1')).toBe(false)
    expect(imported('const d = foo( // signal(1)\n')).toBe(false)
    expect(imported('const d = foo( /* signal */\n')).toBe(false)
    expect(imported('const d = { signal: 1,\n')).toBe(false)
    expect(imported('const d = `signal\n')).toBe(false)
    expect(imported('const d = { x: signal(1),\n')).toBe(true)
    expect(imported('const d = { x: \'a\', y: signal(1),\n')).toBe(true)
    expect(imported('const d = `${signal(1)}\n')).toBe(true)
    expect(imported('const d = `a ${b}` + signal(')).toBe(true)
    expect(imported('const d = foo(`x`, `${y}`, signal(')).toBe(true)
    expect(imported('const d = foo(`${{ a: 1 }.a}`, signal(')).toBe(true)
    expect(imported('const d = foo(/\' /, signal(')).toBe(true)
    expect(imported('const d = foo(/signal/')).toBe(false)
    expect(imported('const d = 4 / 2 + signal(')).toBe(true)
    expect(imported('const d = `signal\nconst e = signal(')).toBe(true)
    expect(imported('const d = `signal`\nconst e = foo(\nconst f = signal(')).toBe(true)
  })

  it('blame only the unfinished statement when the line after it starts with a bracket, a quote or a comment ends it', () => {
    for (const next of ['[x] = [1]', '(async () => 1)()', '\'use strict\'', '`t`']) {
      const { tsx } = compileKay(`---\nconst x = signal(1)\nconst a = x.\n${next}\nconst b = signal(2)\n---\np x\n`, 'test.kay', { check: true })

      expect(tsx).toContain('const b = signal(2)')
      expect(tsx.indexOf('const b = signal(2)')).toBeGreaterThan(tsx.indexOf(next))
    }

    for (const comment of ['// ok', '// url http://x', '// "q']) {
      const { diagnostics } = compileKay(`---\nconst count = signal(1)\nconst x = count. ${comment}\nconst signal2 = signal(2)\n---\np {signal2}\n`, 'test.kay', { check: true })

      expect(diagnostics.map(d => d.message)).toContain('`signal2` is a signal, read by calling it')
    }
  })

  it('write the statement being typed in a server fence wherever it stands', () => {
    const tail = compileKay('--- server\nconst a = 1\nconst todos = load.\n---\np {a}\n', 'test.kay', { check: true })
    const beforeExport = compileKay('--- server\nconst todos = load.\nexport const add = action(() => 1)\n---\np x\n', 'test.kay', { check: true })
    const beforeImport = compileKay('--- server\nconst todos = load.\nimport { b } from \'./b\'\n---\np x\n', 'test.kay', { check: true })

    for (const { tsx } of [tail, beforeExport, beforeImport])
      expect(tsx).toContain('const todos = load.')
  })

  it('import the names kay provides to a fence with a statement that does not parse, the server\'s included', () => {
    const script = compileKay('---\nconst { label } = props<{ label: string }>()\nconst count = signal(1)\nconst b = \'x\n---\np {label}\n', 'test.kay', { check: true })
    const server = compileKay('--- server\nexport const add = action(() => 1)\nconst todos = load.\n---\np x\n', 'test.kay', { check: true })
    const translated = compileKay('---\nconst b = \'x\n---\np {t(\'hello\')}\n', 'test.kay', { check: true })

    expect(script.tsx).toContain('import { signal } from \'kay\'')
    expect(script.tsx).toContain('__props.label')
    expect(server.tsx).toContain('import { action } from \'kay\'')
    expect(translated.tsx).toContain('import { t } from \'kay/i18n\'')
  })

  it('relocate a relative import beside a statement that does not parse', () => {
    const { tsx } = compileKay('---\nimport { a } from \'../../outside/a\'\nconst b = a.\n---\np x\n', 'test.kay', { check: true, relocateImport: specifier => specifier === '../../outside/a' ? '../../../outside/a' : undefined })

    expect(tsx).toContain('import { a } from "../../../outside/a"')
  })

  it('relocate the specifier of an import that does not parse itself, closed or not', () => {
    const relocateImport = (specifier: string) => specifier === '../../outside/a' ? '../../../outside/a' : undefined
    const open = compileKay('---\nimport { a } from \'../../outside/a\nconst b = 1\n---\np x\n', 'test.kay', { check: true, relocateImport }).tsx
    const closed = compileKay('---\nimport { a } from \'../../outside/a\' foo\nconst b = 1\n---\np x\n', 'test.kay', { check: true, relocateImport }).tsx
    const bare = compileKay('---\nimport \'../../outside/a\' foo\nconst b = 1\n---\np x\n', 'test.kay', { check: true, relocateImport }).tsx
    const other = compileKay('---\nimport { a } from \'../other\nconst b = 1\n---\np x\n', 'test.kay', { check: true, relocateImport }).tsx

    expect(open).toContain('import { a } from "../../../outside/a"\n')
    expect(closed).toContain('import { a } from "../../../outside/a" foo\n')
    expect(bare).toContain('import "../../../outside/a" foo\n')
    expect(other).toContain('import { a } from \'../other\n')
  })

  it('keep the lints of the rewrites for the template and the other fence while one fence does not parse', () => {
    const { diagnostics } = compileKay('--- server\nconst todos = [1]\n---\n---\nconst count = signal(1)\nconst b = count.\n---\np {count}\nbutton(onClick={() => todos = []}) x\n', 'test.kay', { check: true })
    const messages = diagnostics.map(d => d.message)

    expect(messages).toContain('Unexpected token')
    expect(messages).toContain('`count` is a signal, read by calling it')
  })

  it('parse each fence and each handler once a compile, however many passes and checks read it', () => {
    const script = 'const a = signal(true)\nconst f = () => 1\nconst g = () => 2\n'
    const server = 'import { t } from \'kay\'\n\nexport const page = { query: t.Object({}) }\n'
    const source = `--- server\n${server}---\n---\nimport { signal } from 'kay'\n${script}---\nbutton(onclick={a() ? f : g}) x\n`
    const parse = spyOn(parser, 'parse')
    const parseExpression = spyOn(parser, 'parseExpression')

    try {
      for (const options of [{ check: true }, { output: 'html' as const }, { output: 'dom' as const }]) {
        parse.mockClear()
        parseExpression.mockClear()
        compileKay(source, 'test.kay', options)

        expect(parse.mock.calls.filter(([code]) => code === server || code === `import { signal } from 'kay'\n${script}`)).toHaveLength(2)
        expect(parseExpression.mock.calls.filter(([code]) => code === 'a() ? f : g').length).toBeLessThanOrEqual(1)
      }
    }
    finally {
      parse.mockRestore()
      parseExpression.mockRestore()
    }
  })
})

describe('head', () => {
  it('registers the head tags before rendering and leaves them out of the template', () => {
    const code = tsx('---\nconst { name } = props<{ name: string }>()\n---\nhead\n  title {name} | Docs\n  meta(name="description" content={name} data-x)\nh1 {name}')

    expect(code).toContain('declare const KayUseHead: KayTemplateHelpers["head"]')
    expect(code).toContain('KayUseHead([{ tag: "title", props: { "children": "" + (__props.name) + " | Docs" } }, { tag: "meta", props: { "name": "description", "content": (__props.name), "data-x": true,  } }, ]);\n\nreturn <h1>{__props.name}</h1>')
  })

  it('keeps an island\'s title in step with what it reads in the browser, and marks the one its server render sets', () => {
    const source = '---\nconst name = signal("a")\n---\nhead\n  title {name()} | Room\nbutton(onClick={() => name.set("b")}) x'
    const dom = compileKay(source, 'room.kay', { output: 'dom' }).tsx
    const html = compileKay(source, 'room.kay', { output: 'html' }).tsx

    expect(dom).toContain('KayPageTitle(() => "" + (name()) + " | Room", false);')
    expect(dom).toContain('import { pageTitle as KayPageTitle } from \'kay/internal/title\'')
    expect(html).toContain('KayHead([{ tag: "title", props: { "island": true, "children": "" + (name()) + " | Room" } }, ]);')
    expect(compileKay(source.replace('title {', 'title(raw) {'), 'room.kay', { output: 'dom' }).tsx).toContain('| Room", true);')
    expect(compileKay(source.replace('title {', 'title(raw={name() === "b"}) {'), 'room.kay', { output: 'dom' }).tsx).toContain('| Room", Boolean(name() === "b"));')
    expect(compileKay(source.replace('  title {name()} | Room', '  title first\n  title {name()} | Room'), 'room.kay', { output: 'dom' }).tsx).toContain('KayPageTitle(() => "" + (name())')
    expect(compileKay('head\n  title {x} here\np y', 'page.kay', { output: 'html' }).tsx).not.toContain('"island"')
  })

  it('types the head tags as elements when checking', () => {
    const checked = compileKay('head\n  link(rel="icon" href={icon})\np x', 'test.kay', { check: true }).tsx

    expect(checked).toContain('void (<><link rel="icon" href={icon} /></>);')
    expect(checked).not.toContain('KayUseHead')
  })

  it('filters a spread onto an element, a component taking its props as they are', () => {
    const source = '---\nimport Card from "./card.kay"\nconst a = { title: "x" }\n---\ndiv({...a})\nCard({...a})'

    for (const output of ['html', 'dom'] as const) {
      const code = compileKay(source, 'test.kay', { output }).tsx

      expect(code).toContain('[KaySpreadAttributes(a)]')
      expect(code).toContain('KayComponent(Card, KayMerge((a)))')
    }
  })

  it('rejects a computed style or script inside svg or math, where HTML reads it as markup', () => {
    expect(errors('---\nconst css = "a{}"\n---\nsvg\n  style {css}')).toEqual(['A `style` inside `svg` or `math` takes static text only'])
    expect(errors('---\nconst c = "red"\n---\nsvg\n  style {`.a{fill:${c}}`}')).toHaveLength(1)
    expect(errors('---\nconst css = "a{}"\n---\nmath\n  g\n    script(textContent={css})')).toEqual(['A `script` inside `svg` or `math` takes static text only'])
    expect(errors('---\nconst css = "a{}"\n---\nsvg\n  style @import \'a.css\';\nsvg\n  style {\'.a{fill:red}\'}\n  style {`.b{fill:blue}`}\nstyle {css}\nsvg\n  foreignObject\n    style {css}')).toEqual([])
  })

  it('rejects head blocks an island, a nested element or a second block holds, and content the head cannot', () => {
    expect(errors('---\nimport { signal } from "kay"\n---\nhead\n  title x\np')).toEqual([])
    expect(errors('---\nconst n = signal(0)\n---\nhead\n  title x\n  meta(name="a" content="b")\nbutton(onClick={() => n.set(1)}) x')).toEqual(['An island\'s `head` block sets the title only, not `meta`'])
    expect(reports('head\n  title a\nhead\n  title b')).toEqual([{ message: 'A template has one `head` block', at: 'head', related: [['head', 'the first one']] }])
    expect(errors('div\n  head\n    title a')).toEqual(['A `head` block sits at the top level of a template'])
    expect(errors('head\n  div x\n  if a\n    title a')).toEqual([expect.stringContaining('holds `title`'), expect.stringContaining('holds `title`')])
    expect(errors('head\n  title Read #[b this]')).toEqual(['`title` holds text only'])
  })

  it('takes the attributes of <html> from an `html` tag, which holds nothing and leaves `lang` and `dir` to the locale', () => {
    expect(errors('head\n  html.dark(data-theme="light" data-mode={mode})\np x')).toEqual([])
    expect(compileKay('head\n  html(data-theme={theme})\np x', 'test.kay', { check: true }).tsx).toContain('void (<><html data-theme={theme} /></>);')
    expect(errors('head\n  html x\np')).toEqual(['`html` holds nothing: it sets the attributes of `<html>`'])
    expect(reports('head\n  html(lang="fr" DIR="rtl")\np')).toEqual([
      expect.objectContaining({ message: 'kay sets `lang` on `<html>` from the page\'s locale', at: 'lang' }),
      expect.objectContaining({ message: 'kay sets `DIR` on `<html>` from the page\'s locale', at: 'DIR' }),
    ])
    expect(errors('html(data-theme="light")\n  p x')).toEqual(['An `html` tag sets the attributes of `<html>` from the `head` block only'])
    expect(errors('div\n  html(data-theme="light")')).toEqual(['An `html` tag sets the attributes of `<html>` from the `head` block only'])
  })

  it('reports what a head tag\'s attributes get wrong in a build, as kay check does', () => {
    const source = 'head\n  meta(name="a" onclick={go})\n  link(rel="x" class="a" class="b")\np x'

    for (const output of ['html', 'dom'] as const)
      expect(compileKay(source, 'test.kay', { output }).diagnostics.map(d => d.message)).toEqual(['`onclick` does not attach a handler', 'An element takes one `class` attribute'])
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
    expect(compileKay('p Date of birth', 'date.kay').tsx).toContain('export default function Date(')
    expect(compileKay('p {Date.now() + DatePage}', 'date.kay').tsx).toContain('export default function DatePagePage(')
    expect(compileKay('---\nconst DatePage = 1\n---\np {Date.now() + DatePage}', 'date.kay').tsx).toContain('export default function DatePagePage(')
  })

  it('keeps the name a type of the template spells, renaming it only for `typeof`, which reads the value', () => {
    const recursive = '---\nconst { n } = props<{ n: number }>()\n---\nif n > 0\n  Node(n={n - 1})\n'
    const named = (template: string) => compileKay(`${recursive}${template}`, 'node.kay', { output: 'html' }).tsx.match(/\bfunction ([A-Z]\w*)\(/)?.[1]

    expect(named('button(onClick={(e: MouseEvent) => (e.target as { parentNode: Node }).parentNode}) x')).toBe('Node')
    expect(named('p {String(((x: Node, y: Array<Node>): x is Node => true) as unknown as new () => Node)}')).toBe('Node')
    expect(named('p {String(n as unknown as typeof Node)}')).toBe('NodePage')
    expect(compileKay('---\nconst { ts } = props<{ ts: number }>()\n---\nif ts > 0\n  Date(ts={0})\np {String(ts as unknown as Date)}', 'date.kay').tsx).toContain('export default function Date(')
  })

  describe('a name inside a type', () => {
    const fence = [
      'type Fn = (cb: (value: string) => void) => void',
      'const fn = (next: string | null) => (onChange as ((value: string | null) => unknown) | undefined)?.(next)',
      'const literal = (x: unknown) => x as { value: string, [value: string]: unknown }',
      'const mapped = (x: unknown) => x as { [value in \'a\' | \'b\']: number }',
      'const generic = (x: unknown) => x as Map<string, { value: number, count: number }>',
      'const method = (x: unknown) => x as { value(value: string): void }',
    ].join('\n')
    const compile = (output: 'html' | 'dom', head: string) => compileKay(`---\n${head}\n${fence}\n---\ndiv(onClick={() => fn(null)}) {value}`, 'test.kay', { output }).tsx

    for (const output of ['html', 'dom'] as const) {
      it(`is never read as a prop, in ${output} output`, () => {
        const code = compile(output, 'const { value, count, onChange } = props<{ value: string, count: number, onChange?: ((value: string) => unknown) | undefined }>()')

        expect(code).not.toContain('__props.value:')
        expect(code).not.toContain('__props.value in')
        expect(code).not.toContain('__props.value(')
        expect(code).not.toContain('__props.count:')
        expect(code).toContain('(cb: (value: string) => void)')
        expect(code).toContain('as ((value: string | null) => unknown) | undefined)?.(next)')
        expect(code).toContain('{ value: string, [value: string]: unknown }')
        expect(code).toContain('{ [value in \'a\' | \'b\']: number }')
        expect(code).toContain('Map<string, { value: number, count: number }>')
        expect(code).toContain('{ value(value: string): void }')
        expect(code).toContain('__props.value')
        expect(code).toContain('__props.onChange as')
      })

      it(`is not read as a signal, in ${output} output`, () => {
        const code = compileKay('---\nconst value = signal(\'a\')\nconst count = signal(1)\n---\np {(count as unknown as (value: string) => string)(value)} {[count].map((x: { value: number }) => x)}', 'test.kay', { output }).tsx

        expect(code).toContain('(value: string) => string')
        expect(code).toContain('{ value: number }')
        expect(code).not.toContain('value(): string')
      })
    }

    it('reads the value in a computed key of a type literal', () => {
      const code = compileKay('---\nconst { value, obj } = props<{ value: string, obj: { key: string } }>()\n---\np {(1 as unknown as { [value]: string, [obj.key]: string, [obj.key](): void })}', 'test.kay', { output: 'html' }).tsx

      expect(code).toContain('[__props.value]: string, [__props.obj.key]: string, [__props.obj.key](): void')
    })

    it('reports a prop only a type names as never read', () => {
      const unread = compileKay('---\nconst { value } = props<{ value: string }>()\nconst f = (x: unknown) => x as (value: string) => void\n---\np hi', 'test.kay', { check: true }).diagnostics.filter(d => d.code === 'unread-name')

      expect(unread.length).toBeGreaterThan(0)
    })

    it('still reads `typeof` as the value', () => {
      const code = compileKay('---\nconst { value } = props<{ value: string }>()\nconst k = (x: unknown) => x as typeof value\n---\np {value}', 'test.kay', { output: 'html' }).tsx

      expect(code).toContain('typeof __props.value')
      expect(code).not.toContain('typeof value')
    })

    it('reads `typeof` as the value inside a function type\'s parameter and a type literal\'s member, in html and dom', () => {
      for (const output of ['html', 'dom'] as const) {
        const code = compileKay('---\nconst { value } = props<{ value: string }>()\nconst f = (x: unknown) => x as ((v: typeof value) => void)\nconst g = (x: unknown) => x as { v: typeof value, m(v: typeof value): void }\n---\np {value}', 'test.kay', { output }).tsx

        expect(code).toContain('x as ((v: typeof __props.value) => void)')
        expect(code).toContain('x as { v: typeof __props.value, m(v: typeof __props.value): void }')
        expect(code).not.toContain('typeof value')
      }
    })

    it('reads a qualified `typeof` and a defaulted prop inside a nested type as the value, and leaves a function type\'s own parameter alone', () => {
      const code = compileKay('---\nconst { value, size = 1 } = props<{ value: { a: string }, size?: number }>()\nconst f = (x: unknown) => x as ((v: typeof value.a, n: typeof size) => void)\nconst g = (x: unknown) => x as ((value: number, w: typeof value) => void)\n---\np {value.a} {size}', 'test.kay', { output: 'dom' }).tsx

      expect(code).toContain('x as ((v: typeof __props.value.a, n: Exclude<(typeof __props)["size"], undefined>) => void)')
      expect(code).toContain('x as ((value: number, w: typeof value) => void)')
    })

    it('reads `typeof` of a template `const` as the type its memo holds, at the top of a type and nested, in html and dom', () => {
      for (const output of ['html', 'dom'] as const) {
        const code = compileKay('---\nconst items = signal([1])\n---\nfor n of items\n  const t = n + 1\n  p {(t as unknown as typeof t)} {(1 as unknown as { a: { b: typeof t }, f: (v: typeof t) => void })} {(1 as unknown as typeof t.a)}', 'test.kay', { output }).tsx

        expect(code).toContain('as unknown as ReturnType<typeof t>)')
        expect(code).toContain('{ a: { b: ReturnType<typeof t> }, f: (v: ReturnType<typeof t>) => void }')
        expect(code).toContain('as unknown as ReturnType<typeof t>["a"])')
        expect(code).not.toContain('typeof t()')
      }
    })

    it('leaves `typeof` of a destructured parameter of the enclosing function type alone', () => {
      for (const output of ['html', 'dom'] as const) {
        const code = compileKay('---\nconst { a, b } = props<{ a: string, b: string }>()\nconst f = (x: unknown) => x as (({ a }: { a: number }, w: typeof a) => void)\nconst g = (x: unknown) => x as (([b]: number[], ...{ length }: string[]) => typeof b)\n---\np {a}{b}', 'test.kay', { output }).tsx

        expect(code).toContain('(({ a }: { a: number }, w: typeof a) => void)')
        expect(code).toContain('=> typeof b)')
        expect(code).not.toContain('typeof __props.a')
        expect(code).not.toContain('typeof __props.b')
      }
    })
  })

  it('reports a template `const` named like the component, which its tags after it would render', () => {
    expect(compileKay('const Card = 1\np {Card}', 'card.kay', { check: true }).diagnostics.map(d => d.message)).toEqual(['`Card` is already declared'])
  })

  it('leaves the names the generated code declares out of the editor\'s completions', () => {
    expect([PROPS, CURRENT, defaultName(0), defaultName(12)].filter(name => !GENERATED_NAME.test(name))).toEqual([])
    expect(['props', 'Current', 'KayCurrentValue', '__default_x'].filter(name => GENERATED_NAME.test(name))).toEqual([])
  })

  it('keeps the name for a template that renders the component itself', () => {
    expect(compileKay('---\nconst { n } = props<{ n: number }>()\n---\nif n > 0\n  Tree(n={n - 1})', 'tree.kay').tsx).toContain('export default function Tree(')
    expect(compileKay('---\nimport { signal } from \'kay\'\n---\np {Counter}', 'counter.kay').tsx).toContain('\nfunction CounterPage(')
  })
})

describe('server values the fence reads', () => {
  it('reports a server value only when neither the template nor the rest of the fence reads it', () => {
    const unread = (server: string, template: string) => compileKay(`--- server\n${server}\n---\n${template}`, 'list.kay', { check: true }).diagnostics.filter(d => d.code === 'unread-name').map(d => d.message)

    expect(unread('const a = 1\nconst b = 2\nconst sum = a + b\nconst lonely = 3', 'p {sum}')).toEqual(['`lonely` is never read'])
    expect(unread('const first = 1\nconst second = 2', 'p {second}')).toEqual(['`first` is never read'])
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

    expect(code).toContain('<List items={[1]} {...KayFunctionProp(List)(0)} show={n => String(n)} />')
  })

  it('checks the parts of a literal prop a page sends, not the literal, so a generic component types it', () => {
    const check = (value: string) => (/<List items=\{(.*)\} \/>/).exec(compileKay(`---\nimport List from './list.kay'\n---\nList(items={${value}})`, '_layout.kay', { check: true }).tsx)?.[1]

    expect(check('[\'a\', [x, `b`], ...rest, { n: 1, m: y, ...more }]')).toBe('[\'a\', [KayProp(List)((x)), `b`], ...KayProp(List)((rest)), { n: 1, m: KayProp(List)((y)), ...KayProp(List)((more)) }]')
    expect(check('[ok ? [\'a\'] : z]')).toBe('[ok ? [\'a\'] : KayProp(List)((z))]')
    // An operand of `&&` keeps what it narrows, so the operation is checked whole.
    expect(check('[a && a.b]')).toBe('[KayProp(List)((a && a.b))]')
    // A shorthand property, a getter or a setter has no value of its own to wrap.
    expect(check('[{ x }, { get y() { return 1 } }, { set z(v: number) {} }]')).toBe('[KayProp(List)(({ x })), KayProp(List)(({ get y() { return 1 } })), KayProp(List)(({ set z(v: number) {} }))]')
  })

  it('checks a method in a literal prop a page sends as a function given to the component', () => {
    const code = compileKay('---\nimport List from \'./list.kay\'\n---\nList(items={[{ run() { return 1 } }]})', '_layout.kay', { check: true }).tsx

    expect(code).toContain('<List {...KayFunctionProp(List)(0)} items={[{ run() { return 1 } }]} />')

    // Beside a getter, which keeps the object whole, the check of the object covering it.
    expect(compileKay('---\nimport List from \'./list.kay\'\n---\nList(items={[{ get n() { return 1 }, run() { return 1 } }]})', '_layout.kay', { check: true }).tsx).toContain('<List items={[KayProp(List)(({ get n() { return 1 }, run() { return 1 } }))]} />')
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

describe('signal writes', () => {
  it('assign a signal through .set, a compound one or ++ through an updater', () => {
    const code = tsx('---\nconst count = signal(0)\nconst open = signal(false)\nfunction f() {\n  count=count() + 1\n  count *= 2\n  --count\n}\n---\nbutton(onClick={() => { count++; open = !open() }}) {count()}')

    expect(code).toContain('count.set(count() + 1)\n  count.set((KayCurrent) => KayCurrent * (2))\n  count.set((KayCurrent) => KayCurrent - 1)')
    expect(code).toContain('count.set((KayCurrent) => KayCurrent + 1); open.set(!open())')
  })

  it('read by calling and write by name a prop typed Signal, inline or through a type of the script, and a signal a module exports', () => {
    const typed = '---\nimport type { Signal as S } from \'kay\'\ninterface Props { open: S<boolean>, label: string }\nconst { open, label } = props<Props>()\n---\nbutton(onClick={() => open = false}) {open()} {label}'

    expect(jsx(typed)).toBe('<button onClick={() => __props.open.set(false)}>{(void __props.open, __values.open)} {__props.label}</button>')
    expect(tsx(typed)).toContain('const __values = { open: __props.open() }')

    const imported = compileKay('---\nimport { accent as tone } from \'./theme\'\n---\nbutton(onClick={() => tone += \'!\'}) {tone()}', 'test.kay', { importedSignals: { './theme': { accent: 'signal' } } })

    expect(imported.tsx).toContain('<button onClick={() => tone.set((KayCurrent) => KayCurrent + (\'!\'))}>{(void tone, __values.tone)}</button>')
  })

  it('reject a write to a memo, a signal written by destructuring and a constant plainly holding no signal', () => {
    const source = '---\nimport { loud } from \'./theme\'\nconst count = signal(0)\nconst double = memo(() => count() * 2)\nconst plain = 1\nconst params = new URLSearchParams()\nconst cast = {} as never\nconst list = [1]\nconst sum = count() + 1\nlet free = 0\nfunction f() {\n  double = 3\n  loud++\n  plain += 1\n  params = new URLSearchParams()\n  cast = 1\n  list = []\n  sum ??= 2\n  free++\n  ;[count] = [signal(1)]\n}\n---\np x'
    const found = compileKay(source, 'test.kay', { importedSignals: { './theme': { loud: 'memo' } } }).diagnostics.map(d => [source.slice(d.start, d.end), d.message])

    expect(found).toEqual([
      ['double', '`double` is a memo, which cannot be written'],
      ['loud', '`loud` is a memo, which cannot be written'],
      ['plain', '`plain` holds no signal, so it cannot be assigned'],
      ['params', '`params` holds no signal, so it cannot be assigned'],
      ['list', '`list` holds no signal, so it cannot be assigned'],
      ['sum', '`sum` holds no signal, so it cannot be assigned'],
      ['count', '`count` is a signal, written by assigning its name'],
    ])
  })

  it('write through .set any other constant or import assigned, which type checking asserts holds a signal', () => {
    const source = '---\nimport accent, { theme, makeSignal, useDialog } from \'./theme\'\nconst sel = makeSignal()\nconst { open } = useDialog()\nfunction f() {\n  accent = \'red\'\n  theme ??= \'dark\'\n  sel += 1\n  sel++\n  for (const each of [sel]) each = 0\n  let shadow = 1\n  shadow = 2\n}\n---\nbutton(onClick={() => open = !open()}) {sel()}'
    const runs = compileKay(source, 'test.kay', { output: 'dom' })
    const served = compileKay(source, 'test.kay', { output: 'html' })
    const checked = compileKay(source, 'test.kay', { check: true })

    for (const result of [runs, served, checked])
      expect(result.diagnostics.map(d => d.message)).toEqual([])

    for (const { tsx: code } of [runs, served]) {
      expect(code).toContain('accent.set(\'red\')\n  theme.set((KayCurrent) => KayCurrent ?? (\'dark\'))\n  sel.set((KayCurrent) => KayCurrent + (1))\n  sel.set((KayCurrent) => KayCurrent + 1)\n  for (const each of [sel]) each.set(0)\n  let shadow = 1\n  shadow = 2')
      expect(code).not.toContain('KayWritable')
    }

    expect(runs.tsx).toContain('open.set(!open())')
    expect(checked.tsx).toContain('KayWritable(accent).set(\'red\')\n  KayWritable(theme).set((KayCurrent) => KayCurrent ?? (\'dark\'))\n  KayWritable(sel).set((KayCurrent) => KayCurrent + (1))\n  KayWritable(sel).set((KayCurrent) => KayCurrent + 1)\n  for (const each of [sel]) KayWritable(each).set(0)\n  let shadow = 1\n  shadow = 2')
    expect(checked.tsx).toContain('KayWritable(open).set(!open())')
  })

  it('keep a parenthesized right side whole, in a plain, compound or logical assignment, on the server, in an island and when type checking', () => {
    const source = '---\nimport { accent } from \'./theme\'\nimport type { Signal } from \'kay\'\nconst { open } = props<{ open: Signal<boolean> }>()\nconst count = signal(0)\nconst pair = signal(0)\nfunction f() {\n  count = (2)\n  count += (1 as number)\n  count = ((3))\n  pair = (count(), 4)\n  count ??= ( 5 )\n  count ||= (9)\n  count &&= (10)\n  count = /* six */ (6)\n  count = (7) + (8)\n  accent = (\'red\')\n  open = (false)\n}\n---\nbutton(onClick={() => count = (count() + 1)}) {count()} {pair()} {open()}'
    const runs = compileKay(source, 'test.kay', { output: 'dom' })
    const served = compileKay(source, 'test.kay', { output: 'html' })
    const checked = compileKay(source, 'test.kay', { check: true })

    for (const { tsx: code, diagnostics } of [runs, served, checked]) {
      expect(diagnostics.map(d => d.message)).toEqual([])
      expect(() => parser.parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })).not.toThrow()
    }

    for (const { tsx: code } of [runs, served]) {
      expect(code).toContain('count.set((2))\n  count.set((KayCurrent) => KayCurrent + ((1 as number)))\n  count.set(((3)))\n  pair.set((count(), 4))\n  count.set((KayCurrent) => KayCurrent ?? (( 5 )))\n  count.set((KayCurrent) => KayCurrent || ((9)))\n  count.set((KayCurrent) => KayCurrent && ((10)))\n  count.set((6))\n  count.set((7) + (8))\n  accent.set((\'red\'))\n  __props.open.set((false))')
    }

    expect(runs.tsx).toContain('count.set((count() + 1))')
    expect(checked.tsx).toContain('KayWritable(accent).set((\'red\'))')
    expect(checked.tsx).toContain('onClick={() => count.set((count() + 1))}')
  })
})

describe('module signals', () => {
  it('finds the signals and memos a module exports as export const, made by kay\'s functions', () => {
    expect(moduleSignals('import { signal as s, memo, persisted } from \'kay\'\nimport { linked } from \'other\'\n\nexport const a = s(1), b = memo(() => a())\nexport const c = persisted(\'c\', 0)\nexport const d = linked(() => 1)\nconst e = s(2)\nexport let f = s(3)\nexport { e }\n')).toEqual({ a: 'signal', b: 'memo', c: 'signal' })
    expect(moduleSignals('import { debounced, signal } from \'kay\'\n\nexport const typed = signal(\'\')\nexport const settled = debounced(typed, \'300ms\')\n')).toEqual({ typed: 'signal', settled: 'memo' })
    expect(moduleSignals('export const a = signal(1)\n')).toEqual({})
  })
})

describe('a component\'s slots', () => {
  const source = 'import Card from \'./card.kay\'\n---\nCard\n  @side\n    p Side\n  em Body\n'

  it('are functions building them in the browser, so a read that is no insert claims nothing, and markup on the server', () => {
    const dom = compileKay(source, 'page.kay', { output: 'dom' }).tsx
    const html = compileKay(source, 'page.kay', { output: 'html' }).tsx

    expect(dom).toContain('get "side"() { return () => (')
    expect(dom).toContain('get children() { return () => (')
    expect(html).not.toContain('return () => (')
  })
})

describe('shorthand classes with a decimal', () => {
  const source = 'div.grid.gap-1.5.p-2.w-1.5.h-2.5 x\n'

  it('renders one class a piece on the server', () => {
    const { tsx, diagnostics } = compileKay(source, 'x.kay')

    expect(diagnostics).toEqual([])
    expect(tsx).toContain('grid gap-1.5 p-2 w-1.5 h-2.5')
    expect(tsx).not.toContain('gap-1 5')
  })

  it('renders one class a piece in an island', () => {
    const { tsx, diagnostics } = compileKay(source, 'x.kay', { output: 'dom' })

    expect(diagnostics).toEqual([])
    expect(tsx).toContain('grid gap-1.5 p-2 w-1.5 h-2.5')
    expect(tsx).not.toContain('gap-1 5')
  })

  it('keeps a decimal class before an attribute list, text and a block expansion', () => {
    expect(compileKay('a.p-0.5(href="/x") go\n', 'x.kay').tsx).toContain('p-0.5')
    expect(compileKay('ul.gap-1.5: li x\n', 'x.kay').diagnostics).toEqual([])
  })
})
