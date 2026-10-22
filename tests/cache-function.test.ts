import type { CacheStore, CacheTag } from '../src/runtime/cache'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { cache, cacheTag, invalidate, onKeysInvalidated, trackStore, untrackStore } from '../src/runtime/cache'
import { readsOf } from '../src/server/page-reads'
import { scratchDir } from './scratch'

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

  it('keeps a value apart for arguments JSON would tell alike', async () => {
    const seen: unknown[] = []
    const echo = cache((value: unknown) => {
      seen.push(value)

      return seen.length
    }, { ttl: 60 })

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
    }, { ttl: 60, tags: [group] })

    const first = posts()

    value = 'new'
    group.invalidate()
    expect(await first).toBe('old')
    expect(await posts()).toBe('new')
  })

  it('tells the other processes of a bare invalidate when this one holds no value', () => {
    const sent: string[] = []
    const store: CacheStore = { get: () => undefined, set: () => undefined, delete: () => undefined, keys: () => [], publish: message => void sent.push(message), subscribe: () => undefined }
    const posts = cache(() => 1, { ttl: 60, store })

    trackStore(store)
    posts.invalidate()
    untrackStore(store)
    expect(sent).toHaveLength(1)
  })

  it('keeps two caches apart without a build id, bundled with the module as an executable is', async () => {
    const root = await scratchDir('cache-bundle-')

    try {
      await Bun.write(join(root, 'app.ts'), `import { cache } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/cache'))}\n\nlet loads = 0\nconst make = (value: number) => cache(() => value + ++loads * 0, { ttl: 60 })\nconst first = make(1)\nconst second = make(2)\nconst third = cache(() => 3, { ttl: 60 })\n\nconsole.log(JSON.stringify([await first(), await third()]))\n`)

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

  it('refuses a tag it did not make', () => {
    expect(() => cache(() => 1, { ttl: 60, tags: [{ invalidate: () => undefined } as CacheTag] })).toThrow('cacheTag()')
  })
})
