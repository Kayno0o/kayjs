import type { CronSchedule, PositiveDuration } from '../runtime/checks'
import type { Duration } from '../runtime/duration'
import type { JobStore } from './queue'
import process from 'node:process'
import { Elysia } from 'elysia'
import { KayError } from '../compiler/errors'
import { DURATION_TEXT, durationSeconds } from '../runtime/duration'
import { MAX_TIMER_MS } from './config-limits'
import { defaultJobStore } from './queue'
import { reportBackgroundError } from './report'

export interface ScheduleOptions {
  // IANA time zone the schedule reads in, such as `Europe/Paris`; the system's by default.
  tz?: string | undefined
  // Runs each time once across every process sharing the job store, the first to reach it taking it: names the lock, unique per schedule.
  // A production server (`NODE_ENV=production`) locks every schedule by default, under a name made of its schedule and its job's source; `false` runs it in every process.
  lock?: string | false | undefined
  // Where the lock is taken: the queues' default store unless given.
  store?: JobStore | undefined
  // Runs each job once as the server starts too, taking the lock like any run, without waiting for the first time it comes.
  boot?: boolean | undefined
  // How long a run may take: past it, the run is logged as failed, its signal aborts and the schedule goes on without it. 10 minutes by default, `false` for no limit.
  timeout?: Duration | false | undefined
}

type Job = (signal: AbortSignal) => unknown
type Jobs = Job | readonly Job[]

// What a table's key must be: a positive length, or a cron that comes some day.
type WhenOf<Key extends string> = Key extends Duration ? PositiveDuration<Key> : CronSchedule<Key>

// What a schedule repeating every so long takes: it runs on the epoch's multiples of its length, the same instants in every time zone.
export type EveryOptions = Omit<ScheduleOptions, 'tz'>

// A lock slot is the minute a run is due, the finest a cron schedule goes: a run falls due at its first second, so the nearest minute names it for a process running it up to 30 s early or late, its clock skewed or its event loop busy.
const SLOT_MS = 60_000
const DEFAULT_TIMEOUT = 600
// How long a stop waits for a run that ignores its signal before leaving it.
const STOP_GRACE_MS = 5000
// Why a run's signal aborted when the server stopped, as against its timeout running out.
const STOPPED = new Error('the server is stopping')
// The lock names the schedules of this process hold, so two schedules alike in every way still take a lock each.
const autoLocks = new Set<string>()

// A lock name for a schedule given none: its schedule and the hash of its job's source, and for a twin its place in the order twins start, which every process of one app shares.
function autoLock(when: string | number, job: Job) {
  let held: string | undefined

  return {
    take() {
      const base = `auto:${String(when)}:${Bun.hash(job.toString()).toString(36)}`

      for (let twin = 1; ; twin++) {
        held = twin === 1 ? base : `${base}#${twin}`

        if (!autoLocks.has(held)) {
          autoLocks.add(held)

          return held
        }
      }
    },
    release() {
      if (held !== undefined)
        autoLocks.delete(held)

      held = undefined
    },
    name: () => held,
  }
}

type AutoLock = ReturnType<typeof autoLock>

// Runs `job` on a cron schedule, such as `@hourly` or `30 2 * * MON`, or every so long, `'30s'` or `30` seconds, from when the server starts until it stops: once per process, or once across processes with `lock`, never two runs at a time.
// A list of jobs, or a table of schedules to jobs, gives each job a schedule of its own in one plugin, a table's `tz` read by its crons alone; with `lock`, each job's lock is its schedule and its place in that schedule's list, `report:@hourly:0`.
// A run that throws is logged and the next one comes as planned; a stopping server waits for the run in progress.
export function schedule<const Every extends Duration>(every: Every & PositiveDuration<Every>, jobs: Jobs, options?: EveryOptions): Elysia
export function schedule<const Cron extends string>(cron: Cron & CronSchedule<Cron>, jobs: Jobs, options?: ScheduleOptions): Elysia
export function schedule<const Table extends Record<string, Jobs>>(table: Table & { readonly [Key in keyof Table & string]: Jobs & WhenOf<Key> }, options?: ScheduleOptions): Elysia
export function schedule(first: Duration | string | Record<string, Jobs>, second?: Jobs | ScheduleOptions, third?: ScheduleOptions) {
  const table = typeof first === 'object'
  const entries = table ? Object.entries(first) : [[first, second as Jobs] as const]
  const options = (table ? second : third) as ScheduleOptions | undefined ?? {}
  const jobs = entries.flatMap(([when, listed]) => (Array.isArray(listed) ? listed as Job[] : [listed as Job]).map((job, place) => [when, job, place] as const))
  const plugins = jobs.map(([when, job, place]) => {
    if (typeof job !== 'function')
      throw new KayError('config-invalid', `kay: the job scheduled ${String(when)} is no function`)

    const own = jobs.length > 1 && typeof options.lock === 'string' ? { ...options, lock: `${options.lock}:${String(when)}:${place}` } : options
    const auto = options.lock === undefined && process.env.NODE_ENV === 'production' ? autoLock(when, job) : undefined

    if (typeof when === 'number' || DURATION_TEXT.test(when))
      return scheduleEvery(when as Duration, job, table ? { ...own, tz: undefined } : own, auto)

    return scheduleCron(when, job, own, auto)
  })

  return plugins.length === 1 ? plugins[0]! : plugins.reduce((app, plugin) => app.use(plugin), new Elysia())
}

