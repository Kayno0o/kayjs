import type { SQL } from 'bun'
import type { PgHandle } from './pg-data'
import { kayLog } from '../runtime/log'

// How often a process reads what the others wrote, and how long a message is kept for one that reads late.
export const POLL_MS = 500
export const EVENT_TTL_MS = 60_000
// A read or a write that takes longer is given up, so a database that stopped answering holds neither the poll nor a store's queue.
export const DB_TIMEOUT_MS = 30_000
// Ids this far behind the last one read are read again, as a transaction that began earlier may commit its event after a later one.
const OVERLAP = 100

// Gives up on `work` after `ms`; the work itself keeps running, its result ignored.
export async function timeLimited<Result>(work: Promise<Result>, ms: number, what: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took more than ${ms / 1000} seconds`)), ms)
      timer.unref()
    })])
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
  run: (db: SQL) => Promise<void>
  // What the log says when a streak of failed runs begins.
  failed: string
}

interface Entry {
  task: PollTask
  next: number
  running: boolean
  failing: boolean
}

interface Poller {
  add: (task: PollTask, now: boolean) => () => void
}

const pollers = new WeakMap<PgHandle, Poller>()

// One timer per handle for every store reading events on it, ticking at the shortest `every` of its tasks, and one `pg.db()` a tick however many tasks are due; a task runs again only once its last run ended.
export function pollerOf(pg: PgHandle): Poller {
  let poller = pollers.get(pg)

  if (poller === undefined) {
    poller = createPoller(pg)
    pollers.set(pg, poller)
  }

  return poller
}

function createPoller(pg: PgHandle): Poller {
  const entries = new Set<Entry>()
  let timer: ReturnType<typeof setInterval> | undefined
  let tickMs = 0

  const runEntry = async (entry: Entry, db: Promise<SQL>) => {
    try {
      await timeLimited((async () => entry.task.run(await db))(), DB_TIMEOUT_MS, 'reading the events')
      entry.failing = false
    }
    catch (error) {
      // A streak of failed reads logs once, as the poll runs several times a second.
      if (!entry.failing)
        kayLog('error', `${entry.task.failed}; trying again`, error)

      entry.failing = true
    }
    finally {
      entry.running = false
    }
  }

  const tick = () => {
    const now = Date.now()
    let db: Promise<SQL> | undefined

    for (const entry of entries) {
      if (entry.running || entry.next > now + tickMs / 2 || !entry.task.wanted())
        continue

      entry.running = true
      entry.next = now + entry.task.every
      db ??= timeLimited(pg.db(), DB_TIMEOUT_MS, 'reaching the database')
      // A database that fails fails every task of the tick, each logging its own streak.
      void runEntry(entry, db)
    }
  }

  const retime = () => {
    const wanted = Math.min(...[...entries].map(entry => entry.task.every))

    if (entries.size === 0) {
      clearInterval(timer)
      timer = undefined
      tickMs = 0

      return
    }

    if (wanted === tickMs)
      return

    clearInterval(timer)
    tickMs = wanted
    timer = setInterval(tick, tickMs)
    timer.unref()
  }

  return {
    add(task, now) {
      const entry: Entry = { task, next: now ? 0 : Date.now() + task.every, running: false, failing: false }

      entries.add(entry)
      retime()

      if (now)
        tick()

      return () => {
        entries.delete(entry)
        retime()
      }
    },
  }
}
