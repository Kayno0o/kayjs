import type { SQL } from 'bun'
import type { JobStore, StoredJob } from '../src/server'
import { resolve } from 'node:path'
import process from 'node:process'
import { Database, generateMigration } from '@kaynooo/pg-orm'
import { afterEach, describe, expect, it } from 'bun:test'
import { openSqlite } from '../src/runtime/sqlite.server'
import { createJobTables, pgJobs, sqliteJobs } from '../src/server'
import { jobTables } from '../src/server/pg-orm'
import { cleanUpAfterFile, freshPg, kinds, pgDescribe, pgIt, postgres, replicas, sqlitePath } from './job-stores'

cleanUpAfterFile()

let ids = 0

function job(overrides: Partial<StoredJob> = {}): StoredJob {
  return { id: `job-${++ids}`, queue: 'q', payload: '[]', attempts: 0, runAt: 0, ...overrides }
}

const REQUIRED = <T>(value: T | undefined): T => value as T

// Holds are read against a clock the store picks: the caller's for memory and SQLite, which a case moves on (`skew`) instead of waiting, and Postgres's own, which a case waits out in real time with leases long enough to stay held or short enough to wait out.
const LONG = 60_000
const SHORT = 400
const SHORT_PAST = 500

let skew = 0

const clockNow = (): number => Date.now() + skew

async function claimFor(store: JobStore, lease = LONG, queue = 'q'): Promise<StoredJob | undefined> {
  const now = clockNow()

  return store.claim(queue, now, now + lease)
}

const heldOf = (claimed: StoredJob | undefined): number => REQUIRED(claimed?.heldUntil)

