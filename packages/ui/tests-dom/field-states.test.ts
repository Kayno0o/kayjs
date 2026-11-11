import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import CheckboxIssue from '../tests/fixture/src/components/checkbox-issue.kay'
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

test('every control takes invalid, written as aria-invalid on its box, the trigger of a MultiSelect included', async () => {
  for (const id of CONTROLS)
    expect(new Set(await boxes(id, 'aria-invalid')), id).toEqual(new Set(['true']))

  expect(await boxes('multi', 'data-refused')).toEqual([])
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

test('every group and box control takes invalid as well, written as aria-invalid on the radiogroup or the box and data-invalid on a plain group', async () => {
  for (const id of ['radios', 'segmented', 'rating'])
    expect(await boxes(id, 'aria-invalid'), id).toEqual(['true'])

  for (const id of ['chips', 'drop', 'rows'])
    expect(await boxes(id, 'data-invalid'), id).toEqual([''])

  expect(new Set(await boxes('rows', 'aria-invalid'))).toEqual(new Set(['true']))

  for (const id of ['color', 'box', 'switch', 'markdown', 'icons'])
    expect(await boxes(id, 'aria-invalid'), id).toEqual(['true'])
})

test('a Checkbox and a Toggle show the issue they are given under the box and mark it invalid, linked by aria-describedby', async () => {
  for (const [id, text] of [['boxmsg', 'Tick it'], ['switchmsg', 'Switch it']] as const) {
    expect((await boxes(id, 'data-part')).includes('issue'), id).toBe(true)

    const root = mounted!.root.querySelector(`#${id}`)!
    const input = root.querySelector('input')!

    expect(root.querySelector('[data-part=issue]')?.textContent, id).toBe(text)
    expect(input.getAttribute('aria-invalid'), id).toBe('true')
    expect(input.getAttribute('aria-describedby'), id).toBe(root.querySelector('[data-part=issues]')!.id)
  }
})

test('every refused control draws a danger look: the stylesheet field class, or a class answering aria-invalid with the danger colour', async () => {
  mounted ??= await mountComponent(FieldStates, {})

  for (const id of [...CONTROLS, 'radios', 'segmented', 'chips', 'rating', 'color', 'drop', 'box', 'switch', 'rows', 'markdown', 'icons']) {
    const classes = [...mounted.root.querySelectorAll(`#${id} [class]`)].map(element => element.getAttribute('class')).join(' ')

    expect(classes, id).toMatch(/kui-field-input|(?:aria-invalid|has-\[input\[aria-invalid)[^ ]*danger|danger[^ ]*aria-invalid/)
  }
})

test('a disabled IconPicker disables its search box and icons, and a refused one stays enabled', async () => {
  mounted ??= await mountComponent(FieldStates, {})

  const off = [...mounted.root.querySelectorAll('#iconsoff input, #iconsoff button')] as HTMLInputElement[]

  expect(off.length).toBeGreaterThan(0)
  expect(off.every(element => element.disabled)).toBe(true)
  expect((mounted.root.querySelector('#icons input.kui-field-input') as HTMLInputElement).disabled).toBe(false)
})

test('an issue arriving after the island started shows under a Checkbox and a Toggle declaring none at first', async () => {
  mounted = await mountComponent(CheckboxIssue, {})

  expect(mounted.root.querySelector('#box [data-part=issue]')).toBeNull()

  click(mounted.root.querySelector('#say'))
  await settle()

  for (const id of ['box', 'switch']) {
    expect(mounted.root.querySelector(`#${id} [data-part=issue]`)?.textContent, id).toBe('Tick it')
    expect(mounted.root.querySelector(`#${id} input`)?.getAttribute('aria-invalid'), id).toBe('true')
  }
})

test('a FormField of the same name around a Checkbox shows the message once', async () => {
  mounted = await mountComponent(CheckboxIssue, {})

  expect(mounted.root.querySelectorAll('#wrapped [data-part=issue]').length).toBe(1)
})

test('a Checkbox declaring a name follows its parent for checked, label, hint, indeterminate and invalid', async () => {
  mounted = await mountComponent(CheckboxIssue, {})

  const input = mounted.root.querySelector('#live input') as HTMLInputElement

  expect(mounted.root.querySelector('#live [data-part=label]')?.textContent).toBe('Before')

  click(mounted.root.querySelector('#flip'))
  await settle()

  expect(input.checked).toBe(true)
  expect(input.indeterminate).toBe(true)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(mounted.root.querySelector('#live [data-part=label]')?.textContent).toBe('Changed')
  expect(mounted.root.querySelector('#live [data-part=hint]')?.textContent).toBe('Changed')
})
