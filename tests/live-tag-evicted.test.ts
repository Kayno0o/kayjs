import { describe, expect, it } from 'bun:test'
import { cache, cacheTag, invalidate } from '../src/runtime/cache'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { liveSlot, slotValue } from '../src/runtime/live-value'
import { inLiveReads } from '../src/server/live'

// What a followed key was last invalidated at, 0 for never.
function stampOf(key: string): number {
  return slotValue(liveSlot(CACHE_LIVE_ID)!, key) as number
}

// The followed keys, which a function that names none lets be.
function followedKeys(): string[] {
  const seen: string[] = []

  invalidate((key) => {
    seen.push(key)

    return false
  })

  return seen
}

describe('a tag invalidated while the cache no longer holds the value that named it', () => {
  it('reaches the followed key all the same', async () => {
    const tag = cacheTag()
    const rows = cache(async (id: number) => id, { ttl: '1m', tags: [tag], live: true, store: false, max: 1 })

    await inLiveReads(async () => rows(1))

    const [first] = followedKeys().filter(key => key.includes('[1'))

    // The second argument evicts the first from memory, the only place that knew it belonged to the tag.
    await inLiveReads(async () => rows(2))
    expect(first).toBeDefined()
    expect(stampOf(first!)).toBe(0)
    tag.invalidate()
    expect(stampOf(first!)).toBeGreaterThan(0)
  })
})
