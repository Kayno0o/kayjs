import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ChoiceSources from '../tests/fixture/src/components/choice-sources.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function mount() {
  const calls: string[] = []

  mounted = await mountComponent(ChoiceSources, { calls })

  const root = mounted.root

  return {
    root,
    calls,
    show: () => click(root.querySelector('#show')),
    hide: () => click(root.querySelector('#hide')),
    answer: () => click(root.querySelector('#answer')),
    refuse: () => click(root.querySelector('#refuse')),
    status: () => root.querySelector('#box [data-part=empty]')?.textContent,
    labels: () => [...root.querySelectorAll('#box [data-part=option] [data-part=label]')].map(one => one.textContent),
    trigger: () => root.querySelector('#box [data-part=trigger]')?.getAttribute('aria-label'),
  }
}

test('a MultiSelect given a function asks when it opens, says loading, then lists the answer and keeps the label of a value it never listed', async () => {
  const { calls, show, answer, status, labels, trigger } = await mount()

  expect(trigger()).toBe('People: Ada')

  show()
  await settle()
  expect(status()).toBe('Loading…')
  expect(calls).toEqual(['ask '])

  answer()
  await settle()
  expect(labels()).toEqual(['Bob', 'Cy'])
  expect(status()).toBe('')
})

test('a MultiSelect keeps the labels of what it picked from an answer a later search no longer lists', async () => {
  const { root, calls, show, answer, labels, trigger } = await mount()

  show()
  await settle()
  answer()
  await settle()
  click(root.querySelector('#box [data-part=checkbox]'))
  await settle()
  expect(calls).toContain('picked ada,bob')
  expect(trigger()).toBe('People: 2 selected')

  const search = root.querySelector<HTMLInputElement>('#box [data-part=search]')!

  search.value = 'cy'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 260))
  await settle()
  expect(calls.at(-1)).toBe('ask cy')
  answer()
  await settle()
  expect(labels()).toEqual(['Bob', 'Cy'])
  expect(root.querySelector('#box [data-part=trigger]')?.getAttribute('aria-description')).toBe('Ada, Bob')
})

test('a MultiSelect says so when its function rejects', async () => {
  const { show, refuse, status } = await mount()

  show()
  await settle()
  refuse()
  await settle()
  expect(status()).toBe('Could not load the options')
})

test('a Select given a function is busy until the answer lists its options, the value kept', async () => {
  const { root } = await mount()

  await settle()

  const select = root.querySelector<HTMLSelectElement>('#sizes')!

  expect([...select.options].map(one => one.textContent)).toEqual(['Small', 'Large'])
  expect(select.hasAttribute('aria-busy')).toBe(false)
  expect(select.value).toBe('l')
})

test('an IconPicker given a list filters it by the text typed and needs no search', async () => {
  const { root, calls } = await mount()

  await settle()

  const names = () => [...root.querySelectorAll('#icons [data-part=option]')].map(one => one.getAttribute('aria-label'))

  expect(names()).toEqual(['home', 'search', 'user'])

  const search = root.querySelector<HTMLInputElement>('#icons [data-part=search]')!

  search.value = 'us'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 260))
  await settle()
  expect(names()).toEqual(['user'])
  click(root.querySelector('#icons [data-part=option]'))
  expect(calls).toEqual(['icon tabler:user'])
})

test('a RadioGroup drawing its options with a snippet still picks, and each input keeps the option\'s label as its name', async () => {
  const { root, calls } = await mount()

  await settle()

  const inputs = [...root.querySelectorAll<HTMLInputElement>('#plans input')]

  expect(inputs.map(input => input.getAttribute('aria-label'))).toEqual(['Free', 'Pro'])
  expect(root.querySelectorAll('#plans .title')).toHaveLength(2)
  click(inputs[1]!)
  await settle()
  expect(calls).toContain('plan pro')
  expect(inputs[1]!.checked).toBe(true)
})
