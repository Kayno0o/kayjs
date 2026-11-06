import type { CachedFunction, CacheFunctionOptions, CacheStore, CacheTag } from '../src/runtime/cache'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { cache, cacheTag, invalidate, invalidateLocally, onKeysInvalidated, trackLoads, trackStore, untrackStore } from '../src/runtime/cache'
import { readsOf } from '../src/server/page-reads'
import { scratchDir } from './scratch'

afterEach(() => {
  setSystemTime()
  invalidate(() => true)
})

describe('cache', () => {
  it('takes stale: false and a fallback, a tag dropping the fallback it remembers', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const group = cacheTag()
    let failing = true
    let loads = 0

    const repos = cache(async (): Promise<string[]> => {
      loads++

      if (failing)
        throw new Error('down')

      return ['repo']
    }, { ttl: '1h', tags: [group], fallback: [] })

    try {
      expect(await repos()).toEqual([])
      expect(await repos()).toEqual([])
      expect(loads).toBe(1)
      failing = false
      group.invalidate()
      expect(await repos()).toEqual(['repo'])
    }
    finally {
      logged.mockRestore()
    }

    let edition = 1
    const feed = cache(() => edition, { ttl: '30s', stale: false })

    expect(await feed()).toBe(1)
    edition = 2
    setSystemTime(Date.now() + 31_000)
    expect(await feed()).toBe(2)
  })

  it('is dropped by invalidate() given the function, its tag or a collection-like object, as by their own invalidate', async () => {
    const group = cacheTag()
    let loads = 0
    const posts = cache(() => ++loads, { ttl: '5m', tags: [group] })
    const tagged = cache(() => ++loads, { ttl: '5m', tags: [group] })
    let dropped = 0

    expect(await posts()).toBe(1)
    invalidate(posts)
    expect(await posts()).toBe(2)
    expect(await tagged()).toBe(3)
    invalidate(group)
    expect(await posts()).toBe(4)
    expect(await tagged()).toBe(5)
    invalidate({ invalidate: () => void dropped++ })
    expect(dropped).toBe(1)
  })

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
    const first = cache(() => ++a, { ttl: '1m' })
    const second = cache(() => ++b, { ttl: '1m' })

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
    }, { ttl: '1m' })

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
    const one = cache(() => ++tagged, { ttl: '1m', tags: [group] })
    const two = cache(() => ++other, { ttl: '1m' })

    await one()
    await two()
    group.invalidate()
    expect(await one()).toBe(2)
    expect(await two()).toBe(1)
  })

  it('lets a render that read a cache function or its tag be refreshed by either invalidation', async () => {
    const group = cacheTag()
    const posts = cache(() => 1, { ttl: '1m', tags: [group] })
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
    const posts = cache(() => 'kept', { ttl: '1m', store, tags: [group] })

    await posts()
    expect(rows.size).toBe(1)
    group.invalidate()
    expect(rows.size).toBe(0)
  })

  it('keeps a value apart for arguments JSON would tell alike', async () => {
    const seen: unknown[] = []
    const echo = cache((value: unknown) => {
      seen.push(value)

      return seen.length
    }, { ttl: '1m' })

    await echo(undefined)
    await echo(null)
    await echo(new Date(0))
    await echo('1970-01-01T00:00:00.000Z')
    expect(seen).toHaveLength(4)
  })

  it('never keeps a value whose tag was dropped while the first load ran', async () => {
    const group = cacheTag()
    let value = 'old'
    const posts = cache(async () => {
      const seen = value

      await Bun.sleep(5)

      return seen
    }, { ttl: '1m', tags: [group] })

    const first = posts()

    value = 'new'
    group.invalidate()
    expect(await first).toBe('old')
    expect(await posts()).toBe('new')
  })

  it('tells the other processes of a bare invalidate when this one holds no value', () => {
    const sent: string[] = []
    const store: CacheStore = { get: () => undefined, set: () => undefined, delete: () => undefined, keys: () => [], publish: message => void sent.push(message), subscribe: () => undefined }
    const posts = cache(() => 1, { ttl: '1m', store })

    trackStore(store)
    posts.invalidate()
    untrackStore(store)
    expect(sent).toHaveLength(1)
  })

  it('makes a process holding values drop every arguments of a function another process invalidated bare', async () => {
    const sent: string[] = []
    let hear: ((message: string) => void) | undefined
    const store: CacheStore = { get: () => undefined, set: () => undefined, delete: () => undefined, keys: () => [], publish: message => void sent.push(message), subscribe: (listener) => {
      hear = listener
    } }
    let loads = 0
    const post = cache((slug: string) => `${slug}${++loads}`, { ttl: '1m', store })

    // The sender holds no value, as another process would not.
    trackStore(store)
    post.invalidate()
    untrackStore(store)
    expect(sent).toHaveLength(1)
    await post('a')
    await post('b')
    expect(loads).toBe(2)
    hear?.(sent[0]!)
    await post('a')
    await post('b')
    expect(loads).toBe(4)
  })

  it('writes a tag added since a row was stored into the row', async () => {
    const rows = new Map<string, { text: string, freshUntil: number }>()
    const store: CacheStore = { get: key => rows.get(key), set: (key, text, freshUntil) => void rows.set(key, { text, freshUntil }), delete: key => void rows.delete(key), keys: () => [...rows.keys()] }
    // The build passes an id as the last argument, which the types hide.
    const group = (cacheTag as unknown as (id: string) => CacheTag)('rewrite-group')
    const named = cache as unknown as (load: () => string, options: CacheFunctionOptions, id: string) => CachedFunction<[], string>

    await named(() => 'kept', { ttl: '1m', store }, 'rewrite')()
    expect(rows.get('cache:rewrite')?.text.startsWith('#deps ')).toBe(false)

    // A restart: memory is empty, the row stays, and the module now names a tag.
    const row = rows.get('cache:rewrite')!

    invalidateLocally('cache:rewrite')
    rows.set('cache:rewrite', row)
    expect(await named(() => 'other', { ttl: '1m', store, tags: [group] }, 'rewrite')()).toBe('kept')
    expect(rows.get('cache:rewrite')?.text.startsWith('#deps ')).toBe(true)
    group.invalidate()
    expect(rows.has('cache:rewrite')).toBe(false)
  })

  it('says an argument devalue cannot write is the cause', async () => {
    const post = cache((_value: unknown) => 1, { ttl: '1m' })

    await expect(post(() => 1)).rejects.toThrow('arguments devalue can write')
  })

  it('finds the calling module when its path holds a space and a parenthesis', async () => {
    const root = await scratchDir('cache-paren-')

    try {
      const dir = join(root, 'a (b)')

      await Bun.write(join(dir, 'app.ts'), `import { cache } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/cache'))}\n\nconst keys: string[] = []\nconst store = { get: () => undefined, set: (key: string) => void keys.push(key), delete: () => undefined, keys: () => [] }\nconst posts = cache(() => 1, { ttl: '1m', store })\n\nawait posts()\nconsole.log(keys[0])\n`)

      const run = Bun.spawn([process.execPath, join(dir, 'app.ts')], { stdout: 'pipe', stderr: 'pipe' })

      expect((await new Response(run.stdout).text()).trim()).toMatch(/^cache:.*a \(b\)\/app\.ts:\d+:\d+$/)
      await run.exited
      expect(run.exitCode).toBe(0)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps two caches apart without a build id, bundled with the module as an executable is', async () => {
    const root = await scratchDir('cache-bundle-')

    try {
      await Bun.write(join(root, 'app.ts'), `import { cache } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/cache'))}\n\nlet loads = 0\nconst make = (value: number) => cache(() => value + ++loads * 0, { ttl: '1m' })\nconst first = make(1)\nconst second = make(2)\nconst third = cache(() => 3, { ttl: '1m' })\n\nconsole.log(JSON.stringify([await first(), await third()]))\n`)

      const built = await Bun.build({ entrypoints: [join(root, 'app.ts')], outdir: join(root, 'out'), target: 'bun' })

      expect(built.success).toBe(true)

      const run = Bun.spawn([process.execPath, join(root, 'out/app.js')], { stdout: 'pipe', stderr: 'pipe' })

      expect(JSON.parse(await new Response(run.stdout).text()) as unknown).toEqual([1, 3])
      await run.exited
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  describe('max', () => {
    // Loads recorded by argument, so a test reads which values were dropped.
    function counted(max: number, store?: CacheStore) {
      const loaded: number[] = []
      const fn = cache(async (n: number) => {
        loaded.push(n)

        if (n < 0)
          throw new Error('down')

        return n
      }, { ttl: '1h', max, store: store ?? false })

      return { fn, loaded }
    }

    it('keeps the values loaded last and drops the oldest past it', async () => {
      const { fn, loaded } = counted(2)

      await fn(1)
      await fn(2)
      await fn(3)
      await fn(2)
      await fn(3)
      expect(loaded).toEqual([1, 2, 3])
      await fn(1)
      expect(loaded).toEqual([1, 2, 3, 1])
    })

    it('starts the count again after fn.invalidate()', async () => {
      const { fn, loaded } = counted(2)

      await fn(1)
      await fn(2)
      fn.invalidate()
      await fn(3)
      await fn(4)
      await fn(3)
      await fn(4)
      expect(loaded).toEqual([1, 2, 3, 4])
    })

    it('counts concurrent loads of one key once', async () => {
      const { fn, loaded } = counted(2)

      await Promise.all([fn(1), fn(1), fn(1), fn(2)])
      await fn(1)
      await fn(2)
      expect(loaded).toEqual([1, 2])
    })

    it('survives an invalidate during a load', async () => {
      const gate = Promise.withResolvers<void>()
      const loaded: number[] = []
      const slow = cache(async (n: number) => {
        loaded.push(n)
        await gate.promise

        return n
      }, { ttl: '1h', max: 1, store: false })

      const first = slow(1)

      slow.invalidate(1)
      gate.resolve()
      await first
      await slow(2)
      await slow(2)
      expect(loaded.filter(n => n === 2)).toEqual([2])
    })

    it('holds no place for a load that failed, so it never evicts a loaded value', async () => {
      const { fn, loaded } = counted(2)

      await fn(1)
      await fn(2)
      await expect(fn(-1)).rejects.toThrow('down')
      await expect(fn(-2)).rejects.toThrow('down')
      await fn(1)
      await fn(2)
      expect(loaded.filter(n => n > 0)).toEqual([1, 2])
    })

    it('stays within the cap when a store reads concurrently, and leaves the stored rows', async () => {
      const rows = new Map<string, { text: string, freshUntil: number }>()
      let reads = 0

      const store: CacheStore = {
        get: async (key) => {
          reads++
          await Bun.sleep(1)

          return rows.get(key)
        },
        set: (key, text, freshUntil) => void rows.set(key, { text, freshUntil }),
        delete: key => void rows.delete(key),
        keys: () => [...rows.keys()],
      }

      const { fn } = counted(3, store)

      await Promise.all(Array.from({ length: 12 }, async (_, n) => fn(n)))
      expect(rows.size).toBe(12)
      reads = 0
      await Promise.all([fn(11), fn(10), fn(9)])
      expect(reads).toBe(0)
      await fn(0)
      expect(reads).toBe(1)
    })

    it('drops a value from memory without telling a page, a dependent or the other processes', async () => {
      const told: string[] = []
      const sent: string[] = []
      const rows = new Map<string, { text: string, freshUntil: number }>()

      const store: CacheStore = {
        get: key => rows.get(key),
        set: (key, text, freshUntil) => void rows.set(key, { text, freshUntil }),
        delete: key => void rows.delete(key),
        keys: () => [...rows.keys()],
        publish: message => void sent.push(message),
        subscribe: () => undefined,
      }

      const off = onKeysInvalidated((_matches, dropped) => {
        told.push(...[...rows.keys()].filter(dropped))

        return []
      })

      // The build adds the module's id as a third argument, which the type keeps from apps.
      const named = cache as unknown as <A extends unknown[], T>(load: (...args: A) => Promise<T>, options: CacheFunctionOptions, id: string) => CachedFunction<A, T>
      const parent = named(async (n: number) => n, { ttl: '1h', max: 1, store }, 'max-parent')
      let child = 0
      const dependent = named(async () => ++child, { ttl: '1h', store: false }, 'max-child')
      const key = `cache:max-parent${stringify([1])}`

      try {
        await parent(1)
        trackLoads(async load => ({ result: await load(), reads: [key] }))
        await dependent()
        sent.length = 0
        told.length = 0
        await parent(2)
        await parent(3)
        expect(told).toEqual([])
        expect(sent).toEqual([])
        expect(rows.has(key)).toBe(true)
        expect(await dependent()).toBe(1)
      }
      finally {
        trackLoads(async load => ({ result: await load(), reads: [] }))
        off()
      }
    })

    it('refuses a max that is not a positive whole number', () => {
      for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
        expect(() => cache(() => 1, { ttl: '1m', max })).toThrow('max')
    })
  })

  it('reloads from the load, not the stored row, after a max eviction, and writes the fresh row', async () => {
    const rows = new Map<string, { text: string, freshUntil: number }>()

    const store: CacheStore = {
      get: key => rows.get(key),
      set: (key, text, freshUntil) => void rows.set(key, { text, freshUntil }),
      delete: key => void rows.delete(key),
      keys: () => [...rows.keys()],
    }

    let loads = 0
    const fn = cache(async (n: number) => `${n}:${++loads}`, { ttl: '1h', max: 1, store })

    expect(await fn(1)).toBe('1:1')
    expect(await fn(2)).toBe('2:2')
    // 1 is gone from memory, its row stays.
    expect(await fn(1)).toBe('1:1')
    await fn(2)
    expect(await fn.reload(1)).toBe('1:3')
    expect([...rows.values()].some(row => row.text.includes('1:3'))).toBe(true)
    expect(await fn(1)).toBe('1:3')
  })

  it('reloads a value once for the callers asking while it loads, keeping the old one if the load throws', async () => {
    let loads = 0
    let failing = false

    const fn = cache(async (n: number) => {
      loads++
      await Bun.sleep(5)

      if (failing)
        throw new Error('down')

      return `${n}:${loads}`
    }, { ttl: '1h', store: false, stale: false })

    expect(await fn(1)).toBe('1:1')
    expect(await Promise.all([fn.reload(1), fn.reload(1), fn.reload(1)])).toEqual(['1:2', '1:2', '1:2'])
    expect(loads).toBe(2)
    failing = true
    await expect(fn.reload(1)).rejects.toThrow('down')
    expect(await fn(1)).toBe('1:2')
  })

  it('refuses a tag it did not make', () => {
    expect(() => cache(() => 1, { ttl: '1m', tags: [{ invalidate: () => undefined } as CacheTag] })).toThrow('cacheTag()')
  })
})
