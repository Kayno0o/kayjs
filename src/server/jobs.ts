import type { CronSchedule, PositiveDuration } from '../runtime/checks'
import type { Duration } from '../runtime/duration'
import type { JobStore } from './queue'
import { Elysia } from 'elysia'
import { logError } from '../build/sourcemap'
import { DURATION_TEXT, durationSeconds } from '../runtime/duration'
import { defaultJobStore } from './queue'

export interface ScheduleOptions {
  // IANA time zone the schedule reads in, such as `Europe/Paris`; the system's by default.
  tz?: string | undefined
  // Runs each time once across every process sharing the job store, the first to reach it taking it: names the lock, unique per schedule.
  lock?: string | undefined
  // Where the lock is taken: the queues' default store unless given.
  store?: JobStore | undefined
}

// What a schedule repeating every so long takes: it runs on the epoch's multiples of its length, the same instants in every time zone.
export type EveryOptions = Omit<ScheduleOptions, 'tz'>

// A lock slot is the minute a run is due, the finest a cron schedule goes: a run falls due at its first second, so the nearest minute names it for a process running it up to 30 s early or late, its clock skewed or its event loop busy.
const SLOT_MS = 60_000

// Runs `job` on a cron schedule, such as `@hourly` or `30 2 * * MON`, or every so long, `'30s'` or `30` seconds, from when the server starts until it stops: once per process, or once across processes with `lock`, never two runs at a time.
// A run that throws is logged and the next one comes as planned; a stopping server waits for the run in progress.
export function schedule<const Every extends Duration>(every: Every & PositiveDuration<Every>, job: () => unknown, options?: EveryOptions): Elysia
export function schedule<const Cron extends string>(cron: Cron & CronSchedule<Cron>, job: () => unknown, options?: ScheduleOptions): Elysia
export function schedule(when: Duration | string, job: () => unknown, options: ScheduleOptions = {}) {
  return typeof when === 'number' || DURATION_TEXT.test(when) ? scheduleEvery(when as Duration, job, options) : scheduleCron(when, job, options)
}

function scheduleCron(cron: string, job: () => unknown, options: ScheduleOptions) {
  const zone = options.tz === undefined ? {} : { tz: options.tz }

  // A typo fails the boot rather than never running.
  if (Bun.cron.parse(cron, Date.now(), zone) === null)
    throw new Error(`kay: the schedule ${cron} never comes`)

  let handle: Bun.CronJob | undefined
  let running: Promise<void> | undefined
  const run = scheduledRun(cron, SLOT_MS, job, options)

  // Unnamed, so Elysia never takes two schedules for one plugin.
  return new Elysia()
    .onStart(() => {
      handle ??= Bun.cron(cron, async () => {
        running = run()
        await running
        running = undefined
      }, zone)
    })
    .onStop(async () => {
      handle?.stop()
      handle = undefined
      await running
    })
}

// The next run is planned once the last settles, at the next multiple of `every` since the epoch, so processes started apart run at the same instants and one lock slot names each run.
function scheduleEvery(every: Duration, job: () => unknown, options: ScheduleOptions) {
  const ms = durationSeconds(every, `the schedule ${String(every)}`) * 1000

  if (options.tz !== undefined)
    throw new Error(`kay: the schedule ${String(every)} takes no tz, it runs every ${String(every)} from the epoch`)

  let timer: Timer | undefined
  let running: Promise<void> | undefined
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
      if (!timer)
        plan()
    })
    .onStop(async () => {
      clearTimeout(timer)
      timer = undefined
      await running
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
      console.error(`kay: the job scheduled ${label} failed`)
      logError(error)
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
            console.error('kay: a background job failed')
            logError(error)
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
