import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import InputProps from '../tests/fixture/src/components/input-props.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a control with an input in a wrapper puts id, title and data-* on the wrapper and inputProps on the input', async () => {
  mounted = await mountComponent(InputProps, {})

  for (const kind of ['toggle', 'checkbox', 'slider', 'colour', 'combobox', 'date']) {
    const wrapper = mounted.root.querySelector<HTMLElement>(`[data-kind="${kind}"]`)!
    const input = mounted.root.querySelector<HTMLInputElement>(`#${kind}-input`)!

    expect(wrapper.title, kind).toBe('wrapper')
    expect(wrapper.querySelector('input'), kind).toBe(input)
    expect(input.dataset.input, kind).toBe(kind)
    expect(input.getAttribute('data-kind'), kind).toBeNull()
    expect(input.getAttribute('title'), kind).toBeNull()
  }
})

test('the state of a control stays on its input', async () => {
  mounted = await mountComponent(InputProps, {})

  expect(mounted.root.querySelector<HTMLInputElement>('#toggle-input')!.disabled).toBe(true)
  expect(mounted.root.querySelector<HTMLInputElement>('#checkbox-input')!.required).toBe(true)
  expect(mounted.root.querySelector<HTMLInputElement>('#slider-input')!.name).toBe('slider')
})