describe.each(kinds)('job store contract, $name', ({ name, open }) => {
  // Lets `ms` go by for the store's clock.
  async function pass(ms: number): Promise<void> {
    if (name === 'postgres')
      await Bun.sleep(ms)
    else
      skew += ms
  }

  afterEach(() => {
    skew = 0
  })

  it('hands a due job to one claim only, and again once its hold ran out', async () => {
    const store = await open()
    const added = job()

    await store.add(added)

    const [first, second] = await Promise.all([claimFor(store, SHORT), claimFor(store, SHORT)])

    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect(await claimFor(store)).toBeUndefined()
    await pass(SHORT_PAST)
    expect((await claimFor(store))?.attempts).toBe(2)
  })

  it('answers a claim with the hold it stored', async () => {
    const store = await open()

    await store.add(job())

    const claimed = await claimFor(store, 5000)

    expect(Math.abs(heldOf(claimed) - (clockNow() + 5000))).toBeLessThan(2000)
  })

  describe('key', () => {
    it('refuses a second job with the key while the first waits or runs, resolving with the first\'s id', async () => {
      const store = await open()
      const first = job({ key: 'anilist', payload: 'first' })

      expect(await store.add(first)).toBeUndefined()
      expect(await store.add(job({ key: 'anilist', payload: 'second' }))).toBe(first.id)

      const claimed = REQUIRED(await claimFor(store))

      expect(claimed.payload).toBe('first')
      expect(await store.add(job({ key: 'anilist' }))).toBe(first.id)
      await store.complete(first.id)
      expect(await claimFor(store)).toBeUndefined()
    })

    it('takes the key again once its job completed or failed', async () => {
      const store = await open()
      const first = job({ key: 'k' })

      await store.add(first)
      await store.complete(first.id)
      expect(await store.add(job({ key: 'k' }))).toBeUndefined()

      const second = REQUIRED(await claimFor(store))

      await store.fail(second.id, 'boom')

      const third = job({ key: 'k' })

      expect(await store.add(third)).toBeUndefined()
      expect((await claimFor(store))?.id).toBe(third.id)
    })

    it('keeps one job when many add with one key at once', async () => {
      const store = await open()
      const results = await Promise.all(Array.from({ length: 8 }, async () => store.add(job({ key: 'race' }))))

      expect(results.filter(id => id === undefined)).toHaveLength(1)
      expect(await store.jobs?.('q')).toHaveLength(1)
      expect(new Set(results.filter(Boolean)).size).toBe(1)
    })

    it('keeps a key apart per queue, and never matches a job without one', async () => {
      const store = await open()

      expect(await store.add(job({ key: 'k' }))).toBeUndefined()
      expect(await store.add(job({ key: 'k', queue: 'other' }))).toBeUndefined()
      expect(await store.add(job())).toBeUndefined()
      expect(await store.add(job())).toBeUndefined()
    })
  })

  describe('state', () => {
    it('tells waiting from running from failed, by key or id', async () => {
      const store = await open()
      const added = job({ key: 'k' })

      expect(await store.state!('q', { key: 'k' }, clockNow())).toBeUndefined()
      await store.add(added)
      expect(await store.state!('q', { key: 'k' }, clockNow())).toMatchObject({ id: added.id, status: 'waiting', key: 'k' })
      await claimFor(store, SHORT)
      expect(await store.state!('q', { id: added.id }, clockNow())).toMatchObject({ status: 'running', attempts: 1 })
      await pass(SHORT_PAST)
      expect(await store.state!('q', { key: 'k' }, clockNow())).toMatchObject({ status: 'waiting' })
      await store.fail(added.id, 'boom')
      expect(await store.state!('q', { key: 'k' }, 0)).toMatchObject({ status: 'failed', error: 'boom' })
      expect(await store.state!('other', { key: 'k' }, 0)).toBeUndefined()
    })

    it('prefers the live job of a key to a failed one, and finds nothing once it completed', async () => {
      const store = await open()
      const failed = job({ key: 'k' })

      await store.add(failed)
      await claimFor(store)
      await store.fail(failed.id, 'boom')

      const live = job({ key: 'k' })

      await store.add(live)
      expect((await store.state!('q', { key: 'k' }, 0))?.id).toBe(live.id)
      await store.complete(live.id)
      expect((await store.state!('q', { key: 'k' }, 0))?.id).toBe(failed.id)
      await store.complete(failed.id)
      expect(await store.state!('q', { key: 'k' }, 0)).toBeUndefined()
    })
  })

  describe('progress', () => {
    it('is written while the hold is the job\'s, read back, kept by a failure and cleared by the next claim', async () => {
      const store = await open()
      const added = job({ key: 'k' })

      await store.add(added)
      await store.progress!(added.id, heldOf(await claimFor(store)), '[1]')
      expect((await store.state!('q', { key: 'k' }, clockNow()))?.progress).toBe('[1]')
      await store.retry(added.id, 10, 'again')
      expect((await store.state!('q', { key: 'k' }, clockNow()))?.progress).toBe('[1]')

      const second = await claimFor(store)

      expect((await store.state!('q', { key: 'k' }, clockNow()))?.progress).toBeUndefined()
      await store.progress!(added.id, heldOf(second), '[2]')
      await store.fail(added.id, 'boom')
      expect((await store.failed('q'))[0]?.progress).toBe('[2]')
    })

    it('drops a write after completion, after the hold went to another claim, or for a hold that is not the job\'s', async () => {
      const store = await open()
      const added = job({ key: 'k' })

      await store.add(added)

      const first = heldOf(await claimFor(store, SHORT))

      await store.progress!(added.id, first + 999, '[stale]')
      expect((await store.state!('q', { key: 'k' }, clockNow()))?.progress).toBeUndefined()
      await pass(SHORT_PAST)

      const second = heldOf(await claimFor(store))

      await store.progress!(added.id, first, '[late]')
      expect((await store.state!('q', { key: 'k' }, clockNow()))?.progress).toBeUndefined()
      await store.complete(added.id)
      await store.progress!(added.id, second, '[after]')
      expect(await store.state!('q', { key: 'k' }, clockNow())).toBeUndefined()
    })
  })

  describe('release', () => {
    it('gives the attempt back and makes the job due at runAt, only for the hold it was claimed with', async () => {
      const store = await open()
      const added = job()

      await store.add(added)

      const held = heldOf(await claimFor(store))
      const runAt = clockNow() + SHORT

      await store.release!(added.id, held + 999, runAt)
      expect(await claimFor(store)).toBeUndefined()
      await store.release!(added.id, held, runAt)
      expect(await claimFor(store)).toBeUndefined()
      expect(await store.nextRunAt('q')).toBe(runAt)
      await pass(SHORT_PAST)

      const again = REQUIRED(await claimFor(store))

      expect(again.attempts).toBe(1)
    })

    it('keeps the due time of a release without runAt', async () => {
      const store = await open()
      const added = job({ runAt: 5 })

      await store.add(added)
      await store.release!(added.id, heldOf(await claimFor(store)))
      expect((await claimFor(store))?.attempts).toBe(1)
    })
  })

  describe('a run past its hold', () => {
    // The first run's hold ran out and another process took the job: nothing the first writes afterwards may touch it.
    async function taken() {
      const store = await open()
      const added = job({ key: 'k' })

      await store.add(added)

      const late = heldOf(await claimFor(store, SHORT))

      await pass(SHORT_PAST)

      const current = heldOf(await claimFor(store))

      return { store, added, late, current }
    }

    it('completes, retries and fails nothing of the job another process holds', async () => {
      const { store, added, late } = await taken()

      await store.complete(added.id, late)
      expect(await store.retry(added.id, 0, 'late', late)).toBe(false)
      expect(await store.fail(added.id, 'late', '[redacted]', late)).toBe(false)
      expect(await store.state!('q', { id: added.id }, clockNow())).toMatchObject({ status: 'running', attempts: 2, payload: '[]' })
      expect(await store.state!('q', { id: added.id }, clockNow())).not.toHaveProperty('error')
      expect(await claimFor(store)).toBeUndefined()
    })

    it('lets the process holding the job complete, retry or fail it', async () => {
      const { store, added, current } = await taken()

      expect(await store.retry(added.id, 0, 'again', current)).not.toBe(false)
      expect(await store.state!('q', { id: added.id }, clockNow())).toMatchObject({ status: 'waiting', error: 'again' })

      const next = heldOf(await claimFor(store))

      expect(await store.fail(added.id, 'boom', '[redacted]', next)).not.toBe(false)
      expect(await store.failed('q')).toMatchObject([{ id: added.id, error: 'boom', payload: '[redacted]' }])
      await store.complete(added.id, next)
      expect(await store.failed('q')).toHaveLength(1)
      await store.complete(added.id)
      expect(await store.failed('q')).toEqual([])
    })

    it('completes by id whatever the hold, as remove() and the purge do', async () => {
      const { store, added } = await taken()

      await store.complete(added.id)
      expect(await store.jobs?.('q')).toEqual([])
    })
  })
})

