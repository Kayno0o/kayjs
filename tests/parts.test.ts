import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { compileKay } from '../src/compiler'
import { installClassTable } from '../src/runtime/class-table'
import { child } from '../src/runtime/html'
import { partClass } from '../src/runtime/values'
import { settle } from '../src/test'
import { scratchDir } from './scratch'

await plugin(kay())

const scratch = await scratchDir('parts-')
const MARKERS = /<!--[[\]]-->/g
const files: Record<string, string> = {
  'card.kay': '---\nconst { title } = props<{ title: string }>()\n---\nsection.card.p-4\n  header.p-2(part="head") {title}\n  div(part="body")\n    slot\n',
  'rows.kay': '---\nconst { rows, open } = props<{ rows: string[], open: boolean }>()\n---\nul.rows\n  if open\n    li.p-2(part="open") open\n  for row of rows\n    li.p-2(part="item") {row}\n  li.p-2(part="slotted")\n    slot\n',
  'spread.kay': '---\nconst { title, ...rest } = props<{ title: string, [key: string]: unknown }>()\n---\narticle.box({...rest} part="root") {title}\n',
  'panel.kay': '---\nimport Card from \'./card.kay\'\n---\nsection.panel\n  Card(part="card" title="t") body\n',
  'plain.kay': '---\nconst { class: className } = props<{ class?: string }>()\n---\ndiv.base(class={className}) plain\n',
  'rooted.kay': 'header.p-2(part="top") a\nfooter.p-2(part="root") b\n',
  'wrapper.kay': '---\nimport Card from \'./card.kay\'\n---\nCard(title="w" part="root" class="from-wrapper") inside\n',
  'btn.kay': '---\nconst { onClick, class: className, ...rest } = props<{ onClick: () => void, class?: string, [key: string]: unknown }>()\n---\nbutton.btn.p-2({...rest} class={className} onClick={onClick})\n  slot\n',
  'island.kay': '---\nimport Btn from \'./btn.kay\'\nconst { title, items } = props<{ title: string, items: string[] }>()\nconst count = signal(0)\n---\nsection.card.p-4\n  header.p-2(part="head") {title}\n  if count > 0\n    p(part="shown") shown\n  for item of items\n    li(part="item") {item}\n  Btn(part="action" onClick={() => count++}) {count}\n',
  '_layout.kay': 'main.p-2(part="page") page\n',
  'client.kay': '--- client\nlet count = 0\n---\nsection.card\n  header(part="head") {count}\n',
  'node_modules/uilib/card.kay': '---\nconst { title } = props<{ title: string }>()\n---\nsection.card.p-4\n  header.p-2(part="head") {title}\n',
  'calls.kay': '---\nimport Card from \'./card.kay\'\nimport Rows from \'./rows.kay\'\nimport Spread from \'./spread.kay\'\nimport Panel from \'./panel.kay\'\nimport Plain from \'./plain.kay\'\nimport Rooted from \'./rooted.kay\'\nimport Wrapper from \'./wrapper.kay\'\nimport Library from \'uilib/card.kay\'\nconst built = [\'p-\', \'8\'].join(\'\')\n---\nCard(title="string" class="mt-4") a\nCard(title="parts" class={{ root: \'mt-6\', head: \'p-6\', body: built }}) b\nCard(title="plain")\nRows(rows={[\'x\', \'y\']} open class={{ item: \'p-8\', open: \'text-lg\' }})\nRows(rows={[]} open={false} class="gap-2")\nSpread(title="s" class={{ root: \'p-9\' }} id="s")\nPanel(class={{ card: { head: \'p-9\', root: \'m-1\' }, root: \'m-2\' }})\nPlain(class="given")\nRooted(class={{ top: \'t\', root: \'r\' }})\nWrapper(class="outer")\nLibrary(title="lib" class={{ head: \'p-6\' }})\n',
}

beforeAll(async () => {
  await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(scratch, name), text)))
  // Two `p-` classes set the same property, as Tailwind's table would say.
  installClassTable({ sets: [[1]], classes: { 'p-2': [0, 0], 'p-6': [0, 0], 'p-8': [0, 0], 'p-9': [0, 0], 'p-4': [0, 0] } })
})

afterAll(async () => {
  installClassTable(undefined)
  await rm(scratch, { recursive: true, force: true })
})

async function render(name: string, props: Record<string, unknown> = {}): Promise<string> {
  const module = await import(join(scratch, name)) as { default: (props: Record<string, unknown>) => unknown }

  return child(module.default(props)).replace(MARKERS, '')
}

function diagnostics(source: string, options = {}): string[] {
  return compileKay(source, 'src/part.kay', { check: true, ...options }).diagnostics.map(diagnostic => diagnostic.message)
}

