import { afterEach, describe, expect, test } from 'bun:test'
import { addDays, addMonths, clampDate, dateRangeFrom, dayName, firstDayOf, isDate, localDateTime, monthTitle, monthWeeks, sameInstant, weekdays, weekEdge, zonedInstant } from '../src/date'

describe('dates', () => {
  test('reads only real calendar dates', () => {
    expect(isDate('2026-02-28')).toBe(true)
    expect(isDate('2026-02-30')).toBe(false)
    expect(isDate('2026-2-3')).toBe(false)
    expect(isDate('')).toBe(false)
    expect(isDate(null)).toBe(false)
  })

  test('moves by days across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
  })

  test('moves by months, a missing day landing on the last of the month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15')
    expect(addMonths('2026-10-21', 12)).toBe('2027-10-21')
  })

  test('clamps to the bounds, an invalid bound being none', () => {
    expect(clampDate('2026-10-01', '2026-10-05', '2026-10-09')).toBe('2026-10-05')
    expect(clampDate('2026-10-20', '2026-10-05', '2026-10-09')).toBe('2026-10-09')
    expect(clampDate('2026-10-07', '', 'oops')).toBe('2026-10-07')
  })

  test('lays a month out in whole weeks from the first day', () => {
    const monday = monthWeeks('2026-10-21', 1)
    const sunday = monthWeeks('2026-10-21', 0)

    expect(monday).toHaveLength(5)
    expect(monday[0]![0]).toBe('2026-09-28')
    expect(monday.at(-1)!.at(-1)).toBe('2026-11-01')
    expect(sunday[0]![0]).toBe('2026-09-27')
    expect(monthWeeks('2026-02-10', 0)).toHaveLength(4)
    expect(monthWeeks('nope', 1)).toEqual([])
  })

  test('finds the ends of a week', () => {
    expect(weekEdge('2026-10-21', 1, false)).toBe('2026-10-19')
    expect(weekEdge('2026-10-21', 1, true)).toBe('2026-10-25')
    expect(weekEdge('2026-10-18', 1, false)).toBe('2026-10-12')
  })

  test('names the weekdays from the first day', () => {
    expect(weekdays('en', 1).map(name => name.long)[0]).toBe('Monday')
    expect(weekdays('fr', 0).map(name => name.long)[0]).toBe('dimanche')
  })

  test('knows the first day of a locale', () => {
    expect(firstDayOf('fr-FR')).toBe(1)
    expect(firstDayOf('en-US')).toBe(0)
    expect(firstDayOf('not a locale')).toBe(1)
  })

  test('names a month and a day in the locale, a locale the runtime rejects drawn in English, and a bad date as written', () => {
    expect(monthTitle('2026-10-21', 'en')).toBe('October 2026')
    expect(monthTitle('2026-10-21', 'fr')).toBe('octobre 2026')
    expect(monthTitle('2026-10-21', 'fr')).toBe('octobre 2026')
    expect(dayName('2026-10-21', 'en')).toBe('Wednesday, October 21, 2026')
    expect(monthTitle('2026-10-21', 'not a locale')).toBe('October 2026')
    expect(monthTitle('nope', 'en')).toBe('nope')
  })

  test('keeps drawing past the formatter cache cap', () => {
    for (let index = 0; index < 500; index++)
      monthTitle('2026-10-21', `en-u-x${index}`)

    expect(monthTitle('2026-10-21', 'fr')).toBe('octobre 2026')
  })

  test('reads a posted pair in order, an empty or invalid box being open', () => {
    expect(dateRangeFrom('2026-10-20', '2026-10-10')).toEqual(['2026-10-10', '2026-10-20'])
    expect(dateRangeFrom('', '2026-10-10')).toEqual([null, '2026-10-10'])
    expect(dateRangeFrom('2026-13-01', '')).toEqual([null, null])
  })
})

describe('date and time on the visitor\'s clock', () => {
  const zone = process.env.TZ

  afterEach(() => {
    if (zone === undefined)
      delete process.env.TZ
    else
      process.env.TZ = zone
  })

  test('writes an instant on the clock of the zone, with its offset at that time', () => {
    process.env.TZ = 'Europe/Paris'
    expect(localDateTime('2026-10-21T07:30:00Z')).toBe('2026-10-21T09:30')
    expect(localDateTime('2026-12-01T07:30:15Z')).toBe('2026-12-01T08:30:15')
    expect(zonedInstant('2026-10-21T09:30')).toBe('2026-10-21T09:30:00+02:00')
    expect(zonedInstant('2026-12-01T08:30:15')).toBe('2026-12-01T08:30:15+01:00')

    process.env.TZ = 'Asia/Kolkata'
    expect(zonedInstant('2026-10-21T09:30')).toBe('2026-10-21T09:30:00+05:30')

    process.env.TZ = 'America/St_Johns'
    expect(zonedInstant('2026-12-01T09:30')).toBe('2026-12-01T09:30:00-03:30')
  })

  test('reads text that is no date as none', () => {
    expect(localDateTime('')).toBe('')
    expect(localDateTime(undefined)).toBe('')
    expect(localDateTime('soon')).toBe('')
    expect(zonedInstant('')).toBe('')
    expect(zonedInstant('2026-13-45T99:99')).toBe('')
  })

  test('compares instants whatever their offsets', () => {
    expect(sameInstant('2026-10-21T07:30:00Z', '2026-10-21T09:30:00+02:00')).toBe(true)
    expect(sameInstant('', '')).toBe(true)
    expect(sameInstant('', '2026-10-21T07:30:00Z')).toBe(false)
  })
})
