import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { child } from '../src/runtime/html'
import { scratchDir } from './scratch'

await plugin(kay())

// Each fixture is a `main.kay` rendered with no props, beside the components it imports. Every one holds a signal, so the server renders it as an island, markers included.
const FIXTURES: Record<string, Record<string, string | Blob>> = {
  'attributes': {
    'main.kay': '---\nconst label = signal(\'Main & co\')\nconst extra = \'wide\'\nconst off = false\nconst rest = { \'data-a\': 1, \'title\': \'from spread\' }\n---\ndiv#main.card(class={extra} title="a &amp; b <c>" data-n={2} hidden={off} aria-label={label()})\n  span(class="x" {...rest}) spread\n  input(type="text" value={label()} disabled)\n  br\n  a(href="/about" target="_blank") About\n',
  },
  'text': {
    'main.kay': '---\nconst name = signal(\'Ada\')\nconst count = 3\n---\np Hello {name()}, you have {count} items & more < less\np\n  | first line\n  | {name()} second\n  strong bold\n  |  tail\n',
  },
  'control flow': {
    'main.kay': '---\nconst items = signal([{ id: 1, title: \'One\' }, { id: 2, title: \'Two\' }])\nconst empty: string[] = []\nconst shown = true\n---\nif shown\n  p shown\nelse\n  p hidden\nif !shown\n  p never\nul\n  for item of items()\n    li {item.title}\nul\n  for word of empty key={word}\n    li {word}\n  else\n    li none\nfor item, i of items() key={i}\n  span {i}: {item.title}\n',
  },
  'components': {
    'main.kay': '---\nimport Card from \'./card.kay\'\n\nconst title = signal(\'Card title\')\n---\nCard.big(title={title()} class="outlined")\n  @actions\n    button Save\n  p Body of {title()}\nCard(title="Bare")\n',
    'card.kay': '---\nconst { title, class: className } = props<{ title: string, class?: string }>()\n---\nsection(class={className})\n  h2 {title}\n  slot\n  footer\n    slot actions\n      span no actions\n',
  },
  'styles and fields': {
    'main.kay': '---\nconst color = signal(\'red\')\nconst on = true\nconst text = \'Some <text>\'\n---\np(style={{ color: color(), \'font-size\': \'2px\' }}) styled\np(style="margin: 0") plain\ninput(type="checkbox" checked={on})\ntextarea(name="body") {text}\nselect(name="pick")\n  option(value="a") A\n  option(value="b" selected) B\n',
  },
  'values': {
    'main.kay': '---\nconst picked = signal(\'b\')\nconst zero = 0\nconst nothing = null\nconst markup = \'<em>raw</em>\'\nconst yes = true\nconst list = [\'x\', \'y\']\n---\nselect(value={picked()})\n  option(value="a") A\n  option(value="b") B\ndiv(innerHTML={markup})\np(data-zero={zero} data-null={nothing} aria-hidden={yes} hidden={yes} aria-busy={false}) values\ninput(type="number" value={zero})\ntextarea(value={picked()})\np {nothing}{list}{zero}{yes}\n',
  },
  'images and links': {
    'main.kay': '---\nconst src = signal(\'/photo.png\')\nconst href = \'/docs\'\n---\nimg(src={src()} alt="Photo" width="40" height="30")\nimg(src={src()} alt="" sizes="50vw")\nimg(src="/static.png" alt="")\na(href={href}) Docs\na(href="https://example.com" rel="noopener") Out\n',
  },
  'merged classes': {
    'main.kay': '---\nimport Box from \'./box.kay\'\nimport Tagged from \'./tagged.kay\'\n\nconst active = signal(true)\nconst rest = { class: \'from-spread\', id: \'spread\' }\n---\ndiv.a(class={{ on: active(), off: !active() }})\ndiv.a(class="b" {...rest})\nBox.shorthand(class={active() ? \'yes\' : \'no\'})\nBox.shorthand({...rest})\nTagged.a({...rest} class={{ on: active() }})\nTagged.a(class={active() ? \'z\' : undefined})\nTagged({...rest} class={undefined})\nTagged({...{}} class={undefined})\n',
    'tagged.kay': '---\nconst { class: className } = props<{ class?: string }>()\n---\np(title={`[${className}]`})\n',
    'box.kay': '---\nconst { class: className } = props<{ class?: string }>()\n---\ndiv(class={className}) box\n',
  },
  'handlers and forms': {
    'main.kay': '---\nimport Box from \'./box.kay\'\n\nconst count = signal(0)\nconst rest = { id: \'spread\', title: \'from spread\' }\nconst extra = signal(\'wide\')\n---\ndiv(onClick={() => count.set(count() + 1)} {...rest}) clicks {count()}\nform(action={\'/save\'} {...rest})\n  input(name="q")\nform(action={\'/save\'} method="get" {...rest})\n  input(name="q")\nBox.tag(class={extra()} {...rest})\n',
    'box.kay': '---\nconst { class: className } = props<{ class?: string }>()\n---\ndiv(class={className}) box\n',
  },
  'slots': {
    'main.kay': [
      '---',
      'import { signal } from \'kay\'',
      'import Card from \'./card.kay\'',
      'import Rows from \'./rows.kay\'',
      '',
      'const names = signal([\'a\', \'b\'])',
      '---',
      'Rows(items={names()})',
      '  @row(name)',
      '    li.row {name}!',
      'Card(items={names()})',
      '  @actions',
      '    button Add',
      '  @row(name, i)',
      '    li {i}: {name}',
      '  p Body',
      'Card(items={[\'a\']})',
      '',
    ].join('\n'),
    'rows.kay': '--- <T>\nimport type { JSX } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: (item: T) => JSX.Element }>()\n---\nul\n  for item of items key={item}\n    | {row(item)}\n',
    'card.kay': '---\nimport type { JSX } from \'kay\'\n\nconst { items, actions, row } = props<{ items: string[], actions?: JSX.Element, row?: (item: string, index: number) => JSX.Element }>()\n---\nheader\n  slot actions\n    | No actions\nul\n  for item, i of items key={i}\n    slot row(item, i)\n      li {item}\nslot\n  p Empty\n',
  },
  'snippets': {
    'main.kay': [
      '---',
      'import { signal } from \'kay\'',
      'import Box from \'./box.kay\'',
      'import Rows from \'./rows.kay\'',
      '',
      'interface Branch { name: string, children: Branch[] }',
      '',
      'const count = signal(3)',
      'const names = signal([\'a\', \'<b>\'])',
      'const tree: Branch = { name: \'root\', children: [{ name: \'x\', children: [{ name: \'y\', children: [] }] }, { name: \'z\', children: [] }] }',
      '---',
      'const suffix = \'!\'',
      'snippet feature(title: string, text = \'none\', ...more: string[])',
      '  article(title={title})',
      '    h3 {title}{suffix}',
      '    p {text} {more.length} {count()}',
      'snippet branch(node: Branch)',
      '  li {node.name}',
      '    if node.children.length > 0',
      '      ul',
      '        for next of node.children',
      '          {branch(next)}',
      'snippet item(name: string, i: number)',
      '  li.row {i}: {name}',
      '.grid',
      '  {feature(\'Fast\', \'Built on Bun\')}',
      '  {feature(\'<Small> "9 KB"\')}',
      '  {feature(\'Typed\', \'Checked\', \'1\', \'2\')}',
      'ul',
      '  {branch(tree)}',
      'for name, i of names()',
      '  snippet tag(mark: string)',
      '    b {name}{mark}{i}',
      '  p {tag(\'?\')} {tag(\'!\')}',
      'Rows(items={names()} row={item})',
      'section',
      '  snippet note(text: string)',
      '    em {text}{count()}',
      '  {note(\'x\')}',
      '  p {note(\'y\')}',
      'Box',
      '  snippet inner()',
      '    u inside',
      '  {inner()}',
      '',
    ].join('\n'),
    'box.kay': '---\nimport type { JSX } from \'kay\'\n\nconst { children } = props<{ children: JSX.Element }>()\n---\ndiv.box\n  slot\n',
    'rows.kay': '--- <T>\nimport type { JSX } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: (item: T, index: number) => JSX.Element }>()\n---\nul\n  for item, i of items key={i}\n    | {row(item, i)}\n',
  },
  'template consts and match': {
    'main.kay': [
      '---',
      'import { signal } from \'kay\'',
      'import Box from \'./box.kay\'',
      '',
      'const products = signal([{ name: \'Tea\', cents: 250, stock: 1 }, { name: \'Mug\', cents: 900, stock: 8 }])',
      'const status = signal(\'scheduled\')',
      'const other = signal(\'gone\')',
      '---',
      'const count = products().length',
      'p {count} products',
      'for product of products()',
      '  const price = (product.cents / 100).toFixed(2)',
      '  const { name, stock: left = 0 } = product',
      '  li(title={price}) {name}: {price}',
      '    if left < 3 as low',
      '      const label = \'only \' + low',
      '      b {label}',
      'Box',
      '  const total = products().reduce((sum, product) => sum + product.cents, 0)',
      '  | {total}',
      'try',
      '  const twice = count * 2',
      '  i {twice}',
      'match status()',
      '  when \'draft\'',
      '    p Draft',
      '  when \'published\', \'scheduled\'',
      '    p Live',
      '  else',
      '    p Unknown',
      'match other()',
      '  when \'draft\'',
      '    p Draft',
      '  else',
      '    p Unknown',
      '',
    ].join('\n'),
    'box.kay': '---\nimport type { JSX } from \'kay\'\n\nconst { children } = props<{ children: JSX.Element }>()\n---\ndiv.box\n  slot\n',
  },
  'sibling consts': {
    'main.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(1)\nconst m = signal(2)\n---\nconst double = n() * 2\nbutton#up {double}\ndiv\n  p\n    const label = \'p\' + n()\n    b {label}\n    i(title={label}) {double}\n  span\n    const label = \'s\' + double\n    | {label}\nif n() > 1\n  const { big } = { big: n() * 10 }\n  em {big}\nif m() > 1\n  const { big } = { big: m() * 10 }\n  em {big}\n',
  },
  'imported images': {
    'main.kay': [
      '---',
      'import { signal } from \'kay\'',
      'import hero from \'./hero.png\'',
      '',
      'const src = signal(hero)',
      'const own = { loading: \'eager\' }',
      '---',
      'img(src={hero} alt="")',
      'img.hero(src={src()} sizes="50vw" alt="")',
      'img.sized(src={hero} height="10" alt="")',
      'img.spread(alt="" {...{ src: src() }})',
      'img(src="/b.png" alt="" fetchpriority="high")',
      'img(src="/c.png" alt="" loading="eager" decoding="sync")',
      'img(src="/d.png" alt="" {...own})',
      '',
    ].join('\n'),
    'hero.png': Bun.file(join(import.meta.dir, 'fixtures/images/src/hero.png')),
  },
  'image loading': {
    'main.kay': [
      '---',
      'import { signal } from \'kay\'',
      '',
      'const src = signal(\'/a.png\')',
      '---',
      'img.lazy(src={src()} alt="")',
      'img.hero(src={src()} alt="" loading="eager")',
      'img.spread(alt="" {...{ src: src() }})',
      '',
    ].join('\n'),
  },
  'ARIA states and bound URLs': {
    'main.kay': [
      '---',
      'import { signal } from \'kay\'',
      '',
      'const open = signal<boolean | null>(false)',
      'const none = signal<boolean | null>(null)',
      'const url = signal(\'/home\')',
      'const bad = signal(\' javascript:alert(1)\')',
      'const aria = { \'aria-pressed\': false, \'aria-busy\': null, \'aria-label\': \'x\' }',
      '---',
      'button(aria-expanded={open()} aria-selected={false} aria-checked={none()} hidden={open() === true} {...aria}) x',
      'div({...{ \'aria-busy\': open() }})',
      'div({...{ \'aria-busy\': none() }})',
      'p(hidden={true} disabled={false}) shut',
      'a(href={url()}) home',
      'a(href={bad()}) bad',
      'img(alt="" {...{ src: bad() }})',
      '',
    ].join('\n'),
  },
  'untrusted spread': {
    'main.kay': '---\nconst count = signal(0)\nconst data = { title: \'ok\', ONCLICK: \'alert(1)\', onmouseover: \'alert(1)\', \'x" onfocus="alert(1)\': 1, srcdoc: \'<script>alert(1)</script>\' }\n---\np {count()}\ndiv({...data})\niframe(title="frame" {...data})\n',
  },
  'consts': {
    'main.kay': '---\nconst cents = signal(1250)\n---\nconst price = cents() / 100\np Price {price}\nconst { a, b } = { a: 1, b: 2 }\np {a} and {b}\n',
  },
}

