import type { RateStore } from '../src/runtime/action'
import type { Duration } from '../src/runtime/duration'
import { describe, expect, it } from 'bun:test'
import { lengthFor, lengthMs } from '../src/runtime/store-base'
import { kv, memoryKv } from '../src/server/kv'
import { limiter, ratesFallingBack } from '../src/server/library'
import { memoryRates } from '../src/server/protection'

// A store that notes the length it is given on top of the store it wraps, with `durations` as asked.
function watched(seen: unknown[], durations: boolean): RateStore {
  const inner = memoryRates()

  return {
    ...durations && { durations: true as const },
    hit(key, window, weight) {
      seen.push(window)

      return inner.hit(key, window, weight)
    },
  }
}

describe('store durations', () => {
  it('hands a kv store written before 1.105 milliseconds and one declaring durations a Duration', async () => {
    const seen: unknown[] = []

    for (const durations of [false, true]) {
      const inner = memoryKv()
      const store = {
        ...inner,
        ...durations && { durations: true as const },
        async set(key: string, value: string, ttl?: Duration | number) {
          seen.push(ttl)

          return inner.set(key, value, ttl)
        },
        async once(key: string, ttl: Duration | number) {
          seen.push(ttl)

          return inner.once(key, ttl)
        },
      }

      await kv('ns', store).once('k', '5m')
      await kv('ns', store).set('j', 'v', 30_000)
    }

    expect(seen).toEqual([300_000, 30_000, '300000ms', '30000ms'])
  })

  it('counts a rate window the same through either contract, and takes both in its own stores', async () => {
    const seen: unknown[] = []
    const legacy = watched(seen, false)
    const modern = watched(seen, true)

    expect((await limiter({ max: 2, window: '1m', store: legacy, name: 'a' }).hit('x')).count).toBe(1)
    expect((await limiter({ max: 2, window: '1m', store: modern, name: 'b', failure: 'refuse' }).hit('x')).count).toBe(1)
    expect((await ratesFallingBack('c', modern).hit('y', 90_000)).count).toBe(1)
    expect(seen).toEqual([60_000, '60000ms', '90000ms'])
    expect((await memoryRates().hit('z', '2s')).resetAt).toBeGreaterThan(Date.now())
  })

  it('reads a length as a Duration or milliseconds and refuses anything else', () => {
    expect(lengthMs('3s')).toBe(3000)
    expect(lengthMs(250)).toBe(250)
    expect(() => lengthMs('3 sec' as Duration)).toThrow('3 sec')
    expect(lengthFor({}, 5) as unknown).toBe(5)
    expect(lengthFor({ durations: true }, 5) as unknown).toBe('5ms')
  })
})
