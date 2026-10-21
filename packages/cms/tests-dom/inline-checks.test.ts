import type { Mounted } from 'kay/test'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const NOTES: ScreenCollection = {
  name: 'notes',
  kind: 'folder',
  localized: false,
  components: [],
  schema: {
    type: 'object',
    required: ['text', 'day', 'moment', 'kind'],
    properties: {
      text: { 'type': 'string', 'minLength': 5, 'x-kay': { kind: 'markdown' } },
      day: { type: 'string', format: 'date' },
      moment: { type: 'string', format: 'date-time' },
      kind: { type: 'string', enum: ['a', 'b'] },
      code: { type: 'string', pattern: '^[a-z]+$' },
      loose: { type: 'string', pattern: '[a-z]+' },
    },
  },
}
const entry = (data: Record<string, unknown>) => ({ slug: 'first', locale: undefined, data, draft: false, version: 'v1', url: '/notes/first' }) as unknown as StoredEntry
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function open(data: Record<string, unknown>) {
  mounted = await mountComponent('src/components/entry-screen.kay', { collection: NOTES, entry: entry(data) })
  await settle()

  const root = mounted.root
  const box = (name: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-kcms-path="${name}"] :is(input, textarea, select)`)!
  const issueOf = (name: string) => root.querySelector(`[data-kcms-path="${name}"] .kui-form-field-issue`)?.textContent?.trim()
  const change = async (name: string, text: string, type = 'input') => {
    box(name).value = text
    box(name).dispatchEvent(new Event(type, { bubbles: true }))
    await settle()
  }

  return { box, issueOf, change }
}

const FULL = { text: 'long enough', day: '2026-01-02', moment: '2026-01-02T10:00:00.000Z', kind: 'a' }

test('a markdown editor checks its text once left, then as it is typed', async () => {
  const { box, issueOf, change } = await open(FULL)

  await change('text', 'ab')
  expect(issueOf('text')).toBeUndefined()
  box('text').dispatchEvent(new FocusEvent('blur'))
  await settle()
  expect(issueOf('text')).toBe('Text needs at least 5 characters')
  await change('text', 'abcdef')
  expect(issueOf('text')).toBeUndefined()
  await change('text', '')
  expect(issueOf('text')).toBe('Text needs at least 5 characters')
  expect(box('text').getAttribute('minlength')).toBe('5')
  expect(box('text').hasAttribute('required')).toBe(true)
})

test('a date, a date and time and a select take required, and a date or time emptied says so', async () => {
  const { box, issueOf, change } = await open(FULL)

  expect(box('day').hasAttribute('required')).toBe(true)
  expect(box('moment').hasAttribute('required')).toBe(true)
  expect(box('kind').hasAttribute('required')).toBe(true)
  await change('day', '')
  expect(issueOf('day')).toBe('Day is required')
  await change('moment', '')
  expect(issueOf('moment')).toBe('Moment is required')
  await change('kind', 'b', 'change')
  expect(issueOf('kind')).toBeUndefined()
  await change('kind', '', 'change')
  expect(issueOf('kind')).toBe('Kind is required')
})

test('a pattern anchored at both ends is the attribute, any other is left to the form\'s own check', async () => {
  const { box, issueOf, change } = await open({ ...FULL, code: 'abc', loose: 'abc' })

  expect(box('code').getAttribute('pattern')).toBe('^[a-z]+$')
  expect(box('loose').hasAttribute('pattern')).toBe(false)
  await change('loose', 'A1')
  box('loose').dispatchEvent(new FocusEvent('blur'))
  await settle()
  expect(issueOf('loose')).toBe('Loose is not in the expected form')
  await change('loose', 'A1b')
  expect(issueOf('loose')).toBeUndefined()
})
