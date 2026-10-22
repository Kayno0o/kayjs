import type { SQL } from 'bun'
import type { JobStore, StoredJob, StoredJobState } from './queue'
import { onReload } from './reload'

interface PgJobRow {
  id: string
  queue: string
  payload: string
  attempts: number
  run_at: string
  error: string | null
  job_key: string | null
  progress: string | null
}

type PgStateRow = PgJobRow & { failed: boolean, held: boolean }

// Whatever holds a Bun SQL on Postgres: the `SQL` itself, a pg-orm `Database` (its `sql`), or a connection URL.
export type PgJobsSource = SQL | { sql: SQL } | string

// What replicas starting together take turns on while one creates the tables.
const MIGRATION_LOCK = 'kay_jobs'
const INDEX_LOCK = 'kay_indexes'
const LOST_KEY_TRIES = 3
const INSUFFICIENT_PRIVILEGE = '42501'
const DUPLICATE_RELATION = '42P07'
const DEADLOCK_DETECTED = '40P01'
const INDEX_WAIT_MS = 120_000
const INDEX_POLL_MS = 200

// The names of the tables a store keeps its jobs and schedule locks in, for a pg-orm `ignoreTables` of an app that creates them with `createJobTables`: one that lists the table definitions of `jobTables` from `kay/pg-orm` has no use for it.
export const jobTables = ['kay_jobs', 'kay_locks'] as const

// An index a kay table keeps, created with its table or, on a table already there, on its own.
export interface PgIndex { name: string, on: string, unique?: boolean }

const JOB_INDEXES: readonly PgIndex[] = [
  { name: 'kay_jobs_due', on: 'kay_jobs (queue, failed, run_at)' },
  { name: 'kay_jobs_key', on: 'kay_jobs (queue, job_key) WHERE job_key IS NOT NULL AND NOT failed', unique: true },
]

export function indexStatement(index: PgIndex, concurrently: boolean): string {
  return `CREATE ${index.unique === true ? 'UNIQUE ' : ''}INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${index.name} ON ${index.on}`
}

// Gives the database back after creating the indexes it lacks, unless its role may not: the tables are there, and the app is then run without them rather than stopped.
export async function withMissingIndexes(db: SQL, indexes: readonly PgIndex[]): Promise<SQL> {
  try {
    await createMissingIndexes(db, indexes)
  }
  catch (error) {
    if ((error as { errno?: string }).errno !== INSUFFICIENT_PRIVILEGE)
      throw error
  }

  return db
}

// Whether one of these relations does not exist.
export async function relationsMissing(db: SQL, names: readonly string[]): Promise<boolean> {
  const [found] = await rowsOf<{ missing: boolean }>(db.unsafe(`SELECT ${names.map(name => `to_regclass('${name}') IS NULL`).join(' OR ')} AS missing`))

  return found?.missing === true
}

// Creates the indexes missing on tables that exist, each on its own and concurrently: a plain CREATE INDEX locks its table against writes, and inside a transaction with others it would deadlock with a replica writing several tables.
// One replica at a time: two concurrent builds of one index deadlock each other, so a replica that finds another one at it leaves the indexes to it. Whoever built or not, it then waits for the unique ones to be valid, as a keyed job enqueued before kay_jobs_key is enforced could be enqueued twice. It waits at most INDEX_WAIT_MS, then warns and goes on: a build that failed is taken over by the next try of the lock.
// The lock is a session one, held on the connection that builds. Behind a transaction-mode pooler it is not held across statements, so a replica that deadlocked (40P01) with another's build counts as having lost it, and the same wait applies; the lock only keeps builds apart on a direct or session-mode connection.
export async function createMissingIndexes(db: SQL, indexes: readonly PgIndex[]): Promise<void> {
  const deadline = Date.now() + INDEX_WAIT_MS

  while (true) {
    await buildMissingIndexes(db, indexes)

    if (await uniqueIndexesValid(db, indexes))
      return

    if (Date.now() >= deadline) {
      console.warn('kay: a unique index of the job tables is still not valid, so a keyed job may be enqueued twice until it is; the index build may be stuck, or a lock held by a pooled connection')

      return
    }

    await Bun.sleep(INDEX_POLL_MS)
  }
}

