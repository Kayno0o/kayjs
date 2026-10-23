import type { SQL } from 'bun'
import type { PgHandle } from './pg-data'
import { kayLog } from '../runtime/log'
import { delayAfter, pollClock } from '../runtime/poll-backoff'
import { startedStatements, trackStatements } from './pg-jobs'
import { onReload } from './reload'

// How often a process reads what the others wrote while there is activity (see `delayAfter` for how it slows down when idle), and how long a message is kept for one that reads late.
export const POLL_MS = 500
export const EVENT_TTL_MS = 60_000
// A read or a write that takes longer is given up, so a database that stopped answering holds neither the poll nor a store's queue.
export const DB_TIMEOUT_MS = 30_000
// Ids this far behind the last one read are read again, as a transaction that began earlier may commit its event after a later one.
export const OVERLAP = 100

// Ends what a store of `pg` runs when its `pgData` is closed, or, for a handle that keeps no list, when a `kay dev` reload runs the module that opened it again.
export function closeWith(pg: PgHandle, dispose: () => unknown): void {
  if (pg.onClose === undefined)
    onReload(dispose)
  else
    pg.onClose(dispose)
}

// What a call given up on by `timeLimited` fails with.
export class TimeoutError extends Error {}

// Gives up on `work` after `ms`, cancelling the statements it started that are still in flight so they free their connection; what else it does keeps running, its result ignored.
export async function timeLimited<Result>(work: () => Promise<Result>, ms: number, what: string): Promise<Result> {
  const run = { statements: new Set<{ cancel: () => void }>(), over: false }

  trackStatements()
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([startedStatements.run(run, work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Only a run given up on is over: the context of one that succeeded lives on in the timers and listeners it made, whose statements are theirs to run.
        run.over = true

        for (const statement of run.statements)
          statement.cancel()

        reject(new TimeoutError(`${what} took more than ${ms / 1000} seconds`))
      }, ms)
      timer.unref()
    })])
  }
  catch (error) {
    // Work that failed by itself frees the statements it left in flight, but is not over: its timers keep their context.
    for (const statement of run.statements)
      statement.cancel()

    throw error
  }
  finally {
    clearTimeout(timer)
  }
}

// Where a store's reading of an event table stands: the last id read, and the ids in the overlap behind it that were read already.
export interface EventWindow {
  // Where to read from, the overlap included, or undefined before the first read.
  from: () => number | undefined
  // Starts after the events already there, noting `known` as read.
  start: (known: number[]) => void
  has: (id: number) => boolean
  note: (id: number) => void
  forget: () => void
}

export function eventWindow(): EventWindow {
  const recent = new Set<number>()
  let last: number | undefined

  return {
    from: () => last === undefined ? undefined : last - OVERLAP,
    start(known) {
      for (const id of known)
        recent.add(id)

      last = Math.max(0, ...known)
    },
    has: id => recent.has(id),
    note(id) {
      recent.add(id)
      last = Math.max(last ?? 0, id)

      for (const old of recent) {
        if (old <= last - OVERLAP)
          recent.delete(old)
      }
    },
    forget() {
      recent.clear()
      last = undefined
    },
  }
}

export interface PollTask {
  // Milliseconds between two runs.
  every: number
  // Whether there is anything to read; the database is not reached when not.
  wanted: () => boolean
  // Resolves 'busy' when it did not read because its last run is still going: that is neither a success nor a failure, so a streak of failed runs goes on. Resolves 'heard' when it read something, which keeps a task with `backoff` at its base rate.
  run: (db: SQL) => Promise<void | 'busy' | 'heard'>
  // Whether the task polls less often after runs that heard nothing, back at `every` on a `wake`.
  backoff?: boolean
  // What the log says when a streak of failed runs begins.
  failed: string
}

interface Entry {
  task: PollTask
  next: number
  running: boolean
  failing: boolean
  // The runs in a row that heard nothing, and when the last began.
  quiet: number
  began: number
  // A held task keeps its base rate, as a watcher waits on its next change.
  held: boolean
}

export type Stop = (() => void) & { wake: () => void, hold: (held: boolean) => void }

interface Poller {
  add: (task: PollTask, now: boolean) => Stop
}

const pollers = new WeakMap<PgHandle, Poller>()

// One timer per handle for every store reading events on it, and one `pg.db()` a tick however many tasks are due; a task whose last run was given up at the time limit may run again while that run still ends.
export function pollerOf(pg: PgHandle): Poller {
  let poller = pollers.get(pg)

  if (poller === undefined) {
    poller = createPoller(pg)
    pollers.set(pg, poller)
  }

  return poller
}

// Tasks due within this of each other share a tick, so stores started a few milliseconds apart still reach the database once.
const GROUP_MS = 25

function createPoller(pg: PgHandle): Poller {
  const entries = new Set<Entry>()
  let timer: unknown

  // One timeout at the earliest due time of the tasks not running; a task ending schedules again.
  const schedule = () => {
    pollClock.clearTimeout(timer)
    timer = undefined

    const idle = [...entries].filter(entry => !entry.running)

    if (idle.length === 0)
      return

    timer = pollClock.setTimeout(tick, Math.max(0, Math.min(...idle.map(entry => entry.next)) - pollClock.now()))
  }

  const runEntry = async (entry: Entry, db: Promise<SQL>) => {
    try {
      const outcome = await timeLimited(async () => entry.task.run(await db), DB_TIMEOUT_MS, 'reading the events')

      if (outcome !== 'busy') {
        entry.failing = false
        entry.quiet = outcome === 'heard' ? 0 : entry.quiet + 1

        if (entry.task.backoff)
          entry.next = entry.began + (entry.held ? entry.task.every : delayAfter(entry.task.every, entry.quiet))
      }
    }
    catch (error) {
      // A streak of failed reads logs once, as the poll runs several times a second.
      if (!entry.failing)
        kayLog('error', `${entry.task.failed}; trying again`, error)

      entry.failing = true
    }
    finally {
      entry.running = false
      schedule()
    }
  }

  function tick() {
    const now = pollClock.now()
    let db: Promise<SQL> | undefined

    for (const entry of entries) {
      if (entry.running || entry.next > now + GROUP_MS)
        continue

      entry.next = now + entry.task.every
      entry.began = now

      if (!entry.task.wanted())
        continue

      entry.running = true
      db ??= timeLimited(async () => pg.db(), DB_TIMEOUT_MS, 'reaching the database')
      // A database that fails fails every task of the tick, each logging its own streak.
      void runEntry(entry, db)
    }

    schedule()
  }

  return {
    add(task, now) {
      const entry: Entry = { task, next: now ? 0 : pollClock.now() + task.every, running: false, failing: false, quiet: 0, began: 0, held: false }

      entries.add(entry)
      schedule()

      const wake = () => {
        entry.quiet = 0

        const soonest = pollClock.now() + task.every

        // A poll already due within its base rate needs no new timer.
        if (entry.next > soonest) {
          entry.next = soonest
          schedule()
        }
      }

      return Object.assign(() => {
        entries.delete(entry)
        schedule()
      }, {
        wake,
        hold(held: boolean) {
          entry.held = held

          if (held)
            wake()
        },
      })
    },
  }
}
