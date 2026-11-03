import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import FieldStates from '../tests/fixture/src/components/field-states.kay'
import InvalidToggle from '../tests/fixture/src/components/invalid-toggle.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

const CONTROLS = ['text', 'area', 'select', 'combobox', 'multi', 'date', 'time', 'datetime', 'dates', 'range', 'slider']

async function boxes(id: string, attribute: string) {
  mounted ??= await mountComponent(FieldStates, {})

  return [...mounted.root.querySelectorAll(`#${id} [${attribute}]`)].map(box => box.getAttribute(attribute))
}

test('every control takes a size, written as data-size on its box and left off the default', async () => {
  for (const id of CONTROLS)
    expect((await boxes(id, 'data-size')).length, id).toBeGreaterThan(0)

  for (const id of CONTROLS)
    expect(new Set(await boxes(id, 'data-size')), id).toEqual(new Set(['lg']))

  expect(await boxes('plain', 'data-size')).toEqual([])
})

test('every control takes invalid, written as aria-invalid on its box, data-refused on the trigger of a MultiSelect', async () => {
  for (const id of CONTROLS.filter(id => id !== 'multi'))
    expect(new Set(await boxes(id, 'aria-invalid')), id).toEqual(new Set(['true']))

  expect(await boxes('multi', 'data-refused')).toEqual(['true'])
  expect(await boxes('plain', 'aria-invalid')).toEqual([])
})

test('invalid is held with a FormField message, which keeps the box invalid once invalid goes false', async () => {
  mounted = await mountComponent(InvalidToggle, {})

  const box = mounted.root.querySelector('input')!

  expect(box.getAttribute('aria-invalid')).toBe('true')

  click(mounted.root.querySelector('#say'))
  await settle()
  click(mounted.root.querySelector('#flip'))
  await settle()

  expect(box.getAttribute('aria-invalid')).toBe('true')

  click(mounted.root.querySelector('#say'))
  await settle()

  expect(box.getAttribute('aria-invalid')).toBeNull()

  click(mounted.root.querySelector('#flip'))
  await settle()

  expect(box.getAttribute('aria-invalid')).toBe('true')
})
