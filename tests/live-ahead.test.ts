import type { CacheStore } from '../src/runtime/cache'
import type { LiveRequest } from '../src/runtime/live-value'
import type { TestSite } from '../src/test'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { invalidate, trackStore, untrackStore } from '../src/runtime/cache'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { testSite } from '../src/test'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'

const ROOT = 'tests/fixtures/live-cache'
// How far ahead of this process's clock the other replica's is, within the few seconds a proof tolerates.
const AHEAD_MS = 3000

describe('a followed cached value, read by a process that heard of a clock ahead of its own', () => {
  let site: TestSite
  let heard: ((message: string) => void) | undefined
  const store: CacheStore = {
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
    keys: () => [],
    subscribe: (listener) => {
      heard = listener
    },
  }

  // The time the render of a page read the followed key, and the stamp a connection opened for it sends first.
  async function readAndSnapshot(): Promise<{ readAt: number, stamp: number }> {
    const { html } = await site.visit('/')
    const pages = pagesOf(html)
    const [[, , readAt]] = pages.flatMap(page => page.values.filter(([id]) => id === CACHE_LIVE_ID)) as [[string, string, number]]
    const feed = new Feed(await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pages), watch: [[CACHE_LIVE_ID, 'orders']] } satisfies LiveRequest) }))
    const [[, , stamp]] = await feed.next() as [[string, string, number]]

    await feed.close()

    return { readAt, stamp }
  }

  beforeAll(async () => {
    site = await testSite({ root: ROOT })
    trackStore(store)
  })

  afterAll(async () => {
    untrackStore(store)
    await site.close()
  })

  // Runs first: the clock a process heard of only ever moves forward, so every test after the skewed one meets it.
  it('dates a read by its own clock and an invalidation after it, when no clock is ahead', async () => {
    await site.visit('/')
    invalidate('orders')

    const before = Date.now()
    const { readAt, stamp } = await readAndSnapshot()

    expect(readAt).toBeGreaterThanOrEqual(before)
    expect(readAt).toBeLessThanOrEqual(Date.now() + 1)
    expect(stamp).toBeLessThan(readAt)

    invalidate('orders')

    const feed = new Feed(await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf((await site.visit('/')).html)), watch: [[CACHE_LIVE_ID, 'orders']] } satisfies LiveRequest) }))
    const [[, , latest]] = await feed.next() as [[string, string, number]]

    expect(latest).toBeGreaterThan(stamp)
    await feed.close()
  })

  it('dates a read after the invalidation another replica, whose clock is ahead, made known before it', async () => {
    await site.visit('/')
    heard!(JSON.stringify({ pages: [], at: Date.now() + AHEAD_MS }))
    invalidate('orders')

    const { readAt, stamp } = await readAndSnapshot()

    // A stamp at or after the read would refresh the page for an invalidation it already shows.
    expect(stamp).toBeLessThan(readAt)
  })

  it('stamps an invalidation after the read it follows, whichever clock dated them', async () => {
    const { html } = await site.visit('/')
    const pages = pagesOf(html)
    const [[, , readAt]] = pages.flatMap(page => page.values.filter(([id]) => id === CACHE_LIVE_ID)) as [[string, string, number]]
    const feed = new Feed(await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pages), watch: [[CACHE_LIVE_ID, 'orders']] } satisfies LiveRequest) }))

    await feed.next()
    invalidate('orders')

    const [[, , stamp]] = await feed.next() as [[string, string, number]]

    expect(stamp).toBeGreaterThanOrEqual(readAt)
    await feed.close()
  })
})
