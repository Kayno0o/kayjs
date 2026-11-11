import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

// Loaded after the DOM exists, as the runtime reads `document` as it runs.
let announce: typeof import('../src/runtime/announce').announce
let pendingBlock: typeof import('../src/runtime/pending').pendingBlock

const wait = async (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const regions = () => [...document.querySelectorAll('[aria-live=polite]')]

describe('announce', () => {
  beforeAll(async () => {
    GlobalRegistrator.register()
    ;({ announce } = await import('../src/runtime/announce'))
    ;({ pendingBlock } = await import('../src/runtime/pending'))
  })
  afterAll(async () => GlobalRegistrator.unregister())
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('writes the text into one kept polite region, whatever the number of calls', async () => {
    announce('Saved')
    await wait(150)
    announce('Deleted')

    expect(regions().length).toBe(1)
    expect([regions()[0]!.textContent, regions()[0]!.hasAttribute('data-kay-keep'), regions()[0]!.parentElement]).toEqual(['Deleted', true, document.body])
    expect(regions()[0]!.matches('[data-kay-announce][data-kui-announce]')).toBe(true)
  })

  it('announces a repeated text again by changing it', async () => {
    announce('Saved')
    await wait(150)
    announce('Saved')

    const first = regions()[0]!.textContent

    expect(first).not.toBe('Saved')
    expect(first.trim()).toBe('Saved')
  })

  it('goes into the modal dialog holding `within`, and into the body without one', async () => {
    document.body.innerHTML = '<dialog open><form><button>Save</button></form></dialog><p id="outside">Outside</p>'

    const button = document.querySelector('button')!

    announce('In the dialog', button)
    announce('In the page', document.querySelector('#outside'))
    await wait(150)

    expect(document.querySelector('dialog > [aria-live]')!.textContent).toBe('In the dialog')
    expect(document.querySelector('body > [aria-live]')!.textContent).toBe('In the page')
  })

  it('says what a pending block shows through the same region', async () => {
    document.body.innerHTML = '<form><p id="wait" hidden>Saving</p></form>'

    pendingBlock(document.querySelector('#wait')!, 'post', true)
    await wait(150)

    expect(regions().map(region => region.textContent)).toEqual(['Saving'])
    expect(regions()[0]!.parentElement).toBe(document.body)
  })
})
