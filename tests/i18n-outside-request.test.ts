import { afterEach, describe, expect, it } from 'bun:test'
import { direction, formatDate, formatList, formatNumber, formatRelativeTime } from '../src/runtime/i18n.server'
import { runInLocale, setSiteLocale, siteLocales } from '../src/runtime/locale-state'

afterEach(() => {
  setSiteLocale('en')
})

describe('relative times at the edge of a unit', () => {
  const now = Date.UTC(2026, 5, 1, 12)
  const at = (seconds: number) => formatRelativeTime(now + seconds * 1000, { now, locale: 'en' })

  it('write the rounded count in the unit above when it reaches one', () => {
    expect([59.6, 3599, 86_399, 604_799, 31_535_999, -3599, -86_399].map(at)).toEqual(['in 1 minute', 'in 1 hour', 'tomorrow', 'next week', 'next year', '1 hour ago', 'yesterday'])
  })

  it('keep a count that stays under it', () => {
    expect([29, 59.4, 3569, 82_000, 540_000, 2_000_000, 28_000_000].map(at)).toEqual(['in 29 seconds', 'in 59 seconds', 'in 59 minutes', 'in 23 hours', 'in 6 days', 'in 3 weeks', 'in 11 months'])
  })
})

describe('the formatters outside a request', () => {
  it('format in English when the site names no locale', () => {
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatDate(Date.UTC(2024, 0, 5), { dateStyle: 'long', timeZone: 'UTC' })).toBe('January 5, 2024')
    expect(formatList(['Ada', 'Grace'])).toBe('Ada and Grace')
    expect(formatRelativeTime(2, 'week')).toBe('in 2 weeks')
    expect(direction()).toBe('ltr')
  })

  it('format in the site\'s default locale once it is known', () => {
    setSiteLocale('fr')

    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat('fr').format(1234.5))
    expect(formatDate(Date.UTC(2024, 0, 5), { dateStyle: 'long', timeZone: 'UTC' })).toBe('5 janvier 2024')
    expect(formatList(['Ada', 'Grace'])).toBe('Ada et Grace')

    setSiteLocale('ar')

    expect(direction()).toBe('rtl')
  })

  it('leave the request\'s locale first while one runs', () => {
    setSiteLocale('fr')

    expect(runInLocale({ locale: 'en', messages: new Map(), settings: { locales: ['en', 'fr'], defaultLocale: 'fr', prefixDefault: false }, path: '/' }, () => formatNumber(1234.5))).toBe('1,234.5')
  })

  it('take a locale of their own first, outside a request and in one', () => {
    const request = { locale: 'en', messages: new Map(), settings: { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false }, path: '/' }
    const date = Date.UTC(2024, 0, 5, 12)
    const all = () => [
      formatNumber(1234.5, { locale: 'fr' }),
      formatDate(date, { locale: 'fr', dateStyle: 'long', timeZone: 'UTC' }),
      formatDate(date, { locale: 'fr' }),
      formatList(['Ada', 'Grace'], { locale: 'fr' }),
      formatRelativeTime(2, 'week', { locale: 'fr' }),
      formatRelativeTime(date + 7 * 86_400_000, { locale: 'fr', now: date }),
    ]
    const french = [new Intl.NumberFormat('fr').format(1234.5), '5 janvier 2024', '5 janv. 2024', 'Ada et Grace', 'dans 2 semaines', 'la semaine prochaine']

    expect(all()).toEqual(french)
    expect(runInLocale(request, all)).toEqual(french)
    expect(formatNumber(1234.5, { locale: 'de' })).toBe('1.234,5')
  })

  it('keep the medium date for a locale alone, left undefined or empty options, and for options naming no part of the date', () => {
    const date = Date.UTC(2024, 0, 5, 12)

    expect(formatDate(date, { locale: undefined })).toBe('Jan 5, 2024')
    expect(formatDate(date, { locale: 'fr' })).toBe('5 janv. 2024')
    expect(formatDate(date, {})).toBe('Jan 5, 2024')
    expect(formatDate(date, { timeZone: 'UTC' })).toBe('Jan 5, 2024')
    expect(formatDate(date, { year: 'numeric' })).toBe('2024')
    expect(formatDate(date, { dateStyle: undefined, year: undefined })).toBe('Jan 5, 2024')
    expect(formatRelativeTime(-2, 'day', { locale: 'fr', numeric: 'always' })).toBe('il y a 2 jours')
  })
})

describe('the site\'s locales outside a request', () => {
  it('list the default one alone until the server says them all', () => {
    expect(siteLocales()).toEqual(['en'])

    setSiteLocale('fr', ['fr', 'en'])

    expect(siteLocales()).toEqual(['fr', 'en'])
  })
})
