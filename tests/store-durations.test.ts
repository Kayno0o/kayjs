import type { RateStore } from '../src/runtime/action'
import type { Duration } from '../src/runtime/duration'
import { describe, expect, it } from 'bun:test'
import { lengthFor, lengthMs } from '../src/runtime/store-base'
import { kv, memoryKv } from '../src/server/kv'
import { limiter, ratesFallingBack } from '../src/server/library'
import { memoryRates } from '../src/server/protection'

// A store that notes the length it is given on top of the store it wraps.
function watched(seen: unknown[]): RateStore {
  const inner = memoryRates()

  return {
    hit(key, window, weight) {
      seen.push(window)

      return inner.hit(key, window, weight)
    },
  }
}

describe('store durations', () => {
  it('hands a kv store every length as a Duration', async () => {
    const seen: unknown[] = []
    const inner = memoryKv()
    const store = {
      ...inner,
      async set(key: string, value: string, ttl?: Duration) {
        seen.push(ttl)

        return inner.set(key, value, ttl)
      },
      async once(key: string, ttl: Duration) {
        seen.push(ttl)

        return inner.once(key, ttl)
      },
    }

    await kv('ns', store).once('k', '5m')
    await kv('ns', store).set('j', 'v', '30s')
    expect(seen).toEqual(['300000ms', '30000ms'])
  })

  it('hands a rate store its window as a Duration', async () => {
    const seen: unknown[] = []
    const store = watched(seen)

    expect((await limiter({ max: 2, window: '1m', store, name: 'a', failure: 'refuse' }).hit('x')).count).toBe(1)
    expect((await ratesFallingBack('c', store).hit('y', '90s')).count).toBe(1)
    expect(seen).toEqual(['60000ms', '90000ms'])
    expect((await memoryRates().hit('z', '2s')).resetAt).toBeGreaterThan(Date.now())
  })

  it('reads a length as a Duration and refuses anything else', () => {
    expect(lengthMs('3s')).toBe(3000)
    expect(() => lengthMs('3 sec' as Duration)).toThrow('3 sec')
    expect(lengthFor(5)).toBe('5ms')
  })
})
