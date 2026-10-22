import type { SQL } from 'bun'
import type { PgHandle } from '../src/server/pg-data'
import { describe, expect, it } from 'bun:test'
import { logSink, setLogSink } from '../src/runtime/log'
import { pgCache } from '../src/server/pg-cache'
import { pgHandle } from '../src/server/pg-data'
import { rowsOf } from '../src/server/pg-jobs'
import { pgLive } from '../src/server/pg-live'
import { pollerOf, timeLimited } from '../src/server/pg-poll'
import { pgRooms } from '../src/server/pg-rooms'
import { cleanUpAfterFile, pgIt, postgres } from './job-stores'

cleanUpAfterFile()

// A handle counting how often it is asked for the database.
function counted(inner: PgHandle): { handle: PgHandle, calls: () => number } {
  let calls = 0

  return { handle: { db: async () => {
    calls++

    return inner.db()
  } }, calls: () => calls }
}

describe('the shared event poller', () => {
  it('reaches the database once a tick however many tasks are due, and tasks keep their own rhythm', async () => {
    const counter = counted({ db: async () => ({}) as SQL })
    const runs = { fast: 0, same: 0, slow: 0 }
    const poller = pollerOf(counter.handle)
    const task = (every: number, key: keyof typeof runs) => ({ every, wanted: () => true, run: async () => void runs[key]++, failed: 'reading failed' })
    const removals = [poller.add(task(40, 'fast'), false), poller.add(task(40, 'same'), false), poller.add(task(160, 'slow'), false)]

    await Bun.sleep(500)
    for (const remove of removals) {
      remove()
    }
    expect(runs.fast).toBeGreaterThan(5)
    expect(runs.same).toBe(runs.fast)
    expect(runs.slow).toBeLessThan(runs.fast / 2)
    expect(counter.calls()).toBe(runs.fast)

    const stopped = counter.calls()

    await Bun.sleep(120)
    expect(counter.calls()).toBe(stopped)
  })

  it('gives up on work that takes longer than its limit, and lets work within it answer', async () => {
    await expect(timeLimited(async () => Bun.sleep(300), 30, 'the read')).rejects.toThrow('the read took more than 0.03 seconds')
    await expect(timeLimited(async () => 'done', 30, 'the read')).resolves.toBe('done')
  })

  pgIt('cancels the statement it gave up on, so it frees its connection', async () => {
    const { sql } = await postgres()
    const started = performance.now()

    await expect(timeLimited(async () => rowsOf(sql.unsafe('SELECT pg_sleep(10)')), 100, 'the read')).rejects.toThrow('the read took more than')
    await Bun.sleep(100)

    const [{ busy }] = await sql`SELECT count(*)::int AS busy FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(10)%' AND state = 'active' AND pid != pg_backend_pid()`

    expect(busy).toBe(0)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  pgIt('cancels a tagged template statement awaited directly, in a transaction too', async () => {
    const { sql } = await postgres()

    await expect(timeLimited(async () => {
      await sql`SELECT pg_sleep(11)`
    }, 100, 'the read')).rejects.toThrow('the read took more than')
    await expect(timeLimited(async () => sql.begin(async (tx) => {
      await tx`SELECT pg_sleep(12)`
    }), 100, 'the write')).rejects.toThrow('the write took more than')
    await Bun.sleep(150)

    const [{ busy }] = await sql`SELECT count(*)::int AS busy FROM pg_stat_activity WHERE (query LIKE 'SELECT pg_sleep(11)%' OR query LIKE 'SELECT pg_sleep(12)%') AND state = 'active' AND pid != pg_backend_pid()`

    expect(busy).toBe(0)
  })

  pgIt('cancels a statement that abandoned work starts after the limit', async () => {
    const { sql } = await postgres()

    await expect(timeLimited(async () => {
      await Bun.sleep(150)
      await sql`SELECT pg_sleep(13)`
    }, 50, 'the read')).rejects.toThrow('the read took more than')
    await Bun.sleep(400)

    const [{ busy }] = await sql`SELECT count(*)::int AS busy FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(13)%' AND state = 'active' AND pid != pg_backend_pid()`

    expect(busy).toBe(0)
  })

  pgIt('leaves alone a statement a timer started from a run that succeeded', async () => {
    const { sql } = await postgres()
    let later: Promise<unknown> = Promise.resolve()

    await timeLimited(async () => {
      later = new Promise((resolve) => {
        setTimeout(() => {
          void (async () => {
            resolve(await sql`SELECT 7 AS seven`)
          })()
        }, 50)
      })
    }, 1000, 'the read')
    await Bun.sleep(100)

    expect(((await later) as { seven: number }[])[0]?.seven).toBe(7)
  })

  it('does not run a task again before its last run ended', async () => {
    const counter = counted({ db: async () => ({}) as SQL })
    let started = 0
    const remove = pollerOf(counter.handle).add({ every: 20, wanted: () => true, run: async () => {
      started++
      await Bun.sleep(150)
    }, failed: 'reading failed' }, true)

    await Bun.sleep(400)
    remove()
    expect(started).toBeLessThanOrEqual(4)
  })

  it('logs a streak of failed runs once, and a run skipped as busy does not end it', async () => {
    const sink = logSink()
    const logged: string[] = []

    setLogSink((level, message) => void logged.push(`${level}: ${message}`))

    try {
      const outcomes: ('fail' | 'busy' | 'ok')[] = ['fail', 'busy', 'fail', 'ok', 'fail']
      const done: number[] = []
      const remove = pollerOf({ db: async () => ({}) as SQL }).add({ every: 5, wanted: () => true, run: async () => {
        const outcome = outcomes[done.length] ?? 'ok'

        done.push(done.length)

        if (outcome === 'fail')
          throw new Error('down')

        return outcome === 'busy' ? 'busy' : undefined
      }, failed: 'reading failed' }, true)

      const until = Date.now() + 2000

      while (done.length < outcomes.length) {
        if (Date.now() > until) {
          remove()

          throw new Error(`timed out waiting for ${outcomes.length} runs of the poller, got ${done.length}`)
        }

        await Bun.sleep(10)
      }

      remove()
      expect(logged.filter(line => line.includes('reading failed'))).toHaveLength(2)
    }
    finally {
      setLogSink(sink)
    }
  })

  it('drops the writes past the queue bound while the database does not answer', async () => {
    const store = pgLive({ db: async () => new Promise<SQL>(() => undefined) })

    for (let index = 0; index < 10_000; index++)
      void store.set('app:hung', String(index), '[1]')

    // Dropped at once instead of waiting behind the 10,000 before it.
    const outcome = await Promise.race([(async () => {
      await store.set('app:hung', 'last', '[1]')

      return 'dropped'
    })(), (async () => {
      await Bun.sleep(1000)

      return 'queued'
    })()])

    expect(outcome).toBe('dropped')
  })

  pgIt('serves pgLive, pgCache and pgRooms from one tick', async () => {
    const { sql } = await postgres()
    const counter = counted(pgHandle(sql))
    const live = pgLive(counter.handle)
    const cache = pgCache(counter.handle)
    const store = pgRooms(counter.handle)

    await live.entries()
    live.subscribe(() => undefined)
    cache.subscribe?.(() => undefined)
    await cache.keys()
    store.subscribe(() => undefined)

    const before = counter.calls()

    await Bun.sleep(1100)

    // Rooms poll every 250ms, so four or five ticks; three separate timers would reach the database about twice that.
    expect(counter.calls() - before).toBeLessThanOrEqual(7)
    expect(counter.calls() - before).toBeGreaterThanOrEqual(3)
    live.stop?.()
    store.close()
  })
})
