import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const changes: string[] = []
const created: string[] = []

afterEach(() => {
  mounted?.unmount()
  changes.length = 0
  created.length = 0
})

const PLANETS = [{ value: 'mars', label: 'Mars' }, { value: 'moon', label: 'Moon', disabled: true }, { value: 'earth', label: 'Earth' }]

async function combobox(options: unknown = PLANETS, minLength?: number, create = true, extra: Record<string, unknown> = {}) {
  mounted = await mountComponent('src/components/combobox.kay', { options, minLength, create, ...extra, onChange: (value: string) => changes.push(value), onCreate: (text: string) => created.push(text) })

  const { root } = mounted
  const input = root.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const rows = () => [...root.querySelectorAll('[role="option"]')].map(row => row.textContent)
  const active = () => root.querySelector('[role="option"][aria-selected="true"]')?.textContent

  return { root, input, rows, active }
}

function type(input: HTMLInputElement, text: string) {
  input.focus()
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(input: HTMLInputElement, name: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })

  input.dispatchEvent(event)

  return event
}

test('follows the combobox pattern: a combobox input controlling a listbox, closed until typed in', async () => {
  const { root, input } = await combobox()
  const list = root.querySelector('[role="listbox"]')!

  expect([input.getAttribute('aria-expanded'), input.getAttribute('aria-autocomplete'), input.getAttribute('aria-controls')]).toEqual(['false', 'list', list.id])
  expect((list as HTMLElement).hidden).toBe(true)

  type(input, 'ar')
  await settle()

  expect(input.getAttribute('aria-expanded')).toBe('true')
  expect((list as HTMLElement).hidden).toBe(false)
})

test('filters a list as the visitor types and keeps focus in the input while the arrows move, skipping a disabled row', async () => {
  const { input, rows, active } = await combobox()

  input.focus()
  key(input, 'ArrowDown')
  await settle()

  expect(rows()).toEqual(['Mars', 'Moon', 'Earth'])
  expect(active()).toBe('Mars')
  expect(input.getAttribute('aria-activedescendant')).toBe(document.querySelector('[aria-selected="true"]')!.id)

  key(input, 'ArrowDown')
  await settle()

  expect(active()).toBe('Earth')

  key(input, 'ArrowDown')
  await settle()

  expect(active()).toBe('Mars')

  key(input, 'ArrowUp')
  await settle()

  expect(active()).toBe('Earth')
  expect(document.activeElement).toBe(input)
})

test('Enter picks the active row, Escape closes the list and then clears the text', async () => {
  const { root, input } = await combobox()

  type(input, 'ea')
  await settle()
  key(input, 'ArrowDown')
  await settle()
  key(input, 'Enter')
  await settle()

  expect([input.value, changes, input.getAttribute('aria-expanded')]).toEqual(['Earth', ['earth'], 'false'])
  expect(root.querySelector<HTMLInputElement>('input[type="hidden"][name="planet"]')?.value).toBe('earth')
  expect(input.hasAttribute('name')).toBe(false)

  type(input, 'Ma')
  await settle()

  expect(changes).toEqual(['earth', ''])
  expect(root.querySelector('input[type="hidden"]')).toBeNull()
  expect(input.name).toBe('planet')

  key(input, 'Escape')
  await settle()

  expect([input.value, input.getAttribute('aria-expanded')]).toEqual(['Ma', 'false'])

  key(input, 'Escape')
  await settle()

  expect(input.value).toBe('')
})

test('a click on a row picks it, and a disabled row cannot be picked', async () => {
  const { input, root } = await combobox()

  type(input, 'mo')
  await settle()
  click(root.querySelector('[role="option"][aria-disabled="true"]'))
  await settle()

  expect(changes).toEqual([])

  type(input, 'ma')
  await settle()
  click(root.querySelector('[role="option"]'))
  await settle()

  expect([input.value, changes]).toEqual(['Mars', ['mars']])
})

test('offers the typed text as a new option unless one bears its label, and hands it over on pick', async () => {
  const { input, rows } = await combobox()

  type(input, 'Pluto')
  await settle()

  expect(rows()).toEqual(['Create "Pluto"'])

  key(input, 'ArrowDown')
  await settle()
  key(input, 'Enter')
  await settle()

  expect([input.value, changes, created]).toEqual(['Pluto', ['Pluto'], ['Pluto']])

  type(input, 'mars')
  await settle()

  expect(rows()).toEqual(['Mars'])
})

