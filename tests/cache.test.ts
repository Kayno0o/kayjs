import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { cached, invalidate } from '../src/runtime/cache'
import { pages } from '../src/server'
import { feed } from './fixtures/production/src/news'

afterEach(() => {
  setSystemTime()
  invalidate(() => true)
})

describe('cached', () => {
  it('loads once for concurrent misses and keeps the value for its ttl', async () => {
    let loads = 0
    const load = async () => {
      loads++
      await Bun.sleep(5)

      return loads
    }

    expect(await Promise.all([cached('a', 60, load), cached('a', 60, load)])).toEqual([1, 1])
    expect(await cached('a', 60, load)).toBe(1)
    expect(await cached('b', 60, load)).toBe(2)
  })

  it('gives the stale value past its ttl while refreshing it in the background', async () => {
    let edition = 1
    const load = () => edition

    expect(await cached('news', 60, load)).toBe(1)
    edition = 2
    setSystemTime(Date.now() + 61_000)
    expect(await cached('news', 60, load)).toBe(1)
    await Bun.sleep(0)
    expect(await cached('news', 60, load)).toBe(2)
  })

  it('keeps nothing from a first load that throws, and the stale value through a refresh that throws', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    let failing = true
    const load = () => {
      if (failing)
        throw new Error('down')

      return 'up'
    }

    try {
      await expect(cached('feed', 60, load)).rejects.toThrow('down')
      failing = false
      expect(await cached('feed', 60, load)).toBe('up')

      failing = true
      setSystemTime(Date.now() + 61_000)
      expect(await cached('feed', 60, load)).toBe('up')
      await Bun.sleep(0)
      expect(logged).toHaveBeenCalledTimes(1)
      // A minute before the next attempt, whatever the ttl.
      expect(await cached('feed', 60, load)).toBe('up')
      expect(logged).toHaveBeenCalledTimes(1)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('drops a key, or the keys a function matches, a load already running for one never landing', async () => {
    let value = 'old'
    const load = async () => value

    await Promise.all([cached('post:1', 60, load), cached('post:2', 60, load), cached('tags', 60, load)])
    value = 'new'
    invalidate(key => key.startsWith('post:'))
    expect(await cached('post:1', 60, load)).toBe('new')
    expect(await cached('tags', 60, load)).toBe('old')

    const running = cached('tags:slow', 60, async () => {
      await Bun.sleep(5)

      return 'slow'
    })

    invalidate('tags:slow')
    expect(await running).toBe('slow')
    expect(await cached('tags:slow', 60, load)).toBe('new')
  })

  it('refuses a ttl that is not a positive number of seconds', async () => {
    await expect(cached('x', 0, () => 1)).rejects.toThrow('takes a positive ttl in seconds')
  })

  it('shares a value across requests from a page\'s server fence', async () => {
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, security: false }))
    const visit = async () => (await app.handle(new Request('http://localhost/feed'))).text()

    feed.items = ['one']
    expect(await visit()).toContain('<p class="feed">one</p>')
    feed.items = ['two']
    expect(await visit()).toContain('<p class="feed">one</p>')
    invalidate('feed')
    expect(await visit()).toContain('<p class="feed">two</p>')
  })
})
