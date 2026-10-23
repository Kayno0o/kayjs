import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Editor from '../src/editor/editor.kay'

let mounted: Mounted | undefined

Object.assign(document, { caretPositionFromPoint: () => null, elementsFromPoint: () => [] })

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  localStorage.clear()
  document.documentElement.removeAttribute('data-kui-dock')
})

// Every edge the editor made room at on the root while it mounted, in order, whatever it flipped to within the same task: a record keeps the value its change replaced.
async function mountedAt(width: number): Promise<string[]> {
  const was = window.innerWidth
  const root = document.documentElement
  const olds: (string | null)[] = []
  const watcher = new MutationObserver((records) => {
    olds.push(...records.map(record => record.oldValue))
  })

  watcher.observe(root, { attributes: true, attributeFilter: ['data-kui-dock'], attributeOldValue: true })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })

  try {
    mounted = await mountComponent(Editor, { entries: [], unclickable: [] })
    await settle()

    const seen = [...olds, ...watcher.takeRecords().map(record => record.oldValue), root.dataset.kuiDock]

    return [...new Set(seen.filter((edge): edge is string => edge != null))]
  }
  finally {
    watcher.disconnect()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: was })
  }
}

test('a narrow window docks the editor to the bottom from the first paint, never making room at the side', async () => {
  expect(await mountedAt(500)).toEqual(['bottom'])
})

test('a wide window docks it to the side', async () => {
  expect(await mountedAt(1400)).toEqual(['right'])
})

test('the launcher is never in the document while the stored layout keeps the panel open', async () => {
  localStorage.setItem('kcms-editor', JSON.stringify({ open: true }))

  const seen: Element[] = []
  const watcher = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes)
        seen.push(...(node instanceof Element ? node.querySelectorAll('[data-part=launcher]') : []))
    }
  })

  watcher.observe(document.body, { childList: true, subtree: true })

  try {
    mounted = await mountComponent(Editor, { entries: [], unclickable: [] })
    await settle()
    seen.push(...document.querySelectorAll('[data-part=launcher]'))
  }
  finally {
    watcher.disconnect()
  }

  expect(seen).toHaveLength(0)
})

test('the launcher shows once the stored layout says the panel is closed', async () => {
  localStorage.setItem('kcms-editor', JSON.stringify({ open: false }))
  mounted = await mountComponent(Editor, { entries: [], unclickable: [] })
  await settle()

  const launcher = mounted.root.querySelector('[data-part=launcher]')

  expect(launcher?.getAttribute('aria-controls')).toBe('kcms-editor')
  expect(launcher?.getAttribute('aria-label')).toBe('Edit this page')
})