function scheduleCron(cron: string, job: Job, options: ScheduleOptions, auto: AutoLock | undefined) {
  const zone = options.tz === undefined ? {} : { tz: options.tz }

  // A typo fails the boot rather than never running.
  if (Bun.cron.parse(cron, Date.now(), zone) === null)
    throw new KayError('config-invalid', `kay: the schedule ${cron} never comes`)

  let handle: Bun.CronJob | undefined
  let running: Promise<void> | undefined
  const run = scheduledRun(cron, SLOT_MS, job, options, auto)

  // Unnamed, so Elysia never takes two schedules for one plugin.
  return new Elysia()
    .onStart(() => {
      if (handle)
        return

      auto?.take()

      // The boot run is the first, which the first scheduled run waits for: runs never overlap.
      if (options.boot === true)
        running = run(true)

      handle = Bun.cron(cron, async () => {
        running = after(running, run)
        await running
      }, zone)
    })
    .onStop(async () => {
      handle?.stop()
      handle = undefined
      run.abort()
      await running
      auto?.release()
    })
}

// The next run is planned once the last settles, at the next multiple of `every` since the epoch, so processes started apart run at the same instants and one lock slot names each run.
function scheduleEvery(every: Duration, job: Job, options: ScheduleOptions, auto: AutoLock | undefined) {
  const ms = durationSeconds(every, `the schedule ${String(every)}`) * 1000

  if (options.tz !== undefined)
    throw new KayError('config-invalid', `kay: the schedule ${String(every)} takes no tz, it runs every ${String(every)} from the epoch`)

  let timer: Timer | undefined
  let running: Promise<void> | undefined
  const run = scheduledRun(`every ${String(every)}`, ms, job, options, auto)

  const plan = () => {
    const tick = async () => {
      running = after(running, run)
      await running

      if (timer)
        plan()
    }

    timer = setTimeout(() => void tick(), ms - (Date.now() % ms))
  }

  return new Elysia()
    .onStart(() => {
      if (timer)
        return

      auto?.take()
      plan()

      if (options.boot === true)
        running = run(true)
    })
    .onStop(async () => {
      clearTimeout(timer)
      timer = undefined
      run.abort()
      await running
      auto?.release()
    })
}

// A run starting once the one before settles, which never rejects.
async function after(previous: Promise<void> | undefined, run: () => Promise<void>): Promise<void> {
  await previous
  await run()
}

// One run of a schedule, taken by one process when it locks: `slotMs` is how far apart its runs fall due.
// A boot run locks under a name of its own, so its slot, rounded to the nearest, never takes the one of the run due next.
// A run still going after `timeout` is reported as failed and left, its signal aborted, so one that never settles blocks the next run no longer; `abort()` aborts the runs in progress as a stop does, which then waits for them a few seconds at most.
function scheduledRun(label: string, slotMs: number, job: Job, options: ScheduleOptions, auto: AutoLock | undefined) {
  const timeout = options.timeout === false ? undefined : durationSeconds(options.timeout ?? DEFAULT_TIMEOUT, `the timeout of the schedule ${label}`) * 1000
  const active = new Set<AbortController>()

  const run = async (boot = false) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined

    active.add(controller)

    try {
      const lock = options.lock === false ? undefined : options.lock ?? auto?.name()

      if (lock !== undefined && !await (options.store ?? defaultJobStore()).lock(boot ? `${lock}:boot` : lock, Math.round(Date.now() / slotMs)))
        return

      const limit = new Promise<never>((_, reject) => {
        if (timeout !== undefined) {
          timer = setTimeout(() => {
            const error = new Error(`it ran past its timeout, ${Math.round(timeout / 1000)} s`)

            controller.abort(error)
            reject(error)
          }, Math.min(timeout, MAX_TIMER_MS))
        }

        // A stop waits for the run to wind down, but not past the grace, so a job ignoring its signal never holds a shutdown.
        controller.signal.addEventListener('abort', () => {
          if (controller.signal.reason === STOPPED)
            grace = setTimeout(reject, Math.min(STOP_GRACE_MS, timeout ?? STOP_GRACE_MS), STOPPED)
        })
      })

      await Promise.race([job(controller.signal), limit])
    }
    catch (error) {
      // A run the stop cut short is no failure to report.
      if (controller.signal.reason !== STOPPED)
        await reportBackgroundError(`the job scheduled ${label} failed`, error)
    }
    finally {
      clearTimeout(timer)
      clearTimeout(grace)
      active.delete(controller)
    }
  }

  return Object.assign(run, {
    abort() {
      for (const controller of active)
        controller.abort(STOPPED)
    },
  })
}

// Starts `work` with the server, for a queue consumer or anything else that runs the whole time; on stop, its signal aborts and the server waits for it to return.
// Work that throws is logged; it is not started again.
export function background(work: (signal: AbortSignal) => unknown) {
  let controller: AbortController | undefined
  let running: Promise<void> | undefined

  return new Elysia()
    .onStart(() => {
      if (controller)
        return

      const started = new AbortController()

      controller = started
      running = (async () => {
        try {
          await work(started.signal)
        }
        catch (error) {
          if (!started.signal.aborted) {
            await reportBackgroundError('a background job failed', error)
          }
        }
      })()
    })
    .onStop(async () => {
      controller?.abort()
      await running
      controller = undefined
    })
}
