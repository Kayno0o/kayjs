import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
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
