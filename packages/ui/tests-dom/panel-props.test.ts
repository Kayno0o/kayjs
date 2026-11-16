import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
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
