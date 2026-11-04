import type { RateStore } from '../src/runtime/action'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { memoryRates } from 'kay/server'
import { setupStore } from '../src/server/app-store'
import { limiter } from '../src/server/protection'

// A store as an app writes one: counting by `hit` alone.
function hitOnly(): RateStore {
  return { hit: memoryRates().hit }
}

afterEach(() => setupStore(undefined))

describe('limiter', () => {
  it('counts, peeks without counting, resets and enforces on a store with all of them', async () => {
    const limit = limiter({ max: 2, window: '1m', store: memoryRates() })

    expect(await limit.peek('a')).toBeUndefined()
    expect(await limit.enforce('a')).toBeUndefined()
    expect(await limit.enforce('a')).toBeUndefined()
    expect(await limit.enforce('a')).toBeGreaterThan(0)
    expect((await limit.peek('a'))?.count).toBe(3)
    expect((await limit.peek('a'))?.count).toBe(3)
    await limit.reset('a')
    expect(await limit.peek('a')).toBeUndefined()
    expect(await limit.enforce('a')).toBeUndefined()
  })

  it('derives peek and reset for a store that has only hit', async () => {
    const limit = limiter({ max: 5, window: '1m', store: hitOnly() })

    expect(await limit.peek('a')).toBeUndefined()
    await limit.hit('a', 3)
    expect((await limit.peek('a'))?.count).toBe(3)
    expect((await limit.hit('a')).count).toBe(4)
    await limit.reset('a')
    expect(await limit.peek('a')).toBeUndefined()
    expect((await limit.hit('a')).count).toBe(1)
    await limit.reset('never')
  })

  it('keeps the counts of limiters with different names apart in one store', async () => {
    const store = memoryRates()
    const first = limiter({ max: 5, window: '1m', store, name: 'first' })
    const second = limiter({ max: 5, window: '1m', store, name: 'second' })

    await first.hit('k')
    expect(await second.peek('k')).toBeUndefined()
  })

  it('counts in the app\'s store.rates, read at each call, else in its memory', async () => {
    const limit = limiter({ max: 5, window: '1m', name: 'late' })
    const shared = memoryRates()
    const hit = spyOn(shared, 'hit')

    await limit.hit('k')
    setupStore({ rates: shared })
    await limit.hit('k')
    expect(hit).toHaveBeenCalledWith('late\nk', 60_000, undefined)
  })

  it('counts in the memory it is given when no store is there', async () => {
    const memory = memoryRates()
    const hit = spyOn(memory, 'hit')

    await limiter({ max: 1, window: '1m', memory }).hit('k')
    expect(hit).toHaveBeenCalledTimes(1)
  })

  it('falls back to memory on a failing store, or lets the failure through with failure: refuse', async () => {
    const gone = (): never => {
      throw new Error('the database went away')
    }
    const store: RateStore = { hit: gone, peek: gone, reset: gone }
    const warned = spyOn(console, 'warn').mockReturnValue()

    try {
      const counting = limiter({ max: 1, window: '1m', store, name: 'fallback' })

      expect((await counting.hit('k')).count).toBe(1)
      expect((await counting.hit('k')).count).toBe(2)
      await expect(limiter({ max: 1, window: '1m', store, failure: 'refuse' }).hit('k')).rejects.toThrow('database went away')
    }
    finally {
      warned.mockRestore()
    }
  })

  it('refunds only where the store can', async () => {
    const full = limiter({ max: 3, window: '1m', store: memoryRates() })
    const { resetAt } = await full.hit('k')

    expect(await full.refund('k', resetAt)).toBe(true)
    expect((await full.peek('k'))?.count).toBe(0)
    expect(await limiter({ max: 3, window: '1m', store: hitOnly() }).refund('k', resetAt)).toBe(false)
  })

  it('refuses a max or a window it cannot read', () => {
    expect(() => limiter({ max: 0, window: '1m' })).toThrow('whole number')
    expect(() => limiter({ max: 1, window: 'soon' as never })).toThrow('window')
  })
})

describe('a derived reset', () => {
  it('never leaves a negative count when the window closed between its two calls', async () => {
    const memory = memoryRates()
    let first = true
    const racing: RateStore = {
      async hit(key, window, weight) {
        // The window closes right after the peek read it.
        if (weight !== undefined && weight < 0 && first) {
          first = false
          await memory.reset(key)
        }

        return memory.hit(key, window, weight)
      },
    }
    const limit = limiter({ max: 5, window: '1m', store: racing })

    await limit.hit('k', 3)
    await limit.reset('k')
    expect((await limit.hit('k')).count).toBe(1)
  })
})
