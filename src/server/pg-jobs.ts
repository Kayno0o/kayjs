import type { SQL } from 'bun'
import type { JobStore, StoredJob, StoredJobState } from './queue'

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

type PgStateRow = PgJobRow & { failed: boolean, held_until: string | null }

// Whatever holds a Bun SQL on Postgres: the `SQL` itself, a pg-orm `Database` (its `sql`), or a connection URL.
export type PgJobsSource = SQL | { sql: SQL } | string

// What replicas starting together take turns on while one creates the tables.
const MIGRATION_LOCK = 'kay_jobs'
const LOST_KEY_TRIES = 3

function toJob(row: PgJobRow): StoredJob {
  return { id: row.id, queue: row.queue, payload: row.payload, attempts: row.attempts, runAt: Number(row.run_at), ...row.error !== null && { error: row.error }, ...row.job_key !== null && { key: row.job_key }, ...row.progress !== null && { progress: row.progress } }
}

function statusOf(row: PgStateRow, now: number): StoredJobState['status'] {
  if (row.failed)
    return 'failed'

  return row.held_until !== null && Number(row.held_until) > now ? 'running' : 'waiting'
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

// Jobs kept in the app's Postgres, shared by every process of every replica opening it, each job running in one of them: a claim is one `UPDATE` over a `FOR UPDATE SKIP LOCKED` pick.
// The tables `kay_jobs` and `kay_locks` create themselves the first time they are used, and a table made by an older kay gains the columns it lacks, so nothing is listed in the app's own migrations.
// Holds are read against the clock of the process claiming, as `sqliteJobs` does, so the replicas' clocks should agree to within a few seconds.
export function pgJobs(source: PgJobsSource): JobStore {
  let sql: SQL | undefined
  let ready: Promise<SQL> | undefined
  const connect = (): SQL => sql ??= connectionOf(source)

  // One connection runs it all, so a replica creating the tables at once with another waits its turn instead of failing on a duplicate.
  const create = async (db: SQL): Promise<SQL> => {
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`
      await tx`CREATE TABLE IF NOT EXISTS kay_jobs (id text PRIMARY KEY, queue text NOT NULL, payload text NOT NULL, attempts integer NOT NULL, run_at bigint NOT NULL, held_until bigint, failed boolean NOT NULL DEFAULT false, error text, job_key text, progress text)`
      await tx`ALTER TABLE kay_jobs ADD COLUMN IF NOT EXISTS job_key text`
      await tx`ALTER TABLE kay_jobs ADD COLUMN IF NOT EXISTS progress text`
      await tx`CREATE INDEX IF NOT EXISTS kay_jobs_due ON kay_jobs (queue, failed, run_at)`
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS kay_jobs_key ON kay_jobs (queue, job_key) WHERE job_key IS NOT NULL AND NOT failed`
      await tx`CREATE TABLE IF NOT EXISTS kay_locks (name text NOT NULL, slot bigint NOT NULL, PRIMARY KEY (name, slot))`
    })

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
      const [row] = await rowsOf<PgJobRow>(db`UPDATE kay_jobs SET held_until = ${until}::bigint, progress = NULL, attempts = attempts + 1 WHERE id = (SELECT id FROM kay_jobs WHERE queue = ${queue} AND NOT failed AND run_at <= ${now}::bigint AND (held_until IS NULL OR held_until <= ${now}::bigint) ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, queue, payload, attempts, run_at, error, job_key, progress`)

      return row === undefined ? undefined : toJob(row)
    },
    async complete(id) {
      const db = await open()

      await db`DELETE FROM kay_jobs WHERE id = ${id}`
    },
    async retry(id, runAt, error) {
      const db = await open()

      await db`UPDATE kay_jobs SET run_at = ${runAt}::bigint, held_until = NULL, error = ${error} WHERE id = ${id}`
    },
    async release(id, until, runAt) {
      const db = await open()

      await db`UPDATE kay_jobs SET held_until = NULL, attempts = attempts - 1, run_at = coalesce(${runAt ?? null}::bigint, run_at) WHERE id = ${id} AND held_until = ${until}::bigint`
    },
    async progress(id, until, progress) {
      const db = await open()

      await db`UPDATE kay_jobs SET progress = ${progress} WHERE id = ${id} AND held_until = ${until}::bigint`
    },
    async state(queue, ref, now) {
      const db = await open()
      const [row] = 'key' in ref
        ? await rowsOf<PgStateRow>(db`SELECT id, queue, payload, attempts, run_at, error, job_key, progress, failed, held_until FROM kay_jobs WHERE queue = ${queue} AND job_key = ${ref.key} ORDER BY failed, run_at DESC LIMIT 1`)
        : await rowsOf<PgStateRow>(db`SELECT id, queue, payload, attempts, run_at, error, job_key, progress, failed, held_until FROM kay_jobs WHERE queue = ${queue} AND id = ${ref.id}`)

      return row === undefined ? undefined : { ...toJob(row), status: statusOf(row, now) }
    },
    async fail(id, error, payload) {
      const db = await open()

      await db`UPDATE kay_jobs SET failed = true, held_until = NULL, error = ${error}, payload = coalesce(${payload ?? null}, payload) WHERE id = ${id}`
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
