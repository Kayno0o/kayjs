import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import TreeLazy from '../tests/fixture/src/components/tree-lazy.kay'
import Tree from '../tests/fixture/src/components/tree.kay'
import { click } from './dom'

let mounted: Mounted | undefined
let picks: string[] = []
let nodes: string[] = []

afterEach(() => {
  mounted?.unmount()
  picks = []
  nodes = []
})

async function tree() {
  mounted = await mountComponent(Tree, { onSelect: (id: string, node: { label: string }) => {
    picks.push(id)
    nodes.push(node.label)
  } })

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

  expect([rows(root)[2], picks, nodes]).toEqual(['API 3 1/1  true 0', ['api'], ['API']])

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

test('a chord stays the browser\'s, Space selects, and a letter goes to the next row starting with it', async () => {
  const root = await tree()
  const focused = () => document.activeElement?.querySelector('.kui-tree-view-label')?.textContent
  const chord = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true })

  root.querySelector<HTMLElement>('[tabindex="0"]')!.focus()
  document.activeElement!.dispatchEvent(chord)
  await settle()

  expect([focused(), chord.defaultPrevented]).toEqual(['Notes', false])

  press(root, 'i')
  await settle()
  press(root, ' ')
  await settle()
  press(root, 'W')
  await settle()

  expect([focused(), picks]).toEqual(['Work', ['inbox']])
})

test('a click on the blank before a leaf selects it, and new nodes never reopen a branch closed since', async () => {
  const root = await tree()

  click(root.querySelectorAll('.kui-tree-view-toggle')[3]!)
  await settle()

  expect(picks).toEqual(['inbox'])

  click(root.querySelector('.kui-tree-view-toggle'))
  await settle()
  click(mounted!.root.querySelector('#rename'))
  await settle()

  expect(rows(root)).toEqual(['Work 1 1/2 false false -1', 'Mail 1 2/2  true 0'])
})

async function lazy() {
  const calls: string[] = []

  mounted = await mountComponent(TreeLazy, { calls })
  await settle()

  const root = mounted.root

  return { root, calls, labels: () => [...root.querySelectorAll('.kui-tree-view-label')].map(label => label.textContent), row: (label: string) => [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(item => item.textContent?.startsWith(label))! }
}

test('a branch whose children are a function loads them the first time it opens, busy meanwhile, and keeps them', async () => {
  const { root, calls, labels, row } = await lazy()

  click(row('Remote').querySelector('.kui-tree-view-toggle'))
  await settle()
  expect(row('Remote').getAttribute('aria-busy')).toBe('true')
  expect(labels()).toEqual(['Remote', 'Flaky', 'Plain'])

  click(root.querySelector('#release'))
  await settle()
  expect(row('Remote').getAttribute('aria-busy')).toBeNull()
  expect(labels()).toEqual(['Remote', 'File', 'Flaky', 'Plain'])

  click(row('Remote').querySelector('.kui-tree-view-toggle'))
  click(row('Remote').querySelector('.kui-tree-view-toggle'))
  await settle()
  expect(labels()).toEqual(['Remote', 'File', 'Flaky', 'Plain'])
  expect(calls).toEqual(['remote true', 'remote false', 'remote true'])
})

test('a branch whose children fail says so, and tries again from its button or by opening it again', async () => {
  const { root, calls, labels, row } = await lazy()

  click(row('Flaky').querySelector('.kui-tree-view-toggle'))
  await settle()
  expect(row('Flaky').querySelector('[role=alert]')?.textContent).toBe('Could not load.')
  expect(calls).toEqual(['flaky true', 'flaky call'])

  click(root.querySelector('#heal'))
  click(row('Flaky').querySelector('.kui-tree-view-retry'))
  await settle()
  expect(labels()).toEqual(['Remote', 'Flaky', 'Ok', 'Plain'])
  expect(row('Flaky').querySelector('[role=alert]')).toBeNull()
  expect(calls).toEqual(['flaky true', 'flaky call', 'flaky call'])
})

test('expanded is followed when the parent passes a new list, and the reader\'s own toggles are not reported as the parent\'s', async () => {
  const { root, calls, labels } = await lazy()

  click(root.querySelector('#expand'))
  await settle()
  expect(labels()).toEqual(['Remote', 'Flaky', 'Plain', 'Leaf'])
  expect(calls).toEqual([])
})
