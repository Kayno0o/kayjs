import type { RateStore } from '../src/runtime/action'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it, jest, setSystemTime, spyOn } from 'bun:test'
import { Elysia, t } from 'elysia'
import { sqliteCache } from '../src/runtime/cache.server'
import { logSink, setLogSink } from '../src/runtime/log'
import { solveWork } from '../src/runtime/work'
import { setupStore } from '../src/server/app-store'
import { countWrites } from '../src/server/kept-pages'
import { TimeoutError } from '../src/server/pg-poll'
import { apiLimitWait, countSucceeded, memoryRates, overLimit, protectionRefusal, rateLimit, refundRateLimit } from '../src/server/protection'
import { memoryRooms, sqliteRooms } from '../src/server/rooms'
import { signWork } from '../src/server/work'
import { verifyWork, workChallenge } from '../src/server/work-scope'
import { eventually } from './helpers/eventually'
import { scratchDir } from './scratch'

afterEach(() => {
  setSystemTime()
  setupStore(undefined)
})

// A rates store that keeps its windows where a test can see them, as another replica's would be shared.
function sharedRates(): RateStore & { keys: Set<string> } {
  const inner = memoryRates()
  const keys = new Set<string>()

  return {
    keys,
    hit(key, window, weight) {
      keys.add(key)

      return inner.hit(key, window, weight)
    },
    peek: key => inner.peek(key),
  }
}

describe('overLimit', () => {
  it('counts in the app store\'s rates, so replicas sharing it share the count', async () => {
    const rates = sharedRates()

    setupStore({ rates })
    expect(await overLimit('gaps-shared', '10.0.0.1', 2, 60_000)).toBeUndefined()
    expect(await overLimit('gaps-shared', '10.0.0.1', 2, 60_000)).toBeUndefined()
    expect(await overLimit('gaps-shared', '10.0.0.1', 2, 60_000)).toBeGreaterThan(0)
    expect(rates.keys.size).toBe(1)
  })

  it('counts in this process\'s memory with no app store, and when the rates store fails', async () => {
    expect(await overLimit('gaps-memory', '10.0.0.2', 1, 60_000)).toBeUndefined()
    expect(await overLimit('gaps-memory', '10.0.0.2', 1, 60_000)).toBeGreaterThan(0)

    setupStore({ rates: { hit: () => {
      throw new Error('the database went away')
    } } })
    expect(await overLimit('gaps-failing', '10.0.0.3', 1, 60_000)).toBeUndefined()
    expect(await overLimit('gaps-failing', '10.0.0.3', 1, 60_000)).toBeGreaterThan(0)
  })
})

describe('overLimit with a rates store that hangs', () => {
  it('counts in memory once the store time limit passes, and logs it once', async () => {
    jest.useFakeTimers()

    const log = spyOn(console, 'warn').mockReturnValue()

    try {
      setupStore({ rates: { hit: async () => new Promise<never>(Function.prototype as never) } })

      const first = overLimit('gaps-hanging', '10.0.0.4', 1, 60_000)

      jest.advanceTimersByTime(8_000)
      expect(await first).toBeUndefined()

      const second = overLimit('gaps-hanging', '10.0.0.4', 1, 60_000)

      jest.advanceTimersByTime(8_000)
      expect(await second).toBeGreaterThan(0)
      expect(log.mock.calls.filter(call => String(call[0]).includes('gaps-hanging'))).toHaveLength(1)

      // The store is left alone for a while, so this request is not held at all.
      expect(await overLimit('gaps-hanging', '10.0.0.6', 1, 60_000)).toBeUndefined()
      expect(await overLimit('gaps-hanging', '10.0.0.6', 1, 60_000)).toBeGreaterThan(0)
    }
    finally {
      jest.useRealTimers()
      log.mockRestore()
    }
  })
})