describe('a sqlite file made before keys and progress', () => {
  it('gains the columns and the key index, keeping its jobs', async () => {
    const path = await sqlitePath()
    const old = openSqlite(path)

    old.run('CREATE TABLE kay_jobs (id TEXT PRIMARY KEY, queue TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL, run_at INTEGER NOT NULL, held_until INTEGER, failed INTEGER NOT NULL DEFAULT 0, error TEXT)')
    old.run('INSERT INTO kay_jobs (id, queue, payload, attempts, run_at) VALUES (\'old\', \'q\', \'[]\', 0, 0)')
    old.close()

    const store = sqliteJobs(path)

    expect(await store.add(job({ key: 'k' }))).toBeUndefined()
    expect(await store.add(job({ key: 'k' }))).toBeDefined()
    expect((await store.jobs!('q')).map(listed => listed.id)).toContain('old')
    expect((await store.claim('q', 10, 100))?.id).toBe('old')
  })

  it('is migrated once however many processes open it at the same time', async () => {
    const path = await sqlitePath()
    const old = openSqlite(path)

    old.run('CREATE TABLE kay_jobs (id TEXT PRIMARY KEY, queue TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL, run_at INTEGER NOT NULL, held_until INTEGER, failed INTEGER NOT NULL DEFAULT 0, error TEXT)')
    old.close()

    const script = `import { sqliteJobs } from ${JSON.stringify(resolve('src/server/index.ts'))}\nawait sqliteJobs(${JSON.stringify(path)}).add({ id: crypto.randomUUID(), queue: 'q', payload: '[]', attempts: 0, runAt: 0, key: 'k' })\n`
    const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, '-e', script], { stderr: 'pipe' }))
    const exits = await Promise.all(children.map(async child => child.exited))

    expect(exits).toEqual([0, 0, 0])
    expect(await sqliteJobs(path).jobs!('q')).toHaveLength(1)
  })

  it('opens twice without error', async () => {
    const path = await sqlitePath()

    await sqliteJobs(path).add(job())
    expect(await sqliteJobs(path).add(job({ key: 'k' }))).toBeUndefined()
  })
})

