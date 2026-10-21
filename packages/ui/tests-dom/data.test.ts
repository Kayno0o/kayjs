import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click, clock } from './dom'

let mounted: Mounted | undefined
const selected: string[] = []

afterEach(() => {
  mounted?.unmount()
  selected.length = 0
})

async function data(src = '/favicon.png', copiedFor?: string) {
  mounted = await mountComponent('src/components/data.kay', { onSelect: (key: string) => selected.push(key), src, copiedFor })

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

describe('Avatar', () => {
  test('falls back to the initial on a seeded colour once the picture fails, and tries a new picture again', async () => {
    const root = await data()

    root.querySelector('#avatar img')!.dispatchEvent(new Event('error'))
    await settle()

    expect(root.querySelector('#avatar img')).toBeNull()
    expect(root.querySelector('#avatar .kui-avatar-initial')?.textContent).toBe('A')
    expect(root.querySelector<HTMLElement>('#avatar .kui-avatar-initial')?.style.backgroundColor).not.toBe('')

    click(root.querySelector('#swap'))
    await settle()

    expect(root.querySelector('#avatar img')?.getAttribute('src')).toBe('/grace.png')
  })
})

describe('CopyButton', () => {
  // The label showing: the one not showing is aria-hidden, so it is not in the button's accessible name.
  const shown = (root: ParentNode) => root.querySelector('#copy')?.querySelector('span > span:not([aria-hidden])')?.textContent
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

  test('copies its text with its html alongside, and says so on itself and to screen readers', async () => {
    const written = clipboardWith()
    const root = await data()

    click(root.querySelector('#copy'))
    await settle()

    expect(written).toEqual([{ 'text/plain': 'https://kaynooo.fr', 'text/html': '<b>kaynooo.fr</b>' }])
    expect(shown(root)).toBe('Copied!')
    expect(root.querySelector('#copy + [role="status"]')?.textContent).toBe('Copied!')
  })

  test('says it copied for as long as copiedFor, two seconds by default', async () => {
    clipboardWith()

    for (const [copiedFor, lasts] of [[undefined, 2000], ['500ms', 500], ['1s', 1000]] as const) {
      const root = await data('/favicon.png', copiedFor)

      clock.start()
      click(root.querySelector('#copy'))
      await clock.elapse(10)
      await clock.settle()
      expect(shown(root)).toBe('Copied!')
      await clock.elapse(lasts - 100)
      expect(shown(root)).toBe('Copied!')
      await clock.elapse(200)
      expect(shown(root)).toBe('Copy link')
      clock.stop()
      mounted?.unmount()
    }
  })

  test('toasts a copy the browser refused, and keeps its label', async () => {
    clipboardWith(true)
    const root = await data()

    click(root.querySelector('#copy'))
    await settle()

    expect([...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Could not copy to the clipboard')
    expect(shown(root)).toBe('Copy link')
  })
})