describe('overLimit after a store gave up by itself', () => {
  it('leaves a store that threw a TimeoutError alone for a while', async () => {
    const log = spyOn(console, 'warn').mockReturnValue()
    let calls = 0

    try {
      setupStore({ rates: { hit: async () => {
        calls++

        throw new TimeoutError('too slow')
      } } })
      await overLimit('gaps-gave-up', '10.0.0.7', 5, 60_000)
      await overLimit('gaps-gave-up', '10.0.0.7', 5, 60_000)
      expect(calls).toBe(1)
    }
    finally {
      log.mockRestore()
    }
  })
})

describe('overLimit logging', () => {
  it('logs again when the store failed after it answered', async () => {
    const log = spyOn(console, 'warn').mockReturnValue()
    let broken = true

    try {
      setupStore({ rates: { hit: async () => {
        if (broken)
          throw new Error('gone')

        return { count: 1, resetAt: Date.now() + 60_000 }
      } } })
      await overLimit('gaps-relog', '10.0.0.5', 5, 60_000)
      await overLimit('gaps-relog', '10.0.0.5', 5, 60_000)
      broken = false
      await overLimit('gaps-relog', '10.0.0.5', 5, 60_000)
      broken = true
      await overLimit('gaps-relog', '10.0.0.5', 5, 60_000)
      expect(log.mock.calls.filter(call => String(call[0]).includes('gaps-relog'))).toHaveLength(2)
    }
    finally {
      log.mockRestore()
    }
  })
})

// A store that throws on every call, counting them.
function brokenRates(): RateStore & { calls: number } {
  const store = {
    calls: 0,
    hit: () => {
      store.calls++

      throw new Error('the database went away')
    },
    peek: () => {
      store.calls++

      throw new Error('the database went away')
    },
  }

  return store
}

function warnings(name: string): { count: () => number, restore: () => void } {
  const log = spyOn(console, 'warn').mockReturnValue()

  return { count: () => log.mock.calls.filter(call => String(call[0]).includes(name)).length, restore: () => log.mockRestore() }
}

const refusalOptions = { body: {}, form: false, server: null, plain: false }