// Columns, indexes and constraints of the two tables, as the database reports them.
async function shapeOf(sql: SQL) {
  const columns = await sql`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name IN ('kay_jobs', 'kay_locks') ORDER BY table_name, column_name`
  const indexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('kay_jobs', 'kay_locks') ORDER BY indexname`
  const constraints = await sql`SELECT conname, contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('kay_jobs'::regclass, 'kay_locks'::regclass) ORDER BY conname`

  return { columns: [...columns], indexes: [...indexes], constraints: [...constraints] }
}

pgDescribe('the tables of kay/pg-orm', () => {
  pgIt('are what createJobTables creates, made by db.sync() or a generated migration, and pgJobs runs over them', async () => {
    const sql = await freshPg()

    await createJobTables(sql)

    const created = await shapeOf(sql)
    const { url: target } = await postgres()
    const db = new Database({ url: target, tables: [...jobTables] })

    try {
      // An app that created them with createJobTables sees no drift once it lists the definitions.
      expect((await db.sync({ dryRun: true })).ops).toEqual([])
      await sql.unsafe('DROP TABLE kay_jobs, kay_locks')

      const migration = await generateMigration(db, db.getTablesRegistry())

      expect(migration?.up).toContain('CREATE TABLE "kay_jobs"')
      expect(migration?.up).toContain('CREATE UNIQUE INDEX "kay_jobs_key"')
      await db.sync()
      expect(await shapeOf(sql)).toEqual(created)

      const store = pgJobs(db)
      const added = job({ key: 'k' })

      expect(await store.add(added)).toBeUndefined()
      expect(await store.add(job({ key: 'k' }))).toBe(added.id)
      expect((await claimFor(store))?.id).toBe(added.id)
    }
    finally {
      await db.close()
    }
  })
})

pgDescribe('pgJobs', () => {
  pgIt('takes a Bun SQL, a pg-orm style { sql } or a URL', async () => {
    const sql = await freshPg()
    const { url: target } = await postgres()

    expect(await pgJobs(sql).add(job())).toBeUndefined()
    expect(await pgJobs({ sql }).jobs!('q')).toHaveLength(1)
    expect(await pgJobs(target).jobs!('q')).toHaveLength(1)
  })

  pgIt('creates its tables when replicas open it at once', async () => {
    await freshPg()

    const stores = replicas(6).map(pgJobs)

    expect(await Promise.all(stores.map(async store => store.add(job({ key: 'k' }))))).toHaveLength(6)
    expect(await stores[0]!.jobs!('q')).toHaveLength(1)
  })

  pgIt('needs no clock agreement between replicas: a hold lasts from the database\'s time', async () => {
    await freshPg()

    const [behind, ahead] = replicas(2).map(pgJobs)
    const added = job()

    await behind!.add(added)

    // The replica behind stores a hold its own clock puts 10 s before the other's, a lease that its peer's clock would take as ended.
    const now = Date.now()
    const claimed = await behind!.claim('q', now - 10_000, now - 5000)

    expect(claimed?.id).toBe(added.id)
    expect(Math.abs(heldOf(claimed) - (now + 5000))).toBeLessThan(2000)
    expect(await ahead!.claim('q', now + 10_000, now + 15_000)).toBeUndefined()
    expect(await ahead!.state!('q', { id: added.id }, now + 60_000)).toMatchObject({ status: 'running' })
    await behind!.release!(added.id, heldOf(claimed))
    expect((await ahead!.claim('q', now + 10_000, now + 15_000))?.id).toBe(added.id)
  })

  pgIt('hands each of many due jobs to exactly one of many claimers on separate connections', async () => {
    await freshPg()

    const stores = replicas(4).map(pgJobs)

    await Promise.all(Array.from({ length: 20 }, async (_, index) => stores[0]!.add(job({ runAt: index }))))

    const claimed = await Promise.all(Array.from({ length: 60 }, async (_, index) => stores[index % 4]!.claim('q', 1000, 2000)))
    const ids = claimed.filter(Boolean).map(claim => claim!.id)

    expect(ids).toHaveLength(20)
    expect(new Set(ids).size).toBe(20)
  })

  pgIt('lets one process take a schedule slot, however many ask at once', async () => {
    await postgres()

    const stores = replicas(4).map(pgJobs)
    const won = await Promise.all(stores.map(async store => store.lock('digest', 7)))

    expect(won.filter(Boolean)).toHaveLength(1)
    expect(await stores[0]!.lock('digest', 8)).toBe(true)
  })

  pgIt('drops expired failed jobs and counts them', async () => {
    const store = pgJobs(await freshPg())
    const old = job({ runAt: 1 })

    await store.add(old)
    await store.add(job({ runAt: 5000 }))
    await store.fail(old.id, 'boom', '[redacted]')
    expect((await store.failed('q'))[0]?.payload).toBe('[redacted]')
    expect(await store.purge!('q', 100)).toBe(1)
    expect(await store.failed('q')).toEqual([])
  })
})