describe('a component with parts, on the server', () => {
  it('gives a string class to the single top element, and renders data-part on a marked element', async () => {
    const html = await render('calls.kay')

    expect(html).toContain('<section class="card p-4 mt-4"><header class="p-2" data-part="head">string</header><div data-part="body">a</div></section>')
  })

  it('merges each entry onto its part, a later Tailwind class winning, and takes a class built at runtime', async () => {
    const html = await render('calls.kay')

    expect(html).toContain('<section class="card p-4 mt-6"><header class="p-6" data-part="head">parts</header><div class="p-8" data-part="body">b</div></section>')
  })

  it('leaves a part nothing styles with its own classes, and no class at all on a bare one', async () => {
    const html = await render('calls.kay')

    expect(html).toContain('<section class="card p-4"><header class="p-2" data-part="head">plain</header><div data-part="body"></div></section>')
  })

  it('reaches a part inside an if, a for and a slot, one name on every row', async () => {
    const html = await render('calls.kay')

    expect(html).toContain('<ul class="rows"><li class="p-2 text-lg" data-part="open">open</li><li class="p-8" data-part="item">x</li><li class="p-8" data-part="item">y</li><li class="p-2" data-part="slotted"></li></ul>')
    expect(html).toContain('<ul class="rows gap-2"><li class="p-2" data-part="slotted"></li></ul>')
  })

  it('keeps the class out of a rest spread, and merges it onto the part marked root', async () => {
    const html = await render('calls.kay')

    expect(html).toContain('<article id="s" data-part="root" class="box p-9">s</article>')
  })

  it('hands a part that is a component the nested object, its string going to that component\'s root', async () => {
    const html = await render('calls.kay')

    expect(html).toContain('<section class="panel m-2"><section class="card p-4 m-1"><header class="p-9" data-part="head">t</header><div data-part="body">body</div></section></section>')
  })

  it('leaves a component without parts alone, class prop and all', async () => {
    expect(await render('calls.kay')).toContain('<div class="base given">plain</div>')
  })

  it('gives the string to the part marked root when the template has several top elements', async () => {
    expect(await render('calls.kay')).toContain('<header class="p-2 t" data-part="top">a</header><footer class="p-2 r" data-part="root">b</footer>')
  })

  it('gives a root that is a component call the string and the object, merged with its own class', async () => {
    expect(await render('calls.kay')).toContain('<section class="card p-4 from-wrapper outer">')
  })

  it('renders the classes of a library component compiled from node_modules', async () => {
    expect(await render('calls.kay')).toContain('<section class="card p-4"><header class="p-6" data-part="head">lib</header></section>')
  })

  it('renders data-part in a layout, which has no props to take a class from', async () => {
    expect(await render('_layout.kay')).toBe('<main class="p-2" data-part="page">page</main>')
  })
})

// Each element's tag, class and data-part, in order, whatever order the attributes were written in.
function summary(element: Element): [string, string | null, string | null][] {
  return [...element.querySelectorAll('section, header, p, li, button')].map(found => [found.localName, found.getAttribute('class'), found.getAttribute('data-part')])
}

describe('a component with parts, as an island', () => {
  let render!: (fn: () => unknown, element: Element) => () => void
  let island!: (props: object) => unknown
  let client!: (props: object) => unknown

  beforeAll(async () => {
    GlobalRegistrator.register()
    await Bun.write(join(scratch, 'entry.ts'), 'import { render } from \'kay/dom\'\nimport Client from \'./client.kay\'\nimport Island from \'./island.kay\'\n\nexport { Client, Island, render }\n')

    const build = await Bun.build({ entrypoints: [join(scratch, 'entry.ts')], outdir: join(scratch, 'out'), target: 'browser', plugins: [kay()] })

    if (!build.success)
      throw new AggregateError(build.logs, 'client build failed')

    const module = await import(build.outputs[0]!.path) as { Client: typeof client, Island: typeof island, render: typeof render }

    client = module.Client
    island = module.Island
    render = module.render
  }, 60_000)

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  function mount(component: (props: object) => unknown, props: object): { root: HTMLElement, stop: () => void } {
    const root = document.createElement('div')

    document.body.append(root)

    return { root, stop: render(() => component(props), root) }
  }

  it('renders the classes and data-part the server renders, in an if, a for and a component call', async () => {
    const props = { title: 'hi', items: ['a', 'b'], class: { root: 'mt-6', head: 'p-6', item: 'p-8', action: 'p-9' } }
    const server = await import(join(scratch, 'island.kay')) as { default: (props: object) => unknown }
    const holder = document.createElement('div')

    holder.innerHTML = child(server.default(props)).replace(MARKERS, '')

    const { root, stop } = mount(island, props)

    expect(summary(root)).toEqual([['section', 'card p-4 mt-6', null], ['header', 'p-6', 'head'], ['li', 'p-8', 'item'], ['li', 'p-8', 'item'], ['button', 'btn p-9', 'action']])
    expect(summary(holder)).toEqual(summary(root))
    stop()
  })

  it('follows a class the page builds from a signal', async () => {
    const props = { title: 'hi', items: [], class: { shown: 'text-lg' } }
    const { root, stop } = mount(island, props)

    expect(root.querySelector('p')).toBeNull()
    root.querySelector('button')?.click()
    await settle()

    expect(summary(root).find(([tag]) => tag === 'p')).toEqual(['p', 'text-lg', 'shown'])
    stop()
  })

  it('merges a string class onto the root', () => {
    const { root, stop } = mount(island, { title: 'hi', items: [], class: 'mt-4' })

    expect(root.querySelector('section')?.getAttribute('class')).toBe('card p-4 mt-4')
    expect(root.querySelector('header')?.getAttribute('data-part')).toBe('head')
    stop()
  })

  it('renders a client-only component\'s parts', () => {
    const { root, stop } = mount(client, { class: { root: 'mt-2', head: 'p-3' } })

    expect(summary(root)).toEqual([['section', 'card mt-2', null], ['header', 'p-3', 'head']])
    stop()
  })
})