describe('a rates store that fails, given to a limit or the app\'s', () => {
  it('counts rateLimit() in memory and logs once', async () => {
    const seen = warnings('gaps-limiter')

    try {
      const limiter = rateLimit('gaps-limiter', { max: 1, window: '1m', store: brokenRates() })

      expect(await limiter.hit('one')).toBeUndefined()
      expect(await limiter.hit('one')).toBeGreaterThan(0)
      expect(seen.count()).toBe(1)

      setupStore({ rates: brokenRates() })

      const shared = rateLimit('gaps-limiter-app', { max: 1, window: '1m' })

      expect(await shared.hit('one')).toBeUndefined()
      expect(await shared.hit('one')).toBeGreaterThan(0)
    }
    finally {
      seen.restore()
    }
  })

  it('counts an API route\'s limit in memory', async () => {
    const seen = warnings('gaps-api')

    try {
      const limits = [{ name: 'gaps-api', limit: { max: 1, window: '1m' as const, store: brokenRates() } }]
      const request = () => new Request('http://localhost/api/items')
      const context = () => ({ request: request(), locale: 'en', cookies: new Bun.CookieMap(''), locals: {} }) as never

      expect(await apiLimitWait(limits, request(), null, context)).toBeUndefined()
      expect(await apiLimitWait(limits, request(), null, context)).toBeGreaterThan(0)
      expect(seen.count()).toBe(1)
    }
    finally {
      seen.restore()
    }
  })

  it('counts an action\'s limits in memory, those on the posts that went through and their refunds included', async () => {
    const seen = warnings('/_kay/action/gaps')

    try {
      const broken = { ...brokenRates(), refund: () => {
        throw new Error('the database went away')
      } }
      const tried = { url: '/_kay/action/gaps', protection: { rateLimit: { max: 2, window: '1m', store: broken } } } as never
      const succeeded = { url: '/_kay/action/gaps-ok', protection: { rateLimit: { max: 1, window: '1m', count: 'succeeded', store: brokenRates() } } } as never
      const request = () => new Request('http://localhost/_kay/action/gaps', { method: 'POST' })

      expect(await protectionRefusal(tried, request(), refusalOptions)).toBeUndefined()

      const refunded = request()

      expect(await protectionRefusal(tried, refunded, refusalOptions)).toBeUndefined()
      await refundRateLimit(refunded)
      // The refund took the second attempt back off the memory count, so a third fits.
      expect(await protectionRefusal(tried, request(), refusalOptions)).toBeUndefined()
      expect(await protectionRefusal(tried, request(), refusalOptions)).toMatchObject({ status: 429 })

      expect(await protectionRefusal(succeeded, request(), refusalOptions)).toBeUndefined()
      await countSucceeded(succeeded, request(), null)
      expect(await protectionRefusal(succeeded, request(), refusalOptions)).toMatchObject({ status: 429 })
      expect(seen.count()).toBe(2)
    }
    finally {
      seen.restore()
    }
  })

  it('still refuses a limit on the posts that went through when the store has no peek', async () => {
    const action = { url: '/_kay/action/gaps-peekless', protection: { rateLimit: { max: 1, window: '1m', count: 'succeeded', store: { hit: memoryRates().hit } } } } as never

    await expect(protectionRefusal(action, new Request('http://localhost/', { method: 'POST' }), refusalOptions)).rejects.toThrow('peek')
  })

  it('refuses a replayed proof of work from memory', async () => {
    const seen = warnings('gaps-work')

    try {
      const url = '/_kay/action/gaps-work'
      const action = { url, protection: { proofOfWork: { difficulty: 50, store: brokenRates() } } } as never
      const solved = solveWork(signWork(url, 50, 60_000))!
      const request = () => new Request(`http://localhost${url}`, { method: 'POST', headers: { 'x-kay-work': solved } })

      expect(await protectionRefusal(action, request(), refusalOptions)).toBeUndefined()
      expect(await protectionRefusal(action, request(), refusalOptions)).toMatchObject({ status: 422 })

      const scoped = solveWork(workChallenge('gaps-work-scope', { difficulty: 50 }))!
      const store = brokenRates()

      expect(await verifyWork(scoped, 'gaps-work-scope', { store })).toBeUndefined()
      expect(await verifyWork(scoped, 'gaps-work-scope', { store })).toBe('wrong')
    }
    finally {
      seen.restore()
    }
  })

  it('leaves a store that hangs alone for a while, so one request waits for it and the next does not', async () => {
    jest.useFakeTimers()

    const seen = warnings('gaps-limiter-hanging')
    let calls = 0

    try {
      const limiter = rateLimit('gaps-limiter-hanging', { max: 1, window: '1m', store: { hit: async () => {
        calls++

        return new Promise<never>(Function.prototype as never)
      } } })
      const first = limiter.hit('one')

      jest.advanceTimersByTime(8_000)
      expect(await first).toBeUndefined()
      expect(await limiter.hit('one')).toBeGreaterThan(0)
      expect(calls).toBe(1)
      expect(seen.count()).toBe(1)
    }
    finally {
      jest.useRealTimers()
      seen.restore()
    }
  })
})

