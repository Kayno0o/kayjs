import type { PgHandle } from '../src/server/pg-data'
import { SQL } from 'bun'
import { describe, expect, it } from 'bun:test'
import { logSink, setLogSink } from '../src/runtime/log'
import { pgCache } from '../src/server/pg-cache'
import { pgJobs } from '../src/server/pg-jobs'
import { STORE_TIMEOUT_MS } from '../src/server/pg-limit'
import { pgNotifications, pgRates, pgSessions } from '../src/server/pg-stores'
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

    await Bun.sleep(300)
    await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'UPDATE kay_jobs%' AND state = 'active' AND pid != pg_backend_pid()`)

    const [settled] = await outcome

    expect(settled?.status).toBe('rejected')
    expect(performance.now() - started).toBeLessThan(STORE_TIMEOUT_MS + 2000)
    await holder.unsafe('ROLLBACK')
    await holder.release()

    const claimed = await store.claim('q', Date.now(), Date.now() + 60_000)

    expect(claimed?.id).toBe('one')
  }, STORE_TIMEOUT_MS + 15_000)
})
