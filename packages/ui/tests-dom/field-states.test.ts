import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import FieldStates from '../tests/fixture/src/components/field-states.kay'

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

test('every control takes invalid, written as aria-invalid on its box', async () => {
  for (const id of CONTROLS)
    expect(new Set(await boxes(id, 'aria-invalid')), id).toEqual(new Set(['true']))

  expect(await boxes('plain', 'aria-invalid')).toEqual([])
})
