import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function mount(props: { onDays?: (days: number[]) => unknown, disabled?: boolean } = {}) {
  mounted = await mountComponent('src/components/group-values.kay', { onDays: () => undefined, ...props })

  return mounted.root
}

const states = (root: HTMLElement, selector: string) => [...root.querySelectorAll<HTMLInputElement>(selector)].map(box => box.disabled)
const ticked = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>('#days input')].map(box => box.checked)
const box = (root: HTMLElement, value: number) => root.querySelector<HTMLInputElement>(`#days input[value="${value}"]`)!

test('a ChipGroup over numbers answers numbers, in the order of its options', async () => {
  const heard: number[][] = []
  const root = await mount({ onDays: days => heard.push(days) })

  click(box(root, 2))
  click(box(root, 0))

  expect(heard).toEqual([[0, 2], [2]])
})

test('a ChipGroup over numbers starts with its numbers ticked', async () => {
  const root = await mount()

  expect(ticked(root)).toEqual([true, false, false])
})

test('a ChipGroup over numbers puts a refused pick back, a 0 included', async () => {
  const root = await mount({ onDays: async () => false })

  click(box(root, 0))
  await settle()

  expect(ticked(root)).toEqual([true, false, false])
})

test('a form reset puts a ChipGroup over numbers back on its start and tells the app', async () => {
  const heard: number[][] = []
  const root = await mount({ onDays: days => heard.push(days) })

  click(box(root, 0))
  click(box(root, 2))
  expect(ticked(root)).toEqual([false, false, true])

  click(root.querySelector('#reset'))
  await settle()

  expect(ticked(root)).toEqual([true, false, false])
  expect(heard.at(-1)).toEqual([0])
})

test('disabled on a group disables every option, and an option\'s own disabled applies without it', async () => {
  const root = await mount()

  for (const group of ['#one', '#all', '#radios'])
    expect(states(root, `${group} input`)).toEqual([false, true, false])

  mounted?.unmount()

  const all = await mount({ disabled: true })

  for (const group of ['#one', '#all', '#radios'])
    expect(states(all, `${group} input`)).toEqual([true, true, true])
})

test('a click on a chip of a disabled group ticks nothing', async () => {
  const root = await mount({ disabled: true })
  const chip = root.querySelector<HTMLInputElement>('#all input[value="2"]')!

  click(chip)
  await settle()

  expect(chip.checked).toBe(false)
})
