import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import OpenPickers from '../tests/fixture/src/components/open-pickers.kay'
import { click, clock } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  clock.stop()
  mounted?.unmount()
})

async function picker() {
  const calls: string[] = []

  mounted = await mountComponent(OpenPickers, { calls })
  clock.start()
  await clock.settle()

  return { root: mounted.root, calls }
}

const isOpen = (root: Element, selector: string) => root.querySelector<HTMLElement>(selector)!.matches(':popover-open')

test.each([
  ['multi', '#open-multi', '#multi'],
  ['date', '#open-date', '[role=dialog][popover]'],
  ['switcher', '#open-switcher', '#switcher'],
])('%s opens from the app and reports the browser closing it', async (name, button, panel) => {
  const { root, calls } = await picker()

  click(root.querySelector(button))
  await clock.settle()

  expect(isOpen(root, panel)).toBe(true)

  root.querySelector<HTMLElement>(panel)!.hidePopover()
  await clock.settle()

  expect(calls).toEqual([`${name} true`, `${name} false`])
})

test('a Combobox opens from the app and reports it', async () => {
  const { root, calls } = await picker()

  click(root.querySelector('#open-combo'))
  await clock.settle()

  expect(root.querySelector('[role=listbox]')!.hasAttribute('hidden')).toBe(false)
  expect(calls).toEqual([])

  root.querySelector('input[role=combobox]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await clock.settle()

  expect(calls).toEqual(['combo false'])
})

test('a Combobox reports its own opening on focus', async () => {
  const { root, calls } = await picker()

  root.querySelector('input[role=combobox]')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  await clock.settle()

  expect(calls).toEqual(['combo true'])
})

test('a DateRangeInput names the box whose calendar shows', async () => {
  const { root, calls } = await picker()
  const panels = root.querySelectorAll<HTMLElement>('[role=group] [role=dialog][popover]')

  panels[1]!.showPopover()
  await clock.settle()

  expect(calls).toEqual(['range to true'])
})

test('a HoverCard tells the app it closed on Escape, and shows again once the app re-anchors', async () => {
  const { root, calls } = await picker()
  const card = root.querySelector<HTMLElement>('#card')!

  click(root.querySelector('#anchor'))
  await clock.settle()

  expect(card.matches(':popover-open')).toBe(true)

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await clock.settle()

  expect(card.matches(':popover-open')).toBe(false)
  expect(calls).toEqual(['card true', 'card false'])

  click(root.querySelector('#clear'))
  click(root.querySelector('#anchor'))
  await clock.settle()

  expect(card.matches(':popover-open')).toBe(true)
  expect(calls).toEqual(['card true', 'card false', 'card true'])
})

test('Menu, AppSwitcher, ConfirmDelete and Toaster spread their attributes on the trigger or root', async () => {
  const { root } = await picker()

  expect(root.querySelector('[popovertarget=menu]')!.getAttribute('data-testid')).toBe('menu')
  expect(root.querySelector('[popovertarget=menu]')!.getAttribute('style')).toContain('anchor-name')
  expect(root.querySelector('[popovertarget=menu]')!.getAttribute('style')).toContain('color: blue')

  const tile = root.querySelector('[popovertarget=switcher]')!

  expect([tile.getAttribute('data-testid'), tile.getAttribute('aria-describedby'), tile.getAttribute('style')]).toEqual(['switch', 'hint', expect.stringContaining('color: red')])
  expect(root.querySelector('[data-testid=confirm]')!.tagName).toBe('BUTTON')
  expect(root.querySelector('[data-testid=toaster]')!.getAttribute('data-part')).toBe('root')
})
