import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { scratchDir } from './scratch'

type Page = (props: object) => unknown

let render: typeof import('../src/runtime/dom').render
let dir = ''
let count = 0

beforeAll(async () => {
  GlobalRegistrator.register()
  ;({ render } = await import('../src/runtime/dom'))
  dir = await scratchDir('string-tags')
})

afterAll(async () => GlobalRegistrator.unregister())

async function load(source: string, output: 'html' | 'dom'): Promise<Page> {
  const tsx = compileKay(source, 'comp.kay', { output, component: true, page: false }).tsx.replace(/export default KayIsland\("comp.kay", (\w+)\)/, 'export default $1')
  const file = join(dir, `tag-${count++}.ts`)

  await Bun.write(file, tsx)

  const loaded = await import(file) as { default: Page }

  return loaded.default
}

const MARKERS = /<!--[[\]]-->/g

async function onServer(source: string, props: object): Promise<string> {
  const html = await (await load(source, 'html'))(props) as string | { t: string }

  return (typeof html === 'string' ? html : html.t).replace(MARKERS, '')
}

async function inBrowser(source: string, props: object): Promise<string> {
  const page = await load(source, 'dom')
  const target = document.createElement('div')

  render(() => page(props), target)

  return target.innerHTML.replace(MARKERS, '')
}

describe('a tag held in a value as text', () => {
  const cases: [string, string, object, string][] = [
    ['a plain prop', '---\nconst { Tag } = props<{ Tag: string }>()\n---\nTag(class="x") hi', { Tag: 'section' }, '<section class="x">hi</section>'],
    ['a prop with a default', '---\nconst { Tag = \'p\' } = props<{ Tag?: string }>()\n---\nTag(class="x") hi', {}, '<p class="x">hi</p>'],
    ['a script const', '---\nconst T = \'em\'\n---\nT(class="x") hi', {}, '<em class="x">hi</em>'],
    ['a template const', '---\nconst { tag } = props<{ tag: string }>()\n---\nconst T = tag\nT(class="x") hi', { tag: 'section' }, '<section class="x">hi</section>'],
    ['a loop item', '---\nconst { tags } = props<{ tags: string[] }>()\n---\nfor T of tags\n  T(class="x") hi', { tags: ['b', 'i'] }, '<b class="x">hi</b><i class="x">hi</i>'],
  ]

  for (const [name, source, props, expected] of cases) {
    it(`renders the element on both targets for ${name}`, async () => {
      expect([await onServer(source, props), await inBrowser(source, props)]).toEqual([expected, expected])
    })
  }

  it('still draws a component a prop, a script const or a loop item holds', async () => {
    const source = '---\nconst { Icon, list } = props<{ Icon: unknown, list: unknown[] }>()\nconst Local = () => `L`\n---\nIcon\nLocal\nfor Item of list\n  Item'
    const props = { Icon: () => 'I', list: [() => 'J'] }

    expect(await onServer(source, props)).toBe('ILJ')
    expect(await inBrowser(source, props)).toBe('ILJ')
  })

  it('keeps a held component with server="defer" a server island on the server, whichever value holds it', () => {
    const sources = [
      '---\nconst { Example } = props<{ Example: () => string }>()\n---\nExample(server="defer")',
      '---\nimport { pick } from \'./pick\'\nconst Example = pick(\'x\')\n---\nExample(server="defer")',
      '---\nimport { demo } from \'./demo\'\nconst { component: Example } = demo(\'x\')\n---\nExample(server="defer")',
      '---\nconst { items } = props<{ items: (() => string)[] }>()\n---\nfor Item of items\n  Item(server="defer")',
    ]

    for (const source of sources) {
      const html = compileKay(source, 'comp.kay', { output: 'html', component: true, page: false } as never).tsx

      expect(html, source).toContain('KayServerIsland(')
      expect(html, source).not.toContain('KayDynamic(')
    }
  })

  it('costs the browser nothing for a component value, and loads the element code only for one that can be text', () => {
    const dom = (source: string) => compileKay(source, 'comp.kay', { output: 'dom', component: true, page: false } as never).tsx
    const held = (type: string) => `---\nconst { Held } = props<{ Held: ${type} }>()\n---\nHeld(class="x")`

    expect(dom(held('() => string'))).not.toContain('KayDynamic(')

    expect(dom('---\nimport { pick } from \'./pick\'\nconst Held = pick()\n---\nHeld')).not.toContain('KayDynamic(')
    expect(dom(held('string'))).toContain('KayDynamic(')
    expect(dom(held('string | (() => string)'))).toContain('KayDynamic(')
    expect(dom(`---\ntype Props = { Held: 'a' | 'b' }\nconst { Held } = props<Props>()\n---\nHeld`)).toContain('KayDynamic(')
  })

  it('throws for a held component that is missing, on both targets', async () => {
    const source = '---\nconst { Held } = props<{ Held: () => string }>()\n---\nHeld'

    for (const missing of [undefined, null]) {
      await expect(onServer(source, { Held: missing })).rejects.toThrow()
      await expect(inBrowser(source, { Held: missing })).rejects.toThrow()
    }
  })

  it('refuses a held tag that names no safe element, on both targets', async () => {
    const source = '---\nconst { Tag } = props<{ Tag: string }>()\n---\nTag hi'

    await expect(onServer(source, { Tag: 'script' })).rejects.toThrow()
    await expect(inBrowser(source, { Tag: 'script' })).rejects.toThrow()
  })
})
