import type { PgHandle } from '../src/server/pg-data'
import { SQL } from 'bun'
import { describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { Elysia } from 'elysia'
import { logSink, setLogSink } from '../src/runtime/log'
import { queue as makeQueue } from '../src/server'
import { pgCache } from '../src/server/pg-cache'
import { connectionOf, pgJobs } from '../src/server/pg-jobs'
import { limitedStore, STORE_TIMEOUT_MS } from '../src/server/pg-limit'
import { pgRooms } from '../src/server/pg-rooms'
import { pgNotifications, pgRates, pgSessions } from '../src/server/pg-stores'
import { forgetQueue } from '../src/server/queue'
import { cleanUpAfterFile, freshPg, pgIt, postgres } from './job-stores'

cleanUpAfterFile()

// A handle whose connection never answers a statement, as one the server dropped.
const never = async () => new Promise<never>(() => undefined)
const silent: PgHandle = { db: async () => Object.assign(never, { unsafe: never, begin: never }) as unknown as SQL }

// Runs `work` with the log collected, then puts the sink back.
async function collecting(work: () => Promise<void>): Promise<string[]> {
  const sink = logSink()
  const lines: string[] = []

  setLogSink((level, message) => void lines.push(`${level}: ${message}`))

  try {
    await work()
  }
  finally {
    setLogSink(sink)
  }

  return lines
}

describe('the Postgres stores under a database that does not answer', () => {
  it('fail every call with a logged error instead of hanging', async () => {
    const calls = {
      sessions: async () => pgSessions(silent).get('a'),
      sessionWrite: async () => pgSessions(silent).set('a', {}, '1h'),
      rates: async () => pgRates(silent).hit('a', '1m'),
      cache: async () => pgCache(silent).get('a'),
      notifications: async () => pgNotifications(silent).unread('a', 0),
    }
    const lines = await collecting(async () => {
      const started = performance.now()
      const settled = await Promise.allSettled(Object.values(calls).map(async call => call()))

      expect(performance.now() - started).toBeLessThan(STORE_TIMEOUT_MS + 2000)

      for (const outcome of settled) {
        expect(outcome.status).toBe('rejected')
        expect(((outcome as PromiseRejectedResult).reason as Error).message).toContain('took more than')
      }
    })

    expect(lines.filter(line => line.startsWith('error: ') && line.includes('was given up on'))).toHaveLength(Object.keys(calls).length)
  }, STORE_TIMEOUT_MS + 5000)
})

describe('the Postgres job store when its session is killed', () => {
  pgIt('gives up on a claim stuck behind a killed session and claims again once the database answers', async () => {
    await freshPg()

    const { url } = await postgres()
    const client = new SQL(url, { max: 2 })
    const locker = new SQL(url, { max: 1 })
    const admin = new SQL(url, { max: 1 })
    const store = pgJobs(client)

    await store.add({ id: 'one', queue: 'q', payload: 'p', attempts: 0, runAt: 0 })

    // A lock the claim waits on, so its session is busy when the server kills it.
    const holder = await locker.reserve()

    await holder.unsafe('BEGIN')
    await holder.unsafe('LOCK TABLE kay_jobs IN ACCESS EXCLUSIVE MODE')

    const started = performance.now()
    const stuck = store.claim('q', Date.now(), Date.now() + 60_000)
    const outcome = Promise.allSettled([stuck])

    // The claim is stuck on the lock once its statement shows as active.
    await until(async () => Number((await admin.unsafe<{ count: string }[]>(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'UPDATE kay_jobs%' AND state = 'active' AND pid != pg_backend_pid()`))[0]!.count) > 0, 5000)
    await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'UPDATE kay_jobs%' AND state = 'active' AND pid != pg_backend_pid()`)

    const [settled] = await outcome

    expect(settled?.status).toBe('rejected')
    expect(performance.now() - started).toBeLessThan(STORE_TIMEOUT_MS + 2000)
    await holder.unsafe('ROLLBACK')
    await holder.release()

    const claimed = await store.claim('q', Date.now(), Date.now() + 60_000)

    expect(claimed?.id).toBe('one')
  }, STORE_TIMEOUT_MS + 15_000)
})
describe('the rooms store under a database that does not answer', () => {
  it('fails a state read within one limit however many writes are queued before it', async () => {
    const store = pgRooms(silent)
    const lines = await collecting(async () => {
      for (let message = 0; message < 3; message++)
        store.publish('hall', 'hi', {})

      const started = performance.now()

      await expect(store.state!('hall')).rejects.toThrow('took more than')
      expect(performance.now() - started).toBeLessThan(STORE_TIMEOUT_MS + 2000)
    })

    expect(lines.some(line => line.includes('was given up on'))).toBe(true)
  }, STORE_TIMEOUT_MS + 5000)
})

describe('limitedStore', () => {
  it('limits every method of a store, so one added later needs no listing, and leaves the unlimited ones alone', async () => {
    const store = limitedStore({ added: async () => 1, later: async () => 2, listen: () => 3, name: 'x' }, 'a store', { unlimited: ['listen'] })

    expect(store.listen()).toBe(3)
    expect(store.name).toBe('x')

    expect(await store.added()).toBe(1)
    expect(await store.later()).toBe(2)
  })

  it('refuses a synchronous method nobody named as unlimited, instead of turning it into a promise', () => {
    expect(() => limitedStore({ close: () => undefined }, 'a store')).toThrow('close is not an async function')
    expect(() => limitedStore({ close: () => undefined }, 'a store', { unlimited: ['close'] })).not.toThrow()
  })

  it('leaves the cache store\'s subscribe synchronous', () => {
    expect(pgCache(silent).subscribe?.(() => undefined)).toBeUndefined()
  })
})

describe('the rooms store with a throwing listener', () => {
  pgIt('hands a published message to the listeners after one that throws', async () => {
    const { sql } = await postgres()
    const store = pgRooms({ db: async () => sql })
    const heard: string[] = []
    const lines = await collecting(async () => {
      store.subscribe(() => {
        throw new Error('listener failed')
      })
      store.subscribe((room, text) => void heard.push(`${room}:${text}`))
      store.publish('hall', 'hi', {})
      await until(() => heard.length > 0, 5000)
    })

    expect(heard).toEqual(['hall:hi'])
    expect(lines.some(line => line.startsWith('error: a listener of the room hall threw'))).toBe(true)
    await store.close?.()
  })
})

describe('the connections kay opens from a URL', () => {
  it('time out connecting, close when idle and are replaced after a while', () => {
    const { options } = connectionOf('postgres://kay@127.0.0.1:1/kay') as unknown as { options: Record<string, number> }

    expect(options).toMatchObject({ connectionTimeout: 10_000, idleTimeout: 60_000, maxLifetime: 1_800_000 })
  })
})

async function until(ready: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  for (let waited = 0; !await ready(); waited += 50) {
    if (waited > ms)
      throw new Error('timed out')

    await Bun.sleep(50)
  }
}

describe('a queue worker on Postgres when its session is killed', () => {
  pgIt('logs the timeout, backs off and runs the next job', async () => {
    await freshPg()

    const { url } = await postgres()
    const client = new SQL(url, { max: 2 })
    const locker = new SQL(url, { max: 1 })
    const admin = new SQL(url, { max: 1 })
    const ran: string[] = []
    const jobs = makeQueue<string>('limits-worker', (payload) => {
      ran.push(payload)
    }, { store: pgJobs(client) })

    // Stored before the queue exists, so no worker has claimed it yet.
    await pgJobs(admin).add({ id: 'one', queue: 'limits-worker', payload: stringify('first'), attempts: 0, runAt: 0 })

    const holder = await locker.reserve()

    await holder.unsafe('BEGIN')
    await holder.unsafe('LOCK TABLE kay_jobs IN ACCESS EXCLUSIVE MODE')

    let app: Elysia | undefined
    const started = performance.now()
    const lines = await collecting(async () => {
      // The worker's claim waits behind the lock, and the server kills its session meanwhile.
      app = new Elysia().use(jobs).listen(0)

      // The worker's purge of failed jobs waits behind the lock first and is given up on, then its claim waits.
      await until(async () => ((await admin.unsafe(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'UPDATE kay_jobs%' AND state = 'active'`)) as unknown[]).length > 0, STORE_TIMEOUT_MS + 5000)
      await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'UPDATE kay_jobs%' AND state = 'active' AND pid != pg_backend_pid()`)
      await until(() => ran.length > 0 || performance.now() - started > STORE_TIMEOUT_MS + 3000, STORE_TIMEOUT_MS + 5000)

      // The database answers again: the worker has backed off and now claims the job.
      await holder.unsafe('ROLLBACK')
      await until(() => ran.length > 0, 15_000)
    })

    await app?.stop()
    forgetQueue(jobs)
    await holder.release()
    expect(ran).toEqual(['first'])
    expect(lines.some(line => line.includes('was given up on'))).toBe(true)
    expect(lines.some(line => line.includes('could not read its store'))).toBe(true)
  }, STORE_TIMEOUT_MS * 3 + 30_000)
})
