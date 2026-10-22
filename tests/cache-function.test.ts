import type { CacheStore } from '../src/runtime/cache'
import { afterEach, describe, expect, it } from 'bun:test'
import { cache, cacheTag, invalidate, onKeysInvalidated } from '../src/runtime/cache'
import { readsOf } from '../src/server/page-reads'

afterEach(() => {
  invalidate(() => true)
})

describe('cache', () => {
  it('keeps a value per call site and drops it with its own invalidate', async () => {
    let loads = 0
    const posts = cache(() => ++loads, { ttl: '5m' })

    expect(await posts()).toBe(1)
    expect(await posts()).toBe(1)
    posts.invalidate()
    expect(await posts()).toBe(2)
  })

  it('gives two caches their own keys', async () => {
    let a = 0
    let b = 0
    const first = cache(() => ++a, { ttl: 60 })
    const second = cache(() => ++b, { ttl: 60 })

    await first()
    await second()
    first.invalidate()
    await first()
    await second()
    expect([a, b]).toEqual([2, 1])
  })

  it('keeps a value per arguments, dropping one or all', async () => {
    const loads: string[] = []
    const post = cache((slug: string) => {
      loads.push(slug)

      return slug
    }, { ttl: 60 })

    await post('a')
    await post('b')
    await post('a')
    post.invalidate('a')
    await post('a')
    await post('b')
    expect(loads).toEqual(['a', 'b', 'a'])
    post.invalidate()
    await post('a')
    await post('b')
    expect(loads).toEqual(['a', 'b', 'a', 'a', 'b'])
  })

  it('drops every value naming a tag, and only those', async () => {
    const group = cacheTag()
    let tagged = 0
    let other = 0
    const one = cache(() => ++tagged, { ttl: 60, tags: [group] })
    const two = cache(() => ++other, { ttl: 60 })

    await one()
    await two()
    group.invalidate()
    expect(await one()).toBe(2)
    expect(await two()).toBe(1)
  })

  it('lets a render that read a cache function or its tag be refreshed by either invalidation', async () => {
    const group = cacheTag()
    const posts = cache(() => 1, { ttl: 60, tags: [group] })
    const { reads } = await readsOf(async () => posts())

    expect(reads).toHaveLength(2)

    let hits = 0
    const stop = onKeysInvalidated((matches) => {
      if (reads.some(read => matches(read)))
        hits++

      return []
    })

    posts.invalidate()
    group.invalidate()
    stop()
    expect(hits).toBe(2)
  })

  it('keeps tagged values in a store and drops their rows with the tag', async () => {
    const rows = new Map<string, { text: string, freshUntil: number }>()
    const store: CacheStore = { get: key => rows.get(key), set: (key, text, freshUntil) => void rows.set(key, { text, freshUntil }), delete: key => void rows.delete(key), keys: () => [...rows.keys()] }
    const group = cacheTag()
    const posts = cache(() => 'kept', { ttl: 60, store, tags: [group] })

    await posts()
    expect(rows.size).toBe(1)
    group.invalidate()
    expect(rows.size).toBe(0)
  })

  it('refuses a tag it did not make', () => {
    expect(() => cache(() => 1, { ttl: 60, tags: [{ invalidate: () => undefined }] })).toThrow('cacheTag()')
  })
})
