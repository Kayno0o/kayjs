import type { SQL } from 'bun'
import type { PgHandle } from '../src/server/pg-data'
import { describe, expect, it } from 'bun:test'
import { pgCache } from '../src/server/pg-cache'
import { pgHandle } from '../src/server/pg-data'
import { pgLive } from '../src/server/pg-live'
import { pollerOf } from '../src/server/pg-poll'
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

  it('does not run a task again before its last run ended', async () => {
    const counter = counted({ db: async () => ({}) as SQL })
    let started = 0
    const remove = pollerOf(counter.handle).add({ every: 20, wanted: () => true, run: async () => {
      started++
      await Bun.sleep(150)
    }, failed: 'reading failed' }, true)

    await Bun.sleep(400)
    remove()
    expect(started).toBeLessThanOrEqual(3)
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
    expect(counter.calls() - before).toBeLessThanOrEqual(6)
    expect(counter.calls() - before).toBeGreaterThanOrEqual(3)
    live.stop?.()
    store.close()
  })
})
