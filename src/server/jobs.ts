import type { CronSchedule } from '../runtime/checks'
import { Elysia } from 'elysia'
import { logError } from '../build/sourcemap'

export interface ScheduleOptions {
  // IANA time zone the schedule reads in, such as `Europe/Paris`; the system's by default.
  tz?: string
}

// Runs `job` on a cron schedule, such as `@hourly` or `30 2 * * MON`, from when the server starts until it stops: once per process, never two runs at a time.
// A run that throws is logged and the next one comes as planned; a stopping server waits for the run in progress.
export function schedule<const Cron extends string>(cron: Cron & CronSchedule<Cron>, job: () => unknown, options: ScheduleOptions = {}) {
  // A typo fails the boot rather than never running.
  if (Bun.cron.parse(cron, Date.now(), options) === null)
    throw new Error(`kay: the schedule ${cron} never comes`)

  let handle: Bun.CronJob | undefined
  let running: Promise<void> | undefined

  const run = async () => {
    try {
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
      }, options)
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
