import type { Mounted } from 'kay/test'
import type { Field } from '../src/fields'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { createDrafts } from '../src/drafts'

const ENTRY = { collection: 'posts', slug: 'hello' }
const TAGS: Field = { key: 'tags', label: 'Tags', hint: undefined, required: false, kind: 'list', numbered: true, item: { key: 0, label: 'Tag', hint: undefined, required: false, kind: 'text' } }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(items: string[]) {
  const drafts = createDrafts({ show: async () => ({}) })

  drafts.open({ ...ENTRY, data: { tags: items } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field: TAGS })

  return { drafts, root: mounted.root }
}

const said = () => document.querySelector('[data-kui-announce]')?.textContent?.trim()

test('the buttons of a list item move it, reorder the saved value and say the item by the place it left', async () => {
  const { drafts, root } = await open(['a', 'b', 'c'])

  root.querySelectorAll<HTMLButtonElement>('[data-kcms-row]')[0]!.querySelector<HTMLButtonElement>('[data-kcms-move="down"]')!.click()
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['b', 'a', 'c'])
  // The live region speaks after a short first-use delay.
  for (let wait = 0; wait < 50 && (said() ?? '') === ''; wait++)
    await Bun.sleep(20)

  expect(said()).toBe('Moved Item 1 to 2 of 3')
})

test('Alt with an arrow in a field of an item moves it, and a move past either end changes nothing', async () => {
  const { drafts, root } = await open(['a', 'b', 'c'])
  const rows = () => root.querySelectorAll<HTMLElement>('[data-kcms-row]')
  const press = (row: HTMLElement, key: string) => row.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }))

  press(rows()[2]!, 'ArrowUp')
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['a', 'c', 'b'])

  press(rows()[0]!, 'ArrowUp')
  press(rows()[2]!, 'ArrowDown')
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['a', 'c', 'b'])
})

test('a date and time is shown and typed in UTC, stored as a full date, and cleared with nothing stored', async () => {
  const drafts = createDrafts({ show: async () => ({}) })
  const field: Field = { key: 'tags', label: 'Publish at', hint: undefined, required: false, kind: 'datetime' }

  drafts.open({ ...ENTRY, data: { tags: '2026-10-20T08:00:00+02:00' } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field })

  const input = mounted.root.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
  const type = (text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  expect(input.value).toBe('2026-10-20T06:00')
  expect(mounted.root.textContent).toContain('Time in UTC')
  type('2026-10-21T09:30')
  await settle()
  expect(drafts.value(ENTRY, 'tags')).toBe('2026-10-21T09:30:00.000Z')
  type('')
  await settle()
  expect(drafts.value(ENTRY, 'tags')).toBeUndefined()
})