describe('a rates store that answers', () => {
  // A store keeping its windows on itself, so it answers only when called on itself.
  class OwnRates {
    readonly windows = new Map<string, number>()

    hit = async function (this: OwnRates, key: string) {
      const count = (this.windows.get(key) ?? 0) + 1

      this.windows.set(key, count)

      return { count, resetAt: Date.now() + 60_000 }
    }

    peek = async function (this: OwnRates, key: string) {
      const count = this.windows.get(key)

      return count === undefined ? undefined : { count, resetAt: Date.now() + 60_000 }
    }

    refund = async function (this: OwnRates, key: string) {
      this.windows.set(key, (this.windows.get(key) ?? 1) - 1)
    }
  }

  it('counts there, called on itself, with no memory fallback', async () => {
    const seen = warnings('/_kay/action/gaps-answers')
    const store = new OwnRates()

    try {
      const action = { url: '/_kay/action/gaps-answers', protection: { rateLimit: { max: 1, window: '1m', store } } } as never
      const refunded = new Request('http://localhost/', { method: 'POST' })

      expect(await protectionRefusal(action, refunded, refusalOptions)).toBeUndefined()
      expect([...store.windows.values()]).toEqual([1])
      await refundRateLimit(refunded)
      expect([...store.windows.values()]).toEqual([0])
      expect(await protectionRefusal(action, new Request('http://localhost/', { method: 'POST' }), refusalOptions)).toBeUndefined()
      expect(await protectionRefusal(action, new Request('http://localhost/', { method: 'POST' }), refusalOptions)).toMatchObject({ status: 429 })
      expect(seen.count()).toBe(0)
    }
    finally {
      seen.restore()
    }
  })

  it('is not timed when it answers at once', async () => {
    const timers = spyOn(globalThis, 'setTimeout')

    try {
      const limiter = rateLimit('gaps-sync', { max: 5, window: '1m', store: memoryRates() })

      expect(await limiter.hit('one')).toBeUndefined()
      expect(timers.mock.calls.filter(call => call[1] === 8_000)).toHaveLength(0)

      setupStore({ rates: memoryRates() })
      expect(await overLimit('gaps-sync-app', '10.0.0.8', 5, 60_000)).toBeUndefined()
      expect(timers.mock.calls.filter(call => call[1] === 8_000)).toHaveLength(0)
    }
    finally {
      timers.mockRestore()
    }
  })

  it('is left alone under every name once one timed out on it', async () => {
    jest.useFakeTimers()

    const log = spyOn(console, 'warn').mockReturnValue()
    let calls = 0

    try {
      setupStore({ rates: { hit: async () => {
        calls++

        return new Promise<never>(Function.prototype as never)
      } } })

      const first = overLimit('gaps-skip-one', '10.0.0.9', 1, 60_000)

      jest.advanceTimersByTime(8_000)
      expect(await first).toBeUndefined()
      expect(await overLimit('gaps-skip-two', '10.0.0.9', 1, 60_000)).toBeUndefined()
      expect(calls).toBe(1)
    }
    finally {
      jest.useRealTimers()
      log.mockRestore()
    }
  })
})

describe('verifyWork', () => {
  it('records a solution in the app store\'s rates, so another replica refuses the replay', async () => {
    const rates = sharedRates()

    setupStore({ rates })

    const solved = solveWork(workChallenge('gaps-replay', { difficulty: 50 }))!

    expect(await verifyWork(solved, 'gaps-replay')).toBeUndefined()
    expect(rates.keys.size).toBe(1)

    // Another replica has a memory of its own and the same store.
    setupStore({ rates: { hit: async (key, window, weight) => rates.hit(key, window, weight), peek: async key => rates.peek!(key) } })
    expect(await verifyWork(solved, 'gaps-replay')).toBe('wrong')
  })

  it('prefers the store it is given over the app\'s', async () => {
    const app = sharedRates()
    const own = sharedRates()

    setupStore({ rates: app })
    expect(await verifyWork(solveWork(workChallenge('gaps-own', { difficulty: 50 })), 'gaps-own', { store: own })).toBeUndefined()
    expect(app.keys.size).toBe(0)
    expect(own.keys.size).toBe(1)
  })
})

describe('sqliteCache', () => {
  it('drops the values stale for a week on a write, and keeps the others', async () => {
    const store = sqliteCache(join(await scratchDir('cache-purge'), 'cache.sqlite'))
    const day = 86_400_000

    store.set('old', '"o"', Date.now() - 8 * day)
    store.set('recent', '"r"', Date.now() - 2 * day)
    store.set('warm', '"w"', Date.now() + 60_000)
    expect(store.keys().sort()).toEqual(['old', 'recent', 'warm'])

    setSystemTime(Date.now() + 2 * 3_600_000)
    store.set('another', '"a"', Date.now() + 60_000)
    expect(store.keys().sort()).toEqual(['another', 'recent', 'warm'])
  })
})

