import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

let mounted: Mounted | undefined
const tabbed: string[] = []

afterEach(() => {
  mounted?.unmount()
  tabbed.length = 0
})

async function options() {
  mounted = await mountComponent('src/components/options.kay', { onTab: (value: string) => tabbed.push(value) })

  return mounted.root
}

test('every group keeps a disabled option from being picked', async () => {
  const root = await options()
  const disabled = (selector: string) => [...root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLOptionElement>(selector)].map(one => one.disabled)

  expect(disabled('#chips input')).toEqual([false, true, false])
  expect(disabled('#segmented input')).toEqual([false, true, false])
  expect(disabled('#multi input')).toEqual([false, true, false])
  expect(disabled('#select option')).toEqual([false, true, false])
  expect(disabled('#tabs [role="tab"]')).toEqual([false, true, false])
})

test('Segmented and Tabs draw an option\'s icon before its label, as ChipGroup does', async () => {
  const root = await options()

  for (const label of ['#chips .kui-chip-label', '#segmented .kui-segmented-label', '#tabs [role="tab"]']) {
    const first = root.querySelector(label)!

    expect([first.querySelectorAll('svg.kui-icon').length, first.textContent]).toEqual([1, 'Alpha'])
    expect(root.querySelectorAll(label)[2]!.querySelectorAll('svg').length).toBe(0)
  }
})

test('MultiSelect draws an option\'s icon before its label and leaves a disabled option as it is under All and None', async () => {
  const root = await options()
  const first = root.querySelector('#multi .kui-multi-select-option')!
  const box = (index: number) => root.querySelectorAll<HTMLInputElement>('#multi .kui-multi-select-checkbox')[index]!
  const [all, none] = root.querySelectorAll<HTMLButtonElement>('#multi .kui-multi-select-action')

  expect([first.querySelectorAll('svg.kui-icon').length, first.textContent]).toEqual([1, 'Alpha'])
  expect(root.querySelectorAll('#multi .kui-multi-select-option')[2]!.querySelectorAll('svg').length).toBe(0)

  all!.click()
  await Promise.resolve()

  expect([box(0).checked, box(1).checked, box(2).checked]).toEqual([true, true, true])
  expect(root.querySelector('.kui-multi-select-summary')?.textContent).toBe('3 selected')

  none!.click()
  await Promise.resolve()

  expect([box(0).checked, box(1).checked, box(2).checked]).toEqual([false, true, false])
})

test('the arrow keys of MultiSelect go past a disabled option, and a click on it picks nothing', async () => {
  const root = await options()
  const boxes = root.querySelectorAll<HTMLInputElement>('#multi .kui-multi-select-checkbox')

  root.querySelector<HTMLElement>('#multi')!.showPopover()
  await Promise.resolve()
  boxes[0]!.focus()
  boxes[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))

  expect(document.activeElement).toBe(boxes[2]!)

  boxes[1]!.click()
  await Promise.resolve()

  expect(boxes[1]!.checked).toBe(true)
  expect(root.querySelector('.kui-multi-select-summary')?.textContent).toBe('Beta')
})

test('the arrow keys of Tabs go past a disabled tab', async () => {
  const root = await options()
  const first = root.querySelector<HTMLElement>('#tabs [role="tab"]')!

  first.focus()
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))

  expect(tabbed).toEqual(['c'])
  expect(document.activeElement?.textContent).toBe('Gamma')

  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))

  expect(tabbed).toEqual(['c', 'a'])
})
