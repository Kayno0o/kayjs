import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import TreeLinks from '../tests/fixture/src/components/tree-links.kay'
import { click } from './dom'

let mounted: Mounted | undefined
let actions: string[] = []
let stars: string[] = []
let picks: string[] = []

beforeEach(() => {
  go('/projects/beta')
})

afterEach(() => {
  mounted?.unmount()
  actions = []
  stars = []
  picks = []
  go('/')
})

function go(path: string) {
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://localhost${path}`)
}

async function tree() {
  mounted = await mountComponent(TreeLinks, { onAction: (label: string) => actions.push(label), onStar: (id: string) => stars.push(id), onSelect: (id: string) => picks.push(id) })

  return mounted.root.querySelector('#tree')!
}

const items = (root: Element) => [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')]

function press(key: string, init: KeyboardEventInit = {}) {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

test('a node with an href is a real link, the one for the current address selected and opened to', async () => {
  const root = await tree()

  expect(items(root).map(row => [row.querySelector('a')?.getAttribute('href') ?? null, row.getAttribute('aria-selected'), row.querySelector('a')?.getAttribute('aria-current') ?? null])).toEqual([
    [null, 'false', null],
    ['/projects/alpha', 'false', null],
    ['/projects/beta/', 'true', 'page'],
    ['/projects/beta?view=list', 'false', null],
    [null, 'false', null],
  ])
})

test('a link row stays one tab stop with the link out of the tab order, and Enter follows the link', async () => {
  const root = await tree()
  const rows = items(root)

  expect(rows.map(row => row.tabIndex)).toEqual([-1, -1, 0, -1, -1])
  expect(rows.flatMap(row => [...row.querySelectorAll('a')].map(link => link.tabIndex))).toEqual([-1, -1, -1])

  let followed = ''
  const link = rows[1]!.querySelector('a')!

  link.addEventListener('click', (event) => {
    event.preventDefault()
    followed = link.getAttribute('href')!
  })
  rows[1]!.focus()
  press('Enter')
  await settle()

  expect([followed, picks]).toEqual(['/projects/alpha', ['alpha']])
})

test('the arrow keys walk link rows as they walk any other', async () => {
  const root = await tree()

  items(root)[2]!.focus()
  press('ArrowUp')
  expect(document.activeElement).toBe(items(root)[1]!)
  press('End')
  expect(document.activeElement).toBe(items(root)[4]!)
  press('Home')
  expect(document.activeElement).toBe(items(root)[0]!)
  press('ArrowLeft')
  await settle()
  expect(items(root).map(row => row.querySelector('a, .kui-tree-view-label')?.textContent)).toEqual(['Group', 'List', 'Plain'])
  press('ArrowRight')
  await settle()
  expect(items(root)).toHaveLength(5)
  press('ArrowDown')
  press('P')
  expect(document.activeElement).toBe(items(root)[4]!)
})

test('the trailing block is drawn per row with the node, and its controls neither select nor take the tree keys', async () => {
  const root = await tree()
  const star = root.querySelectorAll<HTMLElement>('.star')

  expect([...star].map(button => button.dataset.id)).toEqual(['group', 'alpha', 'beta', 'list', 'plain'])

  click(star[1]!)
  star[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()

  expect([stars, picks]).toEqual([['alpha'], []])
})

test('a right click on a row with a menu opens it at the pointer, and one without leaves the browser its own', async () => {
  const root = await tree()
  const menu = () => root.parentElement!.querySelector<HTMLElement>('[role=menu]')

  const plain = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

  items(root)[4]!.dispatchEvent(plain)
  expect(plain.defaultPrevented).toBe(false)

  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })

  items(root)[1]!.dispatchEvent(event)
  await settle()

  expect(event.defaultPrevented).toBe(true)
  expect([...menu()!.querySelectorAll('[role=menuitem]')].map(item => item.textContent)).toEqual(['Rename', 'Delete'])
  expect(menu()!.getAttribute('aria-label')).toBe('Alpha')
  expect(menu()!.closest('[popover]')!.matches(':popover-open')).toBe(true)

  click(menu()!.querySelectorAll('[role=menuitem]')[1]!)
  await settle()

  expect(actions).toEqual(['delete alpha'])
  expect(menu()!.closest('[popover]')!.matches(':popover-open')).toBe(false)
})

test('Shift+F10 and the Menu key open the focused row\'s menu, and a row without one ignores them', async () => {
  const root = await tree()
  const open = () => root.parentElement!.querySelector<HTMLElement>('[popover]')!.matches(':popover-open')

  items(root)[4]!.focus()
  press('F10', { shiftKey: true })
  await settle()
  expect(open()).toBe(false)

  items(root)[1]!.focus()
  press('F10', { shiftKey: true })
  await settle()
  expect(open()).toBe(true)

  press('Escape')
  root.parentElement!.querySelector<HTMLElement>('[popover]')!.hidePopover()
  await settle()
  expect(open()).toBe(false)

  items(root)[1]!.focus()
  press('ContextMenu')
  await settle()
  expect(open()).toBe(true)
})
