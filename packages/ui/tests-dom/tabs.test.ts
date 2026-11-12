import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { focusInvalid } from 'kay'
import { mountComponent, settle } from 'kay/test'
import CountedTabs from '../tests/fixture/src/components/counted-tabs.kay'
import GroupedTabs from '../tests/fixture/src/components/grouped-tabs.kay'
import PlanetTabs from '../tests/fixture/src/components/planet-tabs.kay'
import { click } from './dom'

let mounted: Mounted | undefined
const changes: string[] = []

afterEach(() => {
  mounted?.unmount()
  changes.length = 0
})

async function tabs() {
  mounted = await mountComponent(PlanetTabs, { onChange: (value: string) => changes.push(value) })

  const { root } = mounted
  const shown = () => [...root.querySelectorAll('[role="tab"]')].filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.textContent)
  const visible = () => [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(panel => panel.hidden === false).map(panel => panel.querySelector('input')?.name)

  return { root, shown, visible }
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })

  document.activeElement!.dispatchEvent(event)

  return event
}

test('shows a clicked tab\'s panel alone, keeping what the others hold', async () => {
  const { root, shown, visible } = await tabs()

  expect([shown(), visible()]).toEqual([['Venus'], ['venus']])

  root.querySelector<HTMLInputElement>('input[name="venus"]')!.value = 'typed'
  click(root.querySelectorAll('[role="tab"]')[2]!)
  await settle()

  expect([shown(), visible()]).toEqual([['Earth'], ['earth']])
  expect(changes).toEqual(['earth'])

  click(root.querySelectorAll('[role="tab"]')[1]!)
  await settle()

  expect(root.querySelector<HTMLInputElement>('input[name="venus"]')?.value).toBe('typed')
})

test('moves between tabs with the arrows, wrapping, and Home and End, focus going with the tab shown', async () => {
  const { root, shown } = await tabs()

  root.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.focus()
  key('ArrowRight')
  await settle()

  expect([shown(), document.activeElement?.textContent]).toEqual([['Earth'], 'Earth'])

  key('ArrowRight')
  await settle()

  expect(shown()).toEqual(['Mars'])

  key('ArrowLeft')
  await settle()

  expect(shown()).toEqual(['Earth'])

  key('Home')
  await settle()

  expect([shown(), document.activeElement?.getAttribute('tabindex')]).toEqual([['Mars'], '0'])

  key('End')
  await settle()

  expect(shown()).toEqual(['Earth'])
  expect(changes).toEqual(['earth', 'mars', 'earth', 'mars', 'earth'])

  // Alt with an arrow is the browser going back or forward a page.
  expect(key('ArrowLeft', { altKey: true }).defaultPrevented).toBe(false)
  await settle()

  expect(shown()).toEqual(['Earth'])
})

test('keeps a panel, and the focus inside it, when the tabs are relabelled', async () => {
  mounted = await mountComponent(CountedTabs)

  const { root } = mounted
  const input = root.querySelector<HTMLInputElement>('input[name="venus"]')!

  input.focus()
  input.value = 'v'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()

  expect(root.querySelectorAll('[role="tab"]')[1]?.textContent).toBe('venus (1)')
  expect(document.activeElement).toBe(input)
})

test('shows the tab of a panel hidden until found once the browser finds something in it, such as a field it reveals', async () => {
  const { root, shown, visible } = await tabs()
  const earth = root.querySelectorAll<HTMLElement>('[role="tabpanel"]')[2]!

  expect(earth.getAttribute('hidden')).toBe('until-found')
  expect(earth.hasAttribute('tabindex')).toBe(false)

  earth.dispatchEvent(new Event('beforematch', { bubbles: true }))
  await settle()

  expect([shown(), visible(), changes]).toEqual([['Earth'], ['earth'], ['earth']])
  expect(earth.getAttribute('tabindex')).toBe('0')
})

test('shows the tab of a hidden panel when kay\'s focusInvalid reaches an invalid field in it', async () => {
  const { root, shown, visible } = await tabs()
  const input = root.querySelector<HTMLInputElement>('input[name="earth"]')!

  input.setAttribute('aria-invalid', 'true')

  expect(await focusInvalid(root)).toBe(true)
  await settle()

  expect([shown(), visible(), changes]).toEqual([['Earth'], ['earth'], ['earth']])
  expect(document.activeElement).toBe(input)
})

