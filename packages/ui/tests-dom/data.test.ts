import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const selected: string[] = []

afterEach(() => {
  mounted?.unmount()
  selected.length = 0
})

async function data(src = '/favicon.png') {
  mounted = await mount('src/components/data.kay', { onSelect: (key: string) => selected.push(key), src })

  return mounted.root
}

describe('BarList', () => {
  test('makes each row a button handing back its row once the list takes onSelect', async () => {
    const root = await data()
    const rows = root.querySelectorAll<HTMLButtonElement>('#bars button.kui-bar-list-row')

    expect([...rows].map(row => row.type)).toEqual(['button', 'button'])

    click(rows[1]!)

    expect(selected).toEqual(['earth'])
  })
})

describe('SiteFavicon', () => {
  test('falls back to the globe once the image fails to load', async () => {
    const root = await data()

    root.querySelector('.kui-site-favicon-img')!.dispatchEvent(new Event('error'))
    await settle()

    expect(root.querySelector('.kui-site-favicon-img')).toBeNull()
    expect(root.querySelector('svg.kui-site-favicon-icon')).not.toBeNull()
  })
})

describe('CopyButton', () => {
  const { clipboard } = navigator
  const { ClipboardItem } = globalThis

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
    globalThis.ClipboardItem = ClipboardItem
  })

  // The clipboard as the browser has it: each write's formats, read back as text, or a refusal.
  function clipboardWith(refuse = false) {
    const written: Record<string, string>[] = []

    globalThis.ClipboardItem = class {
      constructor(public formats: Record<string, Blob>) {}
    } as unknown as typeof ClipboardItem
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async write(items: { formats: Record<string, Blob> }[]) {
      if (refuse)
        throw new Error('denied')

      written.push(Object.fromEntries(await Promise.all(Object.entries(items[0]!.formats).map(async ([type, blob]) => [type, await blob.text()]))))
    } } })

    return written
  }

  test('copies its text with its html alongside, and says so on itself', async () => {
    const written = clipboardWith()
    const root = await data()

    click(root.querySelector('#copy'))
    await settle()

    expect(written).toEqual([{ 'text/plain': 'https://kaynooo.fr', 'text/html': '<b>kaynooo.fr</b>' }])
    expect(root.querySelector('#copy')?.textContent).toBe('Copied!')
  })

  test('toasts a copy the browser refused, and keeps its label', async () => {
    clipboardWith(true)
    const root = await data()

    click(root.querySelector('#copy'))
    await settle()

    expect([...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Could not copy to the clipboard')
    expect(root.querySelector('#copy')?.textContent).toBe('Copy link')
  })
})
