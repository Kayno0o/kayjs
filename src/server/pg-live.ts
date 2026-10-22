import type { SQL } from 'bun'
import type { LiveStore } from '../runtime/live-value'
import type { PgHandle } from './pg-data'
import { kayLog } from '../runtime/log'
import { NOW, query } from './pg-sql'
import { onReload } from './reload'

// How often a process reads what the others set, and how long a message is kept for one that reads late.
const POLL_MS = 500
const EVENT_TTL_MS = 60_000
// Ids this far behind the last one read are read again, as a transaction that began earlier may commit its event after a later one.
const OVERLAP = 100
const ESCAPED = /\\(.)/g

// Postgres text holds no NUL, which a key made of a visitor's input may carry: it is stored as `\0`, a backslash doubled.
const escaped = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('\0', '\\0')
const unescaped = (text: string): string => text.replace(ESCAPED, (_, char: string) => char === '0' ? '\0' : char)

type Listener = Parameters<LiveStore['subscribe']>[0]

// Live values in Postgres, the twin of `sqliteLive`: they survive restarts and deploys, and a process hears within about half a second what another one set.
// `set` and `delete` answer with a promise that never rejects, a failed write being logged, and the writes of one store reach the database in the order they were made, so `live.set` stays synchronous for the app.
export function pgLive(pg: PgHandle): LiveStore {
  const self = crypto.randomUUID()
  const listeners = new Set<Listener>()
  let tail: Promise<void> = Promise.resolve()
  let poller: ReturnType<typeof setInterval> | undefined
  let seen: number | undefined
  const recent = new Set<number>()
  let polling = false
  // A streak of failed reads logs once, as the poll runs twice a second.
  let failing = false
  let closed = false
  // The keys with a write of this process still to commit, and the ones heard meanwhile: their row is read once the write ends, so an older row never replaces the newer local value.
  const pending = new Map<string, number>()
  const deferred = new Map<string, [string, string]>()

  // Runs `work` once the ones before it ended, failed or not.
  const ordered = async <Result>(work: () => Promise<Result>): Promise<Result> => {
    const prior = tail
    const run = (async () => {
      await prior

      return work()
    })()

    tail = (async () => {
      try {
        await run
      }
      catch {
        // The caller of `run` has the error.
      }
    })()

    return run
  }

  // The row and its message go together, so a process that heard the message finds the row.
  const write = async (what: string, id: string, key: string, change: (tx: SQL) => Promise<unknown>): Promise<void> => {
    const at = `${escaped(id)}\0${escaped(key)}`

    pending.set(at, (pending.get(at) ?? 0) + 1)

    try {
      await ordered(async () => {
        const db = await pg.db()

        await db.begin(async (tx) => {
          await change(tx)
          await query(tx, `INSERT INTO kay_live_events (origin, id, key, at) VALUES ($1, $2, $3, ${NOW})`, [self, escaped(id), escaped(key)])
          await query(tx, `DELETE FROM kay_live_events WHERE at < ${NOW} - ${EVENT_TTL_MS}`)
        })
      })
    }
    catch (error) {
      kayLog('error', `${what} the live value ${id} failed`, error)
    }
    finally {
      if (pending.get(at) === 1)
        pending.delete(at)
      else
        pending.set(at, (pending.get(at) ?? 1) - 1)
    }
  }

  // Where the events stand: the ones in the overlap are noted as known, so they are not heard again.
  const startAt = async (db: SQL): Promise<number> => {
    const known = await query<{ seq: string }>(db, 'SELECT seq::text AS seq FROM kay_live_events ORDER BY seq DESC LIMIT $1', [OVERLAP])

    for (const event of known)
      recent.add(Number(event.seq))

    return Math.max(0, ...known.map(event => Number(event.seq)))
  }

  // The events of the other processes since the last poll, each value read once however many times it was set.
  const hear = async (db: SQL, after: number): Promise<{ heard: [id: string, key: string, text: string | undefined][], last: number, fresh: number[], read: string[] }> => {
    let last = after
    // The events are noted as known only once their rows are read, so a failed read hears them again.
    const fresh: number[] = []
    const changed = new Map<string, [string, string]>()

    for (const [at, event] of deferred) {
      if (!pending.has(at))
        changed.set(at, event)
    }

    for (const event of await query<{ seq: string, id: string, key: string }>(db, 'SELECT seq::text AS seq, id, key FROM kay_live_events WHERE seq > $1::bigint AND origin != $2 ORDER BY seq', [after - OVERLAP, self])) {
      const seq = Number(event.seq)

      if (recent.has(seq))
        continue

      fresh.push(seq)
      last = Math.max(last, seq)

      const at = `${event.id}\0${event.key}`

      if (pending.has(at))
        deferred.set(at, [event.id, event.key])
      else
        changed.set(at, [event.id, event.key])
    }

    const heard: [id: string, key: string, text: string | undefined][] = []

    const read: string[] = []

    for (const [at, [id, key]] of changed) {
      // A write of this process began since: the row is read once it ends.
      if (pending.has(at)) {
        deferred.set(at, [id, key])

        continue
      }

      const [row] = await query<{ value: string }>(db, 'SELECT value FROM kay_live WHERE id = $1 AND key = $2', [id, key])

      heard.push([unescaped(id), unescaped(key), row?.value])
      read.push(at)
    }

    return { heard, last, fresh, read }
  }

  const poll = async () => {
    if (polling || listeners.size === 0 || closed)
      return

    polling = true

    let heard: [id: string, key: string, text: string | undefined][] = []

    try {
      const db = await pg.db()

      // What was set before this process first used the store is in what it reads from the store already.
      seen ??= await startAt(db)

      const read = await hear(db, seen)

      heard = read.heard
      seen = read.last

      for (const id of read.fresh)
        recent.add(id)

      for (const at of read.read)
        deferred.delete(at)

      for (const id of recent) {
        if (id <= seen - OVERLAP)
          recent.delete(id)
      }

      failing = false
    }
    catch (error) {
      if (!failing)
        kayLog('error', 'reading the live values the other processes set failed; trying again', error)

      failing = true
    }
    finally {
      polling = false
    }

    for (const [id, key, text] of heard) {
      for (const listener of listeners) {
        try {
          listener(id, key, text)
        }
        catch (error) {
          kayLog('error', `a watcher of the live value ${id} threw`, error)
        }
      }
    }
  }

  const stop = () => {
    clearInterval(poller)
    poller = undefined
    listeners.clear()
  }

  onReload(() => {
    closed = true
    stop()
  })

  return {
    stop,
    // After the writes made before it, and noting the last event before the rows are read, so a set between the two is heard.
    async entries() {
      return ordered(async () => {
        const db = await pg.db()

        seen ??= await startAt(db)

        return (await query<{ id: string, key: string, value: string }>(db, 'SELECT id, key, value FROM kay_live')).map(row => [unescaped(row.id), unescaped(row.key), row.value] as [string, string, string])
      })
    },
    set: async (id, key, text) => write('writing', id, key, async tx => query(tx, 'INSERT INTO kay_live (id, key, value) VALUES ($1, $2, $3) ON CONFLICT (id, key) DO UPDATE SET value = excluded.value', [escaped(id), escaped(key), text])),
    delete: async (id, key) => write('deleting', id, key, async tx => query(tx, 'DELETE FROM kay_live WHERE id = $1 AND key = $2', [escaped(id), escaped(key)])),
    subscribe(listener) {
      listeners.add(listener)

      if (poller !== undefined || closed)
        return

      poller = setInterval(() => void poll(), POLL_MS)
      poller.unref()
    },
  }
}
