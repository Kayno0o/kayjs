import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

describe('a page swap over an element being typed in', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/' })
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  const refresh = async (html: string) => {
    const { show } = await import('../src/runtime/page-swap')
    const { navigation } = await import('../src/runtime/navigation')

    navigation.hooks = { hydrate: () => undefined, dispose: () => undefined }

    await show({ url: location.href, type: 'text/html', html }, '', { intent: 'refresh', focused: document.activeElement })
  }

  it('leaves a focused contenteditable element its text and attribute, and renders the rest', async () => {
    document.body.innerHTML = '<h1 contenteditable="plaintext-only">Typed so far</h1><p>Old</p>'

    const heading = document.querySelector('h1')!

    heading.focus()
    expect(document.activeElement).toBe(heading)

    await refresh('<!doctype html><html><head><title>t</title></head><body><h1>Older text</h1><p>New</p></body></html>')

    expect(document.querySelector('h1')).toBe(heading)
    expect(heading.textContent).toBe('Typed so far')
    expect(heading.getAttribute('contenteditable')).toBe('plaintext-only')
    expect(document.querySelector('p')!.textContent).toBe('New')
  })

  it('renders a contenteditable element nobody is typing in like any other', async () => {
    document.body.innerHTML = '<h1 contenteditable="plaintext-only">Typed so far</h1><p>Old</p>'
    ;(document.activeElement as HTMLElement | null)?.blur()

    await refresh('<!doctype html><html><head><title>t</title></head><body><h1>Saved text</h1><p>New</p></body></html>')

    expect(document.querySelector('h1')!.textContent).toBe('Saved text')
    expect(document.querySelector('h1')!.hasAttribute('contenteditable')).toBe(false)
  })
})
