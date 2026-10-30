import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Panels from '../tests/fixture/src/components/panels.kay'
import { untilHolds } from '../tests/until'
import { click } from './dom'

let mounted: Mounted | undefined
let closes = 0

afterEach(() => {
  mounted?.unmount()
  closes = 0
  localStorage.clear()
})

async function panels(listWidthKey?: string) {
  mounted = await mountComponent(Panels, { onClose: () => closes++, listWidthKey })

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
    expect([...panel.querySelectorAll('[data-part=head] > *')].map(element => element.textContent || element.getAttribute('aria-label'))).toEqual(['Mars', 'Next', 'Close'])
    expect(panel.querySelector('[data-part=body] #body')).not.toBeNull()
    expect(panel.querySelector('[data-part=footer] #save')).not.toBeNull()

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

describe('SidePanel with modal={false}', () => {
  test('shows beside the page, stays open on a click outside, and closes on Escape or its close link through onClose', async () => {
    const root = await panels()
    const panel = root.querySelector<HTMLDialogElement>('#beside')!
    const show = spyOn(HTMLDialogElement.prototype, 'show')

    click(root.querySelector('#open-beside'))
    await settle()

    expect(panel.open).toBe(true)
    const calls = show.mock.calls.length

    show.mockRestore()

    expect(calls).toBe(1)
    expect(panel.hasAttribute('data-modal')).toBe(true)
    expect(panel.getAttribute('closedby')).toBe('closerequest')
    expect(panel.matches(':modal')).toBe(false)

    click(root.querySelector('#open'))
    await settle()

    expect(panel.open).toBe(true)
    expect(closes).toBe(0)

    key(document.body, 'Escape')
    await settle()

    expect(panel.open).toBe(false)
    expect(closes).toBe(1)

    click(root.querySelector('#open-beside'))
    await settle()
    const close = panel.querySelector<HTMLAnchorElement>('a.kui-icon-btn')!

    expect(close.getAttribute('href')).toBe('/list')
    expect(close.getAttribute('aria-label')).toBe('Close')
    expect(close.getAttribute('data-part')).toBe('root')
    expect(close.getAttribute('data-tooltip')).toBe('Close')

    let prevented: boolean | undefined

    document.addEventListener('click', event => prevented = event.defaultPrevented, { once: true })
    click(close)
    await settle()

    expect(prevented).toBe(false)
    expect(panel.open).toBe(false)
    expect(closes).toBe(2)

    key(document.body, 'Escape')
    await settle()

    expect(closes).toBe(2)
  })
})

describe('SidePanel with a closeHref and no onOpenChange', () => {
  test('follows closeHref on Escape with no handler from the page', async () => {
    const root = await panels()
    const panel = root.querySelector<HTMLDialogElement>('#linked')!
    const happy = window as unknown as { happyDOM: { setURL: (url: string) => void } }

    happy.happyDOM.setURL('http://localhost/panels')
    click(root.querySelector('#open-linked'))
    await settle()

    expect(panel.open).toBe(true)
    expect(panel.querySelector('a.kui-icon-btn')?.getAttribute('href')).toBe('/list')

    key(document.body, 'Escape')
    await settle()

    expect(panel.open).toBe(false)
    await untilHolds(() => location.pathname === '/list')
  })
})

describe('SidePanel with a dock', () => {
  const launcher = (root: Element) => root.querySelector<HTMLElement>('[data-part=launcher]')

  const html = document.documentElement
  const dock = (root: Element) => root.querySelector<HTMLDialogElement>('#docked')!
  const grip = (root: Element) => dock(root).querySelector<HTMLElement>('[role=separator]')!

  afterEach(() => {
    for (const name of ['--kay-panel-right', '--kay-panel-bottom', '--kui-dock-right', '--kui-dock-bottom'])
      html.style.removeProperty(name)

    html.removeAttribute('data-kui-dock')
  })

  test('sits beside the page, ignores Escape, and publishes what it holds on the page', async () => {
    const root = await panels()
    const panel = dock(root)

    await settle()

    expect(panel.open).toBe(true)
    expect(panel.dataset.dock).toBe('right')
    expect(panel.getAttribute('closedby')).toBe('none')
    expect(html.dataset.kuiDock).toBe('right')
    expect(html.style.getPropertyValue('--kay-panel-right')).toBe('384px')
    expect(html.style.getPropertyValue('--kui-dock-right')).toBe('384px')

    key(document.body, 'Escape')
    await settle()

    expect(panel.open).toBe(true)
    expect(closes).toBe(0)
  })

  test('resizes by the arrow keys within its bounds and tells the parent when a size settles', async () => {
    const settled: number[] = []

    mounted = await mountComponent(Panels, { onClose: () => closes++, onSettled: (size: number) => settled.push(size) })

    const root = mounted.root
    const read = () => [grip(root).getAttribute('aria-valuenow'), grip(root).getAttribute('aria-valuemin'), grip(root).getAttribute('aria-orientation')]

    expect(read()).toEqual(['384', '280', 'vertical'])

    key(grip(root), 'ArrowLeft')
    await settle()

    expect(read()[0]).toBe('408')
    expect(html.style.getPropertyValue('--kay-panel-right')).toBe('408px')

    grip(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    await settle()

    expect(read()[0]).toBe('312')

    for (let press = 0; press < 30; press++)
      key(grip(root), 'ArrowRight')
    await settle()

    expect(read()[0]).toBe('280')
    expect(settled.at(-1)).toBe(280)
  })

  test('sizeKey keeps the settled size in a cookie, which a panel mounted later opens on', async () => {
    const name = 'pane-width'
    const first = await mountComponent(Panels, { onClose: () => closes++, sizeKey: name })

    key(grip(first.root), 'ArrowLeft')
    await settle()

    expect(grip(first.root).getAttribute('aria-valuenow')).toBe('408')
    expect(document.cookie).toContain(`${name}=`)
    first.unmount()

    mounted = await mountComponent(Panels, { onClose: () => closes++, sizeKey: name })

    expect(grip(mounted.root).getAttribute('aria-valuenow')).toBe('408')
    document.cookie = `${name}=; max-age=0; path=/`
  })

  test('resizes by dragging its grip, a cancelled drag keeping the size it reached', async () => {
    const settled: number[] = []

    mounted = await mountComponent(Panels, { onClose: () => closes++, onSettled: (size: number) => settled.push(size) })

    const root = mounted.root
    const pointer = (type: string, x: number) => grip(root).dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, button: 0, bubbles: true, cancelable: true }))

    pointer('pointerdown', 500)
    pointer('pointermove', 460)
    await settle()

    expect(grip(root).getAttribute('aria-valuenow')).not.toBe('384')

    const reached = grip(root).getAttribute('aria-valuenow')

    pointer('pointercancel', 460)
    pointer('pointermove', 100)
    await settle()

    expect(grip(root).getAttribute('aria-valuenow')).toBe(reached)
    expect(settled.at(-1)).toBe(Number(reached))
  })

  test('a click on its grip that never moves settles nothing', async () => {
    const settled: number[] = []

    mounted = await mountComponent(Panels, { onClose: () => closes++, onSettled: (size: number) => settled.push(size) })

    const pointer = (type: string, x: number) => grip(mounted!.root).dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, button: 0, bubbles: true, cancelable: true }))

    pointer('pointerdown', 500)
    pointer('pointerup', 500)
    await settle()

    expect(settled).toEqual([])
  })

  test('moves to the bottom edge, where the grip resizes the height with the vertical arrows', async () => {
    const root = await panels()

    click(root.querySelector('#dock-bottom'))
    await settle()

    expect(dock(root).dataset.dock).toBe('bottom')
    expect(html.dataset.kuiDock).toBe('bottom')
    expect(html.style.getPropertyValue('--kay-panel-right')).toBe('')
    expect(grip(root).getAttribute('aria-orientation')).toBe('horizontal')
    expect(grip(root).getAttribute('aria-valuemin')).toBe('160')

    const before = Number(grip(root).getAttribute('aria-valuenow'))

    key(grip(root), 'ArrowUp')
    await settle()

    expect(Number(grip(root).getAttribute('aria-valuenow'))).toBe(before + 24)
  })

  test('keeps the page its share of the window beside the dev tool\'s docked drawer, and sits beside it', async () => {
    html.style.setProperty('--kay-dev-inset-right', '300px')

    try {
      const root = await panels()

      await settle()

      expect(grip(root).getAttribute('aria-valuemax')).toBe(String(window.innerWidth - 300 - 352))
      expect(dock(root).getAttribute('style')).toContain('right: var(--kay-dev-inset-right, 0px)')
    }
    finally {
      html.style.removeProperty('--kay-dev-inset-right')
    }
  })

  test('the launcher is layered by launcherLayer alone and names its panel, whatever style the panel takes', async () => {
    const root = await panels()

    await settle()
    click(dock(root).querySelector('.kui-icon-btn[aria-label="Close"]'))
    await settle()

    const button = launcher(root)!

    expect(dock(root).style.zIndex).toBe('77')
    expect(button.style.zIndex).toBe('41')
    expect(button.style.opacity).toBe('')
    expect(button.getAttribute('aria-controls')).toBe('docked')
  })

  test('leaves a launcher in the corner once closed, which opens it again and holds the dev tool\'s bar off it', async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 40 })

    try {
      const root = await panels()

      await settle()
      expect(launcher(root)).toBeNull()

      click(dock(root).querySelector('.kui-icon-btn[aria-label="Close"]'))
      await settle()

      expect(launcher(root)?.getAttribute('aria-label')).toBe('Open Jupiter')
      expect(html.style.getPropertyValue('--kay-panel-right')).toBe('56px')

      click(launcher(root))
      await settle()

      expect(dock(root).open).toBe(true)
      expect(launcher(root)).toBeNull()
      expect(html.style.getPropertyValue('--kay-panel-right')).toBe('384px')
    }
    finally {
      if (width)
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
    }
  })

  test('a closeHref panel with a launcherHref and no onOpenChange leaves a launcher that is a link', async () => {
    const root = await panels()

    click(root.querySelector('#show-launched'))
    await settle()

    const link = root.querySelector<HTMLElement>('[data-part=launcher][aria-controls="launched"]')

    expect(link?.getAttribute('aria-label')).toBe('Open Saturn')
    expect(link?.tagName).toBe('A')
    expect(link?.getAttribute('href')).toBe('/saturn')
  })

  test('a panel whose dock arrives later docks then, and makes no room before', async () => {
    const root = await panels()
    const late = root.querySelector<HTMLDialogElement>('#late')!

    expect(late.dataset.dock).toBeUndefined()
    expect(late.querySelector('[role=separator]')).toBeNull()

    click(root.querySelector('#late-dock'))
    await settle()

    expect(late.dataset.dock).toBe('bottom')
    expect(late.querySelector('[role=separator]')).not.toBeNull()
  })

  test('publishes nothing once closed', async () => {
    const root = await panels()

    click(dock(root).querySelector('.kui-icon-btn[aria-label="Close"]'))
    await settle()

    expect(dock(root).open).toBe(false)
    expect(html.hasAttribute('data-kui-dock')).toBe(false)
    expect(html.style.getPropertyValue('--kay-panel-right')).toBe('')

    click(root.querySelector('#open-docked'))
    await settle()

    expect(html.style.getPropertyValue('--kay-panel-right')).toBe('384px')
  })
})