test('loads options as the visitor types after a pause, and drops an answer a newer question overtook', async () => {
  const asked: string[] = []
  const answers = new Map<string, (rows: unknown[]) => void>()
  const load = async ({ q }: { q: string }) => new Promise<unknown[]>((resolve) => {
    asked.push(q)
    answers.set(q, resolve)
  })
  const { input, rows } = await combobox(load, undefined, false)

  type(input, 'm')
  await Bun.sleep(260)
  type(input, 'ma')
  await Bun.sleep(260)

  expect(asked).toEqual(['m', 'ma'])

  answers.get('ma')!([{ value: 'mars', label: 'Mars' }])
  await settle()
  answers.get('m')!([{ value: 'moon', label: 'Moon' }])
  await settle()

  expect(rows()).toEqual(['Mars'])
  expect(input.getAttribute('aria-busy')).toBeNull()
})

test('asks for nothing under minLength, says when the load failed and when nothing matched', async () => {
  const asked: string[] = []
  const { root, input } = await combobox(async ({ q }: { q: string }) => {
    asked.push(q)

    if (q === 'boom')
      throw new Error('down')

    return []
  }, 2, false)

  type(input, 'a')
  await Bun.sleep(260)

  expect(asked).toEqual([])

  type(input, 'zz')
  await Bun.sleep(260)
  await settle()

  expect(root.querySelector('[role="status"]')?.textContent).toBe('No match')

  const logged = console.error

  console.error = () => undefined
  type(input, 'boom')
  await Bun.sleep(260)
  await settle()
  console.error = logged

  expect(root.querySelector('[role="status"]')?.textContent).toBe('Could not load the options')
})

test('hands the browser\'s own suggestions over to the listbox once the script runs', async () => {
  const { root, input } = await combobox()

  expect(input.hasAttribute('list')).toBe(false)
  expect([...root.querySelectorAll('datalist option')].map(option => option.getAttribute('value'))).toEqual(['Mars', 'Moon', 'Earth'])
})

test('a label typed whole is a pick on Enter and on leaving the input', async () => {
  const { root, input } = await combobox()

  type(input, 'earth')
  await settle()
  key(input, 'Enter')
  await settle()

  expect([input.value, changes]).toEqual(['Earth', ['earth']])
  expect(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe('earth')

  type(input, 'mars')
  await settle()
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await settle()

  expect([input.value, changes]).toEqual(['Mars', ['earth', '', 'mars']])
})

test('says expanded only while a list is shown, and leaves Escape to the page once the list and the text are gone', async () => {
  const { root, input } = await combobox(PLANETS, undefined, false)

  type(input, 'zzz')
  await settle()

  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(root.querySelector('[role="status"]')?.textContent).toBe('No match')

  type(input, '')
  await settle()

  expect(key(input, 'Escape').defaultPrevented).toBe(true)
  expect(key(input, 'Escape').defaultPrevented).toBe(false)
})

test('reads one result in the singular', async () => {
  const { root, input } = await combobox(PLANETS, undefined, false)

  type(input, 'ear')
  await settle()

  expect(root.querySelector('[role="status"]')?.textContent).toBe('1 result')
})

test('drops the rows of an older text at once and offers no new option before the answer', async () => {
  const answers = new Map<string, (rows: unknown[]) => void>()
  const { input, rows } = await combobox(async ({ q }: { q: string }) => new Promise<unknown[]>(resolve => answers.set(q, resolve)))

  type(input, 'par')
  await Bun.sleep(260)

  expect(rows()).toEqual([])

  answers.get('par')!([{ value: 'paris', label: 'Paris' }])
  await settle()

  expect(rows()).toEqual(['Paris', 'Create "par"'])

  type(input, 'pari')
  await settle()

  expect(rows()).toEqual([])
})

test('Enter on a label typed whole adopts it without submitting, the post then carrying the value', async () => {
  const { root, input } = await combobox()
  const form = root.querySelector('form')!
  let submitted = 0

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submitted++
  })

  type(input, 'earth')
  await settle()

  expect(key(input, 'Enter').defaultPrevented).toBe(true)
  await settle()

  expect([...new FormData(form)]).toEqual([['planet', 'earth']])

  expect(key(input, 'Enter').defaultPrevented).toBe(false)
  expect(submitted).toBe(0)
})

