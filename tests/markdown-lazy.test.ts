import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { hydrate, property } from '../src/runtime/dom'
import { flush, renderEffect, root } from '../src/runtime/reactive'

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

  it('keeps the server\'s formatted markup while an island hydrates, until the renderer has loaded', async () => {
    const { markdownHtml } = await shell('hydrate')
    const container = document.createElement('div')

    container.innerHTML = '<div><h1>Title</h1></div>'

    const element = container.firstElementChild!

    root(() => hydrate(() => renderEffect(() => property(element, 'innerHTML', markdownHtml('# Title'))), container))
    flush()
    expect(element.innerHTML).toBe('<h1>Title</h1>')

    await settled(() => element.innerHTML === '<h1>Title</h1>\n')
    expect(element.innerHTML).toBe('<h1>Title</h1>\n')
  })

  it('gives the text as written to a call outside any effect', async () => {
    const { markdownHtml } = await shell('plain')

    expect<string>(markdownHtml('*a*')).toBe('<p>*a*</p>\n')
    expect<string>(markdownHtml('*a*')).toBe('<p>*a*</p>\n')
  })
})
