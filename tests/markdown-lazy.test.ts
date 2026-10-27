import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { fresh, hydrate, property } from '../src/runtime/dom'
import { createSignal, flush, memo, renderEffect, root } from '../src/runtime/reactive'

// Each test gets its own copy of the shell, whose renderer has not loaded yet.
async function shell(name: string): Promise<typeof import('../src/runtime/markdown.client')> {
  return import(`../src/runtime/markdown.client.ts?${name}`) as Promise<typeof import('../src/runtime/markdown.client')>
}

async function settled(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++)
    await Bun.sleep(10)
}

describe('markdownHtml in an island', () => {
  beforeAll(() => {
    GlobalRegistrator.register()
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  it('gives the text as written, then the formatted HTML to an effect once the renderer has loaded', async () => {
    const { markdownHtml } = await shell('effect')
    const element = document.createElement('div')

    root(() => renderEffect(() => property(element, 'innerHTML', markdownHtml('**a** & b'))))
    flush()
    expect(element.innerHTML).toBe('<p>**a** &amp; b</p>\n')

    await settled(() => element.innerHTML.includes('<strong>'))
    expect(element.innerHTML).toBe('<p><strong>a</strong> &amp; b</p>\n')
  })

  it('keeps the server\'s formatted markup while an island hydrates, and loads the renderer only once the text changes', async () => {
    const { markdownHtml } = await shell('hydrate')
    const container = document.createElement('div')
    const [text, setText] = createSignal('# Title')

    container.innerHTML = '<div><h1>Title</h1></div>'

    const element = container.firstElementChild!

    root(() => hydrate(() => renderEffect(() => property(element, 'innerHTML', markdownHtml(text()))), container))
    flush()
    await Bun.sleep(50)
    expect(element.innerHTML).toBe('<h1>Title</h1>')

    setText('# Other')
    flush()
    expect(element.innerHTML).toBe('<p># Other</p>\n')

    await settled(() => element.innerHTML.startsWith('<h1'))
    expect(element.innerHTML).toBe('<h1>Other</h1>\n')
  })

  it('keeps the server\'s markup when a hydrated effect writes the same held text again, until the renderer has loaded', async () => {
    const { markdownHtml } = await shell('rerun')
    const container = document.createElement('div')
    const [flag, setFlag] = createSignal(1)

    container.innerHTML = '<div><h1>Title</h1></div>'

    const element = container.firstElementChild!

    root(() => hydrate(() => renderEffect(() => {
      flag()
      property(element, 'innerHTML', markdownHtml('# Title'))
    }), container))
    flush()
    setFlag(2)
    flush()
    expect(element.innerHTML).toBe('<h1>Title</h1>')

    await settled(() => element.innerHTML.endsWith('\n'))
    expect(element.innerHTML).toBe('<h1>Title</h1>\n')
  })

  it('keeps the server\'s markup for a held text a memo cached, and loads the renderer when it is written again', async () => {
    const { markdownHtml } = await shell('cached')
    const container = document.createElement('div')
    const [flag, setFlag] = createSignal(1)

    container.innerHTML = '<div><h1>Title</h1></div>'

    const element = container.firstElementChild!

    root(() => hydrate(() => {
      const html = memo(() => markdownHtml('# Title'))

      renderEffect(() => property(element, 'innerHTML', flag() > 0 ? html() : ''))
    }, container))
    flush()
    setFlag(2)
    flush()
    expect(element.innerHTML).toBe('<h1>Title</h1>')

    await settled(() => element.innerHTML.endsWith('\n'))
    expect(element.innerHTML).toBe('<h1>Title</h1>\n')
  })

  it('forgets a hold no write took when the island ends, so a later island draws its markup', async () => {
    const { markdownHtml } = await shell('forgotten')
    const first = document.createElement('div')
    const second = document.createElement('div')

    first.innerHTML = '<div></div>'
    second.innerHTML = '<div><h1>Old</h1></div>'

    const element = second.firstElementChild!

    root(() => hydrate(() => markdownHtml('# a'), first))
    root(() => hydrate(() => renderEffect(() => property(element, 'innerHTML', '<p>new</p>')), second))
    flush()
    expect(element.innerHTML).toBe('<p>new</p>')
  })

  it('draws a later island\'s write of the very text a finished island held', async () => {
    const { markdownHtml } = await shell('forgotten-same')
    const first = document.createElement('div')
    const second = document.createElement('div')

    first.innerHTML = '<div></div>'
    second.innerHTML = '<div><h1>Old</h1></div>'

    const element = second.firstElementChild!

    root(() => hydrate(() => markdownHtml('# a'), first))
    root(() => hydrate(() => renderEffect(() => property(element, 'innerHTML', '<p># a</p>\n')), second))
    flush()
    expect(element.innerHTML).toBe('<p># a</p>\n')
  })

  it('tells the stand-in of a hydrating island from the formatted markup and from any other text', async () => {
    const { markdownHtml, isHeldMarkdown } = await shell('held')
    const container = document.createElement('div')

    container.innerHTML = '<div><h1>Title</h1></div>'

    const held: boolean[] = []

    root(() => hydrate(() => {
      const html = markdownHtml('# Title')

      held.push(isHeldMarkdown(html), isHeldMarkdown(html.replace('#', '$')))
    }, container))
    flush()
    expect(held).toEqual([true, false])
    expect(isHeldMarkdown(markdownHtml('# Title'))).toBe(false)

    await settled(() => markdownHtml('# Title').startsWith('<h1'))
    expect(isHeldMarkdown(markdownHtml('# Title'))).toBe(false)
  })

  it('keeps the server\'s markup of every markdown of an island', async () => {
    const { markdownHtml } = await shell('two')
    const container = document.createElement('div')

    container.innerHTML = '<div><h1>A</h1></div><div><h2>B</h2></div>'

    const [one, two] = Array.from(container.children)

    root(() => hydrate(() => {
      renderEffect(() => property(one!, 'innerHTML', markdownHtml('# A')))
      renderEffect(() => property(two!, 'innerHTML', markdownHtml('## B')))
    }, container))
    flush()
    expect(one!.innerHTML).toBe('<h1>A</h1>')
    expect(two!.innerHTML).toBe('<h2>B</h2>')
  })

  it('keeps the server\'s markup when another prop is written before the markdown\'s innerHTML', async () => {
    const { markdownHtml } = await shell('other-prop')
    const container = document.createElement('div')

    container.innerHTML = '<div><h1>Title</h1></div>'

    const element = container.firstElementChild!

    root(() => hydrate(() => renderEffect(() => {
      const html = markdownHtml('# Title')

      property(element, 'title', 'a')
      property(element, 'innerHTML', html)
    }), container))
    flush()
    expect(element.innerHTML).toBe('<h1>Title</h1>')
  })

  it('keeps the outer island\'s held markup when an island nested in it ends first', async () => {
    const { markdownHtml } = await shell('nested')
    const container = document.createElement('div')
    const inner = document.createElement('div')

    container.innerHTML = '<div><h1>Title</h1></div>'
    inner.innerHTML = '<div></div>'

    const element = container.firstElementChild!

    root(() => hydrate(() => {
      const html = markdownHtml('# Title')

      hydrate(() => undefined, inner)
      property(element, 'innerHTML', html)
    }, container))
    flush()
    expect(element.innerHTML).toBe('<h1>Title</h1>')
  })

  it('draws the markup of an unrelated element when a markdownHtml was evaluated but never written', async () => {
    const { markdownHtml } = await shell('unwritten')
    const container = document.createElement('div')

    container.innerHTML = '<div><h1>Old</h1></div>'

    const element = container.firstElementChild!

    root(() => hydrate(() => {
      markdownHtml('# a')
      renderEffect(() => property(element, 'innerHTML', '<p>new</p>'))
    }, container))
    flush()
    expect(element.innerHTML).toBe('<p>new</p>')
  })

  it('draws the text as written in a client-only component of a hydrating island, which has no server markup', async () => {
    const { markdownHtml } = await shell('fresh')
    const container = document.createElement('div')

    container.innerHTML = '<div></div>'

    const element = container.firstElementChild!

    root(() => hydrate(() => fresh(() => renderEffect(() => property(element, 'innerHTML', markdownHtml('*a*')))), container))
    flush()
    expect(element.innerHTML).toBe('<p>*a*</p>\n')

    await settled(() => element.innerHTML.includes('<em>'))
    expect(element.innerHTML).toBe('<p><em>a</em></p>\n')
  })

  it('lets a call outside an effect wait for the renderer', async () => {
    const { markdownHtml, markdownReady } = await shell('ready')

    expect<string>(markdownHtml('*a*')).toBe('<p>*a*</p>\n')
    await markdownReady()
    expect<string>(markdownHtml('*a*')).toBe('<p><em>a</em></p>\n')
  })

  it('gives the text as written to a call outside any effect', async () => {
    const { markdownHtml } = await shell('plain')

    expect<string>(markdownHtml('*a*')).toBe('<p>*a*</p>\n')
    expect<string>(markdownHtml('*a*')).toBe('<p>*a*</p>\n')
  })
})
