import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(onInput?: (value: number) => void) {
  mounted = await mountComponent('src/components/slider.kay', { onInput })

  const root = mounted.root
  const input = root.querySelector<HTMLInputElement>('input[name="delay"]')!
  const shown = () => root.querySelector('#delay')?.closest('.kui-slider')?.querySelector('.kui-slider-value')?.textContent
  const drag = async (value: string) => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  return { root, input, shown, drag }
}

test('draws a native range input named by its label, holding the value and the bounds', async () => {
  const { input, root } = await open()

  expect([input.type, input.min, input.max, input.step, input.value, input.getAttribute('aria-label')]).toEqual(['range', '0', '100', '10', '40', 'Delay'])
  expect(root.querySelector('#delay')?.closest('.kui-slider')?.querySelector('.kui-slider-label')?.textContent).toBe('Delay')
})

test('shows the value through formatValue, and without it as the bare number', async () => {
  const { shown, root } = await open()

  expect(shown()).toBe('40 ms')
  expect(root.querySelector('#quiet')?.closest('.kui-slider')?.querySelector('.kui-slider-value')).toBeNull()
  expect(root.querySelector('#quiet')?.getAttribute('aria-valuetext')).toBeNull()
})

test('tells onInput the number while dragging and the shown value follows', async () => {
  const told: number[] = []
  const { drag, shown, root } = await open(value => told.push(value))

  await drag('70')

  expect([told, shown(), root.querySelector('#state')?.textContent]).toEqual([[70], '70 ms', '70'])
  expect(root.querySelector('#delay')?.getAttribute('aria-valuetext')).toBe('70 ms')
})

test('follows a value its parent sets', async () => {
  const { input, shown, root } = await open()

  click(root.querySelector('#set'))
  await settle()

  expect([input.value, shown()]).toEqual(['80', '80 ms'])
})

test('posts under its name in a plain form and goes back to its start on a reset', async () => {
  const { drag, root, shown } = await open()
  const form = root.querySelector<HTMLFormElement>('#form')!

  await drag('20')

  expect(new FormData(form).get('delay')).toBe('20')

  click(root.querySelector('#reset'))
  await new Promise(resolve => setTimeout(resolve, 30))
  await settle()

  expect([new FormData(form).get('delay'), shown()]).toEqual(['40', '40 ms'])
})
