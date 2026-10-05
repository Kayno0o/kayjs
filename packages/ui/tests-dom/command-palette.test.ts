import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'

let mounted: Mounted | undefined
const seen: { open: boolean[], recent: string[][], actions: string[] } = { open: [], recent: [], actions: [] }

// The test stays on its page: a followed link is a click the palette handles, not a navigation.
function stay(event: Event) {
  if (event.target instanceof Element && event.target.closest('a'))
    event.preventDefault()
}

beforeEach(() => {
  document.addEventListener('click', stay, true)
})

afterEach(() => {
  mounted?.unmount()
  document.removeEventListener('click', stay, true)
  seen.open = []
  seen.recent = []
  seen.actions = []
})

async function palette(props: { recent?: string[], hotkey?: string | null } = {}) {
  mounted = await mount('src/components/palette.kay', {
    onOpenChange: (open: boolean) => seen.open.push(open),
    onRecentChange: (recent: string[]) => seen.recent.push(recent),
    onAction: (name: string) => seen.actions.push(name),
    ...props,
  })

  const { root } = mounted
  const dialog = root.querySelector<HTMLDialogElement>('dialog')!
  const input = () => root.querySelector<HTMLInputElement>('.command-palette-input')
  const labels = () => [...root.querySelectorAll('.command-palette-heading, .command-palette-label')].map(element => element.classList.contains('command-palette-heading') ? `# ${element.textContent}` : element.textContent)
  const active = () => root.querySelector(`#${input()!.getAttribute('aria-activedescendant')}`)?.querySelector('.command-palette-label')?.textContent

  return { root, dialog, input, labels, active }
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

async function search(input: HTMLInputElement, text: string) {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

describe('CommandPalette', () => {
  test('opens and closes on Ctrl+K from anywhere, and lists its entries under their groups in the order given', async () => {
    const { dialog, input, labels } = await palette()

    press(document.querySelector('#outside')!, 'k', { ctrlKey: true })
    await settle()

    expect(dialog.open).toBe(true)
    expect(input()).not.toBeNull()
    expect(labels()).toEqual(['# Actions', 'New moon', '# Pages', 'Table', 'Content', '# Links', 'Docs'])

    press(window, 'k', { metaKey: true })
    await settle()

    expect(dialog.open).toBe(false)
    expect(seen.open).toEqual([true, false])
  })

  test('leaves opening to the app without a hotkey, and puts recently followed links on top', async () => {
    const { dialog } = await palette({ recent: ['/content', '/gone'], hotkey: null })

    press(window, 'k', { ctrlKey: true })
    await settle()

    expect(dialog.open).toBe(false)

    mounted!.unmount()

    const { labels } = await palette({ recent: ['/content', '/gone'] })

    press(window, 'k', { ctrlKey: true })
    await settle()

    expect(labels().slice(0, 3)).toEqual(['# Recent', 'Content', '# Actions'])
  })

  test('ranks the matches of a query in one list, walked with the arrows, wrapping', async () => {
    const { input, labels, active } = await palette()

    press(window, 'k', { ctrlKey: true })
    await settle()
    await search(input()!, 'badges')

    expect(labels()).toEqual(['Content'])

    await search(input()!, 'e')

    expect(labels()).toEqual(['New moon', 'Content', 'Table'])
    expect(active()).toBe('New moon')

    press(input()!, 'ArrowUp')
    await settle()

    expect(active()).toBe('Table')

    press(input()!, 'ArrowDown')
    await settle()

    expect(active()).toBe('New moon')
  })

  test('runs an action on Enter once it has closed, and remembers a followed link', async () => {
    const { dialog, input } = await palette()

    press(window, 'k', { ctrlKey: true })
    await settle()
    await search(input()!, 'new moon')
    press(input()!, 'Enter')
    await settle()

    expect(seen.actions).toEqual(['new-moon'])
    expect(dialog.open).toBe(false)

    press(window, 'k', { ctrlKey: true })
    await settle()

    expect(input()?.value).toBe('')

    await search(input()!, 'table')
    press(input()!, 'Enter')
    await settle()

    expect(seen.recent).toEqual([['/table']])
    expect(dialog.open).toBe(false)
  })
})