// What a fixture draws, written as the browser holds it, for the ones whose output the other test files no longer assert.
const EXPECTED: Record<string, string> = {
  'snippets': '<div class="grid"><article title="Fast"><h3>Fast!</h3><p>Built on Bun 0 3</p></article>\n<article title="<Small> "9 KB""><h3>&lt;Small> "9 KB"!</h3><p>none 0 3</p></article>\n<article title="Typed"><h3>Typed!</h3><p>Checked 2 3</p></article></div><ul><li>root<ul><li>x<ul><li>y</li></ul></li><li>z</li></ul></li></ul><p><b>a?0</b> <b>a!0</b></p><p><b>&lt;b>?1</b> <b>&lt;b>!1</b></p><ul><li class="row">0: a</li><li class="row">1: &lt;b></li></ul><section><em>x3</em><p><em>y3</em></p></section><div class="box"><u>inside</u></div>',
  'slots': '<ul><li class="row">a!</li><li class="row">b!</li></ul><header><button>Add</button></header><ul><li>0: a</li><li>1: b</li></ul><p>Body</p><header>No actions</header><ul><li>a</li></ul><p>Empty</p>',
  'template consts and match': '<p>2 products</p><li title="2.50">Tea: 2.50<b>only true</b></li><li title="9.00">Mug: 9.00</li><div class="box">1150</div><i>4</i><p>Live</p><p>Unknown</p>',
  'image loading': '<img alt="" class="lazy" decoding="async" loading="lazy" src="/a.png"></img><img alt="" class="hero" decoding="async" loading="eager" src="/a.png"></img><img alt="" class="spread" decoding="async" loading="lazy" src="/a.png"></img>',
  'ARIA states and bound URLs': '<button aria-expanded="false" aria-label="x" aria-pressed="false" aria-selected="false">x</button><div aria-busy="false"></div><div></div><p hidden="">shut</p><a href="/home">home</a><a href="unsafe: javascript:alert(1)">bad</a><img alt="" decoding="async" loading="lazy" src="unsafe: javascript:alert(1)"></img>',
  'merged classes': '<div class="a on"></div><div class="a b from-spread" id="spread"></div><div class="shorthand yes">box</div><div class="shorthand from-spread">box</div><p title="[a from-spread on]"></p><p title="[a z]"></p><p title="[from-spread]"></p><p title="[undefined]"></p>',
}

