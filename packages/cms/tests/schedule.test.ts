import type { CollectionInfo } from '../src/kay/contract'
import process from 'node:process'
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

describe('scheduledFor in an editor\'s zone', () => {
  it('says the time in that zone, named by its offset, and UTC by default', () => {
    expect(scheduledFor(talks, { at: '2026-10-20T06:00:00Z' }, NOW, 'Europe/Paris')).toBe('2026-10-20 08:00 GMT+2')
    expect(scheduledFor(talks, { at: '2026-10-20T06:00:00Z' }, NOW, 'Asia/Kolkata')).toBe('2026-10-20 11:30 GMT+5:30')
    expect(scheduledFor(talks, { at: '2026-10-20T06:00:00Z' }, NOW, 'UTC')).toBe('2026-10-20 06:00 UTC')
  })

  it('follows the offset the zone has at that date, not today\'s', () => {
    expect(scheduledFor(talks, { at: '2026-12-20T06:00:00Z' }, NOW, 'Europe/Paris')).toBe('2026-12-20 07:00 GMT+1')
  })

  it('reads an unknown zone as UTC', () => {
    expect(scheduledFor(talks, { at: '2026-10-20T06:00:00Z' }, NOW, 'Mars/Olympus')).toBe('2026-10-20 06:00 UTC')
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

    expect(rows.map(row => [row.slug, row.scheduledAt])).toEqual([['later', Date.parse('2026-10-20T08:00:00Z')], ['drafted', undefined], ['live', undefined], ['plain', undefined]])
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

describe('the datetime field in an editor\'s zone', () => {
  const ZONES = ['UTC', 'Europe/Paris', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'America/St_Johns']

  it('shows a stored instant as the wall clock of the zone, whatever the zone of the server', () => {
    const zone = process.env.TZ

    try {
      for (const server of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
        process.env.TZ = server
        expect(inputValue('2026-10-20T06:00:00.000Z', 'Europe/Paris')).toBe('2026-10-20T08:00')
        expect(inputValue('2026-10-20T06:00:00.000Z', 'America/New_York')).toBe('2026-10-20T02:00')
        expect(inputValue('2026-10-20T06:00:00.000Z', 'Asia/Kolkata')).toBe('2026-10-20T11:30')
        expect(inputValue('2026-10-20T06:00:00.000Z', 'Pacific/Auckland')).toBe('2026-10-20T19:00')
        expect(inputValue('2026-10-20T06:00:00.000Z', 'Pacific/Kiritimati')).toBe('2026-10-20T20:00')
        expect(storedValue('2026-10-20T08:00', 'Europe/Paris')).toBe('2026-10-20T06:00:00.000Z')
        expect(storedValue('2026-10-20T08:00')).toBe('2026-10-20T08:00:00.000Z')
      }
    }
    finally {
      if (zone === undefined)
        delete process.env.TZ
      else
        process.env.TZ = zone
    }
  })

  it('reads a date alone, an offset and the zone-less form of a stored value as the same instant', () => {
    expect(inputValue('2026-10-20', 'America/New_York')).toBe('2026-10-19T20:00')
    expect(inputValue('2026-10-20T08:00:00+02:00', 'Asia/Kolkata')).toBe('2026-10-20T11:30')
  })

  it('stores what two editors in different zones mean by the same moment as one instant', () => {
    expect(storedValue('2026-10-20T08:00', 'Europe/Paris')).toBe(storedValue('2026-10-20T02:00', 'America/New_York'))
    expect(storedValue('2026-10-20T08:00', 'Europe/Paris')).toBe(storedValue('2026-10-20T11:30', 'Asia/Kolkata'))
  })

  it('gives back what it stored, at a time of every zone, on a day the offset changes included', () => {
    for (const zone of ZONES) {
      for (const day of ['2026-01-15', '2026-03-29', '2026-04-05', '2026-10-04', '2026-10-25', '2026-11-01']) {
        for (const time of ['00:00', '00:30', '09:15', '12:00', '23:59']) {
          const typed = `${day}T${time}`
          const stored = storedValue(typed, zone)!

          expect(stored).toMatch(/Z$/)
          expect(storedValue(inputValue(stored, zone), zone)).toBe(stored)
        }
      }
    }
  })

  it('moves a time the clocks skip forward, as a Date does, and takes the first of one they repeat', () => {
    // Paris went from 02:00 to 03:00 on 2026-03-29, and back from 03:00 to 02:00 on 2026-10-25.
    expect(storedValue('2026-03-29T02:30', 'Europe/Paris')).toBe('2026-03-29T01:30:00.000Z')
    expect(inputValue('2026-03-29T01:30:00.000Z', 'Europe/Paris')).toBe('2026-03-29T03:30')
    expect(storedValue('2026-03-29T01:59', 'Europe/Paris')).toBe('2026-03-29T00:59:00.000Z')
    expect(storedValue('2026-03-29T03:00', 'Europe/Paris')).toBe('2026-03-29T01:00:00.000Z')
    expect(storedValue('2026-10-25T02:30', 'Europe/Paris')).toBe('2026-10-25T00:30:00.000Z')
    expect(storedValue('2026-10-25T03:00', 'Europe/Paris')).toBe('2026-10-25T02:00:00.000Z')
    // New York skipped 02:00 to 03:00 on 2026-03-08 and repeated 01:00 to 02:00 on 2026-11-01.
    expect(storedValue('2026-03-08T02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z')
    expect(storedValue('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
    // Lord Howe moves by half an hour: 02:00 to 02:30 on 2026-10-04.
    expect(storedValue('2026-10-04T02:15', 'Australia/Lord_Howe')).toBe('2026-10-03T15:45:00.000Z')
  })

  it('agrees with the engine\'s own reading of a wall time in a zone', () => {
    const zone = process.env.TZ

    try {
      process.env.TZ = 'Europe/Paris'

      for (const typed of ['2026-03-29T02:30', '2026-10-25T02:30', '2026-07-01T12:00', '2026-12-31T23:59'])
        expect(storedValue(typed, 'Europe/Paris')).toBe(new Date(typed).toISOString())
    }
    finally {
      if (zone === undefined)
        delete process.env.TZ
      else
        process.env.TZ = zone
    }
  })

  it('falls back to UTC for a zone it does not know, and refuses what is not a date and time', () => {
    expect(inputValue('2026-10-20T06:00:00.000Z', 'Mars/Olympus')).toBe('2026-10-20T06:00')
    expect(storedValue('2026-10-20T08:00', 'Mars/Olympus')).toBe('2026-10-20T08:00:00.000Z')
    expect(storedValue('2026-10-20T', 'Europe/Paris')).toBeUndefined()
    expect(storedValue('', 'Europe/Paris')).toBeUndefined()
    expect(inputValue('someday', 'Europe/Paris')).toBe('')
  })
})
