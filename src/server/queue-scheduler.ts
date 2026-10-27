import type { JobStore } from './queue'
import { AsyncLocalStorage } from 'node:async_hooks'
import { kayLog } from '../runtime/log'
import { MAX_TIMER_MS } from './config-limits'
import { onDrain } from './drain'

// How soon an idle queue looks again after a job, the first wait of its backoff.
export const POLL_MS = 1000
// The longest a worker waits between looks at a store that keeps failing.
const MAX_OUTAGE_MS = 60_000

// Where a queue's workers stand: `idle` before they start (no server yet, or a lazy queue not activated), `running` while they take jobs, `draining` once a stop began and they wind down, `stopped` once they ended, which a next start leaves again.
type SchedulerState = 'idle' | 'running' | 'draining' | 'stopped'

interface SchedulerOptions {
  name: string
  concurrency: number
  // The longest wait between looks at the store while the queue is idle.
  idlePoll: number
  lazy: boolean
  store: () => JobStore
  // Claims one due job and runs it, false when none was due.
  run: (scheduler: Scheduler) => Promise<boolean>
  // Drops the expired failed jobs, throwing when the store fails.
  purge: () => Promise<void>
}

// Set while a job runs, so a drain the job awaits does not wait for the run awaiting it.
const inJob = new AsyncLocalStorage<true>()

// The schedulers of this process, which `drainQueues` drains.
const schedulers = new Set<Scheduler>()

// Runs a queue's workers and its drains: one worker at a time looks at the store while the queue is idle, the others sleep until a claim leaves no worker looking.
export class Scheduler {
  #state: SchedulerState = 'idle'
  readonly #options: SchedulerOptions
  #serving = false
  #activated: boolean
  #controller: AbortController | undefined
  #workers: Promise<void>[] = []
  #forgetDrain: (() => void) | undefined
  // The worker looking for jobs while the queue is idle sleeps until its next look, woken when this process enqueues a job or retries one.
  readonly #pollers = new Set<() => void>()
  // The others sleep until a claim leaves no worker looking, which wakes one of them to take over.
  readonly #idlers = new Set<() => void>()
  // The workers waiting out a store that fails, which nothing wakes but a stop.
  readonly #outage = new Set<() => void>()
  // Whether a worker is the one looking for jobs while the queue is idle.
  #polling = false
  // The wait of the next empty look: the poll, doubling up to `idlePoll` while no job is found, shared by the workers as one looks at a time.
  #idleWait = POLL_MS
  // Counts the wakes of the poller, so one finding that came while it awaited the store looks again.
  #wakes = 0
  // Whether the store failed at the last look, so an outage is logged once as it starts and once as it ends, whatever the concurrency.
  #storeDown = false
  // Every run in flight, a worker's included: a drain cannot claim a job a worker holds, so it waits for these instead.
  readonly #running = new Set<Promise<boolean>>()
  // The runs a drain already counted, which another drain waiting for the same run does not count again.
  readonly #counted = new WeakSet<Promise<boolean>>()

  constructor(options: SchedulerOptions) {
    this.#options = options
    this.#activated = !options.lazy
    schedulers.add(this)
  }

  // Aborts once the stop of the workers began, for a run to stop on.
  get stopping(): AbortSignal | undefined {
    return this.#controller?.signal
  }

  // The server started: the workers start unless the queue waits to be activated.
  serve(): void {
    this.#serving = true
    this.#forgetDrain = onDrain(() => this.#beginStop())
    this.#start()
  }

  activate(): void {
    this.#activated = true
    this.#start()
  }

