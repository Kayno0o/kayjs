import type { Mounted } from 'kay/test'
import type { Field } from '../src/fields'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import type { EntryRow } from '../src/listing'
import process from 'node:process'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { inputValue } from '../src/datetime'
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

test('Alt and Shift with an arrow in a field of an item moves it, and a move past either end changes nothing', async () => {
  const { drafts, root } = await open(['a', 'b', 'c'])
  const rows = () => root.querySelectorAll<HTMLElement>('[data-kcms-row]')
  const press = (row: HTMLElement, key: string) => row.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, shiftKey: true, bubbles: true, cancelable: true }))

  press(rows()[2]!, 'ArrowUp')
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['a', 'c', 'b'])

  press(rows()[0]!, 'ArrowUp')
  press(rows()[2]!, 'ArrowDown')
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['a', 'c', 'b'])
})

const PEOPLE: Field = { key: 'tags', label: 'People', hint: undefined, required: false, kind: 'list', numbered: true, minItems: 1, maxItems: 3, item: { key: 0, label: 'Person', hint: undefined, required: true, kind: 'group', fields: [{ key: 'name', label: 'Name', hint: undefined, required: false, kind: 'text', default: 'Anon' }, { key: 'role', label: 'Role', hint: undefined, required: true, kind: 'select', options: [{ value: 'a', label: 'A', raw: 'a' }, { value: 'b', label: 'B', raw: 'b' }] }] } }

async function openField(field: Field, data: unknown) {
  mounted = await mountComponent('src/components/list-state.kay', { data, field })
  await settle()

  const root = mounted.root
  const drafted = () => JSON.parse(root.querySelector('.drafted')!.textContent) as unknown
  const click = async (selector: string, at = 0) => {
    root.querySelectorAll<HTMLElement>(selector)[at]!.click()
    await settle()
  }

  return { drafted, root, click, rows: () => [...root.querySelectorAll<HTMLElement>('[data-kcms-row]')] }
}

test('a list of strings shows its label once, the rows naming their input for a screen reader only', async () => {
  const { root } = await openField(TAGS, ['a', 'b'])

  expect(root.querySelectorAll('[data-kcms-row][data-compact]').length).toBe(2)
  expect(root.querySelector('legend')?.textContent).toContain('Tags')
  expect(root.querySelectorAll('input')[0]!.closest('label')?.textContent).toContain('Item 1')
  expect(root.querySelector('.kcms-item-head')).toBeNull()
})

test('a list of groups heads each item by its first filled text, folds it away, and keeps the fold on the item when it moves', async () => {
  const { root, click, rows } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }, { name: '', role: 'b' }])

  expect(root.querySelectorAll('.kcms-item-title').length).toBe(2)
  expect([...root.querySelectorAll('.kcms-item-title')].map(title => title.textContent)).toEqual(['Ada', 'Item 2'])
  await click('.kcms-fold', 0)
  expect(rows()[0]!.querySelector('.kcms-item-body')!.hasAttribute('hidden')).toBe(true)
  expect(rows()[0]!.querySelector('.kcms-fold')!.getAttribute('aria-expanded')).toBe('false')
  await click('[data-kcms-move="down"]', 0)
  expect(rows()[1]!.querySelector('.kcms-item-body')!.hasAttribute('hidden')).toBe(true)
  expect(rows()[0]!.querySelector('.kcms-item-body')!.hasAttribute('hidden')).toBe(false)
  await click('.kcms-fold', 1)
  expect(rows()[1]!.querySelector('.kcms-item-body')!.hasAttribute('hidden')).toBe(false)
})

test('a new item starts from the schema default, a required select left unpicked, and the list shows its count and bounds', async () => {
  const { drafted, root, click } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }])

  expect(root.textContent).toContain('1 item')
  expect(root.textContent).toContain('Between 1 and 3 items')
  await click('[data-kcms-add]')
  expect(drafted()).toEqual([{ name: 'Ada', role: 'a' }, { name: 'Anon' }])
  expect(root.querySelectorAll('select')[1]!.value).toBe('')
})