// Runs `run` with the viewport below `md`, whatever the test window's width.
async function whenNarrow(run: () => Promise<void>) {
  const media = window.matchMedia.bind(window)

  window.matchMedia = (query: string) => {
    const list = media(query)

    return new Proxy(list, { get: (target, name) => {
      if (name === 'matches')
        return query.includes('width <')

      const found = Reflect.get(target, name) as unknown

      return typeof found === 'function' ? (found as (...args: unknown[]) => unknown).bind(target) : found
    } })
  }

  try {
    await run()
  }
  finally {
    window.matchMedia = media
  }
}

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
    const width = () => [root.querySelector<HTMLElement>('#split')!.style.getPropertyValue('--_split-list-width'), resizer().getAttribute('aria-valuenow')]

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

  test('resizes the list by dragging its separator, a cancelled drag keeping the width it reached', async () => {
    let root = await panels('planets-drag')
    const resizer = () => root.querySelector('.kui-split-layout-resizer')!
    const width = () => root.querySelector<HTMLElement>('#split')!.style.getPropertyValue('--_split-list-width')
    const pointer = (type: string, x: number) => resizer().dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, button: 0, bubbles: true, cancelable: true }))

    pointer('pointerdown', 100)
    pointer('pointermove', 160)
    await settle()

    expect(width()).toBe('320px')

    pointer('pointercancel', 160)
    pointer('pointermove', 400)
    await settle()

    expect(width()).toBe('320px')

    mounted!.unmount()
    root = await panels('planets-drag')

    expect(width()).toBe('320px')
  })
})