  // The server stopped: the workers end, a run in flight winding down first.
  async stop(): Promise<void> {
    this.#forgetDrain?.()
    this.#serving = false
    this.#beginStop()
    await Promise.all(this.#workers)
    this.#controller = undefined
    this.#workers = []
    this.#state = 'stopped'
  }

  // A run claimed a job: unless another worker looks, one asleep wakes to look for the next job while this one runs.
  claimed(): void {
    this.#idleWait = POLL_MS

    if (!this.#polling) {
      const [sleeper] = this.#idlers

      sleeper?.()
    }
  }

  // Wakes the worker looking for jobs, for a job made due now or sooner than it sleeps.
  wake = (): void => {
    this.#wakes++

    for (const sleeper of this.#pollers)
      sleeper()

    // A poller whose store failed waits in the outage set; an enqueue gives it a reason to ask again now.
    for (const sleeper of this.#outage)
      sleeper()
  }

  // Runs every job whose time has come, here and now, until none is left and none a worker took is still running.
  drain = async (): Promise<number> => {
    let ran = 0

    await this.#options.purge()

    for (;;) {
      while (await this.#runNext(true))
        ran++

      if (this.#running.size === 0 || inJob.getStore())
        return ran

      // A job a worker holds may enqueue another, so the queue is looked at again once it ends, and counts as run, so `drainQueues` looks at every queue again too.
      const waited = [...this.#running]
      const settled = await Promise.allSettled(waited)

      for (const [at, run] of waited.entries()) {
        const result = settled[at]

        if (result?.status === 'fulfilled' && result.value && !this.#counted.has(run)) {
          this.#counted.add(run)
          ran++
        }
      }
    }
  }

  #start(): void {
    if (this.#state === 'running' || this.#state === 'draining' || !this.#serving || !this.#activated)
      return

    const started = new AbortController()

    this.#controller = started
    this.#state = 'running'
    this.#workers = Array.from({ length: this.#options.concurrency }, async () => this.#work(started.signal))
  }

  #beginStop(): void {
    if (this.#controller === undefined)
      return

    this.#controller.abort()
    this.#state = 'draining'
  }

  async #runNext(byDrain = false): Promise<boolean> {
    const run = inJob.run(true, this.#options.run, this)

    this.#running.add(run)

    try {
      const ran = await run

      if (byDrain && ran)
        this.#counted.add(run)

      return ran
    }
    finally {
      this.#running.delete(run)
    }
  }

  async #work(signal: AbortSignal): Promise<void> {
    const { name, idlePoll, store, purge } = this.#options
    let outageWait = 0

    while (!signal.aborted) {
      try {
        await purge()

        const ran = await this.#runNext()

        if (this.#storeDown) {
          this.#storeDown = false
          kayLog('info', `queue('${name}') reads its store again`)
        }

        outageWait = 0

        if (ran)
          continue

        // One worker looks at the store; the others sleep until a claim leaves no worker looking and wakes one of them.
        if (this.#polling) {
          await sleep(MAX_TIMER_MS, signal, this.#idlers)

          continue
        }

        this.#polling = true

        const seen = this.#wakes

        try {
          const next = await store().nextRunAt(name)

          // Something was enqueued or retried meanwhile, before the sleep could be woken.
          if (this.#wakes !== seen)
            continue

          const wait = next === undefined ? this.#idleWait : Math.min(this.#idleWait, Math.max(0, next - Date.now()))

          this.#idleWait = Math.min(this.#idleWait * 2, idlePoll)
          await sleep(wait, signal, this.#pollers)
        }
        finally {
          this.#polling = false
        }
      }
      // A store that failed, locked past its timeout say, is asked again later and later, up to a minute apart.
      catch (error) {
        if (!this.#storeDown) {
          this.#storeDown = true
          kayLog('error', `queue('${name}') could not read its store; its workers ask it again less and less often until it answers`, error)
        }

        outageWait = Math.min(outageWait === 0 ? POLL_MS : outageWait * 2, MAX_OUTAGE_MS)
        await sleep(outageWait, signal, this.#outage)
      }
    }
  }
}

// Takes the scheduler running that drain out of what `drainQueues` runs.
export function forgetDrain(drain: () => Promise<number>): void {
  for (const scheduler of schedulers) {
    if (scheduler.drain === drain)
      schedulers.delete(scheduler)
  }
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

// Work a library started off a response's path, which `drainQueues` waits for before it looks at the queues.
const detached = new Set<Promise<unknown>>()

// Registers work started off a response's path, such as a mail issued after the answer left, so a test's `runJobs()` finds what it enqueues; a rejection is ignored here, so the work logs its own failure.
export function trackDetached(work: Promise<unknown>): void {
  const tracked: Promise<void> = (async () => {
    try {
      await work
    }
    catch {
      // The caller handles its own failure; here the work only has to be over.
    }
    finally {
      queueMicrotask(() => detached.delete(tracked))
    }
  })()

  detached.add(tracked)
}

// Calls of kay's and its libraries' own async entry points (an enqueue, a mail send) that have not settled, which `drainQueues` waits for like detached work, so one an app left unawaited is found without the app declaring anything.
let inFlight = 0
const idleWaiters = new Set<() => void>()
const flying = () => inFlight > 0
const working = () => detached.size > 0 || flying()

// Runs `work` counting it as in flight, and hands back its own promise, so its rejection reaches the caller as it would and an unawaited one stays unhandled.
export async function inFlightWork<T>(work: () => Promise<T>): Promise<T> {
  inFlight++

  try {
    return await work()
  }
  finally {
    inFlight--

    if (inFlight === 0) {
      for (const wake of idleWaiters)
        wake()

      idleWaiters.clear()
    }
  }
}

// Runs every due job of every queue in this process, until none is left: `kay/test`'s `runJobs`.
export async function drainQueues(): Promise<number> {
  let ran = 0

  for (let more = true; more;) {
    more = false

    while (working()) {
      await Promise.all(detached)

      if (flying())
        await new Promise<void>(resolve => idleWaiters.add(resolve))
    }

    for (const scheduler of schedulers) {
      const count = await scheduler.drain()

      ran += count
      more ||= count > 0
    }
  }

  return ran
}
