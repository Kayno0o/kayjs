import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Payloads from '../tests/fixture/src/components/payloads.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

type Calls = Record<'onMoved' | 'onSelect' | 'onSegment' | 'onChips' | 'onMulti' | 'onIcon', unknown[][]> & Record<'onTimeInput' | 'onRequiredInput' | 'onDateInput', string[]>

async function open(answers: Partial<Record<'onMoved' | 'onSelect' | 'onSegment', unknown>> = {}) {
  const calls: Calls = { onMoved: [], onSelect: [], onSegment: [], onChips: [], onMulti: [], onIcon: [], onTimeInput: [], onRequiredInput: [], onDateInput: [] }
  const record = (name: 'onMoved' | 'onSelect' | 'onSegment' | 'onChips' | 'onMulti' | 'onIcon') => (...args: unknown[]) => {
    calls[name].push(args)

    return answers[name as 'onMoved' | 'onSelect' | 'onSegment']
  }

  mounted = await mountComponent(Payloads, {
    onMoved: record('onMoved'),
    onSelect: record('onSelect'),
    onSegment: record('onSegment'),
    onChips: record('onChips'),
    onMulti: record('onMulti'),
    onIcon: record('onIcon'),
    onTimeInput: (value: string) => calls.onTimeInput.push(value),
    onRequiredInput: (value: string) => calls.onRequiredInput.push(value),
    onDateInput: (value: string) => calls.onDateInput.push(value),
  })
  await settle()

  return { root: mounted.root, calls }
}

function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('Select passes the option, and undefined for the empty one', async () => {
  const { root, calls } = await open()
  const select = root.querySelector<HTMLSelectElement>('#select')!

  for (const value of ['b', '']) {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  await settle()

  expect(calls.onSelect).toEqual([['b', { value: 'b', label: 'Beta' }], ['', undefined]])
})

test('Segmented with a param passes the option to a refusing onChange, and goes back', async () => {
  const { root, calls } = await open({ onSegment: false })

  click(root.querySelector('#segmented input[value="b"]'))
  await settle()

  expect(calls.onSegment).toEqual([['b', expect.objectContaining({ value: 'b', label: 'Beta' })]])
  expect(root.querySelector<HTMLInputElement>('#segmented input[value="a"]')!.checked).toBe(true)
})

test('a Select with a param and no value passes the option to a refusing onChange, and goes back to its accepted pick', async () => {
  const { root, calls } = await open({ onMoved: false })
  const select = root.querySelector<HTMLSelectElement>('#moved')!

  select.value = 'b'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()

  expect(calls.onMoved).toEqual([['b', { value: 'b', label: 'Beta' }]])
  expect(select.value).toBe('a')
})

test('ChipGroup passes the picked options in order', async () => {
  const { root, calls } = await open()

  click(root.querySelector('#chips input[value="b"]'))
  click(root.querySelector('#chips input[value="a"]'))
  await settle()

  expect(calls.onChips.map(args => (args[1] as { value: string }[]).map(option => option.value))).toEqual([['b'], ['a', 'b']])
})

test('MultiSelect lines options up with values, a never loaded one standing in as itself', async () => {
  const { root, calls } = await open()

  click(root.querySelector('#multi [data-part=option] input[type=checkbox]'))
  await settle()

  const [values, options] = calls.onMulti[0] as [string[], { value: string, label: string }[]]

  expect(options.map(option => option.value)).toEqual(values)
  expect(options.find(option => option.value === 'ghost')).toEqual({ value: 'ghost', label: 'ghost' })
})

test('IconPicker passes the choice, and undefined once cleared', async () => {
  const { root, calls } = await open()

  click(root.querySelector('#icon [data-part=icons] button, #icon [role=listbox] button, #icon button[aria-label*="home" i]'))
  await settle()
  click(root.querySelector('#icon [data-part=clear]'))
  await settle()

  expect(calls.onIcon).toEqual([['tabler:home', expect.objectContaining({ name: 'tabler:home' })], ['', undefined]])
})

test('TimeInput onInput hears every edit, empty ones too, and a required box hears the empty edit as well', async () => {
  const { root, calls } = await open()
  const time = root.querySelector<HTMLInputElement>('#time')!
  const required = root.querySelector<HTMLInputElement>('#required')!

  type(time, '08:30')
  type(time, '')
  type(required, '')
  await settle()

  expect([calls.onTimeInput, calls.onRequiredInput]).toEqual([['08:30', ''], ['']])
})

test('DateInput onInput hears a date and its emptying', async () => {
  const { root, calls } = await open()
  const date = root.querySelector<HTMLInputElement>('#date')!

  type(date, '2026-12-01')
  type(date, '')
  await settle()

  expect(calls.onDateInput).toEqual(['2026-12-01', ''])
})
