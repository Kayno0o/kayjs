import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
let picks: string[] = []

afterEach(() => {
  mounted?.unmount()
  picks = []
})

async function tree() {
  mounted = await mount('src/components/tree.kay', { onSelect: (id: string) => picks.push(id) })

  return mounted.root.querySelector('#tree')!
}

// Each row shown as its label, depth, place, and its open, selected and tab stop states.
function rows(root: Element) {
  return [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')].map(row => [
    row.querySelector('.kui-tree-view-label')?.textContent,
    `${row.getAttribute('aria-level')} ${row.getAttribute('aria-posinset')}/${row.getAttribute('aria-setsize')}`,
    row.getAttribute('aria-expanded'),
    row.getAttribute('aria-selected'),
    row.tabIndex,
  ].join(' '))
}

function press(root: Element, key: string) {
  (document.activeElement ?? root).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

test('shows the roots and the open branches, the selected node opened to and the one tab stop', async () => {
  const root = await tree()

  expect([root.getAttribute('role'), root.getAttribute('aria-label')]).toEqual(['tree', 'Folders'])
  expect(rows(root)).toEqual(['Work 1 1/2 true false -1', 'Specs 2 1/2 false false -1', 'Notes 2 2/2  true 0', 'Inbox 1 2/2  false -1'])
})

test('a click on a row selects it, and one on a chevron opens or closes its branch alone', async () => {
  const root = await tree()

  click(root.querySelectorAll('.kui-tree-view-toggle')[1]!)
  await settle()

  expect([rows(root).map(row => row.slice(0, row.indexOf(' '))), picks]).toEqual([['Work', 'Specs', 'API', 'Notes', 'Inbox'], []])

  click(root.querySelectorAll('[role="treeitem"]')[2]!)
  await settle()

  expect([rows(root)[2], picks]).toEqual(['API 3 1/1  true 0', ['api']])

  click(root.querySelector('.kui-tree-view-toggle'))
  await settle()

  expect(rows(root)).toEqual(['Work 1 1/2 false false 0', 'Inbox 1 2/2  false -1'])
})

test('the arrows walk the rows shown, open and close branches, and Enter selects', async () => {
  const root = await tree()
  const focused = () => document.activeElement?.querySelector('.kui-tree-view-label')?.textContent

  root.querySelector<HTMLElement>('[tabindex="0"]')!.focus()
  press(root, 'ArrowUp')
  await settle()
  press(root, 'ArrowRight')
  await settle()

  expect([focused(), rows(root)[1]]).toEqual(['Specs', 'Specs 2 1/2 true false 0'])

  press(root, 'ArrowRight')
  await settle()
  press(root, 'ArrowLeft')
  await settle()
  press(root, 'ArrowLeft')
  await settle()

  expect([focused(), rows(root)[1]]).toEqual(['Specs', 'Specs 2 1/2 false false 0'])

  press(root, 'End')
  await settle()
  press(root, 'Enter')
  await settle()

  expect([focused(), picks]).toEqual(['Inbox', ['inbox']])
})

test('follows a node its parent selects, opening the branches holding it', async () => {
  const root = await tree()

  click(root.querySelector('.kui-tree-view-toggle'))
  await settle()
  click(mounted!.root.querySelector('#pick-api'))
  await settle()

  expect(rows(root)).toEqual(['Work 1 1/2 true false -1', 'Specs 2 1/2 true false -1', 'API 3 1/1  true 0', 'Notes 2 2/2  false -1', 'Inbox 1 2/2  false -1'])
})