let dir: string
const server = new Map<string, string>()
const browser = new Map<string, string>()

// The tree as the browser holds it, written out with attributes sorted and form controls by their live state, which the browser sets as properties where the server writes attributes: a server island's wrapper and hydration markers left out.
function normalized(html: string): string {
  const template = document.createElement('template')

  template.innerHTML = html

  const first = template.content.firstElementChild
  const root = first?.matches('slot[data-component]') ? first : template.content

  return [...root.childNodes].map(written).join('')
}

function written(node: globalThis.Node): string {
  if (node.nodeType === 3)
    return (node as Text).data.replaceAll('&', '&amp;').replaceAll('<', '&lt;')

  if (node.nodeType === 8)
    return node.nodeValue === '[' || node.nodeValue === ']' ? '' : `<!--${node.nodeValue}-->`

  const element = node as HTMLElement
  const control = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
  const option = element instanceof HTMLOptionElement
  const attributes = [...element.attributes].filter(attribute => control ? attribute.name !== 'value' && attribute.name !== 'checked' : !option || attribute.name !== 'selected').map(attribute => `${attribute.name}="${attribute.value}"`)

  if (control)
    attributes.push(`.value="${(element as HTMLInputElement).value}"`)

  if (element instanceof HTMLInputElement)
    attributes.push(`.checked="${element.checked}"`)

  if (option)
    attributes.push(`.selected="${element.selected}"`)

  const children = element instanceof HTMLTextAreaElement ? '' : [...element.childNodes].map(written).join('')

  return `<${element.localName}${attributes.sort().map(attribute => ` ${attribute}`).join('')}>${children}</${element.localName}>`
}

