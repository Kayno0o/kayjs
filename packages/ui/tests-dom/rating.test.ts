import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import RatingPicker from '../tests/fixture/src/components/rating-picker.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

const radios = (root: Element, id: string) => [...root.querySelectorAll<HTMLInputElement>(`#${id} input`)]
const lit = (root: Element, id: string) => [...root.querySelectorAll(`#${id} [data-part="star"]`)].map(star => star.hasAttribute('data-on'))

test('a Rating without onChange or name is the image it was, whatever icon it draws', async () => {
  mounted = await mountComponent(RatingPicker, { heard: [] })

  const shown = mounted.root.querySelector('#shown')!

  expect([shown.getAttribute('role'), shown.getAttribute('aria-label'), shown.querySelectorAll('input').length, shown.querySelectorAll('svg').length]).toEqual(['img', 'Rated 4.6 out of 5', 0, 10])
})

test('a Rating with onChange is a radio group of its stars, lit up to the value and picked by a click', async () => {
  const heard: unknown[] = []

  mounted = await mountComponent(RatingPicker, { heard })

  const root = mounted.root.querySelector('#picked')!

  expect([root.getAttribute('role'), radios(mounted.root, 'picked').length, radios(mounted.root, 'picked').findIndex(radio => radio.checked)]).toEqual(['radiogroup', 5, 2])
  expect(lit(mounted.root, 'picked')).toEqual([true, true, true, false, false])

  click(radios(mounted.root, 'picked')[4]!)
  await settle()
  expect([heard, lit(mounted.root, 'picked')]).toEqual([[5], [true, true, true, true, true]])
})

test('clicking the star already picked clears the rating with allowClear', async () => {
  const heard: unknown[] = []

  mounted = await mountComponent(RatingPicker, { heard })
  click(radios(mounted.root, 'picked')[2]!)
  await settle()
  expect([heard, radios(mounted.root, 'picked').some(radio => radio.checked), lit(mounted.root, 'picked')]).toEqual([[null], false, [false, false, false, false, false]])
})

test('a refused onChange puts the previous rating back', async () => {
  const heard: unknown[] = []

  mounted = await mountComponent(RatingPicker, { heard, refuse: true })
  click(radios(mounted.root, 'picked')[0]!)
  await settle()
  expect([heard, radios(mounted.root, 'picked').findIndex(radio => radio.checked)]).toEqual([[1], 2])
})

test('the radios post under the name, take the icon given, and a form reset goes back to the start', async () => {
  const heard: unknown[] = []

  mounted = await mountComponent(RatingPicker, { heard })

  const form = mounted.root.querySelector<HTMLFormElement>('#form')!

  click(radios(mounted.root, 'hearts')[1]!)
  click(radios(mounted.root, 'picked')[0]!)
  await settle()
  expect([...new FormData(form)]).toEqual([['stars', '1'], ['hearts', '2']])
  expect(mounted.root.querySelectorAll('#hearts svg').length).toBe(3)

  form.reset()
  await settle()
  expect([...new FormData(form)]).toEqual([['stars', '3']])
  expect(heard).toEqual([1, 3])
})
