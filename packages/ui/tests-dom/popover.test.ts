import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import { click, clock } from './dom'

let mounted: Mounted | undefined
const toggles: boolean[] = []

afterEach(() => {
  clock.stop()
  mounted?.unmount()
  toggles.length = 0
})

async function popovers(delays: { showDelay?: string, hideDelay?: string } = {}) {
  mounted = await mountComponent('src/components/popovers.kay', { onToggle: (open: boolean) => toggles.push(open), ...delays })

  clock.start()

  return mounted.root
}

describe('Popover', () => {
  test('pairs its trigger with its panel, anchored and placed', async () => {
    const root = await popovers()
    const trigger = root.querySelector('#trigger')!
    const panel = root.querySelector<HTMLElement>('#menu')!

    expect(trigger.getAttribute('popovertarget')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('style')).toBe('anchor-name: --kui-popover-menu')
    expect(panel.getAttribute('popover')).toBe('auto')
    expect(panel.dataset.placement).toBe('top-end')
    expect(panel.getAttribute('style')).toBe('position-anchor: --kui-popover-menu')
  })

  test('shows when the page asks, and follows the browser closing it, as on a click outside', async () => {
    const root = await popovers()
    const panel = root.querySelector<HTMLElement>('#menu')!

    click(root.querySelector('#show'))
    await clock.settle()

    expect(panel.matches(':popover-open')).toBe(true)
    expect(root.querySelector('#trigger')?.getAttribute('aria-expanded')).toBe('true')

    panel.hidePopover()
    await clock.settle()

    expect(root.querySelector('#trigger')?.getAttribute('aria-expanded')).toBe('false')
    expect(toggles).toEqual([true, false])
  })
})

describe('TooltipHost', () => {
  test('shows an element\'s tooltip a moment after the pointer lands on it, anchored to it, until a press', async () => {
    const root = await popovers()
    const button = root.querySelector<HTMLElement>('#delete')!
    const tooltip = root.querySelector<HTMLElement>('.kui-tooltip')!

    button.querySelector('svg')!.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await clock.settle()

    expect(tooltip.matches(':popover-open')).toBe(false)

    await clock.elapse(100)
    await clock.settle()

    expect(tooltip.textContent).toBe('Delete')
    expect(tooltip.matches(':popover-open')).toBe(true)
    expect(tooltip.style.getPropertyValue('position-area')).toBe('bottom')
    expect(button.style.getPropertyValue('anchor-name')).toBe('--kui-tooltip-anchor')
    expect(tooltip.id).toBe('kui-tooltip')
    expect(button.getAttribute('aria-describedby')).toBe('kui-tooltip')

    document.dispatchEvent(new Event('pointerdown'))
    await clock.settle()

    expect(tooltip.matches(':popover-open')).toBe(false)
    expect(button.style.getPropertyValue('anchor-name')).toBe('')
    expect(button.hasAttribute('aria-describedby')).toBe(false)
  })

  test('shows a data-hint under the pointer only, never as the focus lands on its element', async () => {
    const root = await popovers()
    const figure = root.querySelector<HTMLElement>('#figure')!
    const tooltip = root.querySelector<HTMLElement>('.kui-tooltip')!

    root.querySelector<HTMLElement>('#focusable')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await clock.elapse(100)
    await clock.settle()

    expect(tooltip.matches(':popover-open')).toBe(false)

    figure.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await clock.elapse(100)
    await clock.settle()

    expect(tooltip.textContent).toBe('Damage per second')
    expect(tooltip.matches(':popover-open')).toBe(true)
    expect(figure.getAttribute('aria-describedby')).toBe('kui-tooltip')
  })

  test('adds its id to an element\'s own aria-describedby while it shows, and leaves the rest as it was', async () => {
    const root = await popovers()
    const button = root.querySelector<HTMLElement>('#delete')!

    button.setAttribute('aria-describedby', 'hint')
    button.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await clock.elapse(100)
    await clock.settle()

    expect(button.getAttribute('aria-describedby')).toBe('hint kui-tooltip')

    document.dispatchEvent(new Event('pointerdown'))
    await clock.settle()

    expect(button.getAttribute('aria-describedby')).toBe('hint')
  })
})

test('keeps a tooltip while the pointer crosses onto it, and Escape closes it until the pointer moves to another element', async () => {
  const root = await popovers()
  const button = root.querySelector<HTMLElement>('#delete')!
  const tooltip = root.querySelector<HTMLElement>('.kui-tooltip')!
  const over = async (target: Element, wait = 100) => {
    target.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await clock.elapse(wait)
    await clock.settle()
  }

  await over(button)
  await over(document.body, 0)
  await over(tooltip)

  expect(tooltip.matches(':popover-open')).toBe(true)

  await over(document.body, 200)

  expect(tooltip.matches(':popover-open')).toBe(false)

  await over(button)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await clock.settle()

  expect(tooltip.matches(':popover-open')).toBe(false)

  await over(button.querySelector('svg')!)

  expect(tooltip.matches(':popover-open')).toBe(false)
})

test('waits as long as showDelay says before showing, and as hideDelay says before hiding', async () => {
  const root = await popovers({ showDelay: '400ms', hideDelay: '1s' })
  const button = root.querySelector<HTMLElement>('#delete')!
  const tooltip = root.querySelector<HTMLElement>('.kui-tooltip')!

  button.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await clock.elapse(300)
  await clock.settle()

  expect(tooltip.matches(':popover-open')).toBe(false)

  await clock.elapse(200)
  await clock.settle()

  expect(tooltip.matches(':popover-open')).toBe(true)

  document.body.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await clock.elapse(900)
  await clock.settle()

  expect(tooltip.matches(':popover-open')).toBe(true)

  await clock.elapse(200)
  await clock.settle()

  expect(tooltip.matches(':popover-open')).toBe(false)
})

test('a second TooltipHost renders nothing while the first is mounted, and takes over once it unmounts', async () => {
  mounted = await mountComponent('src/components/hosts.kay')
  clock.start()
  const { root } = mounted
  const tip = root.querySelector('#tip')!
  const tooltips = () => [...root.querySelectorAll('.kui-tooltip')]

  async function hover(target: Element) {
    target.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await clock.elapse(100)
    await clock.settle()
  }

  await hover(tip)

  expect(tooltips().map(item => [item.textContent, item.matches(':popover-open')])).toEqual([['Copy', true]])

  click(root.querySelector('#unmount'))
  await clock.settle()
  await hover(root.querySelector('#saved')!)
  await hover(tip)

  expect(tooltips().map(item => [item.textContent, item.matches(':popover-open')])).toEqual([['Copy', true]])
})
