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
import { onReload } from './reload'

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
}

type Maybe<T> = T | Promise<T>

// Where queued jobs wait, shared by every process opening it: `sqliteJobs` by default, or one of an app's own, Redis or Postgres say.
export interface JobStore {
  add: (job: StoredJob) => Maybe<void>
  // Takes the queue's next job whose time has come and that no process holds, holding it until `until`, past which a process that died running it is taken as gone; one process at a time gets a job.
  claim: (queue: string, now: number, until: number) => Maybe<StoredJob | undefined>
  complete: (id: string) => Maybe<void>
  // Runs it again at `runAt`.
  retry: (id: string, runAt: number, error: string) => Maybe<void>
  // Keeps it as failed, out of the queue.
  fail: (id: string, error: string) => Maybe<void>
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
  // Gets a job that failed its last attempt, once it is kept as failed.
  onFailed?: ((payload: Payload, error: unknown) => unknown) | undefined
}

export interface EnqueueOptions {
  // Runs it this long from now rather than as soon as a worker can.
  delay?: Duration | undefined
}

export interface FailedJob<Payload> {
  id: string
  payload: Payload
  attempts: number
  error: string
}

export type Queue<Payload> = Elysia & {
  // Keeps the job for a worker to run, surviving a restart; resolves with its id once stored.
  enqueue: (payload: Payload, options?: EnqueueOptions) => Promise<string>
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
// The longest a timer waits: past it, setTimeout fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1
// The longest a worker waits between looks at a store that keeps failing.
const MAX_OUTAGE_MS = 60_000
const DEFAULT_PATH = 'data/jobs.sqlite'

// What drains each queue made, for `kay/test` to run them all.
const drains = new Set<() => Promise<number>>()
let defaultStore: JobStore | undefined

// Jobs kept in a SQLite file: they survive restarts and deploys, and every process of the machine opening it shares them, each job running in one of them.
// The file is created by the first job enqueued or schedule locked, so a server whose queue never gets one, an app only sending its mails say, writes nothing.
export function sqliteJobs(path: string): JobStore {
  let statements: ReturnType<typeof prepareJobs> | undefined
  let db: Database | undefined
  // A read before the file exists finds no job rather than creating it, then opens it once another process did.
  const open = (create: boolean) => statements ??= create || existsSync(path) ? prepareJobs(db = openSqlite(path)) : undefined

  // The default store is kept for good, so a reload only lets go of the file, which the next job opens again.
  onReload(() => {
    db?.close()
    db = undefined
    statements = undefined
  })

  return {
    add(job) {
      open(true)!.insert.run(job.id, job.queue, job.payload, job.attempts, job.runAt)
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
    fail(id, error) {
      open(true)!.fail.run(error, id)
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

interface JobRow { id: string, queue: string, payload: string, attempts: number, run_at: number, error: string | null }

function toJob(row: JobRow): StoredJob {
  return { id: row.id, queue: row.queue, payload: row.payload, attempts: row.attempts, runAt: row.run_at, ...row.error !== null && { error: row.error } }
}

function prepareJobs(db: Database) {
  db.run('CREATE TABLE IF NOT EXISTS kay_jobs (id TEXT PRIMARY KEY, queue TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL, run_at INTEGER NOT NULL, held_until INTEGER, failed INTEGER NOT NULL DEFAULT 0, error TEXT)')
  db.run('CREATE INDEX IF NOT EXISTS kay_jobs_due ON kay_jobs (queue, failed, run_at)')
  db.run('CREATE TABLE IF NOT EXISTS kay_locks (name TEXT NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY (name, slot))')

  const insert = db.query('INSERT INTO kay_jobs (id, queue, payload, attempts, run_at) VALUES (?, ?, ?, ?, ?)')
  const claim = db.query<JobRow, [number, string, number, number]>('UPDATE kay_jobs SET held_until = ?, attempts = attempts + 1 WHERE id = (SELECT id FROM kay_jobs WHERE queue = ? AND failed = 0 AND run_at <= ? AND (held_until IS NULL OR held_until <= ?) ORDER BY run_at LIMIT 1) RETURNING id, queue, payload, attempts, run_at, error')
  const remove = db.query('DELETE FROM kay_jobs WHERE id = ?')
  const retry = db.query('UPDATE kay_jobs SET run_at = ?, held_until = NULL, error = ? WHERE id = ?')
  const fail = db.query('UPDATE kay_jobs SET failed = 1, held_until = NULL, error = ? WHERE id = ?')
  const purge = db.query('DELETE FROM kay_jobs WHERE queue = ? AND failed = 1 AND run_at < ?')
  const failed = db.query<JobRow, [string]>('SELECT id, queue, payload, attempts, run_at, error FROM kay_jobs WHERE queue = ? AND failed = 1 ORDER BY run_at')
  const all = db.query<JobRow, [string]>('SELECT id, queue, payload, attempts, run_at, error FROM kay_jobs WHERE queue = ? ORDER BY run_at')
  // A held job counts from when its hold ends, as it runs again then if its process died.
  const next = db.query<{ at: number | null }, [string]>('SELECT min(max(run_at, coalesce(held_until, 0))) AS at FROM kay_jobs WHERE queue = ? AND failed = 0')
  const lock = db.query('INSERT OR IGNORE INTO kay_locks (name, slot) VALUES (?, ?)')
  const pruneLocks = db.query('DELETE FROM kay_locks WHERE name = ? AND slot < ?')

  return { insert, claim, remove, retry, fail, purge, failed, all, next, lock, pruneLocks }
}

// Jobs kept in this process's memory, gone with it: what tests run on.
export function memoryJobs(): JobStore {
  const jobs = new Map<string, StoredJob & { heldUntil?: number, failed?: boolean }>()
  const locks = new Set<string>()
  const waiting = (queue: string) => [...jobs.values()].filter(job => job.queue === queue && !job.failed)

  return {
    add(job) {
      jobs.set(job.id, { ...job })
    },
    claim(queue, now, until) {
      const job = waiting(queue).filter(job => job.runAt <= now && (job.heldUntil ?? 0) <= now).sort((a, b) => a.runAt - b.runAt)[0]

      if (!job)
        return undefined

      job.heldUntil = until
      job.attempts++

      return { id: job.id, queue, payload: job.payload, attempts: job.attempts, runAt: job.runAt, ...job.error !== undefined && { error: job.error } }
    },
    complete(id) {
      jobs.delete(id)
    },
    retry(id, runAt, error) {
      Object.assign(jobs.get(id) ?? {}, { runAt, error, heldUntil: undefined })
    },
    fail(id, error) {
      Object.assign(jobs.get(id) ?? {}, { failed: true, error, heldUntil: undefined })
    },
    purge(queue, before) {
      const purged = [...jobs.values()].filter(job => job.queue === queue && job.failed && job.runAt < before)

      for (const job of purged)
        jobs.delete(job.id)

      return purged.length
    },
    failed(queue) {
      return [...jobs.values()].filter(job => job.queue === queue && job.failed).map(({ heldUntil: _, failed: __, ...job }) => job)
    },
    jobs(queue) {
      return [...jobs.values()].filter(job => job.queue === queue).map(({ heldUntil: _, failed: __, ...job }) => job)
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
  return defaultStore ??= process.env.NODE_ENV === 'test' ? memoryJobs() : sqliteJobs(DEFAULT_PATH)
}

// A queue of jobs the server runs in the background, each surviving a restart: `enqueue` from an action, `app.use(queue)` in the server to run them.
// A run that throws is retried later, waiting `backoff` then twice as long each time, until `attempts` runs failed: it is then kept as failed, logged and handed to `onFailed`.
export function queue<Payload>(name: string, handler: (payload: Payload) => unknown, options: QueueOptions<Payload> = {}): Queue<Payload> {
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

  // A run that outlasts `lostAfter` fails, so its worker takes the next job; the handler itself goes on, as nothing can stop it.
  // It ends a moment before the hold does, so no other process takes the job while this one still marks how it went.
  const withinLostAfter = async (run: unknown, held: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      await Promise.race([run, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it ran past lostAfter, ${Math.round(lostAfter / 1000)} s`)), Math.min(Math.max(held - Date.now() - Math.min(1000, lostAfter / 10), 0), MAX_TIMER_MS))
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

      await store().fail(job.id, message)
      kayLog('error', `a job of queue('${name}') is kept as failed without running: ${message}`)
      await reportFailed(job, new Error(message))

      return true
    }

    try {
      await withinLostAfter(handler(parse(job.payload) as Payload), held)
      await store().complete(job.id)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (job.attempts < attempts) {
        const wait = backoff * 2 ** (job.attempts - 1)

        await store().retry(job.id, Date.now() + wait, message)
        // The worker looking for jobs may sleep past the time this one is due.
        wakePoller()
        kayLog('warn', `a job of queue('${name}') failed, attempt ${job.attempts} of ${attempts}, and runs again in ${Math.round(wait / 1000)} s: ${message}`)

        return true
      }

      await store().fail(job.id, message)
      kayLog('error', `a job of queue('${name}') failed ${job.attempts} times and is kept as failed`, error)
      await reportFailed(job, error)
    }

    return true
  }

  let purged = 0

  // Drops the failed jobs whose last attempt is older than `keepFailed`, once an hour at most, whichever worker or drain gets there first.
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

      await store().add({ id, queue: name, payload: stringify(payload), attempts: 0, runAt: Date.now() + delay })

      // A delayed job too: the worker looking for jobs sleeps until the next one is due, which this may precede.
      wakePoller()

      return id
    },
    drain: async () => {
      let ran = 0

      await purgeFailed()

      while (await runNext())
        ran++

      return ran
    },
    failed: async () => (await store().failed(name)).map(job => ({ id: job.id, payload: parse(job.payload) as Payload, attempts: job.attempts, error: job.error ?? '' })),
    remove: async (match: string | ((payload: Payload) => boolean)) => {
      const listed = store().jobs?.(name)

      if (typeof match !== 'string' && !listed)
        throw new Error(`kay: queue('${name}')'s store lists no jobs, so remove() takes a job's id rather than a function`)

      // A store listing its jobs tells an id of this queue from one it never held; one that does not counts the id as removed.
      const ids = listed ? (await listed).filter(job => typeof match === 'string' ? job.id === match : match(parse(job.payload) as Payload)).map(job => job.id) : [match as string]

      for (const id of ids)
        await store().complete(id)

      return ids.length
    },
  }) as Queue<Payload>

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
