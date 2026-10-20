import type { Mounted } from 'kay/test'
import type { Field } from '../src/fields'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
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
