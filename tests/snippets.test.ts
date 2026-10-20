import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { parseKay } from '../src/compiler/parser'
import { child, html } from '../src/runtime/html'
import { scratchDir } from './scratch'

await plugin(kay())

const scratch = await scratchDir('snippets-')
let cases = 0

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

// An island's hydratable markup separates dynamic text with comment markers; the assertions read the text alone.
const MARKERS = /<!--[[\]]-->/g

async function renderKay(source: string, props: Record<string, unknown> = {}): Promise<string> {
  const file = join(scratch, `case-${cases++}.kay`)

  await Bun.write(file, source)

  const module = await import(file) as { default: (props: Record<string, unknown>) => unknown }

  return child(module.default(props)).replace(MARKERS, '')
}

describe('parsing a snippet', () => {
  it('reads its name, its parameters as written and the lines below it', () => {
    const source = 'snippet feature(title: string, text = \'x\')\n  h3 {title}\n  p {text}\n'
    const { template } = parseKay(source)
    const [node] = template

    expect(node).toMatchObject({ kind: 'snippet', children: [{ kind: 'element' }, { kind: 'element' }] })

    if (node?.kind !== 'snippet')
      throw new Error('not a snippet')

    expect(source.slice(node.name.start, node.name.end)).toBe('feature')
    expect(source.slice(node.params.start, node.params.end)).toBe('title: string, text = \'x\'')
  })

  it('takes no brackets as no parameters', () => {
    const source = 'snippet divider\n  hr\n'
    const [node] = parseKay(source).template

    expect(node?.kind === 'snippet' && source.slice(node.params.start, node.params.end)).toBe('')
  })

  it('keeps a word that only starts with snippet an element', () => {
    expect(parseKay('snippets\n  p x\n').template[0]).toMatchObject({ kind: 'element', name: 'snippets' })
  })

  it('reports a missing name, a reserved one, text after the parameters and an empty body', () => {
    expect(parseKay('snippet\n  p x\n').diagnostics.map(diagnostic => diagnostic.message)).toEqual(['A snippet needs a name'])
    expect(parseKay('snippet class()\n  p x\n').diagnostics.map(diagnostic => diagnostic.message)).toEqual(['`class` is a reserved word, so it cannot name a snippet'])
    expect(parseKay('snippet a() text\n  p x\n').diagnostics.map(diagnostic => diagnostic.message)).toEqual(['Nothing may follow the parameters of a snippet on its line'])
    expect(parseKay('snippet a()\np x\n').diagnostics.map(diagnostic => diagnostic.message)).toEqual(['A snippet needs lines below it'])
  })
})