describe('SplitLayout on a phone', () => {
  const inert = (root: Element) => [...root.querySelectorAll('.kui-split-layout-list, .kui-split-layout-detail')].map(pane => pane.hasAttribute('inert'))

  test('makes the covered panes inert while the sidebar overlay is open, and only then', async () => {
    await whenNarrow(async () => {
      const root = await panels()

      expect(inert(root)).toEqual([true, true])

      click(root.querySelector('.kui-split-layout-sidebar-head .kui-icon-btn'))
      await settle()

      expect(inert(root)).toEqual([false, false])
    })
  })

  test('leaves the panes reachable side by side from md up', async () => {
    const root = await panels()

    expect(inert(root)).toEqual([false, false])
  })

  test('focuses the sidebar when it opens and gives focus back to what opened it', async () => {
    await whenNarrow(async () => {
      const root = await panels()
      const reopen = root.querySelector<HTMLElement>('#open-sidebar')!

      click(root.querySelector('.kui-split-layout-sidebar-head .kui-icon-btn'))
      await settle()
      reopen.focus()
      click(reopen)
      await settle()
      await untilHolds(() => document.activeElement === root.querySelector('.kui-split-layout-sidebar-head .kui-icon-btn'))

      expect(document.activeElement).toBe(root.querySelector('.kui-split-layout-sidebar-head .kui-icon-btn'))

      click(root.querySelector('.kui-split-layout-sidebar-head .kui-icon-btn'))
      await settle()
      await untilHolds(() => document.activeElement === reopen)

      expect(document.activeElement).toBe(reopen)
    })
  })

  test('focuses the detail when it opens and gives focus back to the list control when it closes', async () => {
    await whenNarrow(async () => {
      const root = await panels()
      const toggle = root.querySelector<HTMLElement>('#toggle-detail')!

      click(root.querySelector('.kui-split-layout-sidebar-head .kui-icon-btn'))
      await settle()
      toggle.focus()
      click(toggle)
      await settle()
      toggle.focus()
      click(toggle)
      await settle()
      await untilHolds(() => document.activeElement === root.querySelector('#edit'))

      expect(document.activeElement).toBe(root.querySelector('#edit'))

      click(toggle)
      await settle()
      await untilHolds(() => document.activeElement === toggle)

      expect(document.activeElement).toBe(toggle)
    })
  })

  test('puts focus on the list when a pane open from the first render closes with no opener', async () => {
    await whenNarrow(async () => {
      const root = await panels()

      click(root.querySelector('.kui-split-layout-sidebar-head .kui-icon-btn'))
      await settle()
      await untilHolds(() => document.activeElement === root.querySelector('#mars'))

      expect(document.activeElement).toBe(root.querySelector('#mars'))
    })
  })

  test('leaves focus alone on the first render and from md up', async () => {
    const root = await panels()
    const toggle = root.querySelector<HTMLElement>('#toggle-detail')!

    toggle.focus()
    click(toggle)
    await settle()
    // Nothing is meant to move focus, which a turn after the click would have shown.
    await settle()

    expect(document.activeElement).toBe(toggle)
  })
})
