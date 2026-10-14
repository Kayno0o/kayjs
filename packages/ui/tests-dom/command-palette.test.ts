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

async function palette(props: { recent?: string[], hotkey?: string | null, siteSearch?: boolean } = {}) {
  mounted = await mount('src/components/palette.kay', {
    onOpenChange: (open: boolean) => seen.open.push(open),
    onRecentChange: (recent: string[]) => seen.recent.push(recent),
    onAction: (name: string) => seen.actions.push(name),
    ...props,
  })

  const { root } = mounted
  const dialog = root.querySelector<HTMLDialogElement>('dialog')!
  const input = () => root.querySelector<HTMLInputElement>('.kui-command-palette-input')
  const labels = () => [...root.querySelectorAll('.kui-command-palette-heading, .kui-command-palette-label')].map(element => element.classList.contains('kui-command-palette-heading') ? `# ${element.textContent}` : element.textContent)
  const active = () => root.querySelector(`#${input()!.getAttribute('aria-activedescendant')}`)?.querySelector('.kui-command-palette-label')?.textContent

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

  test('matches its hotkey whatever its case', async () => {
    const { dialog } = await palette({ hotkey: 'P' })

    press(window, 'p', { ctrlKey: true })
    await settle()

    expect(dialog.open).toBe(true)
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

describe('CommandPalette with siteSearch', () => {
  const realFetch = globalThis.fetch
  const asked: string[] = []
  let failing = false
  // The file of the index holding the words starting as `word` does, by its first two letters.
  const shard = (word: string) => [...word].slice(0, 2).map(char => char.codePointAt(0)!.toString(36)).join('-')
  const files: Record<string, unknown> = {
    '/_kay/search.json': { dir: 'build', langs: { en: 0 } },
    '/_kay/search/build/0/index.json': { shards: [shard('table')], sections: 2 },
    [`/_kay/search/build/0/w-${shard('table')}.json`]: { table: [0, 2, 1, 1] },
    '/_kay/search/build/0/t-0.json': [
      { page: 'Table', href: '/table', text: 'The table page' },
      { page: 'Table', heading: 'Sorting', href: '/table#sorting', text: 'Sort the table by a column' },
    ],
  }

  beforeEach(() => {
    globalThis.fetch = (async (url: string) => {
      asked.push(url)

      return !failing && url in files ? Response.json(files[url]) : new Response('', { status: 404 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    asked.length = 0
    failing = false
  })

  async function until(ready: () => boolean) {
    for (let tries = 0; tries < 100 && !ready(); tries++) {
      await Bun.sleep(5)
      await settle()
    }
  }

  // First, as a failed load clears what the index had loaded for the next test to fetch afresh.
  test('says the pages could not be searched when the index fails to load, still listing the entries', async () => {
    failing = true
    const { root, input, labels } = await palette({ siteSearch: true })

    press(window, 'k', { ctrlKey: true })
    await settle()
    await search(input()!, 'table')
    await until(() => root.querySelector('.kui-command-palette-empty') !== null)

    expect(labels()).toEqual(['Table'])
    expect(root.querySelector('.kui-command-palette-empty')?.textContent).toBe('The pages could not be searched')
  })

  test('lists the sections found after the entries, leaving out one an entry links, and follows one without keeping it as recent', async () => {
    const { root, dialog, input, labels, active } = await palette({ siteSearch: true })

    press(window, 'k', { ctrlKey: true })
    await settle()
    await search(input()!, 'table')
    await until(() => labels().includes('Sorting'))

    expect(labels()).toEqual(['Table', '# In the pages', 'Sorting'])
    expect(root.querySelector('.kui-command-palette-snippet mark')?.textContent).toBe('table')

    press(input()!, 'ArrowDown')
    await settle()

    expect(active()).toBe('Sorting')

    press(input()!, 'Enter')
    await settle()

    expect(dialog.open).toBe(false)
    expect(seen.recent).toEqual([])
  })

  test('loads nothing without siteSearch', async () => {
    const { input } = await palette()

    press(window, 'k', { ctrlKey: true })
    await settle()
    await search(input()!, 'table')
    await Bun.sleep(20)

    expect(asked).toEqual([])
  })
})
