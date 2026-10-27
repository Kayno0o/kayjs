import { afterEach, describe, expect, it } from 'bun:test'
import { setTimeZone } from '../src/runtime/i18n'
import { formatBytes, formatDate, formatDuration, timeZone } from '../src/runtime/i18n.server'
import { runInLocale } from '../src/runtime/locale-state'
import { checkTimeZone } from '../src/server/config-limits'
import { messagesScript } from '../src/server/i18n'

const request = (implicit: boolean) => ({ locale: 'en', messages: new Map(), settings: { locales: ['en'], defaultLocale: 'en', prefixDefault: false }, path: '/', ...implicit && { implicit: true as const } })
const LATE = Date.UTC(2024, 0, 5, 23, 30)

afterEach(() => {
  setTimeZone(undefined)
})

describe('formatBytes', () => {
  it('writes the largest unit below 1024 with one decimal at most, in the locale', () => {
    expect(formatBytes(0)).toBe('0 byte')
    expect(formatBytes(1023)).toBe('1,023 byte')
    expect(formatBytes(1536)).toBe('1.5 kB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 TB')
    expect(formatBytes(1024 ** 6)).toBe('1,048,576 TB')
    expect(formatBytes(-1536)).toBe('-1.5 kB')
    expect(formatBytes(1536, { locale: 'fr' }).replaceAll(/\s/g, ' ')).toBe('1,5 ko')
    expect(formatBytes(1536, { unitDisplay: 'long' })).toBe('1.5 kilobytes')
    expect(formatBytes(1048575)).toBe('1 MB')
    expect(formatBytes(1536, { minimumFractionDigits: 2 })).toBe('1.50 kB')
  })
})

describe('formatDuration', () => {
  it('writes the two largest units of a length in milliseconds, dropping a zero one', () => {
    expect(formatDuration(0)).toBe('0 sec')
    expect(formatDuration(499)).toBe('0 sec')
    expect(formatDuration(45_000)).toBe('45 sec')
    expect(formatDuration(14 * 60_000)).toBe('14 min')
    expect(formatDuration(125 * 60_000)).toBe('2 hr 5 min')
    expect(formatDuration(2 * 3_600_000 + 30_000)).toBe('2 hr')
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 5 * 60_000)).toBe('3 days 4 hr')
    expect(formatDuration(-5000)).toBe('0 sec')
    expect(formatDuration(Number.NaN)).toBe('0 sec')
    expect(formatDuration(125 * 60_000, { locale: 'fr' }).replaceAll(/\s/g, ' ')).toBe('2 h 5 min')
  })
})

describe('the site time zone', () => {
  it('moves the dates formatted without a zone of their own, and only those', () => {
    expect(formatDate(LATE, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })).toBe('1/5/24, 11:30 PM')

    setTimeZone('Asia/Tokyo')

    expect(timeZone()).toBe('Asia/Tokyo')
    expect(formatDate(LATE, { dateStyle: 'short', timeStyle: 'short' })).toBe('1/6/24, 8:30 AM')
    expect(formatDate(LATE)).toBe('Jan 6, 2024')
    expect(formatDate(LATE, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })).toBe('1/5/24, 11:30 PM')
    expect(formatDate(LATE, {})).toBe(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo' }).format(LATE))
  })

  it('goes to the browser with the first script of a page, even on a site without i18n', () => {
    setTimeZone('Europe/Paris')

    expect(runInLocale(request(true), () => messagesScript(new Set(), true))).toBe('<script type="application/json" data-kay-i18n>{"locale":"en","timeZone":"Europe/Paris","messages":{}}</script>')
    expect(runInLocale(request(true), () => messagesScript(new Set(), false))).toBe('')
    expect(runInLocale(request(false), () => messagesScript(new Set(), true))).toContain('"timeZone":"Europe/Paris"')

    setTimeZone(undefined)

    expect(runInLocale(request(true), () => messagesScript(new Set(), true))).toBe('')
  })

  it('is refused when the engine does not know it', () => {
    expect(() => checkTimeZone('Europe/Paris')).not.toThrow()
    expect(() => checkTimeZone(undefined)).not.toThrow()
    expect(() => checkTimeZone('Mars/Olympus')).toThrow('timeZone is "Mars/Olympus"')
  })
})
