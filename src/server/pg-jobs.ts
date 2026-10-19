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
const LOST_KEY_TRIES = 3
const INSUFFICIENT_PRIVILEGE = '42501'

// The tables a store keeps its jobs and schedule locks in, for a pg-orm `ignoreTables` that keeps `db.sync()` and `pg-orm generate` from dropping them.
export const jobTables = ['kay_jobs', 'kay_locks'] as const

function toJob(row: PgJobRow): StoredJob {
  return { id: row.id, queue: row.queue, payload: row.payload, attempts: row.attempts, runAt: Number(row.run_at), ...row.error !== null && { error: row.error }, ...row.job_key !== null && { key: row.job_key }, ...row.progress !== null && { progress: row.progress } }
}

function statusOf(row: PgStateRow): StoredJobState['status'] {
  if (row.failed)
    return 'failed'

  return row.held ? 'running' : 'waiting'
}

// What a query resolves with, its rows typed.
async function rowsOf<Row>(query: PromiseLike<unknown>): Promise<Row[]> {
  return await query as Row[]
}

function connectionOf(source: PgJobsSource): SQL {
  if (typeof source === 'string')
    return new Bun.SQL(source)

  return 'sql' in source ? source.sql : source
}

// Creates `kay_jobs` and `kay_locks` and their indexes unless they exist: run it as the database's owner, in a migration or a boot script, when the app connects with a role that creates nothing (the app template's `app_rw`). `pgJobs` creates them itself when its role may.
// Replicas running it together take turns, and tables already there are left alone.
export async function createJobTables(source: PgJobsSource): Promise<void> {
  const db = connectionOf(source)

  try {
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`
      await tx`CREATE TABLE IF NOT EXISTS kay_jobs (id text PRIMARY KEY, queue text NOT NULL, payload text NOT NULL, attempts integer NOT NULL, run_at bigint NOT NULL, held_until bigint, failed boolean NOT NULL DEFAULT false, error text, job_key text, progress text)`
      await tx`CREATE INDEX IF NOT EXISTS kay_jobs_due ON kay_jobs (queue, failed, run_at)`
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS kay_jobs_key ON kay_jobs (queue, job_key) WHERE job_key IS NOT NULL AND NOT failed`
      await tx`CREATE TABLE IF NOT EXISTS kay_locks (name text NOT NULL, slot bigint NOT NULL, PRIMARY KEY (name, slot))`
    })
  }
  finally {
    if (typeof source === 'string')
      await db.close()
  }
}

// Jobs kept in the app's Postgres, shared by every process of every replica opening it, each job running in one of them: a claim is one `UPDATE` over a `FOR UPDATE SKIP LOCKED` pick.
// The tables `kay_jobs` and `kay_locks` are looked for first and created only when missing, which takes a role that may create tables: with one that may not, `createJobTables` run by the owner makes them. Either way they are outside pg-orm's table definitions, so list `jobTables` in its `ignoreTables`.
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
    const [found] = await rowsOf<{ jobs: string | null, locks: string | null, key: string | null }>(db`SELECT to_regclass('kay_jobs')::text AS jobs, to_regclass('kay_locks')::text AS locks, to_regclass('kay_jobs_key')::text AS key`)

    if (found?.jobs !== null && found?.locks !== null && found?.key !== null)
      return db

    try {
      await createJobTables(db)
    }
    catch (error) {
      if ((error as { errno?: string }).errno === INSUFFICIENT_PRIVILEGE)
        throw new Error('kay: pgJobs needs the tables kay_jobs and kay_locks, and its role may not create them: run `await createJobTables(db)` from kay/server as the database\'s owner, in a migration or a boot script', { cause: error })

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

      await db`UPDATE kay_jobs SET run_at = ${runAt}::bigint, held_until = NULL, error = ${error} WHERE id = ${id} AND (${until ?? null}::bigint IS NULL OR held_until = ${until ?? null}::bigint)`
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

      await db`UPDATE kay_jobs SET failed = true, held_until = NULL, error = ${error}, payload = coalesce(${payload ?? null}, payload) WHERE id = ${id} AND (${until ?? null}::bigint IS NULL OR held_until = ${until ?? null}::bigint)`
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
