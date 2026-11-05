import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import NoValueMore from '../tests/fixture/src/components/no-value-more.kay'
import NoValue from '../tests/fixture/src/components/no-value.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const posted = (root: HTMLElement) => [...new FormData(root.querySelector('form')!).entries()].filter(([key]) => key !== 'heard').map(([key, value]) => `${key}=${value}`)

test('a control with no value starts on its first option, a number at its minimum, black, no stars and no chip', async () => {
  mounted = await mountComponent(NoValue, {})

  expect(posted(mounted.root)).toEqual(['pick=a', 'radio=b', 'slide=10', 'colour=#000000', 'seg=b'])
})

test('a pick is kept and posted under the name, and a form reset goes back to the start', async () => {
  mounted = await mountComponent(NoValue, {})

  const { root } = mounted
  const select = root.querySelector<HTMLSelectElement>('select')!

  select.value = 'c'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  click(root.querySelector('input[name="radio"][value="c"]'))
  click(root.querySelector('input[name="stars"][value="3"]'))
  click(root.querySelector('input[name="seg"][value="c"]'))
  click(root.querySelector('input[name="chips"][value="b"]'))

  const slide = root.querySelector<HTMLInputElement>('input[name="slide"]')!
  const colour = root.querySelector<HTMLInputElement>('input[name="colour"]')!

  slide.value = '30'
  slide.dispatchEvent(new Event('input', { bubbles: true }))
  slide.dispatchEvent(new Event('change', { bubbles: true }))
  colour.value = '#ff0000'
  colour.dispatchEvent(new Event('input', { bubbles: true }))
  colour.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()

  expect(posted(root)).toEqual(['pick=c', 'radio=c', 'slide=30', 'colour=#ff0000', 'stars=3', 'seg=c', 'chips=b'])
  expect(root.querySelector('[data-part=value]')!.textContent).toBe('30')

  click(root.querySelector('#reset'))
  await settle()

  expect(posted(root)).toEqual(['pick=a', 'radio=b', 'slide=10', 'colour=#000000', 'seg=b'])
  expect(root.querySelector('[data-part=value]')!.textContent).toBe('10')
})

test('a select with no value and a callback hears a reset only when the reset moved it', async () => {
  const heard: unknown[] = []

  mounted = await mountComponent(NoValue, { onPick: (value: string) => heard.push(value) })

  const { root } = mounted
  const select = root.querySelector<HTMLSelectElement>('select[name="heard"]')!

  click(root.querySelector('#reset'))
  await settle()
  expect(heard).toEqual([])

  select.value = 'c'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  click(root.querySelector('#reset'))
  await settle()
  expect(heard).toEqual(['c', 'a'])
})

async function more() {
  const heard: [string, unknown][] = []

  mounted?.unmount()
  mounted = await mountComponent(NoValueMore, { onHear: (what: string, value: unknown) => heard.push([what, value]) })
  await settle()

  return { root: mounted.root, heard }
}

const checkedIn = (root: Element, id: string) => [...root.querySelectorAll<HTMLInputElement>(`#${id} input:checked`)].map(input => input.value)

test('a null value starts a radio group with none picked', async () => {
  const { root } = await more()

  expect(checkedIn(root, 'none')).toEqual([])
})

test('a control that gets a value after living without one follows it over its own pick', async () => {
  const { root } = await more()
  const select = root.querySelector<HTMLSelectElement>('#switching')!

  click(root.querySelector('#switching-radios input[value="b"]'))
  select.value = 'b'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  click(root.querySelector('#hold'))
  await settle()

  expect([select.value, checkedIn(root, 'switching-radios')]).toEqual(['c', ['c']])
})

test('a select with async options starts on its first option once they arrive, and a reset then changes nothing', async () => {
  const { root, heard } = await more()
  const select = root.querySelector<HTMLSelectElement>('#async')!

  expect(select.value).toBe('a')
  click(root.querySelector('#reset'))
  await settle()
  expect(heard.filter(([what]) => what === 'async')).toEqual([])
})

test('a refused move of a select without a value puts back the last pick that was accepted', async () => {
  const { root } = await more()
  const select = root.querySelector<HTMLSelectElement>('#refused')!

  select.value = 'b'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  select.value = 'c'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()

  expect(select.value).toBe('a')
})

test('a rating and a chip group without a value tell onChange of a reset to none', async () => {
  const { root, heard } = await more()

  click(root.querySelector('#stars input[value="3"]'))
  click(root.querySelector('#chips input[value="b"]'))
  await settle()
  click(root.querySelector('#reset'))
  await settle()

  expect(heard.filter(([what]) => what === 'stars' || what === 'chips')).toEqual([['stars', 3], ['chips', ['b']], ['stars', null], ['chips', []]])
})
