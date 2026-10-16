import type { CacheStore } from '../src/runtime/cache'
import type { ServedPage } from '../src/server/render'
import { afterEach, describe, expect, it } from 'bun:test'
import { cached, invalidate, noteRead, onKeysInvalidated } from '../src/runtime/cache'
import { readsOf } from '../src/server/page-reads'
import { revalidateStale } from '../src/server/revalidate'
import { invalidationCount, revalidationOf, trackPrerendered } from '../src/server/stale-pages'

afterEach(() => {
  invalidate(() => true)
})

// A store kept in memory, shared the way a SQLite file is, whose `publish` reaches every other store sharing the bus.
function memoryStore(rows = new Map<string, { text: string, freshUntil: number }>(), bus = new Set<(message: string) => void>()) {
  let listener: ((message: string) => void) | undefined
  const store: CacheStore = {
    get: key => rows.get(key),
    set: (key, text, freshUntil) => void rows.set(key, { text, freshUntil }),
    delete: key => void rows.delete(key),
    keys: () => [...rows.keys()],
    publish: (message) => {
      for (const other of bus) {
        if (other !== listener)
          other(message)
      }
    },
    subscribe: (next) => {
      listener = next
      bus.add(next)
    },
  }

  return { store, rows, bus }
}

function fakePage(reads: string[] | undefined): ServedPage {
  return { reads, html: 'one', status: 200, headers: [], etag: '', renderedAt: Date.now() } as unknown as ServedPage
}

// A cache module of its own, as a process that restarted has.
async function restart(tag: string): Promise<typeof import('../src/runtime/cache')> {
  return import(`../src/runtime/cache.ts?${tag}`) as Promise<typeof import('../src/runtime/cache')>
}

describe('a value restored from a store keeps what it was built from', () => {
  it('drops it when a collection it read is invalidated', async () => {
    const { store } = memoryStore()
    const before = await restart('before')

    before.trackLoads(async load => ({ result: await load(), reads: ['collection:news'] }))
    expect(await before.cached('latest', 600, () => 'one', { store })).toBe('one')

    const after = await restart('after')
    let loads = 0
    const load = () => ++loads

    expect(await after.cached('latest', 600, () => 'restored', { store })).toBe('one')
    after.invalidate('collection:news')
    expect(await after.cached('latest', 600, load, { store })).toBe(1)
    expect(store.get('latest')?.text).not.toContain('collection:news')
  })

  it('is dropped by an invalidation that comes before anything read it', async () => {
    const { store } = memoryStore()
    const before = await restart('early-before')

    before.trackLoads(async load => ({ result: await load(), reads: ['collection:news'] }))
    await before.cached('latest', 600, () => 'one', { store })

    const after = await restart('early-after')

    after.trackStore(store)
    after.invalidate('collection:news')
    expect(store.keys()).toEqual([])
    expect(await after.cached('latest', 600, () => 'two', { store })).toBe('two')
  })

  it('is dropped by any invalidation when it read more than the server tracks', async () => {
    const { store } = memoryStore()
    const before = await restart('all-before')

    before.trackLoads(async load => ({ result: await load(), reads: [before.ALL_READS] }))
    await before.cached('many', 600, () => 'one', { store })

    const after = await restart('all-after')

    after.trackStore(store)
    after.invalidate('anything')
    expect(store.keys()).toEqual([])
  })

  it('still reads a value an older kay stored, with no reads', async () => {
    const { store } = memoryStore()
    const old = await restart('old')

    old.trackLoads(async load => ({ result: await load(), reads: [] }))
    await old.cached('plain', 600, () => ({ n: 1 }), { store })

    const after = await restart('plain-after')

    expect(await after.cached('plain', 600, () => ({ n: 2 }), { store })).toEqual({ n: 1 })
  })

  it('hands the reads to the page that hits the restored value', async () => {
    const { store } = memoryStore()
    const before = await restart('hands-before')

    before.trackLoads(async load => ({ result: await load(), reads: ['collection:news'] }))
    await before.cached('latest', 600, () => 'one', { store })

    const after = await restart('hands-after')
    const seen: string[] = []

    after.onRead(key => seen.push(key))
    await after.cached('latest', 600, () => 'two', { store })
    expect(seen).toEqual(['latest', 'collection:news'])
  })
})

describe('a key invalidated in another process', () => {
  it('marks the pages that read it stale, as heard() does', async () => {
    const bus = new Set<(message: string) => void>()
    const mine = memoryStore(undefined, bus)
    const theirs = memoryStore(mine.rows, bus)
    const page = fakePage(['k'])
    const untouched = fakePage(['other'])

    trackPrerendered(new Map([['/a', page], ['/b', untouched]]))
    await cached('k', 600, () => 1, { store: mine.store })

    const before = invalidationCount()

    // The other process drops the key and tells this one.
    theirs.store.publish!(JSON.stringify({ keys: ['k'] }))
    expect(revalidationOf(page).invalidatedAt).toBeGreaterThan(before)
    expect(revalidationOf(untouched).invalidatedAt).toBe(0)
  })
})

describe('a render that newly reads a key invalidated while it runs', () => {
  it('reports it, and the page is rendered again', async () => {
    const page = fakePage(['k1'])
    let renders = 0

    trackPrerendered(new Map([['/p', page]]))
    invalidate('k1')

    await revalidateStale(page, async () => {
      renders++
      noteRead('k2')

      // Invalidated after the render read it, before it landed: the page's `reads` has no k2 yet.
      if (renders === 1)
        invalidate('k2')

      return new Response(`render ${renders}`)
    }, () => undefined)

    expect(renders).toBe(2)
    expect(page.html).toBe('render 2')
    expect(page.reads).toEqual(['k2'])
  })

  it('does not keep a cached value whose load read a key invalidated meanwhile, and the page is rendered again', async () => {
    const page = fakePage(undefined)
    let loads = 0
    let renders = 0

    trackPrerendered(new Map([['/c', page]]))
    page.reads = ['unrelated']
    invalidate('unrelated')

    await revalidateStale(page, async () => {
      renders++
      await cached('built', 600, async () => {
        noteRead('collection:news')

        if (loads === 0)
          invalidate('collection:news')

        return ++loads
      })

      return new Response(`render ${renders}`)
    }, () => undefined)

    expect(renders).toBe(2)
    expect(await cached('built', 600, () => 99)).toBe(2)
  })

  it('names the invalidation in what readsOf gives back', async () => {
    const { invalidated } = await readsOf(async () => {
      noteRead('a')
      invalidate('b')
      invalidate('a')
    })

    expect(invalidated).toBe(true)
    expect((await readsOf(async () => noteRead('a'))).invalidated).toBe(false)
  })
})

describe('a page reading many keys', () => {
  it('keeps a bounded list, refreshed by any invalidation', async () => {
    const { reads } = await readsOf(async () => {
      for (let index = 0; index < 5000; index++)
        noteRead(`key:${index}`)
    })

    expect(reads.length).toBeLessThan(500)

    const page = fakePage(reads)

    trackPrerendered(new Map([['/many', page]]))
    invalidate('unrelated')
    expect(revalidationOf(page).invalidatedAt).toBeGreaterThan(0)
  })
})

describe('onKeysInvalidated', () => {
  it('stops hearing once the listener it gave back is called', () => {
    let heard = 0
    const stop = onKeysInvalidated(() => {
      heard++

      return []
    })

    invalidate('a')
    stop()
    invalidate('a')
    expect(heard).toBe(1)
  })
})
