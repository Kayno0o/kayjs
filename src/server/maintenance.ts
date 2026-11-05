import type { JobStore } from './queue'
import process from 'node:process'
import { appStore } from './app-store'
import { outsideRequest } from './clean-context'
import { onDrain } from './drain'
import { scheduledRun } from './jobs'
import { trackDetached } from './queue'

export interface MaintenanceOptions {
  // Runs once this long (ms) after the maintenance starts, under a lock of its own so processes starting together run it once.
  first?: number | undefined
  // Where the lock is taken: the queues' default store unless given.
  store?: JobStore | undefined
  // How long (ms) a run may take before it is reported as failed and its signal aborts; 10 minutes by default.
  timeout?: number | undefined
  // `false` for upkeep of what is this process's or this host's own, a sqlite file say, which a lock shared with other hosts would leave unswept on all but one.
  lock?: false | undefined
}

export interface Maintenance {
  // Arms the timers; calling it again does nothing, and it arms them again after a stop.
  start: () => void
  // Runs one pass now under the lock, as the timers do, tracked so a test's `runJobs()` waits for it; a pass already going is waited for first.
  run: () => Promise<void>
  // Ends the timers and aborts the pass in progress.
  stop: () => void
}

export interface MaintenanceView {
  name: string
  // Milliseconds between passes.
  every: number
  // How the last pass this process ran went, none while it has run none.
  last?: { at: number, error?: string }
}

interface Entry {
  name: string
  every: number
  last: MaintenanceView['last']
  stop: () => void
}

// The maintenance with timers armed in this process.
const armed = new Set<Entry>()

// A production server locks its maintenance as it does its schedules, so with several processes behind one database only one runs each pass. Without a job store of the app's or of the call's own there is nothing shared to lock in, and the default sqlite store is not created for upkeep alone, so it runs unlocked.
// A clock skewed by more than half of `every` between two processes names different lock slots, so both run the pass: harmless for upkeep, which is idempotent.
const locking = (options: MaintenanceOptions) => options.lock !== false && process.env.NODE_ENV === 'production' && process.env.KAY_LOCK_SCHEDULES !== 'false' && (options.store !== undefined || appStore()?.jobs !== undefined)

// A library's or a store's upkeep, such as pruning what expired: a schedule that is internal, started by the code that owns the data rather than by `app.use`, with the lock, the signal, the stop handling and the `kay_job_runs_total` series of `schedule()`, and an entry in the dev tool's Jobs tab.
// Passes fall on the epoch's multiples of `every` (ms), so processes started apart share one lock slot per pass. Upkeep that is per process on purpose, such as pruning an in-memory cache, needs none of this.
// Stopped with the server, whatever started it: `start()` arms it again on the next use.
export function maintenance(name: string, every: number, work: (signal: AbortSignal) => unknown, options: MaintenanceOptions = {}): Maintenance {
  const lock = `maintenance:${name}`
  const entry: Entry = { name, every, last: undefined, stop: () => undefined }
  const run = scheduledRun(lock, every, async (signal) => {
    try {
      await work(signal)
      entry.last = { at: Date.now() }
    }
    catch (error) {
      entry.last = { at: Date.now(), error: error instanceof Error ? error.message : String(error) }

      throw error
    }
  }, { get lock() { return locking(options) ? undefined : false }, store: options.store, timeout: options.timeout === undefined ? undefined : `${options.timeout}ms` }, { take: () => lock, release: () => undefined, name: () => lock })

  let timer: Timer | undefined
  let first: Timer | undefined
  let forgetDrain: (() => void) | undefined
  let running: Promise<void> | undefined

  // Passes never overlap: each waits for the one before.
  const pass = async (boot: boolean): Promise<void> => {
    const previous = running

    armed.add(entry)
    const current = (async () => {
      await previous
      await run(boot)
    })()

    running = current
    trackDetached(current)
    await current
  }

  const plan = () => {
    const tick = async () => {
      await pass(false)

      if (timer !== undefined)
        plan()
    }

    timer = outsideRequest(() => setTimeout(() => void tick(), every - (Date.now() % every)))
    timer.unref()
  }

  const stop = () => {
    forgetDrain?.()
    forgetDrain = undefined
    clearTimeout(timer)
    clearTimeout(first)
    timer = first = undefined
    armed.delete(entry)
    run.abort()
  }

  entry.stop = stop

  return {
    start() {
      if (timer !== undefined)
        return

      armed.add(entry)
      forgetDrain = onDrain(() => run.abort())
      plan()

      if (options.first !== undefined) {
        first = outsideRequest(() => setTimeout(() => void pass(true), options.first))
        first.unref()
      }
    },
    run: async () => pass(false),
    stop,
  }
}

// Ends every maintenance of this process, as a stopping server does.
export function stopMaintenance(): void {
  for (const { stop } of armed)
    stop()
}

// What the dev tool's Jobs tab lists beside the queues: the maintenance running in this process.
export function maintenanceOverview(): MaintenanceView[] {
  return [...armed].map(({ name, every, last }) => ({ name, every, ...last && { last } }))
}