test('Add and Duplicate stop at maxItems and Remove at minItems', async () => {
  const { drafted, root, click } = await openField(PEOPLE, [{ name: 'Ada', role: 'a' }])
  const removers = () => [...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove"]')]

  expect(removers()[0]!.disabled).toBe(true)
  await click('[data-kcms-add]')
  await click('button[aria-label^="Duplicate"]', 0)
  expect(drafted()).toHaveLength(3)
  expect(root.querySelector('[data-kcms-add]')).toBeNull()
  expect([...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="Duplicate"]')].every(button => button.disabled)).toBe(true)
  expect(removers().every(button => !button.disabled)).toBe(true)
  await click('button[aria-label^="Remove"]', 2)
  await click('button[aria-label^="Remove"]', 1)
  expect(drafted()).toHaveLength(1)
  expect(removers()[0]!.disabled).toBe(true)
})

test('Duplicate copies an item right after it without sharing it', async () => {
  const { drafted, root, click } = await openField(TAGS, ['a', 'b'])

  await click('button[aria-label^="Duplicate"]', 0)
  expect(drafted()).toEqual(['a', 'a', 'b'])

  const copy = root.querySelectorAll('input')[1]!

  copy.value = 'z'
  copy.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(drafted()).toEqual(['a', 'z', 'b'])
})

test('removing an item can be undone at its place, and focus lands on the item that took its place, else on Add', async () => {
  const { drafted, root, click, rows } = await openField(TAGS, ['a', 'b', 'c'])

  await click('button[aria-label^="Remove"]', 1)
  expect(drafted()).toEqual(['a', 'c'])
  expect(root.querySelector('[role="status"]')?.textContent).toContain('Item 2 removed')
  expect(document.activeElement).toBe(rows()[1]!.querySelector('input'))
  await click('.kcms-item-removed button')
  expect(drafted()).toEqual(['a', 'b', 'c'])
  expect(root.querySelector('[role="status"]')).toBeNull()
  expect(document.activeElement).toBe(rows()[1]!.querySelector('input'))
  await click('button[aria-label^="Remove"]', 2)
  await click('button[aria-label^="Remove"]', 1)
  await click('button[aria-label^="Remove"]', 0)
  expect(drafted()).toEqual([])
  expect(document.activeElement).toBe(root.querySelector('[data-kcms-add]'))
})

test('Add puts focus in the new item', async () => {
  const { root, click, rows } = await openField(TAGS, ['a'])

  await click('[data-kcms-add]')
  expect(rows()).toHaveLength(2)
  expect(document.activeElement).toBe(rows()[1]!.querySelector('input'))
  expect(root.querySelector('.kcms-item-removed')).toBeNull()
})

const ZONE = process.env.TZ

afterEach(() => {
  if (ZONE === undefined)
    delete process.env.TZ
  else
    process.env.TZ = ZONE
})

async function openDate(stored: string | undefined) {
  const drafts = createDrafts({ show: async () => ({}) })
  const field: Field = { key: 'tags', label: 'Publish at', hint: undefined, required: false, kind: 'datetime' }

  drafts.open({ ...ENTRY, data: { tags: stored } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field })
  await settle()

  const input = mounted.root.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
  const type = async (text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  return { drafts, input, type, hint: () => mounted!.root.textContent }
}

test('a date and time is shown and typed on the wall clock of the editor\'s zone, stored as the instant it names, and cleared with nothing stored', async () => {
  process.env.TZ = 'America/New_York'

  const { drafts, input, type, hint } = await openDate('2026-10-20T08:00:00+02:00')

  expect(input.value).toBe('2026-10-20T02:00')
  expect(hint()).toContain('Time in America/New_York')
  await type('2026-10-21T09:30')
  expect(drafts.value(ENTRY, 'tags')).toBe('2026-10-21T13:30:00.000Z')
  await type('')
  expect(drafts.value(ENTRY, 'tags')).toBeUndefined()
})

test('an editor in UTC sees UTC, and one in a zone with a half hour offset sees it', async () => {
  process.env.TZ = 'UTC'

  const utc = await openDate('2026-10-20T08:00:00+02:00')

  expect(utc.input.value).toBe('2026-10-20T06:00')
  expect(utc.hint()).toContain('Time in UTC')
  mounted?.unmount()
  process.env.TZ = 'Asia/Kolkata'

  const india = await openDate('2026-10-20T08:00:00+02:00')

  expect(india.input.value).toBe('2026-10-20T11:30')
  await india.type('2026-10-20T11:30')
  expect(india.drafts.value(ENTRY, 'tags')).toBe('2026-10-20T06:00:00.000Z')
})

test('a time the clocks of the editor\'s zone skip is stored an hour on, and a repeated one at its first turn', async () => {
  process.env.TZ = 'Europe/Paris'

  const { drafts, type } = await openDate(undefined)

  await type('2026-03-29T02:30')
  expect(drafts.value(ENTRY, 'tags')).toBe('2026-03-29T01:30:00.000Z')
  await type('2026-10-25T02:30')
  expect(drafts.value(ENTRY, 'tags')).toBe('2026-10-25T00:30:00.000Z')
})

const TALKS: ScreenCollection = { name: 'talks', kind: 'folder', localized: false, components: [], publishField: 'at', draftField: 'draft', schema: { properties: { title: { type: 'string' }, at: { type: 'string', format: 'date-time' }, draft: { type: 'boolean' } } } }
const talk = (at: string) => ({ slug: 'talk', locale: undefined, data: { title: 'Talk', at }, draft: false, version: 'v1', url: '/talks/talk' }) as unknown as StoredEntry
const badge = () => (/Scheduled for \d{4}-\d\d-\d\d \d\d:\d\d (?:UTC|GMT[+-][\d:]+)/).exec(mounted!.root.textContent ?? '')?.[0]

test('the scheduled badge of an entry screen names the time in the editor\'s zone and goes when the date passes, with no reload', async () => {
  process.env.TZ = 'Europe/Paris'

  const at = new Date(Date.now() + 1200)

  mounted = await mountComponent('src/components/scheduled-entry.kay', { collection: TALKS, entry: talk(at.toISOString()) })
  await settle()
  expect(badge()).toMatch(new RegExp(`^Scheduled for ${inputValue(at.toISOString(), 'Europe/Paris').replace('T', ' ')} GMT\\+[12]$`))

  for (let wait = 0; badge() !== undefined && wait < 60; wait++) {
    await Bun.sleep(50)
    await settle()
  }

  expect(badge()).toBeUndefined()
})

test('the badge comes back for a date typed ahead and goes for a date typed in the past', async () => {
  process.env.TZ = 'UTC'
  mounted = await mountComponent('src/components/scheduled-entry.kay', { collection: TALKS, entry: talk('2026-10-01T00:00:00Z') })
  await settle()
  expect(badge()).toBeUndefined()

  const input = mounted.root.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
  const type = async (text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  await type('2999-10-19T12:01')
  expect(badge()).toBe('Scheduled for 2999-10-19 12:01 UTC')
  await type('2020-10-19T11:00')
  expect(badge()).toBeUndefined()
})

const rowOf = (slug: string, at: string | undefined) => ({ slug, title: slug, draft: false, ...at !== undefined && Date.parse(at) > Date.now() && { scheduledAt: Date.parse(at) } }) as EntryRow
const statusOf = (slug: string) => mounted!.root.querySelector(`tr:has(a[href$="/${slug}"]) .kui-badge`)?.textContent?.trim()

test('the list names a scheduled time in the editor\'s zone, as the entry screen does, and says Published for an entry with none or one that passed', async () => {
  process.env.TZ = 'Europe/Paris'

  const ahead = new Date(Date.now() + 3_600_000).toISOString()

  mounted = await mountComponent('src/components/scheduled-rows.kay', { collection: TALKS, rows: [rowOf('later', ahead), rowOf('live', '2020-01-01'), rowOf('plain', undefined)] })
  await settle()
  expect(statusOf('later')).toMatch(new RegExp(`^Scheduled for ${inputValue(ahead, 'Europe/Paris').replace('T', ' ')} GMT\\+[12]$`))
  expect([statusOf('live'), statusOf('plain')]).toEqual(['Published', 'Published'])
})

test('the list names a time in UTC for an editor in UTC and the offset of a half hour zone', async () => {
  const ahead = '2999-10-19T06:00:00Z'

  process.env.TZ = 'UTC'
  mounted = await mountComponent('src/components/scheduled-rows.kay', { collection: TALKS, rows: [{ ...rowOf('later', ahead), scheduledAt: Date.parse(ahead) }] })
  await settle()
  expect(statusOf('later')).toBe('Scheduled for 2999-10-19 06:00 UTC')
  mounted.unmount()
  process.env.TZ = 'Asia/Kolkata'
  mounted = await mountComponent('src/components/scheduled-rows.kay', { collection: TALKS, rows: [{ ...rowOf('later', ahead), scheduledAt: Date.parse(ahead) }] })
  await settle()
  expect(statusOf('later')).toBe('Scheduled for 2999-10-19 11:30 GMT+5:30')
})

test('the list\'s badge turns to Published when its date passes, with no reload', async () => {
  process.env.TZ = 'Europe/Paris'

  const at = Date.now() + 1200

  mounted = await mountComponent('src/components/scheduled-rows.kay', { collection: TALKS, rows: [{ ...rowOf('later', undefined), scheduledAt: at }] })
  await settle()
  expect(statusOf('later')).toStartWith('Scheduled for ')

  for (let wait = 0; statusOf('later') !== 'Published' && wait < 60; wait++) {
    await Bun.sleep(50)
    await settle()
  }

  expect(statusOf('later')).toBe('Published')
})
