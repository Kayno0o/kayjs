import type { Mounted } from 'kay/test'
import type { DateRange } from '../src/date'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

let mounted: Mounted | undefined
const seen: { date: string[], range: DateRange[], time: string[] } = { date: [], range: [], time: [] }

afterEach(() => {
  mounted?.unmount()
  seen.date = []
  seen.range = []
  seen.time = []
})

async function dates(props: Record<string, unknown> = {}) {
  mounted = await mountComponent('src/components/dates.kay', {
    onDate: (value: string) => seen.date.push(value),
    onRange: (value: DateRange) => seen.range.push(value),
    onTime: (value: string) => seen.time.push(value),
    firstDay: 1,
    ...props,
  })
  await settle()

  return mounted.root
}

function key(element: Element | null, name: string, shiftKey = false) {
  element!.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }))
}

// The calendar of the `#date` field: its panel is the popover right after the field's trigger.
const calendar = (root: HTMLElement, field = '#date') => root.querySelector(field)!.closest('.kui-date-input')!

async function open(root: HTMLElement, field = '#date') {
  calendar(root, field).querySelector<HTMLElement>('.kui-date-input-panel')!.showPopover()
  await settle()
}

const day = (root: HTMLElement, iso: string, field = '#date') => calendar(root, field).querySelector<HTMLButtonElement>(`[data-day="${iso}"]`)!
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.day

