import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import DatesClosed from '../tests/fixture/src/components/dates-closed.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

// 2026-10-21 is a Wednesday: the 22nd is closed, and so are the 24th and 25th, the weekend.
const CLOSED = new Set(['2026-10-22', '2026-10-24', '2026-10-25', '2026-10-30'])

async function booking() {
  const dates: string[] = []
  const months: string[] = []

  mounted = await mountComponent(DatesClosed, { closed: CLOSED, months, onDate: (value: string) => dates.push(value) })
  await settle()

  return { root: mounted.root, dates, months }
}

const calendar = (root: HTMLElement, field = '#date') => root.querySelector(field)!.closest('.kui-date-input')!
const day = (root: HTMLElement, iso: string, field = '#date') => calendar(root, field).querySelector<HTMLButtonElement>(`[data-day="${iso}"]`)!
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.day

async function open(root: HTMLElement, field = '#date') {
  calendar(root, field).querySelector<HTMLElement>('[data-part=panel]')!.showPopover()
  await settle()
}

async function press(name: string) {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  await settle()
}

test('a closed day is a disabled button that a click does not pick', async () => {
  const { root, dates } = await booking()

  await open(root)
  expect(day(root, '2026-10-22').disabled).toBe(true)
  day(root, '2026-10-22').click()
  await settle()
  expect([dates, root.querySelector<HTMLInputElement>('#date')!.value]).toEqual([[], '2026-10-21'])

  click(day(root, '2026-10-23'))
  await settle()
  expect(dates).toEqual(['2026-10-23'])
})

test('the arrow keys skip closed days, a week at a time too', async () => {
  const { root } = await booking()

  await open(root)
  await press('ArrowRight')
  expect(focused()).toBe('2026-10-23')
  await press('ArrowRight')
  expect(focused()).toBe('2026-10-26')
  await press('ArrowLeft')
  expect(focused()).toBe('2026-10-23')
  await press('ArrowDown')
  expect(focused()).toBe('2026-11-06')
})

test('a typed closed date is flagged invalid and not reported, an open one commits again', async () => {
  const { root, dates } = await booking()
  const input = root.querySelector<HTMLInputElement>('#date')!
  const type = async (value: string) => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }

  await type('2026-10-24')
  expect([dates, input.validity.customError, input.validationMessage]).toEqual([[], true, 'This date is not available'])

  await type('2026-10-26')
  expect([dates, input.validity.customError]).toEqual([['2026-10-26'], false])
})

test('the day block draws the inside of the button, keeping its label and selection', async () => {
  const { root } = await booking()

  await open(root)

  const open21 = day(root, '2026-10-21')

  expect([open21.querySelector('.price')?.textContent, open21.textContent, open21.getAttribute('aria-label')?.includes('21')]).toEqual(['50', '2150', true])
  expect(day(root, '2026-10-22').querySelector('.price')).toBeNull()
  expect(open21.querySelector('.price')?.hasAttribute('data-selected')).toBe(true)
})

test('onMonthChange tells the month on opening and on each move, a range with its box', async () => {
  const { root, months } = await booking()

  await open(root)
  expect(months).toEqual(['2026-10'])
  await press('PageDown')
  await press('PageDown')
  expect(months).toEqual(['2026-10', '2026-11', '2026-12'])

  months.length = 0
  await open(root, '#range input[name="to"]')
  expect(months.length > 0 && months.every(entry => entry.startsWith('to:'))).toBe(true)
})
