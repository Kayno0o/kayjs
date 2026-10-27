import type { RateStore } from 'kay'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { clientAddress, memoryRates, rateLimit, sqliteRates } from 'kay/server'
import { knownAddress } from '../src/server/protection'
import { sendFrom } from '../src/server/rewrite'
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
      // The 1 ms window really has to pass, which the store reads from the clock.
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

describe('a refund', () => {
  it('takes one attempt off the window it names, in memory and in SQLite, never below zero', async () => {
    for (const store of [memoryRates(), sqliteRates(join(await scratchDir('rates'), 'rates.sqlite'))]) {
      const { resetAt } = await store.hit('key', '60000ms', 3)

      await store.refund('key', resetAt)
      expect((await store.peek('key'))!.count).toBe(2)
      await store.refund('key', resetAt)
      await store.refund('key', resetAt)
      await store.refund('key', resetAt)
      expect((await store.peek('key'))!.count).toBe(0)
      // A key with no window opens none.
      await store.refund('other', resetAt)
      expect(await store.peek('other')).toBeUndefined()
    }
  })

  it('leaves a window that is not the one it names, as one reopened since is another', async () => {
    for (const store of [memoryRates(), sqliteRates(join(await scratchDir('rates'), 'rates.sqlite'))]) {
      const old = await store.hit('key', '1ms')

      await Bun.sleep(5)
      expect((await store.hit('key', '60000ms')).count).toBe(1)
      await store.refund('key', old.resetAt)
      expect((await store.peek('key'))!.count).toBe(1)
    }
  })
})

describe('a reset', () => {
  it('forgets the window of its key alone, in memory and in SQLite, the next hit opening a fresh one', async () => {
    for (const store of [memoryRates(), sqliteRates(join(await scratchDir('rates'), 'rates.sqlite'))]) {
      await store.hit('key', '60000ms', 3)
      await store.hit('other', '60000ms')
      await store.reset('key')
      expect(await store.peek('key')).toBeUndefined()
      expect((await store.peek('other'))!.count).toBe(1)
      expect((await store.hit('key', '60000ms')).count).toBe(1)
      await store.reset('none')
      expect(await store.peek('none')).toBeUndefined()
    }
  })
})

describe('the address of a request', () => {
  it('is unknown for a request with no socket, which clientAddress counts as one client', () => {
    const request = new Request('http://localhost/')

    expect(knownAddress(request, null)).toBeUndefined()
    expect(clientAddress(request, null)).toBe('unknown')
    sendFrom(request, '203.0.113.7')
    expect(knownAddress(request, null)).toBe('203.0.113.7')
  })
})
