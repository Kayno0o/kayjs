import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const toggles: boolean[] = []

afterEach(() => {
  mounted?.unmount()
  toggles.length = 0
})

async function popovers() {
  mounted = await mount('src/components/popovers.kay', { onToggle: (open: boolean) => toggles.push(open) })

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
    await settle()

    expect(panel.matches(':popover-open')).toBe(true)
    expect(root.querySelector('#trigger')?.getAttribute('aria-expanded')).toBe('true')

    panel.hidePopover()
    await settle()

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
    await settle()

    expect(tooltip.matches(':popover-open')).toBe(false)

    await Bun.sleep(100)
    await settle()

    expect(tooltip.textContent).toBe('Delete')
    expect(tooltip.matches(':popover-open')).toBe(true)
    expect(tooltip.style.getPropertyValue('position-area')).toBe('bottom')
    expect(button.style.getPropertyValue('anchor-name')).toBe('--kui-tooltip-anchor')

    document.dispatchEvent(new Event('pointerdown'))
    await settle()

    expect(tooltip.matches(':popover-open')).toBe(false)
    expect(button.style.getPropertyValue('anchor-name')).toBe('')
  })
})