describe('DateInput', () => {
  test('is a native date field first, and adds the calendar button once it runs', async () => {
    const root = await dates({ min: '2026-10-05', max: '2026-11-20' })
    const input = root.querySelector<HTMLInputElement>('#date')!

    expect(input.type).toBe('date')
    expect(input.name).toBe('day')
    expect(input.value).toBe('2026-10-21')
    expect(input.min).toBe('2026-10-05')
    expect(calendar(root).querySelector('.kui-date-input-trigger')?.getAttribute('aria-label')).toBe('Choose a date')
  })

  test('opens on the chosen day, in a grid of its month with the weeks starting where firstDay says', async () => {
    const root = await dates()

    await open(root)

    const cell = day(root, '2026-10-21')

    expect(cell.closest('[role="gridcell"]')?.getAttribute('aria-selected')).toBe('true')
    expect(focused()).toBe('2026-10-21')
    expect(calendar(root).querySelector('.kui-date-input-title')?.textContent).toMatch(/2026/)
    expect([...calendar(root).querySelectorAll('thead th')].map(head => head.getAttribute('abbr'))[0]).toBe('Monday')
    expect(calendar(root).querySelectorAll('tbody tr')).toHaveLength(5)
    expect(calendar(root).querySelector('tbody tr td button')?.getAttribute('data-day')).toBe('2026-09-28')
  })

  test('starts its weeks on Sunday when asked', async () => {
    const root = await dates({ firstDay: 0 })

    await open(root)

    expect(calendar(root).querySelector('thead th')?.getAttribute('abbr')).toBe('Sunday')
    expect(calendar(root).querySelector('tbody tr td button')?.getAttribute('data-day')).toBe('2026-09-27')
  })

  test('a click on a day writes it into the field, tells onChange once and closes', async () => {
    const root = await dates()
    const panel = calendar(root).querySelector<HTMLElement>('.kui-date-input-panel')!

    await open(root)
    day(root, '2026-10-03').click()
    await settle()

    expect(root.querySelector<HTMLInputElement>('#date')!.value).toBe('2026-10-03')
    expect(seen.date).toEqual(['2026-10-03'])
    expect(panel.matches(':popover-open')).toBe(false)
  })

  test('the arrows move by day and week, Home and End to the week ends, PageUp and PageDown by month', async () => {
    const root = await dates()

    await open(root)

    const press = async (name: string, shift = false) => {
      key(document.activeElement, name, shift)
      await settle()
    }

    await press('ArrowRight')
    expect(focused()).toBe('2026-10-22')
    await press('ArrowDown')
    expect(focused()).toBe('2026-10-29')
    await press('ArrowLeft')
    await press('ArrowUp')
    expect(focused()).toBe('2026-10-21')
    await press('Home')
    expect(focused()).toBe('2026-10-19')
    await press('End')
    expect(focused()).toBe('2026-10-25')
    await press('PageDown')
    expect(focused()).toBe('2026-11-25')
    expect(calendar(root).querySelector('.kui-date-input-title')?.textContent).toMatch(/2026/)
    await press('PageUp', true)
    expect(focused()).toBe('2025-11-25')
    await press('ArrowRight')
    await press('Enter')
  })

  test('days outside min and max cannot be picked or reached', async () => {
    const root = await dates({ min: '2026-10-20', max: '2026-10-22' })

    await open(root)

    expect(day(root, '2026-10-19').disabled).toBe(true)
    expect(day(root, '2026-10-20').disabled).toBe(false)

    key(document.activeElement, 'ArrowDown')
    await settle()

    expect(focused()).toBe('2026-10-22')
    expect(calendar(root).querySelectorAll<HTMLButtonElement>('.kui-date-input-step')[0]!.disabled).toBe(true)
    expect(calendar(root).querySelectorAll<HTMLButtonElement>('.kui-date-input-step')[1]!.disabled).toBe(true)
  })

  test('the month buttons and Today move and pick', async () => {
    const root = await dates()

    await open(root)
    calendar(root).querySelectorAll<HTMLButtonElement>('.kui-date-input-step')[1]!.click()
    await settle()

    expect(day(root, '2026-11-21')).not.toBeNull()

    calendar(root).querySelector<HTMLButtonElement>('.kui-date-input-today')!.click()
    await settle()

    expect(seen.date).toHaveLength(1)
    expect(root.querySelector<HTMLInputElement>('#date')!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('a typed date reaches onChange, and a form reset puts the first back', async () => {
    const root = await dates()
    const input = root.querySelector<HTMLInputElement>('#date')!

    input.value = '2026-12-01'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('#reset')!.click()
    await settle()
    await new Promise(done => setTimeout(done, 20))

    expect(seen.date).toEqual(['2026-12-01', '2026-10-21'])
    expect(input.value).toBe('2026-10-21')
  })

  test('a plain one keeps what is picked for a form to post', async () => {
    const root = await dates()

    await open(root, '#plain')
    calendar(root, '#plain').querySelector<HTMLButtonElement>('tbody button:not([disabled])')!.click()
    await settle()

    expect(new FormData(root.querySelector('form')!).get('plain')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('DateRangeInput', () => {
  test('two fields named for the pair, posting their own dates', async () => {
    const root = await dates()
    const group = root.querySelector('[role="group"]')!
    const [from, to] = group.querySelectorAll<HTMLInputElement>('input[type="date"]')

    expect(group.getAttribute('aria-label')).toBe('Stay')
    expect([from!.getAttribute('aria-label'), to!.getAttribute('aria-label')]).toEqual(['Stay from', 'Stay to'])
    expect([from!.name, to!.name]).toEqual(['from', 'to'])
  })

  test('tells the pair in order, and only when it changed', async () => {
    const root = await dates()
    const [from, to] = root.querySelectorAll<HTMLInputElement>('[role="group"] input[type="date"]')
    const set = (input: HTMLInputElement, value: string) => {
      input.value = value
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }

    set(to!, '2026-10-10')
    set(from!, '2026-10-20')
    await settle()

    expect(seen.range).toEqual([[null, '2026-10-10'], ['2026-10-10', '2026-10-20']])
    expect([from!.value, to!.value]).toEqual(['2026-10-10', '2026-10-20'])

    set(to!, '2026-10-20')

    expect(seen.range).toHaveLength(2)

    set(from!, '')

    expect(seen.range.at(-1)).toEqual([null, '2026-10-20'])
  })
})

describe('TimeInput', () => {
  test('is a native time field telling the time as it is set', async () => {
    const root = await dates()
    const input = root.querySelector<HTMLInputElement>('#time')!

    expect(input.type).toBe('time')
    expect(input.value).toBe('09:30')

    input.value = '17:45'
    input.dispatchEvent(new Event('change', { bubbles: true }))

    expect(seen.time).toEqual(['17:45'])
  })
})
