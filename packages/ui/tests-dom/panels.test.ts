import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
let closes = 0

afterEach(() => {
  mounted?.unmount()
  closes = 0
  localStorage.clear()
})

async function panels(listWidthKey?: string) {
  mounted = await mount('src/components/panels.kay', { onClose: () => closes++, listWidthKey })

  return mounted.root
}

function key(element: Element | null, name: string) {
  element!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
}

describe('SidePanel', () => {
  test('opens as a named modal holding its head, body and footer, and its close button closes it through onClose', async () => {
    const root = await panels()
    const panel = root.querySelector<HTMLDialogElement>('#panel')!

    expect(panel.open).toBe(false)
    expect(panel.querySelector('#body')).toBeNull()

    click(root.querySelector('#open'))
    await settle()

    expect(panel.open).toBe(true)
    expect(panel.getAttribute('aria-label')).toBe('Mars')
    expect(panel.getAttribute('closedby')).toBe('any')
    expect([...panel.querySelectorAll('.kui-side-panel-head > *')].map(element => element.textContent || element.getAttribute('aria-label'))).toEqual(['Mars', 'Next', 'Close'])
    expect(panel.querySelector('.kui-side-panel-body #body')).not.toBeNull()
    expect(panel.querySelector('.kui-side-panel-footer #save')).not.toBeNull()

    click(panel.querySelector('.kui-icon-btn[aria-label="Close"]'))
    await settle()

    expect(panel.open).toBe(false)
    expect(panel.querySelector('#body')).toBeNull()
    expect(closes).toBe(1)
  })

  test('closes when the parent says so', async () => {
    const root = await panels()

    click(root.querySelector('#open'))
    await settle()
    click(root.querySelector('#shut'))
    await settle()

    expect(root.querySelector<HTMLDialogElement>('#panel')?.open).toBe(false)
  })
})

describe('SplitLayout', () => {
  test('renders its panes once, with the sidebar\'s and the detail\'s state for the narrow layout, and the sidebar\'s back button asks the parent to close it', async () => {
    const root = await panels()
    const split = root.querySelector('#split')!

    expect([...split.children].map(pane => pane.className)).toEqual(['kui-split-layout-sidebar', 'kui-split-layout-list', 'kui-split-layout-detail'])
    expect(['data-sidebar', 'data-sidebar-open', 'data-detail-open'].map(name => split.hasAttribute(name))).toEqual([true, true, true])
    expect(split.querySelector('.kui-split-layout-sidebar-title')?.textContent).toBe('Planets')

    click(split.querySelector('.kui-split-layout-sidebar-head .kui-icon-btn'))
    await settle()

    expect(split.hasAttribute('data-sidebar-open')).toBe(false)
  })

  test('resizes the list with the arrow keys within its bounds, and keeps the width for the next visit', async () => {
    let root = await panels('planets-width')
    const resizer = () => root.querySelector('.kui-split-layout-resizer')!
    const width = () => [root.querySelector<HTMLElement>('#split')!.style.getPropertyValue('--kui-split-list-width'), resizer().getAttribute('aria-valuenow')]

    expect(width()).toEqual(['260px', '260'])

    key(resizer(), 'ArrowRight')
    await settle()

    expect(width()).toEqual(['280px', '280'])

    for (let press = 0; press < 30; press++)
      key(resizer(), 'ArrowLeft')
    await settle()

    expect(width()).toEqual(['180px', '180'])

    key(resizer(), 'ArrowRight')
    mounted!.unmount()
    root = await panels('planets-width')

    expect(width()).toEqual(['200px', '200'])
  })
})
