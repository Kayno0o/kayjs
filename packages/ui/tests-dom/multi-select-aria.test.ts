import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import MultiField from '../tests/fixture/src/components/multi-field.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

// What a screen reader is told of the trigger: its role and the state a FormField writes on it.
function trigger(root: Element) {
  const button = root.querySelector('[data-part=trigger]')!

  return Object.fromEntries(['role', 'aria-haspopup', 'aria-expanded', 'aria-invalid', 'aria-required', 'aria-describedby', 'data-refused'].map(name => [name, button.getAttribute(name)]))
}

test('the trigger of a MultiSelect in a FormField is a combobox opening a dialog, taking aria-required and, once refused, aria-invalid and aria-describedby, with no data-refused', async () => {
  mounted = await mountComponent(MultiField, {})

  const { root } = mounted

  expect(trigger(root)).toMatchObject({ 'role': 'combobox', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-required': 'true', 'aria-invalid': null, 'data-refused': null })

  click(root.querySelector('#refuse'))
  await settle()

  expect(trigger(root)).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': root.querySelector('[data-part=issues]')!.id, 'data-refused': null })

  click(root.querySelector('#clear'))
  await settle()

  expect(trigger(root)['aria-invalid']).toBeNull()
})
