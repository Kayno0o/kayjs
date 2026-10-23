import type { RateStore } from '../src/runtime/action'
import { join } from 'node:path'
import { afterEach, describe, expect, it, jest, setSystemTime, spyOn } from 'bun:test'
import { Elysia, t } from 'elysia'
import { sqliteCache } from '../src/runtime/cache.server'
import { solveWork } from '../src/runtime/work'
import { setupStore } from '../src/server/app-store'
import { countWrites } from '../src/server/kept-pages'
import { memoryRates, overLimit } from '../src/server/protection'
import { sqliteRooms } from '../src/server/rooms'
import { verifyWork, workChallenge } from '../src/server/work-scope'
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

// Elysia runs its afterResponse hooks once the event loop gets to them.
async function settled(): Promise<void> {
  await Bun.sleep(20)
}

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
    await settled()
    expect(writes.count).toBe(1)
    expect((await handle('/broken')).status).toBe(500)
    await settled()
    expect(writes.count).toBe(2)
  })

  it('counts a write answering 200 with a body that has a code field', async () => {
    const { writes, handle } = app()

    expect((await handle('/code')).status).toBe(200)
    await settled()
    expect(writes.count).toBe(1)
  })

  it('does not count a request a guard or the validation refused', async () => {
    const { writes, handle } = app()

    expect((await handle('/forbidden')).status).toBe(403)
    expect((await handle('/limited')).status).toBe(429)

    const invalid = await handle('/invalid', { name: 1 })

    expect(invalid.status).toBeGreaterThanOrEqual(400)
    expect(invalid.status).toBeLessThan(500)
    await settled()
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
      await Bun.sleep(1500)
      expect(started.mock.calls.map(call => call[1])).toContain(250)
    }
    finally {
      store.close()
      started.mockRestore()
    }
  })
})
