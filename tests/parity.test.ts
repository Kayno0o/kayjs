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
const FIXTURES: Record<string, Record<string, string>> = {
  'attributes': {
    'main.kay': '---\nconst label = signal(\'Main & co\')\nconst extra = \'wide\'\nconst off = false\nconst rest = { \'data-a\': 1, \'title\': \'from spread\' }\n---\ndiv#main.card(class={extra} title="a &amp; b <c>" data-n={2} hidden={off} aria-label={label})\n  span(class="x" {...rest}) spread\n  input(type="text" value={label} disabled)\n  br\n  a(href="/about" target="_blank") About\n',
  },
  'text': {
    'main.kay': '---\nconst name = signal(\'Ada\')\nconst count = 3\n---\np Hello {name}, you have {count} items & more < less\np\n  | first line\n  | {name} second\n  strong bold\n  |  tail\n',
  },
  'control flow': {
    'main.kay': '---\nconst items = signal([{ id: 1, title: \'One\' }, { id: 2, title: \'Two\' }])\nconst empty: string[] = []\nconst shown = true\n---\nif shown\n  p shown\nelse\n  p hidden\nif !shown\n  p never\nul\n  for item of items\n    li {item.title}\nul\n  for word of empty key={word}\n    li {word}\n  else\n    li none\nfor item, i of items key={i}\n  span {i}: {item.title}\n',
  },
  'components': {
    'main.kay': '---\nimport Card from \'./card.kay\'\n\nconst title = signal(\'Card title\')\n---\nCard.big(title={title} class="outlined")\n  @actions\n    button Save\n  p Body of {title}\nCard(title="Bare")\n',
    'card.kay': '---\nconst { title, class: className } = props<{ title: string, class?: string }>()\n---\nsection(class={className})\n  h2 {title}\n  slot\n  footer\n    slot actions\n      span no actions\n',
  },
  'styles and fields': {
    'main.kay': '---\nconst color = signal(\'red\')\nconst on = true\nconst text = \'Some <text>\'\n---\np(style={{ color: color(), \'font-size\': \'2px\' }}) styled\np(style="margin: 0") plain\ninput(type="checkbox" checked={on})\ntextarea(name="body") {text}\nselect(name="pick")\n  option(value="a") A\n  option(value="b" selected) B\n',
  },
  'values': {
    'main.kay': '---\nconst picked = signal(\'b\')\nconst zero = 0\nconst nothing = null\nconst markup = \'<em>raw</em>\'\nconst yes = true\nconst list = [\'x\', \'y\']\n---\nselect(value={picked})\n  option(value="a") A\n  option(value="b") B\ndiv(innerHTML={markup})\np(data-zero={zero} data-null={nothing} aria-hidden={yes} hidden={yes} aria-busy={false}) values\ninput(type="number" value={zero})\ntextarea(value={picked})\np {nothing}{list}{zero}{yes}\n',
  },
  'images and links': {
    'main.kay': '---\nconst src = signal(\'/photo.png\')\nconst href = \'/docs\'\n---\nimg(src={src} alt="Photo" width="40" height="30")\nimg(src={src} alt="" sizes="50vw")\nimg(src="/static.png" alt="")\na(href={href}) Docs\na(href="https://example.com" rel="noopener") Out\n',
  },
  'merged classes': {
    'main.kay': '---\nimport Box from \'./box.kay\'\n\nconst active = signal(true)\nconst rest = { class: \'from-spread\', id: \'spread\' }\n---\ndiv.a(class={{ on: active(), off: !active() }})\ndiv.a(class="b" {...rest})\nBox.shorthand(class={active() ? \'yes\' : \'no\'})\nBox.shorthand({...rest})\n',
    'box.kay': '---\nconst { class: className } = props<{ class?: string }>()\n---\ndiv(class={className}) box\n',
  },
  'consts': {
    'main.kay': '---\nconst cents = signal(1250)\n---\nconst price = cents() / 100\np Price {price}\nconst { a, b } = { a: 1, b: 2 }\np {a} and {b}\n',
  },
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
  for (const name of Object.keys(FIXTURES)) {
    it(`renders ${name} alike`, () => {
      expect(browser.get(name)).toBe(normalized(server.get(name)!))
    })
  }
})