describe('rendering a snippet on the server', () => {
  const rows = '--- <T>\nimport type { JSX } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: (item: T, index: number) => JSX.Element }>()\n---\nul\n  for item, i of items key={i}\n    | {row(item, i)}\n'
  const box = '---\nimport type { JSX } from \'kay\'\n\nconst { children } = props<{ children: JSX.Element }>()\n---\ndiv.box\n  slot\n'
  const shell = '---\nimport type { JSX } from \'kay\'\n\nconst { children } = props<{ children: JSX.Element }>()\n---\nsnippet frame(title: string)\n  section\n    h2 {title}\n    slot\n{frame(\'Framed\')}\n'
  const tree = { name: 'root', children: [{ name: 'a', children: [{ name: 'a1', children: [] }] }, { name: 'b', children: [] }] }

  const table: [string, string, Record<string, unknown>, string][] = [
    ['one declared once and rendered three times with other arguments', 'snippet feature(title: string, text: string)\n  article\n    h3 {title}\n    p {text}\n.grid\n  {feature(\'Fast\', \'Built on Bun\')}\n  {feature(\'Small\', \'9 KB\')}\n  {feature(\'Typed\', \'Checked\')}', {}, '<div class="grid"><article><h3>Fast</h3><p>Built on Bun</p></article>\n<article><h3>Small</h3><p>9 KB</p></article>\n<article><h3>Typed</h3><p>Checked</p></article></div>'],
    ['an argument holding markup or a quote escaped as any text is', '---\nconst { risky } = props<{ risky: string }>()\n---\nsnippet note(text: string)\n  p(title={text}) {text}\n{note(risky)}', { risky: '<script>alert("x")</script> \'q\'' }, '<p title="&lt;script>alert(&quot;x&quot;)&lt;/script> \'q\'">&lt;script>alert("x")&lt;/script> \'q\'</p>'],
    ['one rendered in a loop with the loop variables as arguments', '---\nconst { names } = props<{ names: string[] }>()\n---\nsnippet entry(name: string, i: number)\n  li {i}: {name}\nul\n  for name, i of names\n    {entry(name, i)}', { names: ['a', 'b'] }, '<ul><li>0: a</li><li>1: b</li></ul>'],
    ['one declared in a loop reading the loop variables', '---\nconst { names } = props<{ names: string[] }>()\n---\nfor name, i of names\n  snippet tag(mark: string)\n    b {name}{mark}{i}\n  p {tag(\'!\')} {tag(\'?\')}', { names: ['a', 'b'] }, '<p><b>a!0</b> <b>a?0</b></p><p><b>b!1</b> <b>b?1</b></p>'],
    ['one reading the script consts and the template consts around it', '---\nconst greeting = \'Hi\'\n---\nconst who = \'you\'\nsnippet hello()\n  b {greeting} {who}\n{hello()}', {}, '<b>Hi you</b>'],
    ['one calling itself, as a tree does', `---\ninterface Branch { name: string, children: Branch[] }\nconst { root } = props<{ root: Branch }>()\n---\nsnippet branch(node: Branch)\n  li {node.name}\n    if node.children.length > 0\n      ul\n        for next of node.children\n          {branch(next)}\nul\n  {branch(root)}`, { root: tree }, '<ul><li>root<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul></li></ul>'],
    ['one calling another declared above it', 'snippet bold(text: string)\n  b {text}\nsnippet line(label: string, value: number)\n  p {bold(label)}: {value}\n{line(\'Total\', 3)}', {}, '<p><b>Total</b>: 3</p>'],
    ['one holding a component', '---\nimport Box from \'./box.kay\'\n---\nsnippet boxed(label: string)\n  Box\n    b {label}\n{boxed(\'x\')}', {}, '<div class="box"><b>x</b></div>'],
    ['one holding the bare slot of its component', '---\nimport Shell from \'./shell.kay\'\n---\nShell\n  p Inside', {}, '<section><h2>Framed</h2><p>Inside</p></section>'],
    ['one holding if, for and match', '---\nconst { list, status } = props<{ list: string[], status: string }>()\n---\nsnippet panel(items: string[], state: string)\n  if items.length > 1\n    p many\n  else\n    p few\n  for item of items\n    i {item}\n  match state\n    when \'on\'\n      u on\n    else\n      u off\n{panel(list, status)}', { list: ['a', 'b'], status: 'on' }, '<p>many</p><i>a</i><i>b</i><u>on</u>'],
    ['one with destructuring, defaults and rest parameters', 'snippet card({ title, tags = [] }: { title: string, tags?: string[] }, size = \'md\', ...more: string[])\n  div(class={size})\n    h4 {title}\n    span {tags.join(\'+\')} {more.length}\n{card({ title: \'A\' })}\n{card({ title: \'B\', tags: [\'x\', \'y\'] }, \'lg\', \'1\', \'2\')}', {}, '<div class="md"><h4>A</h4><span> 0</span></div>\n<div class="lg"><h4>B</h4><span>x+y 2</span></div>'],
    ['one with no parameters and a line of text', 'snippet dot\n  | .\np a{dot()}b', {}, '<p>a.b</p>'],
    ['one passed to a component as a function prop', '---\nimport Rows from \'./rows.kay\'\n---\nsnippet item(name: string, i: number)\n  li {i}: {name}\nRows(items={[\'a\', \'b\']} row={item})', {}, '<ul><li>0: a</li><li>1: b</li></ul>'],
    ['one in a page with a head block and a props type', '---\nconst { title } = props<{ title: string }>()\n---\nsnippet lead()\n  p {title}\nhead\n  title {title}\n{lead()}', { title: 'T' }, '<p>T</p>'],
  ]

  beforeAll(async () => {
    await Bun.write(join(scratch, 'rows.kay'), rows)
    await Bun.write(join(scratch, 'box.kay'), box)
    await Bun.write(join(scratch, 'shell.kay'), shell)
  })

  it.each(table)('render %s', async (_name, source, props, expected) => {
    expect(await renderKay(source, props)).toBe(expected)
  })

  it('render in a layout around its slot, with the layout\'s head block', async () => {
    const file = join(scratch, 'layout', '_layout.kay')

    await Bun.write(file, 'snippet nav(label: string)\n  a(href="/") {label}\nhead\n  title Site\nheader\n  {nav(\'Home\')}\nmain\n  slot\n')

    const module = await import(file) as { default: (props: Record<string, unknown>) => unknown }

    expect(child(module.default({ children: html('<p>page</p>') }))).toBe('<header><a href="/">Home</a></header><main><p>page</p></main>')
  })

  it('render the same inside an island, markers aside', async () => {
    const html = await renderKay('---\nimport { signal } from \'kay\'\n\nconst count = signal(2)\n---\nsnippet feature(title: string)\n  p {title} {count()}\n.grid\n  {feature(\'A\')}\n  {feature(\'B\')}')

    expect(html).toEndWith('><div class="grid"><p>A 2</p>\n<p>B 2</p></div></slot>')
  })
})
