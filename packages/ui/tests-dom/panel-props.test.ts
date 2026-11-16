import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import ChainedPanel from '../tests/fixture/src/components/chained-panel.kay'
import PanelProps from '../tests/fixture/src/components/panel-props.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a component with a floating panel puts panelProps on the panel', async () => {
  mounted = await mountComponent(PanelProps, {})

  for (const kind of ['menu', 'switcher', 'avatars', 'date', 'multi', 'range', 'table', 'combobox']) {
    const panel = mounted.root.querySelector<HTMLElement>(`[data-panel="${kind}"]`)

    expect(panel, kind).not.toBeNull()
    expect(panel!.matches('[popover], ul[role=listbox]'), kind).toBe(true)
  }
})

test('a component drawing its own trigger puts triggerProps on that button', async () => {
  mounted = await mountComponent(PanelProps, {})

  for (const kind of ['avatars', 'date', 'multi', 'range', 'table']) {
    const trigger = mounted.root.querySelector<HTMLElement>(`[data-trigger="${kind}"]`)

    expect(trigger, kind).not.toBeNull()
    expect(trigger!.tagName, kind).toBe('BUTTON')
    expect(trigger!.getAttribute('popovertarget'), kind).toBe(trigger!.ownerDocument.querySelector(`[data-panel="${kind}"]`)!.id)
  }
})

test('an app handler in panelProps runs before the component\'s own for the same event', async () => {
  mounted = await mountComponent(ChainedPanel, {})

  const list = mounted.root.querySelector<HTMLElement>('[role=listbox]')!
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })

  list.dispatchEvent(press)
  await new Promise(resolve => setTimeout(resolve))

  expect(mounted.root.querySelector('#log')!.textContent).toBe('app')
  expect(press.defaultPrevented).toBe(true)
})

test('a trigger takes the app\'s label over the component\'s', async () => {
  mounted = await mountComponent(PanelProps, {})

  expect(mounted.root.querySelector('[data-trigger="table"]')!.textContent).toContain('Cols')
})