// Elysia runs its afterResponse hooks once the event loop gets to them, and a write still in flight counts half a step.
async function settled(writes: { count: number }): Promise<void> {
  await eventually(() => expect(Number.isInteger(writes.count)).toBe(true))
}

describe('a listener that throws', () => {
  it('does not skip the listeners after it in the cache poll', async () => {
    const path = join(await scratchDir('cache-listener'), 'cache.sqlite')
    const store = sqliteCache(path)
    const heard: string[] = []
    const sink = logSink()

    setLogSink(() => undefined)
    store.set('seed', '"s"', Date.now() + 60_000)
    store.subscribe?.(() => {
      throw new Error('listener failed')
    })
    store.subscribe?.(message => void heard.push(message))

    // Another process's invalidation, written straight into the file.
    const other = new Database(path)

    other.run('INSERT INTO kay_events (origin, message, at) VALUES (\'other\', ?, ?)', ['{"keys":[]}', Date.now()])
    other.close()

    try {
      await eventually(() => expect(heard).toEqual(['{"keys":[]}']))
    }
    finally {
      setLogSink(sink)
    }
  })

  for (const [name, open] of [['memoryRooms', () => memoryRooms()], ['sqliteRooms', () => sqliteRooms(':memory:')]] as const) {
    it(`does not skip the listeners after it in ${name}.publish`, () => {
      const store = open()
      const heard: string[] = []
      const sink = logSink()

      setLogSink(() => undefined)

      store.subscribe(() => {
        throw new Error('listener failed')
      })
      store.subscribe((room, text) => void heard.push(`${room}:${text}`))
      store.publish('hall', 'hi', {})
      setLogSink(sink)
      store.close?.()
      expect(heard).toEqual(['hall:hi'])
    })
  }
})

describe('countWrites', () => {
  function app() {
    const server = new Elysia()
    const writes = countWrites(server)

    server
      .post('/ok', () => 'saved')
      .post('/forbidden', () => new Response(null, { status: 403 }))
      .post('/code', () => ({ code: 403 }))
      .post('/limited', ({ status }) => status(429, 'slow down'))
      .post('/invalid', () => 'unreachable', { body: t.Object({ name: t.String() }) })
      .post('/broken', () => {
        throw new Error('the write failed')
      })

    return { writes, handle: async (path: string, body?: unknown) => server.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })) }
  }

  it('counts a write that went through, and one that failed', async () => {
    const { writes, handle } = app()

    expect((await handle('/ok')).status).toBe(200)
    await settled(writes)
    expect(writes.count).toBe(1)
    expect((await handle('/broken')).status).toBe(500)
    await settled(writes)
    expect(writes.count).toBe(2)
  })

  it('counts a write answering 200 with a body that has a code field', async () => {
    const { writes, handle } = app()

    expect((await handle('/code')).status).toBe(200)
    await settled(writes)
    expect(writes.count).toBe(1)
  })

  it('does not count a request a guard or the validation refused', async () => {
    const { writes, handle } = app()

    expect((await handle('/forbidden')).status).toBe(403)
    expect((await handle('/limited')).status).toBe(429)

    const invalid = await handle('/invalid', { name: 1 })

    expect(invalid.status).toBeGreaterThanOrEqual(400)
    expect(invalid.status).toBeLessThan(500)
    await settled(writes)
    expect(writes.count).toBe(0)
  })
})

describe('sqliteRooms on a file that cannot be watched', () => {
  it('reads every 25 ms at first and backs off to 250 ms while no message comes', async () => {
    const started = spyOn(globalThis, 'setInterval')
    const store = sqliteRooms(':memory:')

    try {
      store.subscribe(() => undefined)
      store.add('lobby', 'c1', '')
      expect(started.mock.calls.map(call => call[1])).toContain(25)
      await eventually(() => expect(started.mock.calls.map(call => call[1])).toContain(250))
    }
    finally {
      store.close()
      started.mockRestore()
    }
  })
})