test('Escape closes an open list that has no rows without taking the press from the page, so it does not reappear when rows arrive', async () => {
  let answer: (rows: unknown[]) => void = () => undefined
  const { input, rows } = await combobox(async () => new Promise<unknown[]>(resolve => answer = resolve))

  type(input, 'par')
  await Bun.sleep(260)

  expect(key(input, 'Escape').defaultPrevented).toBe(false)
  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(input.value).toBe('par')

  answer([{ value: 'paris', label: 'Paris' }])
  await settle()

  expect([input.getAttribute('aria-expanded'), rows()]).toEqual(['false', ['Paris', 'Create "par"']])
})

test('shows the label given for a remote value, and asks the loader for nothing on focus', async () => {
  const asked: string[] = []
  const { root, input } = await combobox(async ({ q }: { q: string }) => {
    asked.push(q)

    return []
  }, undefined, true, { value: 'c-42', valueLabel: 'Ada Lovelace' })

  expect(input.value).toBe('Ada Lovelace')
  expect(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe('c-42')

  input.focus()
  await Bun.sleep(260)

  expect(asked).toEqual([])
})

test('keeps its status line and its rows out of the name a FormField gives the input', async () => {
  const { root, input } = await combobox(PLANETS, undefined, true, { field: true })

  type(input, 'ar')
  await settle()

  const named = input.getAttribute('aria-labelledby')!.split(' ').map(id => root.querySelector(`[id="${id}"]`)?.textContent).join(' ')

  expect(named.trim()).toBe('Planet')
  expect(root.querySelector('[role="status"]')?.textContent).toBe('3 results')
})

test('Escape on an open list with no row closes it and leaves the press to an enclosing dialog', async () => {
  const { input } = await combobox(PLANETS, undefined, false)

  type(input, 'zzz')
  await settle()

  const first = key(input, 'Escape')

  expect(first.defaultPrevented).toBe(false)
  expect(input.value).toBe('zzz')

  await settle()

  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(key(input, 'Escape').defaultPrevented).toBe(true)
})

test('shows no raw id for a remote value without a label, posts it, and leaves the list shut on focus', async () => {
  const asked: string[] = []
  const { root, input } = await combobox(async ({ q }: { q: string }) => {
    asked.push(q)

    return [{ value: 'c-42', label: 'Ada' }]
  }, 0, true, { value: 'c-42' })

  expect(input.value).toBe('')
  expect(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe('c-42')

  input.focus()
  await Bun.sleep(260)

  expect(asked).toEqual([])
  expect([input.getAttribute('aria-expanded'), root.querySelector('[role="status"]')?.textContent]).toEqual(['false', ''])

  expect(key(input, 'Escape').defaultPrevented).toBe(true)
  expect(changes).toEqual([''])
})

test('a list keeps showing the value as its text when no label is given', async () => {
  const { input } = await combobox([{ value: 'mars', label: 'Mars' }], undefined, true, { value: 'venus' })

  expect(input.value).toBe('venus')
})

test('a FormField names the input by its label, a group FormField and a bare label do not', async () => {
  for (const [extra, named] of [[{ field: true }, true], [{ wrap: 'group' }, false], [{ wrap: 'label' }, false]] as const) {
    const { root, input } = await combobox(PLANETS, undefined, true, extra)

    await settle()

    expect(root.textContent).toContain('Planet')
    expect(input.hasAttribute('aria-labelledby')).toBe(named)

    mounted?.unmount()
  }
})

test('ArrowDown on a remote value without a label opens the list and loads it', async () => {
  const asked: string[] = []
  const { root, input, rows } = await combobox(async ({ q }: { q: string }) => {
    asked.push(q)

    return [{ value: 'c-42', label: 'Ada' }, { value: 'c-43', label: 'Grace' }]
  }, 0, false, { value: 'c-42' })

  input.focus()

  const event = key(input, 'ArrowDown')

  await settle()

  expect([event.defaultPrevented, asked, input.getAttribute('aria-expanded'), rows(), root.querySelector('[role="status"]')?.textContent]).toEqual([true, [''], 'true', ['Ada', 'Grace'], '2 results'])
})
