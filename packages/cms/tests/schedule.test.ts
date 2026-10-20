import type { CollectionInfo } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { inputValue, scheduledFor, storedValue } from '../src/datetime'
import { rowsOf } from '../src/listing'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const talks: CollectionInfo = {
  name: 'talks',
  kind: 'folder',
  localized: false,
  components: [],
  publishField: 'at',
  draftField: 'draft',
  schema: { properties: { title: { type: 'string' }, at: { type: 'string', format: 'date-time' }, draft: { type: 'boolean' } } },
}

describe('scheduledFor', () => {
  it('says when an entry whose date is ahead goes live, in UTC', () => {
    expect(scheduledFor(talks, { at: '2026-10-20T08:00:00+02:00' }, NOW)).toBe('2026-10-20 06:00 UTC')
    expect(scheduledFor(talks, { at: '2026-10-20' }, NOW)).toBe('2026-10-20 00:00 UTC')
  })

  it('says nothing for a date past or now, an absent or unreadable one, or a collection with no publishAt', () => {
    expect(scheduledFor(talks, { at: '2026-10-19T12:00:00Z' }, NOW)).toBeUndefined()
    expect(scheduledFor(talks, { at: '2026-10-01' }, NOW)).toBeUndefined()
    expect(scheduledFor(talks, {}, NOW)).toBeUndefined()
    expect(scheduledFor(talks, { at: 'someday' }, NOW)).toBeUndefined()
    expect(scheduledFor(talks, undefined, NOW)).toBeUndefined()
    expect(scheduledFor({ ...talks, publishField: undefined }, { at: '2026-10-20' }, NOW)).toBeUndefined()
  })
})

describe('rowsOf', () => {
  it('marks a published entry whose date is ahead with it, and leaves a draft a draft', () => {
    const rows = rowsOf(talks, [
      { slug: 'later', data: { title: 'Later', at: '2026-10-20T08:00:00Z' }, draft: false },
      { slug: 'drafted', data: { title: 'Drafted', at: '2026-10-20T08:00:00Z', draft: true }, draft: true },
      { slug: 'live', data: { title: 'Live', at: '2026-10-01' }, draft: false },
      { slug: 'plain', data: { title: 'Plain' }, draft: false },
    ], NOW)

    expect(rows.map(row => [row.slug, row.scheduled])).toEqual([['later', '2026-10-20 08:00 UTC'], ['drafted', undefined], ['live', undefined], ['plain', undefined]])
  })
})

describe('the datetime field', () => {
  it('shows a stored date as the minute it falls at in UTC, nothing for none or an unreadable one', () => {
    expect(inputValue('2026-10-20T08:00:00+02:00')).toBe('2026-10-20T06:00')
    expect(inputValue('2026-10-20T08:00:30.000Z')).toBe('2026-10-20T08:00')
    expect(inputValue('2026-10-20')).toBe('2026-10-20T00:00')
    expect(inputValue('')).toBe('')
    expect(inputValue('someday')).toBe('')
  })

  it('stores what is typed as a full UTC date the schema reads, and nothing once it is cleared', () => {
    expect(storedValue('2026-10-20T08:00')).toBe('2026-10-20T08:00:00.000Z')
    expect(storedValue('')).toBeUndefined()
    expect(storedValue('2026-10-20T')).toBeUndefined()
  })
})
