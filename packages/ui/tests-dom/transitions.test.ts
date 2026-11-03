import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Transitions from '../tests/fixture/src/components/transitions.kay'
import { click } from './dom'

let mounted: Mounted | undefined
const { clipboard } = navigator
const { ClipboardItem } = globalThis

afterEach(() => {
  mounted?.unmount()
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  globalThis.ClipboardItem = ClipboardItem
})

async function mount(source = 'plain') {
  const calls: string[] = []

  mounted = await mountComponent(Transitions, { calls, source })

  return { root: mounted.root, calls }
}

// The clipboard as the browser has it: each write's text, or a refusal.
function clipboardWith(refuse = false) {
  const written: string[] = []

  globalThis.ClipboardItem = class {
    constructor(public formats: Record<string, Blob | Promise<Blob>>) {}
  } as unknown as typeof ClipboardItem
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async write(items: { formats: Record<string, Blob | Promise<Blob>> }[]) {
    // A browser reads the promised text first, so its failure is the write's.
    const text = await (await items[0]!.formats['text/plain']!).text()

    if (refuse)
      throw new Error('denied')

    written.push(text)
  } } })

  return written
}

describe('Avatar and SiteFavicon', () => {
  test('tell onLoad when the picture loads and onError when it fails', async () => {
    const { root, calls } = await mount()

    root.querySelector('#avatar img')!.dispatchEvent(new Event('load'))
    root.querySelector('#favicon img')!.dispatchEvent(new Event('load'))
    root.querySelector('#avatar img')!.dispatchEvent(new Event('error'))
    root.querySelector('#favicon img')!.dispatchEvent(new Event('error'))
    await settle()

    expect(calls).toEqual(['avatar load', 'favicon load', 'avatar error', 'favicon error'])
  })

  test('draw the fallback block in place of the initial and the globe', async () => {
    const { root } = await mount()

    root.querySelector('#drawn img')!.dispatchEvent(new Event('error'))
    root.querySelector('#globe img')!.dispatchEvent(new Event('error'))
    await settle()

    expect(root.querySelector('#drawn .fallback')).not.toBeNull()
    expect(root.querySelector('#drawn [data-part=initial]')).toBeNull()
    expect(root.querySelector('#globe .fallback')).not.toBeNull()
    expect(root.querySelector('#globe svg')).toBeNull()
  })
})

describe('CopyButton', () => {
  test('tells onCopy with the text, which a function or a promise may build', async () => {
    for (const source of ['plain', 'built', 'fetched']) {
      const written = clipboardWith()
      const { root, calls } = await mount(source)

      click(root.querySelector('#copy'))
      await settle()
      expect(calls).toEqual([`copied ${source}`])
      expect(written).toEqual([source])
      mounted?.unmount()
    }
  })

  test('tells onFail when the text cannot be built or the browser refuses it, and never onCopy', async () => {
    clipboardWith(true)

    const refused = await mount()

    click(refused.root.querySelector('#copy'))
    await settle()
    expect(refused.calls).toEqual(['failed'])
    mounted?.unmount()

    const broken = await mount('broken')

    click(broken.root.querySelector('#copy'))
    await settle()
    expect(broken.calls).toEqual(['failed'])
  })

  test('writes nothing and tells onFail for a text that resolves to nothing', async () => {
    const written = clipboardWith()
    const { root, calls } = await mount('empty')

    click(root.querySelector('#copy'))
    await settle()
    expect(written).toEqual([])
    expect(calls).toEqual(['failed'])
  })
})
