import type { DevTool } from './dev-tool'
import { drawing, MARK, setIcon } from './dev-tool-icons'
import { DOCKS, GRIPS } from './dev-tool-layout'

// The elements of the bar and the drawer, put together and not yet in the page. Split from dev-tool.ts, which wires them.

const SHOW_TAB_ORDER = 'Show the tab order'

export const COPY_TAB = 'Copy this tab as Markdown'

export function buildShell(doc: Document, make: DevTool['make']) {
  const ui = make('div', 'ui')
  const bar = make('div', 'bar')
  const mark = make('button', 'mark')
  const drawer = make('div', 'drawer')
  const head = make('div', 'head')
  const title = make('span', 'title')
  const where = make('span', 'where')
  const body = make('div', 'body')
  const tabList = make('div', 'tabs')
  const rule = make('span', 'sep')
  const content = make('div', 'content')
  const dock = make('div', 'dock')
  const docks = DOCKS.map(([value, label, icon]) => {
    const button = make('button', 'icon')

    button.type = 'button'
    setIcon(button, label, icon)
    dock.append(button)

    return { value, button }
  })
  const size = make('button', 'icon size')
  const copyTab = make('button', 'icon')
  const order = make('button', 'icon')
  const close = make('button', 'icon')
  const grips = GRIPS.map((edge) => {
    const grip = make('div', `grip ${edge}`)

    grip.dataset.edge = edge

    return grip
  })
  const status = make('span', 'sr')
  const copies = make('div', 'sr copies')

  dock.setAttribute('role', 'group')
  dock.setAttribute('aria-label', 'Dock')
  drawer.id = 'kay-dev-drawer'
  drawer.setAttribute('role', 'dialog')
  drawer.setAttribute('aria-label', 'kay dev tools')
  tabList.setAttribute('role', 'tablist')
  tabList.setAttribute('aria-orientation', 'vertical')
  rule.hidden = true
  rule.setAttribute('aria-hidden', 'true')
  tabList.append(rule)
  mark.type = 'button'
  mark.setAttribute('aria-label', 'kay dev tools (Alt+Shift+K)')
  mark.setAttribute('aria-controls', drawer.id)
  mark.append(drawing(doc, MARK, '4 5 54 52', ''), 'kay')
  title.append(drawing(doc, MARK, '4 5 54 52', ''), make('span', 'words', 'kay dev tools'))
  status.setAttribute('role', 'status')
  copies.setAttribute('role', 'status')
  size.type = 'button'
  close.type = 'button'
  setIcon(close, 'Close', 'x')
  setIcon(copyTab, COPY_TAB, 'clipboard-copy')
  copyTab.type = 'button'
  setIcon(order, SHOW_TAB_ORDER, 'list-ordered')
  order.type = 'button'
  order.setAttribute('aria-pressed', 'false')
  head.append(title, where, copyTab, order, dock, size, close)
  body.append(tabList, content)
  drawer.append(head, body, ...grips)
  bar.append(mark, status)
  ui.append(drawer, bar, copies)

  return { ui, bar, mark, drawer, head, where, tabList, rule, content, docks, size, copyTab, order, close, grips, status }
}

export type Shell = ReturnType<typeof buildShell>
