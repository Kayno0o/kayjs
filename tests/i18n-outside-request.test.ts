import { afterEach, describe, expect, it } from 'bun:test'
import { direction, formatDate, formatList, formatNumber, formatRelativeTime } from '../src/runtime/i18n.server'
import { runInLocale, setSiteLocale } from '../src/runtime/locale-state'

afterEach(() => {
  setSiteLocale('en')
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
})
