import type { Database } from 'bun:sqlite'
import type { Duration } from '../runtime/duration'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { parse, stringify } from 'devalue'
import { Elysia } from 'elysia'
import { KayError } from '../compiler/errors'
import { durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { openSqlite } from '../runtime/sqlite.server'
import { appStore } from './app-store'
import { MAX_TIMER_MS } from './config-limits'
import { onReload } from './reload'
import { reportBackgroundError } from './report'

// A job as a store keeps it, its payload as devalue text.
export interface StoredJob {
  id: string
  queue: string
  payload: string
  // Runs started so far, the one a claim starts included.
  attempts: number
  // When it may run, in ms since the epoch.
  runAt: number
  // Why its last run failed.
  error?: string
  // What the app named it for, one live job (waiting or running) per queue and key.
  key?: string
  // What its run last reported, as devalue text.
  progress?: string
}

// A job as the app reads it back: where it stands, and what its last run reported.
export interface StoredJobState extends StoredJob {
  // `running` while a process holds it, `waiting` for a job due or retried, `failed` once given up.
  status: 'waiting' | 'running' | 'failed'
}

type Maybe<T> = T | Promise<T>

// Where queued jobs wait, shared by every process opening it: `sqliteJobs` by default, or one of an app's own, Redis or Postgres say.
export interface JobStore {
  // Keeps a job, unless it has a `key` that a waiting or running job of its queue holds already: then it keeps nothing and resolves with that job's id, atomically, whichever process added it. A store without `state` ignores keys.
  add: (job: StoredJob) => Maybe<string | void>
  // Takes the queue's next job whose time has come and that no process holds, holding it until `until`, past which a process that died running it is taken as gone; one process at a time gets a job.
  claim: (queue: string, now: number, until: number) => Maybe<StoredJob | undefined>
  complete: (id: string) => Maybe<void>
  // Runs it again at `runAt`.
  retry: (id: string, runAt: number, error: string) => Maybe<void>
  // Gives a job back untouched, its attempt not counted, for the next process to take: a run stopped by a shutdown. Only while the hold `until` it was claimed with is still the job's, so a late release never clears another process's claim. A store without it has the job retried after its backoff as any failed run.
  // With `runAt`, the job is due then rather than at once: a run that wants another go later without spending an attempt.
  release?: ((id: string, until: number, runAt?: number) => Maybe<void>) | undefined
  // Writes what the run holding the job until `until` reports, devalue text, only while that hold is still the job's; a claim clears it.
  progress?: ((id: string, until: number, progress: string) => Maybe<void>) | undefined
  // The waiting or running job of the queue with that key or id, else its last failed one, `now` telling a held job from one whose hold ran out; undefined for a job that completed.
  state?: ((queue: string, ref: { key: string } | { id: string }, now: number) => Maybe<StoredJobState | undefined>) | undefined
  // Keeps it as failed, out of the queue, with `payload` in place of the stored one when the queue redacts what it keeps; a store ignoring it keeps the payload whole.
  fail: (id: string, error: string, payload?: string) => Maybe<void>
  // Removes the failed jobs of the queue whose time came before `before`, and resolves with how many went; a store without it has them listed with `failed` and removed one by one.
  purge?: ((queue: string, before: number) => Maybe<number>) | undefined
  failed: (queue: string) => Maybe<StoredJob[]>
  // Every job of the queue, waiting or failed, which `remove` looks through for a payload; a store without it removes jobs by id alone.
  jobs?: ((queue: string) => Maybe<StoredJob[]>) | undefined
  // When the queue's next job may run, so a worker sleeps until then.
  nextRunAt: (queue: string) => Maybe<number | undefined>
  // True for the first caller naming this lock and slot, in any process: a schedule's run happens once.
  lock: (name: string, slot: number) => Maybe<boolean>
}

export interface QueueOptions<Payload> {
  // `sqliteJobs('data/jobs.sqlite')` unless given, in memory under `bun test`.
  store?: JobStore | undefined
  // Runs in all, the first included, before a job is kept as failed. 5 by default.
  attempts?: number | undefined
  // The wait before the first retry, doubling for each one after it. 10 seconds by default.
  backoff?: Duration | undefined
  // Jobs of this queue one process runs at once. 1 by default.
  concurrency?: number | undefined
  // How long a run may take: past it, the run counts as failed and frees its worker, and another process takes a job its dead process held as lost. 10 minutes by default.
  lostAfter?: Duration | undefined
  // The longest an idle queue waits between looks at the store, 10 seconds by default.
  // After a job it looks again within 1 second, then waits twice as long after each empty look up to this, and starts over once a job runs, so a job another process enqueued is noticed within this at worst; one enqueued in this process, or due at a time the store knows, still runs at once. One worker of a queue looks for all of them.
  // `'1s'` is the poll every second the queue made before.
  idlePoll?: Duration | undefined
  // How long a failed job is kept, its payload included, from when its last attempt was due: 30 days by default, `false` until removed.
  keepFailed?: Duration | false | undefined
  // What a failed job keeps in place of its payload, such as a mail without its body: applied once it is given up, so a failed job holds no more than the app needs to see what went wrong. The payload is kept whole when it throws.
  redact?: ((payload: Payload) => Payload) | undefined
  // Gets a job that failed its last attempt, once it is kept as failed.
  onFailed?: ((payload: Payload, error: unknown) => unknown) | undefined
}

export interface EnqueueOptions {
  // Runs it this long from now rather than as soon as a worker can.
  delay?: Duration | undefined
  // Names the job: while one of this queue with the key is waiting or running, enqueue keeps nothing and resolves with its id, so a sync asked for twice runs once; once it completed or failed the key is free. `job(key)` reads it back.
  key?: string | undefined
}

// What a handler gets besides its payload and signal.
export interface JobContext<Progress> {
  id: string
  // Runs started so far, this one included.
  attempts: number
  // Reports how far the run is, any value devalue keeps, for `state` to read back while it runs and after it fails; the latest report wins, written in the background, and a report after the run ended is dropped.
  progress: (value: Progress) => void
}

// Where a job stands, as the app reads it back.
export interface JobState<Progress> {
  id: string
  // `running` while a process holds it, `waiting` for a job due or waiting for a retry, `failed` once given up.
  status: 'waiting' | 'running' | 'failed'
  // Runs started so far.
  attempts: number
  // What its last run reported.
  progress?: Progress
  // Why its last run failed.
  error?: string
}

export interface FailedJob<Payload> {
  id: string
  payload: Payload
  attempts: number
  error: string
}

export type Queue<Payload, Progress = unknown> = Elysia & {
  // Keeps the job for a worker to run, surviving a restart; resolves with its id once stored.
  enqueue: (payload: Payload, options?: EnqueueOptions) => Promise<string>
  // The waiting or running job with that key, else the last one with it that failed, or the job of that id; undefined for one that completed or never was. Needs a store with `state`, as `sqliteJobs`, `memoryJobs` and `pgJobs` have.
  job: (job: string | { id: string }) => Promise<JobState<Progress> | undefined>
  // Runs every job whose time has come, here and now, until none is left: for a test, or a script with no server.
  drain: () => Promise<number>
  failed: () => Promise<FailedJob<Payload>[]>
  // Removes the job of that id, or every job, waiting or failed, whose payload `match` returns true for, such as a person's mails once they asked to be erased; resolves with how many went.
  remove: (match: string | ((payload: Payload) => boolean)) => Promise<number>
}

const DEFAULT_ATTEMPTS = 5
const DEFAULT_BACKOFF = 10
const DEFAULT_LOST_AFTER = 600
const DEFAULT_KEEP_FAILED = 30 * 24 * 60 * 60
// How often a process's workers drop the failed jobs past `keepFailed`.
const PURGE_MS = 60 * 60 * 1000
// How soon an idle queue looks again after a job, the first wait of its backoff.
const POLL_MS = 1000
// The longest an idle queue waits between looks unless `idlePoll` says otherwise: a job another process enqueued waits this at worst.
const IDLE_POLL_S = 10
// The longest a worker waits between looks at a store that keeps failing.
const MAX_OUTAGE_MS = 60_000
const DEFAULT_PATH = 'data/jobs.sqlite'
// Why a run's signal aborted when the server stopped, as against lostAfter running out.
const STOPPED = new Error('the server is stopping')

class RetryLater extends Error {
  readonly waitMs: number

  constructor(waitMs: number, reason: string) {
    super(reason)
    this.name = 'RetryLater'
    this.waitMs = waitMs
  }
}

// Thrown from a handler to run the job again after `wait` without spending an attempt, for a failure that is nobody's fault, a full disk or a service asked to slow down: `throw retryLater('30s')`.
// It repeats for as long as the handler throws it, so a handler that should give up throws an error of its own, which spends attempts as ever; a store without `release` spends one here too.
export function retryLater(wait: Duration, reason = 'it asked to run again later'): Error {
  return new RetryLater(durationSeconds(wait, 'retryLater\'s wait') * 1000, reason)
}

// What drains each queue made, for `kay/test` to run them all.
const drains = new Set<() => Promise<number>>()
let defaultStore: JobStore | undefined

// Jobs kept in a SQLite file: they survive restarts and deploys, and every process of the machine opening it shares them, each job running in one of them.
// The file is created by the first job enqueued or schedule locked, which every schedule of a production server does, so only a development server whose queue never gets a job writes nothing.
export function sqliteJobs(path: string): JobStore {
  let statements: ReturnType<typeof prepareJobs> | undefined
  let db: Database | undefined
  // A read before the file exists finds no job rather than creating it, then opens it once another process did.
  // The default store is kept for good, so a reload only lets go of the file, which the next job opens again, under the module that did.
  const open = (create: boolean) => {
    if (statements === undefined && (create || existsSync(path))) {
      statements = prepareJobs(db = openSqlite(path))
      onReload(() => {
        db?.close()
        db = undefined
        statements = undefined
      })
    }

    return statements
  }

  return {
    add(job) {
      const { insert, holder } = open(true)!

      // A holder that completes between the refused insert and the read leaves the key free: insert again.
      for (let tries = 0; tries < 3; tries++) {
        if (insert.run(job.id, job.queue, job.payload, job.attempts, job.runAt, job.key ?? null).changes === 1 || job.key === undefined)
          return undefined

        const held = holder.get(job.queue, job.key)

        if (held)
          return held.id
      }

      throw new Error(`kay: the key '${job.key}' of queue('${job.queue}') kept changing hands while a job was added`)
    },
    claim(queue, now, until) {
      const row = open(false)?.claim.get(until, queue, now, now)

      return row ? toJob(row) : undefined
    },
    complete(id) {
      open(true)!.remove.run(id)
    },
    retry(id, runAt, error) {
      open(true)!.retry.run(runAt, error, id)
    },
    release(id, until, runAt) {
      open(true)!.release.run(runAt ?? null, id, until)
    },
    progress(id, until, progress) {
      open(true)!.progress.run(progress, id, until)
    },
    state(queue, ref, now) {
      const statements = open(false)

      if (!statements)
        return undefined

      const row = 'key' in ref ? statements.byKey.get(queue, ref.key) : statements.byId.get(queue, ref.id)

      return row ? { ...toJob(row), status: statusOf(row.failed === 1, row.held_until ?? 0, now) } : undefined
    },
    fail(id, error, payload) {
      open(true)!.fail.run(error, payload ?? null, id)
    },
    purge(queue, before) {
      return open(false)?.purge.run(queue, before).changes ?? 0
    },
    failed(queue) {
      return open(false)?.failed.all(queue).map(toJob) ?? []
    },
    jobs(queue) {
      return open(false)?.all.all(queue).map(toJob) ?? []
    },
    nextRunAt(queue) {
      return open(false)?.next.get(queue)?.at ?? undefined
    },
    lock(name, slot) {
      const { lock, pruneLocks } = open(true)!
      const won = lock.run(name, slot).changes === 1

      // A slot is a minute, so a day of them is far past any process still deciding one.
      pruneLocks.run(name, slot - 1440)

      return won
    },
  }
}

interface JobRow { id: string, queue: string, payload: string, attempts: number, run_at: number, error: string | null, job_key: string | null, progress: string | null }
type StateRow = JobRow & { failed: number, held_until: number | null }

function statusOf(failed: boolean, heldUntil: number, now: number): StoredJobState['status'] {
  if (failed)
    return 'failed'

  return heldUntil > now ? 'running' : 'waiting'
}

const JOB_COLUMNS = 'id, queue, payload, attempts, run_at, error, job_key, progress'

function toJob(row: JobRow): StoredJob {
  return { id: row.id, queue: row.queue, payload: row.payload, attempts: row.attempts, runAt: row.run_at, ...row.error !== null && { error: row.error }, ...row.job_key !== null && { key: row.job_key }, ...row.progress !== null && { progress: row.progress } }
}

function prepareJobs(db: Database) {
  db.run('CREATE TABLE IF NOT EXISTS kay_jobs (id TEXT PRIMARY KEY, queue TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL, run_at INTEGER NOT NULL, held_until INTEGER, failed INTEGER NOT NULL DEFAULT 0, error TEXT)')
  // A file made before keys and progress gains their columns.
  const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(kay_jobs)').all().map(column => column.name))

  for (const column of ['job_key', 'progress']) {
    if (!columns.has(column))
      db.run(`ALTER TABLE kay_jobs ADD COLUMN ${column} TEXT`)
  }

  db.run('CREATE INDEX IF NOT EXISTS kay_jobs_due ON kay_jobs (queue, failed, run_at)')
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS kay_jobs_key ON kay_jobs (queue, job_key) WHERE job_key IS NOT NULL AND failed = 0')
  db.run('CREATE TABLE IF NOT EXISTS kay_locks (name TEXT NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY (name, slot))')

  const insert = db.query('INSERT OR IGNORE INTO kay_jobs (id, queue, payload, attempts, run_at, job_key) VALUES (?, ?, ?, ?, ?, ?)')
  const holder = db.query<{ id: string }, [string, string]>('SELECT id FROM kay_jobs WHERE queue = ? AND job_key = ? AND failed = 0')
  const claim = db.query<JobRow, [number, string, number, number]>(`UPDATE kay_jobs SET held_until = ?, progress = NULL, attempts = attempts + 1 WHERE id = (SELECT id FROM kay_jobs WHERE queue = ? AND failed = 0 AND run_at <= ? AND (held_until IS NULL OR held_until <= ?) ORDER BY run_at LIMIT 1) RETURNING ${JOB_COLUMNS}`)
  const remove = db.query('DELETE FROM kay_jobs WHERE id = ?')
  const retry = db.query('UPDATE kay_jobs SET run_at = ?, held_until = NULL, error = ? WHERE id = ?')
  const release = db.query('UPDATE kay_jobs SET held_until = NULL, attempts = attempts - 1, run_at = coalesce(?, run_at) WHERE id = ? AND held_until = ?')
  const progress = db.query('UPDATE kay_jobs SET progress = ? WHERE id = ? AND held_until = ?')
  // A live job comes before a failed one of the same key, the latest failed first.
  const byKey = db.query<StateRow, [string, string]>(`SELECT ${JOB_COLUMNS}, failed, held_until FROM kay_jobs WHERE queue = ? AND job_key = ? ORDER BY failed, run_at DESC LIMIT 1`)
  const byId = db.query<StateRow, [string, string]>(`SELECT ${JOB_COLUMNS}, failed, held_until FROM kay_jobs WHERE queue = ? AND id = ?`)
  const fail = db.query('UPDATE kay_jobs SET failed = 1, held_until = NULL, error = ?, payload = coalesce(?, payload) WHERE id = ?')
  const purge = db.query('DELETE FROM kay_jobs WHERE queue = ? AND failed = 1 AND run_at < ?')
  const failed = db.query<JobRow, [string]>(`SELECT ${JOB_COLUMNS} FROM kay_jobs WHERE queue = ? AND failed = 1 ORDER BY run_at`)
  const all = db.query<JobRow, [string]>(`SELECT ${JOB_COLUMNS} FROM kay_jobs WHERE queue = ? ORDER BY run_at`)
  // A held job counts from when its hold ends, as it runs again then if its process died.
  const next = db.query<{ at: number | null }, [string]>('SELECT min(max(run_at, coalesce(held_until, 0))) AS at FROM kay_jobs WHERE queue = ? AND failed = 0')
  const lock = db.query('INSERT OR IGNORE INTO kay_locks (name, slot) VALUES (?, ?)')
  const pruneLocks = db.query('DELETE FROM kay_locks WHERE name = ? AND slot < ?')

  return { insert, holder, claim, remove, retry, release, progress, byKey, byId, fail, purge, failed, all, next, lock, pruneLocks }
}

// Jobs kept in this process's memory, gone with it: what tests run on.
export function memoryJobs(): JobStore {
  const jobs = new Map<string, StoredJob & { heldUntil?: number, failed?: boolean }>()
  const locks = new Set<string>()
  const waiting = (queue: string) => [...jobs.values()].filter(job => job.queue === queue && !job.failed)
  const stored = ({ heldUntil: _, failed: __, ...job }: StoredJob & { heldUntil?: number, failed?: boolean }): StoredJob => job

  return {
    add(job) {
      const holder = job.key === undefined ? undefined : waiting(job.queue).find(other => other.key === job.key)

      if (holder)
        return holder.id

      jobs.set(job.id, { ...job })

      return undefined
    },
    claim(queue, now, until) {
      const job = waiting(queue).filter(job => job.runAt <= now && (job.heldUntil ?? 0) <= now).sort((a, b) => a.runAt - b.runAt)[0]

      if (!job)
        return undefined

      job.heldUntil = until
      job.attempts++
      delete job.progress

      return stored(job)
    },
    complete(id) {
      jobs.delete(id)
    },
    retry(id, runAt, error) {
      Object.assign(jobs.get(id) ?? {}, { runAt, error, heldUntil: undefined })
    },
    release(id, until, runAt) {
      const job = jobs.get(id)

      if (job?.heldUntil === until) {
        delete job.heldUntil
        job.attempts--

        if (runAt !== undefined)
          job.runAt = runAt
      }
    },
    progress(id, until, progress) {
      const job = jobs.get(id)

      if (job?.heldUntil === until)
        job.progress = progress
    },
    state(queue, ref, now) {
      const matches = [...jobs.values()].filter(job => job.queue === queue && ('key' in ref ? job.key === ref.key : job.id === ref.id))
      const job = matches.find(other => !other.failed) ?? matches.filter(other => other.failed).sort((a, b) => b.runAt - a.runAt)[0]

      return job ? { ...stored(job), status: statusOf(job.failed === true, job.heldUntil ?? 0, now) } : undefined
    },
    fail(id, error, payload) {
      Object.assign(jobs.get(id) ?? {}, { failed: true, error, heldUntil: undefined, ...payload !== undefined && { payload } })
    },
    purge(queue, before) {
      const purged = [...jobs.values()].filter(job => job.queue === queue && job.failed && job.runAt < before)

      for (const job of purged)
        jobs.delete(job.id)

      return purged.length
    },
    failed(queue) {
      return [...jobs.values()].filter(job => job.queue === queue && job.failed).map(stored)
    },
    jobs(queue) {
      return [...jobs.values()].filter(job => job.queue === queue).map(stored)
    },
    nextRunAt(queue) {
      const times = waiting(queue).map(job => Math.max(job.runAt, job.heldUntil ?? 0))

      return times.length === 0 ? undefined : Math.min(...times)
    },
    lock(name, slot) {
      const key = `${name}\n${slot}`

      if (locks.has(key))
        return false

      locks.add(key)

      return true
    },
  }
}

// What a queue or a locked schedule names no store of its own uses, opened on first use.
export function defaultJobStore(): JobStore {
  return appStore()?.jobs ?? (defaultStore ??= process.env.NODE_ENV === 'test' ? memoryJobs() : sqliteJobs(DEFAULT_PATH))
}

// A queue of jobs the server runs in the background, each surviving a restart: `enqueue` from an action, `app.use(queue)` in the server to run them.
// A run that throws is retried later, waiting `backoff` then twice as long each time, until `attempts` runs failed: it is then kept as failed, logged and handed to `onFailed`.
export function queue<Payload, Progress = unknown>(name: string, handler: (payload: Payload, signal: AbortSignal, job: JobContext<Progress>) => unknown, options: QueueOptions<Payload> = {}): Queue<Payload, Progress> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const backoff = durationSeconds(options.backoff ?? DEFAULT_BACKOFF, `queue('${name}')'s backoff`) * 1000
  const lostAfter = durationSeconds(options.lostAfter ?? DEFAULT_LOST_AFTER, `queue('${name}')'s lostAfter`) * 1000
  const concurrency = options.concurrency ?? 1
  const idlePoll = durationSeconds(options.idlePoll ?? IDLE_POLL_S, `queue('${name}')'s idlePoll`) * 1000
  const keepFailed = options.keepFailed === false ? undefined : durationSeconds(options.keepFailed ?? DEFAULT_KEEP_FAILED, `queue('${name}')'s keepFailed`) * 1000

  if (!Number.isInteger(attempts) || attempts < 1)
    throw new KayError('config-invalid', `kay: queue('${name}')'s attempts is ${attempts}; it takes a whole number of at least 1`)

  if (idlePoll < POLL_MS)
    throw new KayError('config-invalid', `kay: queue('${name}')'s idlePoll is ${options.idlePoll}; it takes a duration of at least 1 second, the poll it backs off from`)

  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new KayError('config-invalid', `kay: queue('${name}')'s concurrency is ${concurrency}; it takes a whole number of at least 1`)

  const store = () => options.store ?? defaultJobStore()
  let controller: AbortController | undefined
  let workers: Promise<void>[] = []
  // The worker looking for jobs while the queue is idle sleeps until its next look, woken when this process enqueues a job or retries one.
  const pollers = new Set<() => void>()
  // The others sleep until a claim leaves no worker looking, which wakes one of them to take over.
  const idlers = new Set<() => void>()
  // The workers waiting out a store that fails, which nothing wakes but a stop.
  const outage = new Set<() => void>()
  // Whether a worker is the one looking for jobs while the queue is idle: the others sleep until something wakes them.
  let polling = false
  // The wait of the next empty look: the poll, doubling up to `idlePoll` while no job is found, shared by the workers as one looks at a time.
  let idleWait = POLL_MS
  // Counts the wakes of the poller, so one finding that came while it awaited the store looks again.
  let wakes = 0
  const wakePoller = () => {
    wakes++

    for (const sleeper of pollers)
      sleeper()

    // A poller whose store failed waits in the outage set; an enqueue gives it a reason to ask again now.
    for (const sleeper of outage)
      sleeper()
  }
  const wakeIdler = () => {
    const [sleeper] = idlers

    sleeper?.()
  }

  const reportFailed = async (job: StoredJob, error: unknown) => {
    try {
      await options.onFailed?.(parse(job.payload) as Payload, error)
    }
    catch (failure) {
      kayLog('error', `onFailed of queue('${name}') failed`, failure)
    }
  }

  // The payload a failed job keeps, undefined to keep it whole.
  const redacted = (job: StoredJob): string | undefined => {
    if (!options.redact)
      return undefined

    try {
      return stringify(options.redact(parse(job.payload) as Payload))
    }
    catch (error) {
      kayLog('error', `redact of queue('${name}') failed, so its failed job keeps its payload`, error)

      return undefined
    }
  }

  let progressWarned = false

  // A run's reports to the store: one write in flight at a time, the latest report waiting behind it, so a handler reporting every item costs the store a few writes.
  // A write that fails is logged; one that lands after the hold went to another claim, or after the job completed or failed, matches no job.
  const progressWriter = (id: string, held: number) => {
    let latest: string | undefined
    let writing: Promise<void> | undefined
    let open = true

    const flush = async () => {
      while (latest !== undefined) {
        const text = latest

        latest = undefined

        try {
          await store().progress!(id, held, text)
        }
        catch (error) {
          kayLog('warn', `queue('${name}') could not write a job's progress`, error)
        }
      }

      writing = undefined
    }

    return {
      write: (value: Progress) => {
        if (!open)
          return

        if (!store().progress) {
          if (!progressWarned)
            kayLog('warn', `queue('${name}')'s store has no progress(), so what its jobs report is not kept: add progress() to the JobStore, or use sqliteJobs, memoryJobs or pgJobs`)

          progressWarned = true

          return
        }

        latest = stringify(value)
        writing ??= flush()
      },
      // Lets the write in flight land before the job is marked, so a failed job keeps the last thing it reported.
      settle: async () => {
        open = false
        await writing
      },
    }
  }

  // A run that outlasts `lostAfter` fails and its signal aborts, so its worker takes the next job and a handler listening to the signal stops rather than run beside the retry.
  // It ends a moment before the hold does, so no other process takes the job while this one still marks how it went.
  const withinLostAfter = async (run: unknown, held: number, ended: AbortController): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      await Promise.race([run, new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`it ran past lostAfter, ${Math.round(lostAfter / 1000)} s`)

          ended.abort(error)
          reject(error)
        }, Math.min(Math.max(held - Date.now() - Math.min(1000, lostAfter / 10), 0), MAX_TIMER_MS))
      })])
    }
    finally {
      clearTimeout(timer)
    }
  }

  // Runs one job it claimed, then marks how it went; false when none was due.
  const runNext = async (): Promise<boolean> => {
    const now = Date.now()
    const held = now + lostAfter
    const job = await store().claim(name, now, held)

    if (!job)
      return false

    // Unless another worker looks, one asleep wakes to look for the next job while this one runs.
    idleWait = POLL_MS

    if (!polling)
      wakeIdler()

    // Only runs whose process died never mark how they went: a job that kills its process stops here rather than crash every next one.
    if (job.attempts > attempts) {
      const message = `it was taken ${job.attempts - 1} times, as many as its ${attempts} attempts, its last run never finishing`

      await store().fail(job.id, message, redacted(job))
      kayLog('error', `a job of queue('${name}') is kept as failed without running: ${message}`)
      await reportFailed(job, new Error(message))

      return true
    }

    const ended = new AbortController()
    const stop = () => ended.abort(STOPPED)
    const stopping = controller?.signal

    stopping?.addEventListener('abort', stop)

    // A stop that came while the claim was pending never fires the listener: the job goes back untouched.
    if (stopping?.aborted && store().release) {
      stopping.removeEventListener('abort', stop)
      await store().release!(job.id, held)

      return true
    }

    const reports = progressWriter(job.id, held)

    try {
      await withinLostAfter(handler(parse(job.payload) as Payload, ended.signal, { id: job.id, attempts: job.attempts, progress: reports.write }), held, ended)
      await reports.settle()
      await store().complete(job.id)
    }
    catch (error) {
      await reports.settle()

      // A run that asks for another go hands the job back for later, its attempt not counted.
      if (error instanceof RetryLater && store().release) {
        await store().release!(job.id, held, Date.now() + error.waitMs)
        // The worker looking for jobs may sleep past the time this one is due.
        wakePoller()
        kayLog('info', `a job of queue('${name}') asked to run again in ${Math.round(error.waitMs / 1000)} s, without spending an attempt: ${error.message}`)

        return true
      }

      // A server stopping aborts the run: a job that gave up for it is handed back, not counted as a failed attempt.
      if (ended.signal.reason === STOPPED && store().release) {
        await store().release!(job.id, held)

        return true
      }

      const message = error instanceof Error ? error.message : String(error)

      if (error instanceof RetryLater)
        kayLog('warn', `a job of queue('${name}') asked to run again later, but its store has no release(), so the run counts as failed`)

      if (job.attempts < attempts) {
        const wait = backoff * 2 ** (job.attempts - 1)

        await store().retry(job.id, Date.now() + wait, message)
        // The worker looking for jobs may sleep past the time this one is due.
        wakePoller()
        kayLog('warn', `a job of queue('${name}') failed, attempt ${job.attempts} of ${attempts}, and runs again in ${Math.round(wait / 1000)} s: ${message}`)

        return true
      }

      await store().fail(job.id, message, redacted(job))
      await reportBackgroundError(`a job of queue('${name}') failed ${job.attempts} times and is kept as failed`, error)
      await reportFailed(job, error)
    }
    finally {
      stopping?.removeEventListener('abort', stop)
    }

    return true
  }

  let purged = 0

  // Drops the failed jobs whose last attempt is older than `keepFailed`, once an hour at most, whichever worker, drain, enqueue or read of the failed jobs gets there first, so a process with no worker of the queue purges it too.
  const purgeFailed = async () => {
    const now = Date.now()

    if (keepFailed === undefined || now - purged < PURGE_MS)
      return

    purged = now

    const current = store()

    if (current.purge) {
      await current.purge(name, now - keepFailed)

      return
    }

    for (const job of await current.failed(name)) {
      if (job.runAt < now - keepFailed)
        await current.complete(job.id)
    }
  }

  // The purge outside a worker: a store that fails here is the caller's own business to learn of when it reads or writes, so it is logged and not thrown.
  const tidy = async () => {
    try {
      await purgeFailed()
    }
    catch (error) {
      kayLog('warn', `queue('${name}') could not drop its expired failed jobs`, error)
    }
  }

  // Whether the store failed at the last look, so an outage is logged once as it starts and once as it ends, whatever the concurrency.
  let storeDown = false

  const work = async (signal: AbortSignal) => {
    let outageWait = 0

    while (!signal.aborted) {
      try {
        await purgeFailed()

        const ran = await runNext()

        if (storeDown) {
          storeDown = false
          kayLog('info', `queue('${name}') reads its store again`)
        }

        outageWait = 0

        if (ran)
          continue

        // One worker looks at the store; the others sleep until a claim leaves no worker looking and wakes one of them.
        if (polling) {
          await sleep(MAX_TIMER_MS, signal, idlers)

          continue
        }

        polling = true

        const seen = wakes

        try {
          const next = await store().nextRunAt(name)

          // Something was enqueued or retried meanwhile, before the sleep could be woken.
          if (wakes !== seen)
            continue

          const wait = next === undefined ? idleWait : Math.min(idleWait, Math.max(0, next - Date.now()))

          idleWait = Math.min(idleWait * 2, idlePoll)
          await sleep(wait, signal, pollers)
        }
        finally {
          polling = false
        }
      }
      // A store that failed, locked past its timeout say, is asked again later and later, up to a minute apart.
      catch (error) {
        if (!storeDown) {
          storeDown = true
          kayLog('error', `queue('${name}') could not read its store; its workers ask it again less and less often until it answers`, error)
        }

        outageWait = Math.min(outageWait === 0 ? POLL_MS : outageWait * 2, MAX_OUTAGE_MS)
        await sleep(outageWait, signal, outage)
      }
    }
  }

  // Unnamed, so Elysia never takes two queues for one plugin.
  const plugin = new Elysia()
    .onStart(() => {
      if (controller)
        return

      const started = new AbortController()

      controller = started
      workers = Array.from({ length: concurrency }, async () => work(started.signal))
    })
    .onStop(async () => {
      controller?.abort()
      await Promise.all(workers)
      controller = undefined
      workers = []
    })

  const queued = Object.assign(plugin, {
    enqueue: async (payload: Payload, enqueueOptions: EnqueueOptions = {}) => {
      const id = crypto.randomUUID()
      const delay = enqueueOptions.delay === undefined ? 0 : durationSeconds(enqueueOptions.delay, `queue('${name}')'s delay`) * 1000
      const { key } = enqueueOptions

      if (key !== undefined && key === '')
        throw new KayError('config-invalid', `kay: queue('${name}') was enqueued with an empty key; a key is a non-empty string`)

      if (key !== undefined && !store().state)
        throw new KayError('config-invalid', `kay: queue('${name}')'s store has no state(), so enqueue's key cannot be kept: add state() to the JobStore, or use sqliteJobs, memoryJobs or pgJobs`)

      const held = await store().add({ id, queue: name, payload: stringify(payload), attempts: 0, runAt: Date.now() + delay, ...key !== undefined && { key } })

      // Another job holds the key: nothing was stored, so nobody needs waking.
      if (typeof held === 'string')
        return held

      // A delayed job too: the worker looking for jobs sleeps until the next one is due, which this may precede.
      wakePoller()
      await tidy()

      return id
    },
    job: async (job: string | { id: string }) => {
      const read = store().state

      if (!read)
        throw new KayError('config-invalid', `kay: queue('${name}')'s store has no state(), so a job's state cannot be read: add state() to the JobStore, or use sqliteJobs, memoryJobs or pgJobs`)

      const found = await read(name, typeof job === 'string' ? { key: job } : job, Date.now())

      return found && {
        id: found.id,
        status: found.status,
        attempts: found.attempts,
        ...found.progress !== undefined && { progress: parse(found.progress) as Progress },
        ...found.error !== undefined && { error: found.error },
      }
    },
    drain: async () => {
      let ran = 0

      await purgeFailed()

      while (await runNext())
        ran++

      return ran
    },
    failed: async () => {
      await tidy()

      return (await store().failed(name)).map(job => ({ id: job.id, payload: parse(job.payload) as Payload, attempts: job.attempts, error: job.error ?? '' }))
    },
    remove: async (match: string | ((payload: Payload) => boolean)) => {
      await tidy()

      const listed = store().jobs?.(name)

      if (typeof match !== 'string' && !listed)
        throw new Error(`kay: queue('${name}')'s store lists no jobs, so remove() takes a job's id rather than a function`)

      // A store listing its jobs tells an id of this queue from one it never held; one that does not counts the id as removed.
      const ids = listed ? (await listed).filter(job => typeof match === 'string' ? job.id === match : match(parse(job.payload) as Payload)).map(job => job.id) : [match as string]

      for (const id of ids)
        await store().complete(id)

      return ids.length
    },
  }) as Queue<Payload, Progress>

  drains.add(queued.drain)

  return queued
}

// Waits `ms`, or less once the signal aborts or something wakes the sleepers.
async function sleep(ms: number, signal: AbortSignal, sleepers: Set<() => void>): Promise<void> {
  if (signal.aborted)
    return

  let timer: ReturnType<typeof setTimeout> | undefined

  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      sleepers.delete(done)
      signal.removeEventListener('abort', done)
      resolve()
    }

    timer = setTimeout(done, ms)
    sleepers.add(done)
    signal.addEventListener('abort', done)
  })
}

// Takes a queue out of what `drainQueues` runs, for a test whose queue's store is gone.
export function forgetQueue(queued: { drain: () => Promise<number> }): void {
  drains.delete(queued.drain)
}

// Runs every due job of every queue in this process, until none is left: `kay/test`'s `runJobs`.
export async function drainQueues(): Promise<number> {
  let ran = 0

  for (let more = true; more;) {
    more = false

    for (const drain of drains) {
      const count = await drain()

      ran += count
      more ||= count > 0
    }
  }

  return ran
}
