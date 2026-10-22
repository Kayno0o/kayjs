// A date range's two bounds as `YYYY-MM-DD`, each open when empty.
export type DateRange = [string | null, string | null]

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

// Every date is read and written on the UTC calendar, so no timezone or daylight saving shifts a day.
function utc(iso: string): Date | null {
  const parts = ISO.exec(iso)

  if (!parts)
    return null

  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])))

  return isoOf(date) === iso ? date : null
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// Whether the text is a real calendar date written `YYYY-MM-DD`.
export function isDate(text: string | null | undefined): text is string {
  return text !== null && text !== undefined && utc(text) !== null
}

export function addDays(iso: string, days: number): string {
  const date = utc(iso)

  return date ? isoOf(new Date(date.getTime() + days * DAY_MS)) : iso
}

// Moves by calendar months, a day past the end of the month landing on its last day: 31 January plus one month is 28 or 29 February.
export function addMonths(iso: string, months: number): string {
  const date = utc(iso)

  if (!date)
    return iso

  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()

  target.setUTCDate(Math.min(date.getUTCDate(), last))

  return isoOf(target)
}

// `min` and `max` are `YYYY-MM-DD` and compare as text; an empty or invalid bound is none.
export function clampDate(iso: string, min?: string, max?: string): string {
  if (isDate(min) && iso < min)
    return min

  return isDate(max) && iso > max ? max : iso
}

export function withinBounds(iso: string, min?: string, max?: string): boolean {
  return clampDate(iso, min, max) === iso
}

// 0 for Sunday to 6 for Saturday; the locale's own first day, Monday where the runtime cannot tell.
export function firstDayOf(locale: string): number {
  try {
    // Chromium and Safari answer `getWeekInfo()`, older Firefox and Node the `weekInfo` property.
    const intl: { getWeekInfo?: () => { firstDay: number }, weekInfo?: { firstDay: number } } = new Intl.Locale(locale)
    const info = intl.getWeekInfo?.() ?? intl.weekInfo

    return info === undefined ? 1 : info.firstDay % 7
  }
  catch {
    return 1
  }
}

// The weeks a month shows, each seven dates starting on `firstDay`, the days of the neighbouring months filling the first and last week.
export function monthWeeks(iso: string, firstDay: number): string[][] {
  const date = utc(iso)

  if (!date)
    return []

  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const lead = (first.getUTCDay() - firstDay + 7) % 7
  const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  const count = Math.ceil((lead + days) / 7)
  const start = first.getTime() - lead * DAY_MS

  return Array.from({ length: count }, (_, week) => Array.from({ length: 7 }, (__, day) => isoOf(new Date(start + (week * 7 + day) * DAY_MS))))
}

// The first date of the week holding `iso`, and the last.
export function weekEdge(iso: string, firstDay: number, end: boolean): string {
  const date = utc(iso)

  if (!date)
    return iso

  const lead = (date.getUTCDay() - firstDay + 7) % 7

  return addDays(iso, end ? 6 - lead : -lead)
}

export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7)
}

// `October 2026` in the locale.
export function monthTitle(iso: string, locale: string): string {
  return format(iso, locale, { month: 'long', year: 'numeric' })
}

// `Wednesday 21 October 2026` in the locale, what a day's button is named for screen readers.
export function dayName(iso: string, locale: string): string {
  return format(iso, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

// The seven weekdays from `firstDay`, each as `{ short, long }` in the locale.
export function weekdays(locale: string, firstDay: number): { short: string, long: string }[] {
  // 2026-10-04 is a Sunday.
  return Array.from({ length: 7 }, (_, index) => {
    const iso = addDays('2026-10-04', (firstDay + index) % 7)

    return { short: format(iso, locale, { weekday: 'short' }), long: format(iso, locale, { weekday: 'long' }) }
  })
}

const formatters = new Map<string, Intl.DateTimeFormat>()

// A formatter is slow to build and a calendar asks for the same few dozens of times, so each locale and options pair builds one; a locale the runtime rejects is drawn in English.
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let found = formatters.get(key)

  if (!found) {
    try {
      found = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })
    }
    catch {
      found = new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' })
    }

    formatters.set(key, found)
  }

  return found
}

function format(iso: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  const date = utc(iso)

  return date ? formatter(locale, options).format(date) : iso
}

// Today on the viewer's own calendar.
export function today(): string {
  const now = new Date()

  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// The bounds as typed, an empty or invalid box read as open and a reversed pair put back in order.
export function dateRangeFrom(from: string, to: string): DateRange {
  const start = isDate(from) ? from : null
  const end = isDate(to) ? to : null

  return start !== null && end !== null && start > end ? [end, start] : [start, end]
}