describe('kay check on parts', () => {
  it('reports a part named by an expression', () => {
    expect(diagnostics('---\nconst name = \'head\'\n---\nsection\n  div(part={name}) a\n')).toContain('`part` names a part with a string: `part="head"`')
  })

  it('reports a component with parts that also destructures class', () => {
    expect(diagnostics('---\nconst { class: className } = props<{ class?: string }>()\n---\nsection(class={className})\n  div(part="head") a\n').some(message => message.includes('takes `class` from its parts'))).toBe(true)
  })

  it('reads a quoted class member and skips string literals in the props type', () => {
    const taken = (type: string) => diagnostics(`---\nconst all = props<${type}>()\n---\nsection\n  div(part="head") a\n`).some(message => message.includes('takes `class` from its parts'))

    expect(taken('{ \'class\'?: string }')).toBe(true)
    expect(taken('{ "class": string }')).toBe(true)
    expect(taken('{ mode: \'}\' | \'>\', class?: string }')).toBe(true)
    expect(taken('{ mode: \'{\' | \'class: x\', title: string }')).toBe(false)
  })

  it('reports a component with parts whose props type declares class', () => {
    expect(diagnostics('---\nconst all = props<{ class?: string }>()\n---\nsection\n  div(part="head") a\n').some(message => message.includes('takes `class` from its parts'))).toBe(true)
  })

  it('takes class from the top-level members of the props type only', () => {
    expect(diagnostics('---\nconst all = props<{ style: { class?: string } }>()\n---\nsection\n  div(part="head") a\n').some(message => message.includes('takes `class` from its parts'))).toBe(false)
    expect(diagnostics('---\nconst all = props<{ title: string } & { class?: string }>()\n---\nsection\n  div(part="head") a\n').some(message => message.includes('takes `class` from its parts'))).toBe(true)
  })

  it('imports the helper type for a component part in a component, and not in a server page that never uses it', () => {
    const call = '---\nimport Card from \'./card.kay\'\n---\nsection\n  Card(part="card") a\n'
    const server = '--- server\nimport Card from \'./card.kay\'\n---\nsection\n  Card(part="card") a\n'

    expect(compileKay(call, 'src/panel.kay', { check: true }).tsx).toContain('KayPartOf')
    expect(compileKay(server, 'src/routes/index.kay', { check: true, page: true }).tsx).not.toContain('KayPartOf')
  })

  it('reads a part\'s own entry only', () => {
    expect(partClass({ class: { head: 'p-6' } }, 'constructor')).toBeUndefined()
    expect(partClass({ class: 'mt-4' }, 'head')).toBeUndefined()
    expect(partClass({ class: 'mt-4' }, 'root')).toBe('mt-4')
    expect(partClass(undefined, 'root')).toBeUndefined()
  })

  it('lets a page or layout with parts and a class prop through', () => {
    expect(diagnostics('---\nconst { class: className } = props<{ class?: string }>()\n---\nsection(class={className})\n  div(part="head") a\n', { page: true })).toEqual([])
  })

  it('leaves a component without parts and a class prop alone', () => {
    expect(diagnostics('---\nconst { class: className } = props<{ class?: string }>()\n---\nsection(class={className}) a\n')).toEqual([])
  })

  it('types class from the parts: a string only with a root, the parts a call may name, a component part from its own', () => {
    const one = compileKay('section\n  div(part="head") a\n', 'src/card.kay', { check: true }).tsx
    const several = compileKay('header(part="top") a\nfooter(part="bottom") b\n', 'src/two.kay', { check: true }).tsx
    const nested = compileKay('---\nimport Card from \'./card.kay\'\n---\nsection\n  Card(part="card") a\n', 'src/panel.kay', { check: true }).tsx

    expect(one).toContain('class?: string | { "root"?: string; "head"?: string } | undefined')
    expect(several).toContain('class?: { "top"?: string; "bottom"?: string } | { kayError:')
    expect(nested).toContain('"card"?: KayPartOf<typeof Card>')
  })
})