test('focusInvalid reaches a FormField group with an issue, showing its tab and focusing its first field, and a group without one is left alone', async () => {
  mounted = await mountComponent(GroupedTabs, {})

  const { root } = mounted
  const login = root.querySelector<HTMLInputElement>('#login')!
  const admin = root.querySelector<HTMLInputElement>('#admin')!
  const group = root.querySelector<HTMLElement>('fieldset')!
  const marks = () => [login, admin].map(field => [field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')])

  expect(await focusInvalid(root)).toBe(false)
  expect(marks()).toEqual([[null, null], [null, null]])

  click(root.querySelector('#refuse'))
  await settle()

  const issues = group.querySelector(':scope > [data-part="issues"]')!.id

  expect(marks()).toEqual([['true', issues], ['true', issues]])
  expect(await focusInvalid(root)).toBe(true)
  await settle()

  expect(document.activeElement).toBe(login)
  expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Access')

  click(root.querySelector('#clear'))
  await settle()

  expect(marks()).toEqual([[null, null], [null, null]])
})

test('flips the arrows under a right-to-left direction', async () => {
  const { root, shown } = await tabs()

  root.querySelector<HTMLElement>('[role="tablist"]')!.style.direction = 'rtl'
  root.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.focus()
  key('ArrowLeft')
  await settle()

  expect(shown()).toEqual(['Earth'])

  key('ArrowRight')
  await settle()

  expect(shown()).toEqual(['Venus'])
})

async function configured(props: Record<string, unknown>) {
  mounted = await mountComponent(PlanetTabs, { onChange: (value: string) => changes.push(value), ...props })

  const { root } = mounted
  const tabList = root.querySelector<HTMLElement>('[role="tablist"]')!
  const shown = () => [...root.querySelectorAll('[role="tab"]')].filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.textContent)
  const drawn = () => [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')].map(panel => panel.querySelector('input')?.name ?? null)

  return { root, tabList, shown, drawn }
}

test('a vertical list moves with ArrowUp and ArrowDown, leaves ArrowLeft and ArrowRight alone, and says so to screen readers', async () => {
  const { root, tabList, shown } = await configured({ orientation: 'vertical' })

  expect([tabList.getAttribute('aria-orientation'), root.querySelector('#tabs')?.getAttribute('data-orientation')]).toEqual(['vertical', 'vertical'])

  root.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.focus()

  expect(key('ArrowRight').defaultPrevented).toBe(false)

  key('ArrowDown')
  await settle()

  expect([shown(), document.activeElement?.textContent]).toEqual([['Earth'], 'Earth'])

  key('ArrowDown')
  await settle()

  expect(shown()).toEqual(['Mars'])

  key('ArrowUp')
  await settle()

  expect([shown(), changes]).toEqual([['Earth'], ['earth', 'mars', 'earth']])
})

test('a horizontal list leaves ArrowUp and ArrowDown to the page and carries no orientation', async () => {
  const { root, tabList } = await configured({})

  root.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.focus()

  expect(key('ArrowDown').defaultPrevented).toBe(false)
  expect([tabList.getAttribute('aria-orientation'), tabList.getAttribute('data-orientation')]).toEqual([null, null])
})

test('manual activation moves the focus with the arrows and shows the tab on Enter or a click only', async () => {
  const { root, shown } = await configured({ activation: 'manual' })
  const all = () => root.querySelectorAll<HTMLElement>('[role="tab"]')

  all()[1]!.focus()
  key('ArrowRight')
  await settle()

  expect([shown(), document.activeElement?.textContent, changes]).toEqual([['Venus'], 'Earth', []])

  key('ArrowRight')
  await settle()

  expect([shown(), document.activeElement?.textContent]).toEqual([['Venus'], 'Mars'])

  key('End')
  await settle()

  expect([shown(), document.activeElement?.textContent, changes]).toEqual([['Venus'], 'Earth', []])

  // A button's Enter and Space are its click.
  click(document.activeElement)
  await settle()

  expect([shown(), changes]).toEqual([['Earth'], ['earth']])
})

test('lazy panels are drawn on the first showing of their tab and kept after it', async () => {
  const { root, drawn } = await configured({ lazy: true })

  expect(drawn()).toEqual([null, 'venus', null])

  click(root.querySelectorAll('[role="tab"]')[2]!)
  await settle()

  expect(drawn()).toEqual([null, 'venus', 'earth'])

  root.querySelector<HTMLInputElement>('input[name="earth"]')!.value = 'typed'
  click(root.querySelectorAll('[role="tab"]')[0]!)
  await settle()
  click(root.querySelectorAll('[role="tab"]')[2]!)
  await settle()

  expect([drawn(), root.querySelector<HTMLInputElement>('input[name="earth"]')?.value]).toEqual([['mars', 'venus', 'earth'], 'typed'])
})

test('panels are all drawn at the start without lazy', async () => {
  const { drawn } = await configured({})

  expect(drawn()).toEqual(['mars', 'venus', 'earth'])
})