beforeAll(async () => {
  dir = await scratchDir('parity-')

  const names = Object.keys(FIXTURES)
  const entry = `import { render } from 'kay/dom'\n${names.map((_, index) => `import Main${index} from './${index}/main.kay'`).join('\n')}\n\nexport const mains = [${names.map((_, index) => `Main${index}`).join(', ')}]\nexport { render }\n`

  await Bun.write(join(dir, 'entry.ts'), entry)

  for (const [index, name] of names.entries()) {
    await mkdir(join(dir, String(index)))
    await Promise.all(Object.entries(FIXTURES[name]!).map(async ([file, text]) => Bun.write(join(dir, String(index), file), text)))

    const Main = (await import(join(dir, String(index), 'main.kay')) as { default: (props: object) => unknown }).default

    server.set(name, child(Main({})))
  }

  const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: join(dir, 'out'), target: 'browser', plugins: [kay()] })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  GlobalRegistrator.register()

  const { mains, render } = await import(build.outputs[0]!.path) as { mains: ((props: object) => unknown)[], render: (fn: () => unknown, element: Element) => () => void }

  for (const [index, name] of names.entries()) {
    const root = document.createElement('div')

    render(() => mains[index]!({}), root)
    browser.set(name, [...root.childNodes].map(written).join(''))
  }
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(dir, { recursive: true, force: true })
})

describe('server and browser markup', () => {
  it('drops from a spread what would run or load a document, on both sides', () => {
    const expected = '<p>0</p><div title="ok"></div><iframe title="ok"></iframe>'

    expect(normalized(server.get('untrusted spread')!)).toBe(expected)
    expect(browser.get('untrusted spread')).toBe(expected)
  })

  for (const name of Object.keys(FIXTURES)) {
    it(`renders ${name} alike`, () => {
      expect(browser.get(name)).toBe(normalized(server.get(name)!))

      if (name in EXPECTED)
        expect(browser.get(name)).toBe(EXPECTED[name])
    })
  }
})
