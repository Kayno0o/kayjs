import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { child } from '../src/runtime/html'
import { IslandPropsError } from '../src/runtime/island.server'

await plugin(kay())

const fixtures = join(import.meta.dir, 'fixtures/slots')

let outdir: string
let pageHtml: string

beforeAll(async () => {
  const { default: Page } = await import(join(fixtures, 'page.kay')) as { default: () => unknown }

  pageHtml = child(Page())
  outdir = await mkdtemp(join(tmpdir(), 'kay-slots-'))
  const build = await Bun.build({ entrypoints: [join(fixtures, 'client.ts')], outdir, target: 'browser', splitting: true, plugins: [kay()] })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(outdir, { recursive: true, force: true })
})

const tick = async (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

function click(element: Element) {
  element.dispatchEvent(new Event('click', { bubbles: true }))
}

describe('static slots', () => {
  it('renders the children and slots a page passes an island in the page, an island among them its own', () => {
    expect(pageHtml).toContain(`data-slots='{"actions":0,"children":1}'`)
    expect(pageHtml).toContain(`<!--kay-slot:1--><p class="text">Hello Ada</p><slot data-component="tests/fixtures/slots/counter.kay" data-props='[{"start":1},1]'>`)
    // Not rendered by the island, or a client-only one: sent as markup.
    expect(pageHtml).toContain(`data-slots='{"children":"&lt;p class=\\"hidden\\">Hidden at first&lt;/p>`)
    expect(pageHtml).toContain(`data-slots='{"children":"&lt;p class=\\"client\\">Client only&lt;/p>"}' data-client>`)
    // Text alone is data.
    expect(pageHtml).toContain(`data-props='[{"children":1},"Plain text"]'><span class="label">Plain text</span>`)
  })

  it('hydrates around the slots it claims, which keep their nodes and the state of an island in them as the island hides and shows them', async () => {
    document.body.innerHTML = pageHtml
    const [panel] = document.querySelectorAll('section.panel')
    const text = panel!.querySelector('p.text')!
    const more = panel!.querySelector('a.more')!
    const { ready } = await import(join(outdir, 'client.js')) as { ready: Promise<void> }

    await ready
    await tick()
    expect(panel!.querySelector('p.text')).toBe(text)
    expect(panel!.querySelector('a.more')).toBe(more)

    const count = panel!.querySelector('button.count')!

    click(count)
    await tick()
    expect(count.textContent).toBe('Count 2')

    click(panel!.querySelector('button.toggle')!)
    await tick()
    expect(text.isConnected).toBe(false)

    click(panel!.querySelector('button.toggle')!)
    await tick()
    expect(panel!.querySelector('p.text')).toBe(text)
    expect(panel!.querySelector('button.count')).toBe(count)
    click(count)
    await tick()
    expect(count.textContent).toBe('Count 3')
  })

  it('builds a slot the island did not render from its markup once it shows it, hydrating an island in it', async () => {
    const panel = document.querySelectorAll('section.panel')[1]!

    expect(panel.querySelector('p.hidden')).toBeNull()
    click(panel.querySelector('button.toggle')!)
    await tick(20)
    expect(panel.querySelector('p.hidden')?.textContent).toBe('Hidden at first')

    const count = panel.querySelector('button.count')!

    click(count)
    await tick()
    expect(count.textContent).toBe('Count 11')

    click(panel.querySelector('button.toggle')!)
    click(panel.querySelector('button.toggle')!)
    await tick()
    expect(panel.querySelector('button.count')).toBe(count)
    expect(count.textContent).toBe('Count 11')
  })

  it('gives a client-only island its children from its props, and text children as data', () => {
    expect(document.querySelector('p.client')?.textContent).toBe('Client only')
    expect(document.querySelector('span.label')?.textContent).toBe('Plain text')
  })

  it('renders a static component passing an island a function or a block taking parameters as an island itself, one passing only data staying static', () => {
    expect(pageHtml).toContain(`<slot data-component="tests/fixtures/slots/toolbar.kay" data-props='[{"label":1},"Tool"]'><div class="toolbar"><button class="pick">`)
    expect(pageHtml).toContain('<slot data-component="tests/fixtures/slots/rows.kay" data-props="[{}]">')
    expect(pageHtml).toContain('<div class="counted"><slot data-component="tests/fixtures/slots/counter.kay"')
    // A snippet is a function, so a component passing one on is an island as one passing a block taking parameters is.
    expect(pageHtml).toContain('<slot data-component="tests/fixtures/slots/shelf.kay" data-props="[{}]">')
  })

  it('hydrates a promoted component, which runs the function, the block and the class instance it passes', async () => {
    const pick = document.querySelector('button.pick')!

    click(pick)
    await tick()
    expect(pick.textContent).toBe('Picked Tool: A')

    click(document.querySelector('ul.list')!)
    await tick()
    expect([...document.querySelectorAll('ul.list b')].map(item => item.textContent)).toEqual(['y', 'x'])

    const dot = document.querySelector('button.dot')!

    click(dot)
    await tick()
    expect(dot.textContent).toBe('Dot 3')

    const shelf = document.querySelectorAll('ul.list')[1]!

    expect([...shelf.querySelectorAll('i.snip')].map(item => item.textContent)).toEqual(['p', 'q'])
    click(shelf)
    await tick()
    expect([...shelf.querySelectorAll('i.snip')].map(item => item.textContent)).toEqual(['q', 'p'])
  })

  it('still refuses a layout passing an island a function, naming the fix', async () => {
    const { default: Layout } = await import(join(fixtures, 'refused/_layout.kay')) as { default: (props: object) => unknown }

    expect(() => child(Layout({}))).toThrow(new IslandPropsError('tests/fixtures/slots/picker.kay is interactive, so it renders as an island: its `format` prop is a function and cannot reach the browser; pass it from a component of its own, which then renders as an island in its place'))
  })
})
