import { describe, expect, it } from 'bun:test'
import { durationMs, durationSeconds, optionMs } from '../src/runtime/duration'
import { durationWords } from '../src/runtime/duration-words'

describe('durations', () => {
  it('reads seconds, or a number with its unit', () => {
    expect(['30s', '5m', '1.5h', '30d', '2w', 90, 0.5].map(value => durationSeconds(value, 'ttl'))).toEqual([30, 300, 5400, 2_592_000, 1_209_600, 90, 0.5])
  })

  it('reads a number of milliseconds with its unit, 250ms or 0.5ms', () => {
    expect(['250ms', '1.5ms', '1000ms', '3s'].map(value => durationSeconds(value, 'ttl'))).toEqual([0.25, 0.0015, 1, 3])
    expect(durationSeconds('300ms', 'ttl')).toBe(0.3)
  })

  it('gives milliseconds to an option that took them: a bare number as it is, a string as a duration', () => {
    expect([300, '300ms', '3s', '1.5m', '2h'].map(value => durationMs(value))).toEqual([300, 300, 3000, 90_000, 7_200_000])
    expect([300, '250ms', '2s'].map(value => optionMs(value, 'wait'))).toEqual([300, 250, 2000])
    expect(Number.isNaN(durationMs('soon'))).toBe(true)
  })

  it('refuses a string that is no duration for an option taking milliseconds, naming it', () => {
    for (const value of ['soon', '0ms', '-5s', '5', '5 ms', ''])
      expect(() => optionMs(value, 'wait', 'kayjs-cms')).toThrow(/^kayjs-cms: wait is '.*'; it takes a positive duration/)
  })

  it('keeps the seconds of a fractional minute, hour or day exact, as headers carry them', () => {
    expect(['8.7m', '17.1m', '2.3h', '34.3m'].map(value => durationSeconds(value, 'ttl'))).toEqual([522, 1026, 8280, 2058])
    expect(['1001ms', '1.1s', '8.7m'].map(value => optionMs(value, 'wait'))).toEqual([1001, 1100, 522_000])
  })

  it('refuses what is no positive duration, naming the option', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '0m', '-5m', '5', '5 m', '5min', '5M', 'm', '', null, undefined])
      expect(() => durationSeconds(value, 'ttl')).toThrow(/^kay: ttl is .+; it takes a positive duration, seconds or a string such as '5m', '12h' or '30d'$/)
  })
})

describe('duration words', () => {
  it('words a lifetime in the largest unit it fills exactly, days from two on', () => {
    expect([86_400, 7 * 86_400, 3600, 90 * 60, 900, 45, 2 * 86_400 + 1].map(seconds => durationWords(seconds, 'en'))).toEqual(['24 hours', '7 days', '1 hour', '90 minutes', '15 minutes', '45 seconds', '172,801 seconds'])
  })

  it('words it in French, with its plurals', () => {
    expect([86_400, 7 * 86_400, 3600, 7200, 600, 1].map(seconds => durationWords(seconds, 'fr').replace(/\s/g, ' '))).toEqual(['24 heures', '7 jours', '1 heure', '2 heures', '10 minutes', '1 seconde'])
  })

  it('falls back to English for a bad locale', () => {
    expect(durationWords(600, 'not a locale')).toBe('10 minutes')
  })
})