// Whether every unique index of these exists and is valid, so the constraint it stands for holds.
async function uniqueIndexesValid(db: SQL, indexes: readonly PgIndex[]): Promise<boolean> {
  for (const index of indexes) {
    if (index.unique !== true)
      continue

    const [found] = await rowsOf<{ valid: boolean | null }>(db.unsafe(`SELECT (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('${index.name}')) AS valid`))

    if (found?.valid !== true)
      return false
  }

  return true
}

// Builds the indexes that are missing under the lock, doing nothing when another replica holds it or its build deadlocked with ours.
async function buildMissingIndexes(db: SQL, indexes: readonly PgIndex[]): Promise<void> {
  // It runs all its queries on the one connection holding the lock, so a pool of one connection does not wait on itself.
  const session = await db.reserve()

  try {
    const [lock] = await rowsOf<{ taken: boolean }>(session`SELECT pg_try_advisory_lock(hashtext(${INDEX_LOCK})) AS taken`)

    if (lock?.taken !== true)
      return

    try {
      for (const index of indexes) {
        if (!await relationsMissing(session, [index.name])) {
          // A concurrent build that failed leaves an invalid index, which is dropped to be built again, but one that is invalid while another session still builds it is left alone: its session holds a ShareUpdateExclusiveLock on the table, which pg_locks shows to every role, unlike the progress views, so an autovacuum running meanwhile only delays the repair to the next start. Whether it is building is read before whether it is valid, so a build finishing in between reads as valid.
          const [building] = await rowsOf<{ building: boolean }>(session.unsafe(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'relation' AND mode = 'ShareUpdateExclusiveLock' AND relation = (SELECT indrelid FROM pg_index WHERE indexrelid = to_regclass('${index.name}')) AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS building`))

          if (building?.building === true)
            continue

          const [found] = await rowsOf<{ valid: boolean }>(session.unsafe(`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('${index.name}')`))

          if (found?.valid !== false)
            continue

          await session.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`)
        }

        try {
          await session.unsafe(indexStatement(index, true))
        }
        catch (error) {
          // A replica creating the same index at the same moment won it.
          if ((error as { errno?: string }).errno !== DUPLICATE_RELATION)
            throw error
        }
      }
    }
    catch (error) {
      if ((error as { errno?: string }).errno !== DEADLOCK_DETECTED)
        throw error
    }
    finally {
      // The pooled connection goes back holding the lock otherwise; a dead one frees it by ending.
      try {
        await session`SELECT pg_advisory_unlock(hashtext(${INDEX_LOCK}))`
      }
      catch {}
    }
  }
  finally {
    session.release()
  }
}

function toJob(row: PgJobRow): StoredJob {
  return { id: row.id, queue: row.queue, payload: row.payload, attempts: row.attempts, runAt: Number(row.run_at), ...row.error !== null && { error: row.error }, ...row.job_key !== null && { key: row.job_key }, ...row.progress !== null && { progress: row.progress } }
}

function statusOf(row: PgStateRow): StoredJobState['status'] {
  if (row.failed)
    return 'failed'

  return row.held ? 'running' : 'waiting'
}

// What a query resolves with, its rows typed.
export async function rowsOf<Row>(query: PromiseLike<unknown>): Promise<Row[]> {
  return await query as Row[]
}

export function connectionOf(source: PgJobsSource): SQL {
  if (typeof source === 'string')
    return new Bun.SQL(source)

  return 'sql' in source ? source.sql : source
}

// Creates `kay_jobs` and `kay_locks` and their indexes unless they exist (an index missing on tables already there is created on its own, without a lock that waits on a writer), for an app whose migrations do not: run it as the database's owner, in a boot script, when the app connects with a role that creates nothing (the app template's `app_rw`). `pgJobs` creates them itself when its role may.
// Replicas running it together take turns, and tables already there are left alone.
export async function createJobTables(source: PgJobsSource): Promise<void> {
  const db = connectionOf(source)

  try {
    if (await relationsMissing(db, jobTables)) {
      await db.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`
        await tx`CREATE TABLE IF NOT EXISTS kay_jobs (id text PRIMARY KEY, queue text NOT NULL, payload text NOT NULL, attempts integer NOT NULL, run_at bigint NOT NULL, held_until bigint, failed boolean NOT NULL DEFAULT false, error text, job_key text, progress text)`
        await tx`CREATE TABLE IF NOT EXISTS kay_locks (name text NOT NULL, slot bigint NOT NULL, PRIMARY KEY (name, slot))`

        for (const index of JOB_INDEXES)
          await tx.unsafe(indexStatement(index, false))
      })

      return
    }

    await createMissingIndexes(db, JOB_INDEXES)
  }
  finally {
    if (typeof source === 'string')
      await db.close()
  }
}

// Jobs kept in the app's Postgres, shared by every process of every replica opening it, each job running in one of them: a claim is one `UPDATE` over a `FOR UPDATE SKIP LOCKED` pick.
// The tables `kay_jobs` and `kay_locks` are looked for first, and an app on pg-orm lists `jobTables` from `kay/pg-orm` in its `new Database({ tables })` so its own migrations create them. A store that finds them missing creates them, which takes a role that may create tables: with one that may not, `createJobTables` run by the owner makes them, and pg-orm's `ignoreTables` then needs the names in `jobTables` of `kay/server`.
// A hold lasts from the database's clock, whichever replica claims: replicas' clocks need not agree. A job's `runAt` stays the clock of the process that enqueued or retried it, compared with the claiming process's.
export function pgJobs(source: PgJobsSource): JobStore {
  let sql: SQL | undefined
  let ready: Promise<SQL> | undefined
  const connect = (): SQL => {
    if (sql === undefined) {
      sql = connectionOf(source)

      // A connection this store opened from a URL goes with the module that did, so a reload does not leave its pool behind.
      if (typeof source === 'string') {
        const opened = sql

        onReload(() => {
          void opened.close()
          sql = undefined
          ready = undefined
        })
      }
    }

    return sql
  }

  const create = async (db: SQL): Promise<SQL> => {
    if (!await relationsMissing(db, jobTables))
      return withMissingIndexes(db, JOB_INDEXES)

    try {
      await createJobTables(db)
    }
    catch (error) {
      if ((error as { errno?: string }).errno === INSUFFICIENT_PRIVILEGE)
        throw new Error('kay: pgJobs needs the tables kay_jobs and kay_locks, and its role may not create them: list `jobTables` from kay/pg-orm in the Database\'s tables so a migration creates them, or run `await createJobTables(db)` from kay/server as the database\'s owner', { cause: error })

      throw error
    }

    return db
  }

  // A failed creation is tried again by the next call rather than kept.
  const open = async (): Promise<SQL> => {
    ready ??= create(connect())

    try {
      return await ready
    }
    catch (error) {
      ready = undefined

      throw error
    }
  }

  return {
    async add(job) {
      const db = await open()

      // A holder that completes between the refused insert and the read leaves the key free: insert again.
      for (let tries = 0; tries < LOST_KEY_TRIES; tries++) {
        const inserted = await rowsOf<{ id: string }>(db`INSERT INTO kay_jobs (id, queue, payload, attempts, run_at, job_key) VALUES (${job.id}, ${job.queue}, ${job.payload}, ${job.attempts}, ${job.runAt}::bigint, ${job.key ?? null}) ON CONFLICT DO NOTHING RETURNING id`)

        if (inserted.length === 1 || job.key === undefined)
          return undefined

        const [held] = await rowsOf<{ id: string }>(db`SELECT id FROM kay_jobs WHERE queue = ${job.queue} AND job_key = ${job.key} AND NOT failed`)

        if (held !== undefined)
          return held.id
      }

      throw new Error(`kay: the key '${job.key}' of queue('${job.queue}') kept changing hands while a job was added`)
    },
    async claim(queue, now, until) {
      const db = await open()
      const [row] = await rowsOf<PgJobRow & { held_until: string }>(db`UPDATE kay_jobs SET held_until = (floor(extract(epoch FROM statement_timestamp()) * 1000))::bigint + ${until - now}::bigint, progress = NULL, attempts = attempts + 1 WHERE id = (SELECT id FROM kay_jobs WHERE queue = ${queue} AND NOT failed AND run_at <= ${now}::bigint AND (held_until IS NULL OR held_until <= (floor(extract(epoch FROM statement_timestamp()) * 1000))::bigint) ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, queue, payload, attempts, run_at, error, job_key, progress, held_until`)

      return row === undefined ? undefined : { ...toJob(row), heldUntil: Number(row.held_until) }
    },
    async complete(id, until) {
      const db = await open()

      await db`DELETE FROM kay_jobs WHERE id = ${id} AND (${until ?? null}::bigint IS NULL OR held_until = ${until ?? null}::bigint)`
    },
    async retry(id, runAt, error, until) {
      const db = await open()

      return (await rowsOf<{ id: string }>(db`UPDATE kay_jobs SET run_at = ${runAt}::bigint, held_until = NULL, error = ${error} WHERE id = ${id} AND (${until ?? null}::bigint IS NULL OR held_until = ${until ?? null}::bigint) RETURNING id`)).length === 1
    },
    async release(id, until, runAt) {
      const db = await open()

      await db`UPDATE kay_jobs SET held_until = NULL, attempts = attempts - 1, run_at = coalesce(${runAt ?? null}::bigint, run_at) WHERE id = ${id} AND held_until = ${until}::bigint`
    },
    async progress(id, until, progress) {
      const db = await open()

      await db`UPDATE kay_jobs SET progress = ${progress} WHERE id = ${id} AND held_until = ${until}::bigint`
    },
    async state(queue, ref) {
      const db = await open()
      const [row] = 'key' in ref
        ? await rowsOf<PgStateRow>(db`SELECT id, queue, payload, attempts, run_at, error, job_key, progress, failed, coalesce(held_until > (floor(extract(epoch FROM statement_timestamp()) * 1000))::bigint, false) AS held FROM kay_jobs WHERE queue = ${queue} AND job_key = ${ref.key} ORDER BY failed, run_at DESC LIMIT 1`)
        : await rowsOf<PgStateRow>(db`SELECT id, queue, payload, attempts, run_at, error, job_key, progress, failed, coalesce(held_until > (floor(extract(epoch FROM statement_timestamp()) * 1000))::bigint, false) AS held FROM kay_jobs WHERE queue = ${queue} AND id = ${ref.id}`)

      return row === undefined ? undefined : { ...toJob(row), status: statusOf(row) }
    },
    async fail(id, error, payload, until) {
      const db = await open()

      return (await rowsOf<{ id: string }>(db`UPDATE kay_jobs SET failed = true, held_until = NULL, error = ${error}, payload = coalesce(${payload ?? null}, payload) WHERE id = ${id} AND (${until ?? null}::bigint IS NULL OR held_until = ${until ?? null}::bigint) RETURNING id`)).length === 1
    },
    async purge(queue, before) {
      const db = await open()
      const purged = await rowsOf<{ id: string }>(db`DELETE FROM kay_jobs WHERE queue = ${queue} AND failed AND run_at < ${before}::bigint RETURNING id`)

      return purged.length
    },
    async failed(queue) {
      const db = await open()

      return (await rowsOf<PgJobRow>(db`SELECT id, queue, payload, attempts, run_at, error, job_key, progress FROM kay_jobs WHERE queue = ${queue} AND failed ORDER BY run_at`)).map(toJob)
    },
    async jobs(queue) {
      const db = await open()

      return (await rowsOf<PgJobRow>(db`SELECT id, queue, payload, attempts, run_at, error, job_key, progress FROM kay_jobs WHERE queue = ${queue} ORDER BY run_at`)).map(toJob)
    },
    async nextRunAt(queue) {
      const db = await open()
      // A held job counts from when its hold ends, as it runs again then if its process died.
      const [row] = await rowsOf<{ at: string | null }>(db`SELECT min(greatest(run_at, coalesce(held_until, 0)))::text AS at FROM kay_jobs WHERE queue = ${queue} AND NOT failed`)

      return row?.at === null || row?.at === undefined ? undefined : Number(row.at)
    },
    async lock(name, slot) {
      const db = await open()
      const won = await rowsOf<{ name: string }>(db`INSERT INTO kay_locks (name, slot) VALUES (${name}, ${slot}::bigint) ON CONFLICT DO NOTHING RETURNING name`)

      // A slot is a minute, so a day of them is far past any process still deciding one.
      await db`DELETE FROM kay_locks WHERE name = ${name} AND slot < ${slot - 1440}::bigint`

      return won.length === 1
    },
  }
}
