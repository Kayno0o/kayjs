import type { RateStore } from 'kay'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { memoryRates, rateLimit, sqliteRates } from 'kay/server'
import { scratchDir } from './scratch'

describe('a weighted hit', () => {
  it('counts its weight in memory and in SQLite, one when given none', async () => {
    for (const store of [memoryRates(), sqliteRates(join(await scratchDir('rates'), 'rates.sqlite'))]) {
      expect((await store.hit('key', '60000ms', 5)).count).toBe(5)
      expect((await store.hit('key', '60000ms')).count).toBe(6)
      expect((await store.peek('key'))!.count).toBe(6)
    }
  })

  it('opens an expired window afresh with the weight, in SQLite as in memory', async () => {
    for (const store of [memoryRates(), sqliteRates(join(await scratchDir('rates'), 'rates.sqlite'))]) {
      await store.hit('key', '1ms', 5)
      await Bun.sleep(5)
      expect((await store.hit('key', '60000ms', 3)).count).toBe(3)
    }
  })

  it('counts against a limit of tokens rather than attempts', async () => {
    const budget = rateLimit('tokens', { max: 10, window: '1m' })

    expect(await budget.hit('visitor', undefined, 7)).toBeUndefined()
    expect(await budget.hit('visitor', undefined, 4)).toBeGreaterThan(0)
    expect(await budget.hit('other', undefined, 10)).toBeUndefined()
  })

  it('refuses a weight a store of its own ignores, and counts its hits of one as before', async () => {
    const counts = new Map<string, number>()
    const legacy: RateStore = {
      hit(key) {
        counts.set(key, (counts.get(key) ?? 0) + 1)

        return { count: counts.get(key)!, resetAt: Date.now() + 60_000 }
      },
    }
    const limit = rateLimit('legacy', { max: 2, window: '1m', store: legacy })

    expect(await limit.hit('a')).toBeUndefined()
    expect(await limit.hit('a')).toBeUndefined()
    expect(await limit.hit('a')).toBeGreaterThan(0)
    await expect(limit.hit('b', undefined, 5)).rejects.toThrow('weight')
  })

  it('takes a whole weight of at least 1', async () => {
    const limit = rateLimit('whole', { max: 10, window: '1m' })

    for (const weight of [0, -1, 1.5, Number.NaN])
      await expect(limit.hit('a', undefined, weight)).rejects.toThrow('weight')
  })
})
