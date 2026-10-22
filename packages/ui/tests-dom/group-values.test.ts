import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
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

test('a ChipGroup over numbers answers numbers, in the order of its options', async () => {
  const heard: number[][] = []
  const root = await mount({ onDays: days => heard.push(days) })

  click(root.querySelector<HTMLInputElement>('#days input[value="2"]'))
  click(root.querySelector<HTMLInputElement>('#days input[value="0"]'))

  expect(heard).toEqual([[0, 2], [2]])
})

test('a ChipGroup over numbers starts with its numbers ticked', async () => {
  const root = await mount()

  expect([...root.querySelectorAll<HTMLInputElement>('#days input')].map(box => box.checked)).toEqual([true, false, false])
})

test('disabled on a group disables every option, and an option\'s own disabled applies without it', async () => {
  const root = await mount()

  expect(states(root, '#one input')).toEqual([false, true, false])
  expect(states(root, '#all input')).toEqual([false, true, false])
  mounted?.unmount()

  const all = await mount({ disabled: true })

  expect(states(all, '#one input')).toEqual([true, true, true])
  expect(states(all, '#all input')).toEqual([true, true, true])
})
