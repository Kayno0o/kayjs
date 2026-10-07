import { describe, expect, it } from 'bun:test'
import { durationSeconds } from '../src/runtime/duration'

describe('durations', () => {
  it('reads seconds, or a number with its unit', () => {
    expect(['30s', '5m', '1.5h', '30d', '2w', 90, 0.5].map(value => durationSeconds(value, 'ttl'))).toEqual([30, 300, 5400, 2_592_000, 1_209_600, 90, 0.5])
  })

  it('refuses what is no positive duration, naming the option', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '0m', '-5m', '5', '5 m', '5min', '5M', 'm', '', null, undefined])
      expect(() => durationSeconds(value, 'ttl')).toThrow(/^kay: ttl is .+; it takes a positive duration, seconds or a string such as '5m', '12h' or '30d'$/)
  })
})
