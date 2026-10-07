import type { CronSchedule } from '../runtime/checks'
import type { JobStore } from './queue'
import { Elysia } from 'elysia'
import { logError } from '../build/sourcemap'
import { defaultJobStore } from './queue'

export interface ScheduleOptions {
  // IANA time zone the schedule reads in, such as `Europe/Paris`; the system's by default.
  tz?: string
  // Runs each time once across every process sharing the job store, the first to reach it taking it: names the lock, unique per schedule.
  lock?: string
  // Where the lock is taken: the queues' default store unless given.
  store?: JobStore
}

// A lock slot is the minute a run is due, the finest a cron schedule goes.
const SLOT_MS = 60_000

// Runs `job` on a cron schedule, such as `@hourly` or `30 2 * * MON`, from when the server starts until it stops: once per process, or once across processes with `lock`, never two runs at a time.
// A run that throws is logged and the next one comes as planned; a stopping server waits for the run in progress.
export function schedule<const Cron extends string>(cron: Cron & CronSchedule<Cron>, job: () => unknown, options: ScheduleOptions = {}) {
  // A typo fails the boot rather than never running.
  if (Bun.cron.parse(cron, Date.now(), { tz: options.tz }) === null)
    throw new Error(`kay: the schedule ${cron} never comes`)

  let handle: Bun.CronJob | undefined
  let running: Promise<void> | undefined

  const run = async () => {
    try {
      if (options.lock !== undefined && !await (options.store ?? defaultJobStore()).lock(options.lock, Math.floor(Date.now() / SLOT_MS)))
        return

      await job()
    }
    catch (error) {
      console.error(`kay: the job scheduled ${cron} failed`)
      logError(error)
    }
  }

  // Unnamed, so Elysia never takes two schedules for one plugin.
  return new Elysia()
    .onStart(() => {
      handle ??= Bun.cron(cron, async () => {
        running = run()
        await running
        running = undefined
      }, { tz: options.tz })
    })
    .onStop(async () => {
      handle?.stop()
      handle = undefined
      await running
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
