import type { CronSchedule, PositiveDuration } from '../runtime/checks'
import type { Duration } from '../runtime/duration'
import type { JobStore } from './queue'
import { Elysia } from 'elysia'
import { KayError } from '../compiler/errors'
import { DURATION_TEXT, durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { defaultJobStore } from './queue'

export interface ScheduleOptions {
  // IANA time zone the schedule reads in, such as `Europe/Paris`; the system's by default.
  tz?: string | undefined
  // Runs each time once across every process sharing the job store, the first to reach it taking it: names the lock, unique per schedule.
  lock?: string | undefined
  // Where the lock is taken: the queues' default store unless given.
  store?: JobStore | undefined
  // Runs each job once as the server starts too, taking the lock like any run, without waiting for the first time it comes.
  boot?: boolean | undefined
}

export type Job = () => unknown
type Jobs = Job | readonly Job[]

// What a table's key must be: a positive length, or a cron that comes some day.
type WhenOf<Key extends string> = Key extends Duration ? PositiveDuration<Key> : CronSchedule<Key>

// What a schedule repeating every so long takes: it runs on the epoch's multiples of its length, the same instants in every time zone.
export type EveryOptions = Omit<ScheduleOptions, 'tz'>

// A lock slot is the minute a run is due, the finest a cron schedule goes: a run falls due at its first second, so the nearest minute names it for a process running it up to 30 s early or late, its clock skewed or its event loop busy.
const SLOT_MS = 60_000

// Runs `job` on a cron schedule, such as `@hourly` or `30 2 * * MON`, or every so long, `'30s'` or `30` seconds, from when the server starts until it stops: once per process, or once across processes with `lock`, never two runs at a time.
// A list of jobs, or a table of schedules to jobs, gives each job a schedule of its own in one plugin, a table's `tz` read by its crons alone; with `lock`, each job's lock is its name and its place among them, `report:0`.
// A run that throws is logged and the next one comes as planned; a stopping server waits for the run in progress.
export function schedule<const Every extends Duration>(every: Every & PositiveDuration<Every>, jobs: Jobs, options?: EveryOptions): Elysia
export function schedule<const Cron extends string>(cron: Cron & CronSchedule<Cron>, jobs: Jobs, options?: ScheduleOptions): Elysia
export function schedule<const Table extends Record<string, Jobs>>(table: Table & { readonly [Key in keyof Table & string]: Jobs & WhenOf<Key> }, options?: ScheduleOptions): Elysia
export function schedule(first: Duration | string | Record<string, Jobs>, second?: Jobs | ScheduleOptions, third?: ScheduleOptions) {
  const table = typeof first === 'object'
  const entries = table ? Object.entries(first) : [[first, second as Jobs] as const]
  const options = (table ? second : third) as ScheduleOptions | undefined ?? {}
  const jobs = entries.flatMap(([when, listed]) => (Array.isArray(listed) ? listed as Job[] : [listed as Job]).map(job => [when, job] as const))
  const plugins = jobs.map(([when, job], index) => {
    const own = jobs.length > 1 && options.lock !== undefined ? { ...options, lock: `${options.lock}:${index}` } : options

    if (typeof when === 'number' || DURATION_TEXT.test(when))
      return scheduleEvery(when as Duration, job, table ? { ...own, tz: undefined } : own)

    return scheduleCron(when, job, own)
  })

  return plugins.length === 1 ? plugins[0]! : plugins.reduce((app, plugin) => app.use(plugin), new Elysia())
}

function scheduleCron(cron: string, job: () => unknown, options: ScheduleOptions) {
  const zone = options.tz === undefined ? {} : { tz: options.tz }

  // A typo fails the boot rather than never running.
  if (Bun.cron.parse(cron, Date.now(), zone) === null)
    throw new KayError('config-invalid', `kay: the schedule ${cron} never comes`)

  let handle: Bun.CronJob | undefined
  let running: Promise<void> | undefined
  let booting: Promise<void> | undefined
  const run = scheduledRun(cron, SLOT_MS, job, options)

  // Unnamed, so Elysia never takes two schedules for one plugin.
  return new Elysia()
    .onStart(() => {
      if (handle)
        return

      handle = Bun.cron(cron, async () => {
        running = run()
        await running
        running = undefined
      }, zone)

      if (options.boot === true)
        booting = run()
    })
    .onStop(async () => {
      handle?.stop()
      handle = undefined
      await Promise.all([running, booting])
      booting = undefined
    })
}

// The next run is planned once the last settles, at the next multiple of `every` since the epoch, so processes started apart run at the same instants and one lock slot names each run.
function scheduleEvery(every: Duration, job: () => unknown, options: ScheduleOptions) {
  const ms = durationSeconds(every, `the schedule ${String(every)}`) * 1000

  if (options.tz !== undefined)
    throw new KayError('config-invalid', `kay: the schedule ${String(every)} takes no tz, it runs every ${String(every)} from the epoch`)

  let timer: Timer | undefined
  let running: Promise<void> | undefined
  let booting: Promise<void> | undefined
  const run = scheduledRun(`every ${String(every)}`, ms, job, options)

  const plan = () => {
    const tick = async () => {
      running = run()
      await running
      running = undefined

      if (timer)
        plan()
    }

    timer = setTimeout(() => void tick(), ms - (Date.now() % ms))
  }

  return new Elysia()
    .onStart(() => {
      if (timer)
        return

      plan()

      if (options.boot === true)
        booting = run()
    })
    .onStop(async () => {
      clearTimeout(timer)
      timer = undefined
      await Promise.all([running, booting])
      booting = undefined
    })
}

// One run of a schedule, taken by one process when it locks: `slotMs` is how far apart its runs fall due.
function scheduledRun(label: string, slotMs: number, job: () => unknown, options: ScheduleOptions) {
  return async () => {
    try {
      if (options.lock !== undefined && !await (options.store ?? defaultJobStore()).lock(options.lock, Math.round(Date.now() / slotMs)))
        return

      await job()
    }
    catch (error) {
      kayLog('error', `the job scheduled ${label} failed`, error)
    }
  }
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
            kayLog('error', 'a background job failed', error)
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
