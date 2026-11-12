import type { Duration } from '../src/runtime/duration'
import { describe, expect, it } from 'bun:test'
import { durationMs, durationSeconds, isZeroDuration, optionMs, wholeSeconds } from '../src/runtime/duration'
import { durationWords } from '../src/runtime/duration-words'

describe('durations', () => {
  it('reads a number with its unit', () => {
    expect(['30s', '5m', '1.5h', '30d', '2w'].map(value => durationSeconds(value, 'ttl'))).toEqual([30, 300, 5400, 2_592_000, 1_209_600])
  })

  it('reads a number of milliseconds with its unit, 250ms or 0.5ms', () => {
    expect(['250ms', '1.5ms', '1000ms', '3s'].map(value => durationSeconds(value, 'ttl'))).toEqual([0.25, 0.0015, 1, 3])
    expect(durationSeconds('300ms', 'ttl')).toBe(0.3)
  })

  it('gives milliseconds to an option that takes them, from a duration string', () => {
    expect(['300ms', '3s', '1.5m', '2h'].map(value => durationMs(value as Duration))).toEqual([300, 3000, 90_000, 7_200_000])
    expect(['250ms', '2s'].map(value => optionMs(value as Duration, 'wait'))).toEqual([250, 2000])
    expect(Number.isNaN(durationMs('soon' as Duration))).toBe(true)
  })

  it('refuses a string that is no duration for an option taking milliseconds, naming it', () => {
    for (const value of ['soon', '0ms', '-5s', '5', '5 ms', ''] as Duration[])
      expect(() => optionMs(value, 'wait')).toThrow(/^kay: wait is '.*'; it takes a positive duration/)
  })

  it('keeps the seconds of a fractional minute, hour or day exact, as headers carry them', () => {
    expect(['8.7m', '17.1m', '2.3h', '34.3m'].map(value => durationSeconds(value, 'ttl'))).toEqual([522, 1026, 8280, 2058])
    expect((['1001ms', '1.1s', '8.7m'] as Duration[]).map(value => optionMs(value, 'wait'))).toEqual([1001, 1100, 522_000])
  })

  it('rounds up to whole seconds for a header or a cookie, so a sub-second duration is never 0 nor fractional', () => {
    expect(['250ms', '1.5s', '0.4s', '1ms', '999ms', '1000ms', '1001ms', '2s', '90s'].map(value => wholeSeconds(value, 'maxAge'))).toEqual([1, 2, 1, 1, 1, 1, 2, 2, 90])
    expect(() => wholeSeconds('0ms', 'maxAge')).toThrow(/^kay: maxAge is '0ms'/)
  })

  it('refuses what is no positive duration, naming the option', () => {
    for (const value of [0, -5, 90, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '0m', '-5m', '5', '5 m', '5min', '5M', 'm', '', null, undefined])
      expect(() => durationSeconds(value, 'ttl')).toThrow(/^kay: ttl is .+; it takes a positive duration such as '250ms', '5m' or '30d'$/)
  })
})

describe('zero durations', () => {
  it('tells a zero duration', () => {
    expect(isZeroDuration('0s')).toBe(true)
    expect(isZeroDuration('0ms')).toBe(true)
    expect(isZeroDuration('5s')).toBe(false)
  })
})

describe('a bare number where milliseconds were taken', () => {
  // Never read as seconds: an unfixed `every(3000, ...)` must not turn into 3000 seconds.
  it('is refused by durationMs and optionMs', () => {
    expect(() => durationMs(3000 as never)).toThrow('takes its unit')
    expect(() => durationMs(3000 as never)).toThrow('milliseconds since 1.88')
    expect(() => optionMs(3000 as never, '`every` interval')).toThrow('`every` interval is 3000')
    expect(() => optionMs(3000 as never, 'forgejo timeout')).toThrow('kay: forgejo timeout is 3000')
  })
})

describe('duration words', () => {
  it('words a lifetime in the largest unit it fills exactly, days from two on', () => {
    expect((['86400s', '7d', '3600s', '90m', '900s', '45s', '172801s'] as const).map(duration => durationWords(duration, 'en'))).toEqual(['24 hours', '7 days', '1 hour', '90 minutes', '15 minutes', '45 seconds', '172,801 seconds'])
  })

  it('picks the unit of a fractional duration as it does of the same time written whole', () => {
    expect(wholeSeconds('1.1h', 'x')).toBe(3960)
    expect(wholeSeconds('1.4d', 'x')).toBe(120_960)
    expect(wholeSeconds('0.0004s', 'x')).toBe(1)
    expect((['1.1h', '1.4d', '0.3h', '1.7h'] as const).map(duration => durationWords(duration, 'en'))).toEqual(['66 minutes', '2,016 minutes', '18 minutes', '102 minutes'])
  })

  it('takes a duration with its unit', () => {
    expect((['24h', '7d', '1h', '90m', '15m', '45s', '1500ms'] as const).map(duration => durationWords(duration, 'en'))).toEqual(['24 hours', '7 days', '1 hour', '90 minutes', '15 minutes', '45 seconds', '1.5 seconds'])
  })

  it('refuses a bare number of seconds', () => {
    expect(() => durationWords(86_400 as never, 'en')).toThrow('kay: durationWords() takes a duration with its unit, such as \'24h\' or \'90s\', not 86400; 86400 seconds is \'86400s\'')
  })

  it('words it in French, with its plurals', () => {
    expect((['24h', '7d', '1h', '2h', '10m', '1s'] as const).map(duration => durationWords(duration, 'fr').replace(/\s/g, ' '))).toEqual(['24 heures', '7 jours', '1 heure', '2 heures', '10 minutes', '1 seconde'])
  })

  it('falls back to English for a bad locale', () => {
    expect(durationWords('10m', 'not a locale')).toBe('10 minutes')
  })
})
