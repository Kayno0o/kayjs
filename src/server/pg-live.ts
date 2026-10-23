import type { SQL } from 'bun'
import type { LiveEntry, LiveStore } from '../runtime/live-value'
import type { PgHandle } from './pg-data'
import type { Stop } from './pg-poll'
import { PURGE_STALE_MS } from '../runtime/cache'
import { kayLog } from '../runtime/log'
import { closeWith, DB_TIMEOUT_MS, EVENT_TTL_MS, eventWindow, OVERLAP, POLL_MS, pollerOf, timeLimited } from './pg-poll'
import { escaped, NOW, query, unescaped } from './pg-sql'

// Writes waiting behind a database that stopped answering: past this many a new one is dropped and logged, rather than held in memory.
const MAX_QUEUED = 10_000

// The event about every row of an id carries the id behind this prefix, which no escaped id starts with (a backslash is always doubled or followed by 0), and no key. A build that predates it hears an id no module declares and does nothing.
const WHOLE_ID = '\\*'

type Listener = Parameters<LiveStore['subscribe']>[0]

// Live values in Postgres, the twin of `sqliteLive`: they survive restarts and deploys, and a process hears within about half a second what another one set.
// `set` and `delete` answer with a promise that never rejects, a failed write being logged, and the writes of one store reach the database in the order they were made, so `live.set` stays synchronous for the app.
export function pgLive(pg: PgHandle): LiveStore {
  const self = crypto.randomUUID()
  const listeners = new Set<Listener>()
  let tail: Promise<void> = Promise.resolve()
  let polling: Stop | undefined
  let held = false
  const events = eventWindow()
  let queued = 0
  let overflowing = false
  let closed = false
  let purged = 0
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
  const write = async (what: string, id: string, eventKey: string, change: (tx: SQL) => Promise<unknown>, eventId = escaped(id)): Promise<void> => {
    if (queued >= MAX_QUEUED) {
      if (!overflowing)
        kayLog('error', `${what} the live value ${id} failed: ${MAX_QUEUED} writes wait for the database, the ones after are dropped until it answers`)

      overflowing = true

      return
    }

    const at = `${eventId}\0${eventKey}`

    queued++
    polling?.wake()
    pending.set(at, (pending.get(at) ?? 0) + 1)

    try {
      // A write given up at the time limit may still commit later, after the next write of its key.
      await ordered(async () => timeLimited(async () => {
        const db = await pg.db()

        await db.begin(async (tx) => {
          await change(tx)
          await query(tx, `INSERT INTO kay_live_events (origin, id, key, at) VALUES ($1, $2, $3, ${NOW})`, [self, eventId, eventKey])
          await query(tx, `DELETE FROM kay_live_events WHERE at < ${NOW} - ${EVENT_TTL_MS}`)
        })
      }, DB_TIMEOUT_MS, 'the write'))
    }
    catch (error) {
      kayLog('error', `${what} the live value ${id} failed`, error)
    }
    finally {
      queued--
      overflowing &&= queued > 0

      if (pending.get(at) === 1)
        pending.delete(at)
      else
        pending.set(at, (pending.get(at) ?? 1) - 1)
    }
  }

  const purging = async (): Promise<void> => {
    try {
      await timeLimited(async () => query(await pg.db(), `DELETE FROM kay_live WHERE expires_at < ${NOW}`), DB_TIMEOUT_MS, 'the purge')
    }
    catch (error) {
      kayLog('warn', 'dropping the live values past their ttl failed; trying again in an hour', error)
    }
  }

  // Drops the rows past their end, at most once an hour, apart from the write that triggers it and under a time limit of its own, so a slow or refused purge never costs a write.
  const purge = (): void => {
    if (closed || Date.now() - purged <= PURGE_STALE_MS)
      return

    purged = Date.now()
    void purging()
  }

  // Where the events stand: the ones in the overlap are noted as known, so they are not heard again.
  const startAt = async (db: SQL) => {
    // The table column again, as the text of the select list would give the highest of its text.
    const known = await query<{ seq: string }>(db, 'SELECT seq::text AS seq FROM kay_live_events ORDER BY kay_live_events.seq DESC LIMIT $1', [OVERLAP])

    events.start(known.map(event => Number(event.seq)))
  }

  // The events of the other processes since the last poll, each value read once however many times it was set, all the rows in one query.
  const hear = async (db: SQL, after: number): Promise<{ heard: [id: string, key: string, text: string | undefined, expiresAt: number | undefined][], fresh: number[], read: string[] }> => {
    // The events are noted as known only once their rows are read, so a failed read hears them again.
    const fresh: number[] = []
    const changed = new Map<string, [string, string]>()
    const whole = new Set<string>()

    for (const [at, event] of deferred) {
      if (!pending.has(at))
        changed.set(at, event)
    }

    // Ordered by the table column: a bare `seq` is the text of the select list, where '100' sorts before '99'.
    for (const event of await query<{ seq: string, id: string, key: string }>(db, 'SELECT seq::text AS seq, id, key FROM kay_live_events WHERE seq > $1::bigint AND origin != $2 ORDER BY kay_live_events.seq', [after, self])) {
      const seq = Number(event.seq)

      if (events.has(seq))
        continue

      fresh.push(seq)

      if (event.id.startsWith(WHOLE_ID)) {
        whole.add(event.id.slice(WHOLE_ID.length))

        continue
      }

      const at = `${event.id}\0${event.key}`

      if (pending.has(at))
        deferred.set(at, [event.id, event.key])
      else
        changed.set(at, [event.id, event.key])
    }

    const wanted = [...changed]
    // The keys with a write still to commit before the rows are read: one that commits during the read is not mistaken for settled.
    const busy = new Set(pending.keys())

    const values = new Map<string, { value: string, expiresAt: number | undefined }>()

    if (wanted.length > 0) {
      const rows = await query<{ id: string, key: string, value: string, expires_at: string | null }>(db, `SELECT id, key, value, (expires_at - ${NOW})::text AS expires_at FROM kay_live WHERE (id, key) IN (SELECT * FROM unnest($1::text[], $2::text[])) AND (expires_at IS NULL OR expires_at > ${NOW})`, [wanted.map(([, [id]]) => id), wanted.map(([, [, key]]) => key)])

      for (const row of rows)
        values.set(`${row.id}\0${row.key}`, { value: row.value, expiresAt: row.expires_at === null ? undefined : Date.now() + Number(row.expires_at) })
    }

    const heard = wanted.map(([at, [id, key]]): [string, string, string | undefined, number | undefined] => [unescaped(id), unescaped(key), values.get(at)?.value, values.get(at)?.expiresAt])

    // The rows an id-wide event dated, in one query; a key with a write of this process still to commit is read once that ends, and one already read above is not heard twice.
    if (whole.size > 0) {
      const rows = await query<{ id: string, key: string, value: string, expires_at: string }>(db, `SELECT id, key, value, (expires_at - ${NOW})::text AS expires_at FROM kay_live WHERE id = ANY($1::text[]) AND expires_at > ${NOW}`, [[...whole]])

      for (const row of rows) {
        const at = `${row.id}\0${row.key}`

        if (busy.has(at) || pending.has(at))
          deferred.set(at, [row.id, row.key])
        else if (!changed.has(at))
          heard.push([unescaped(row.id), unescaped(row.key), row.value, Date.now() + Number(row.expires_at)])
      }
    }

    return {
      heard,
      fresh,
      read: wanted.map(([at]) => at),
    }
  }

  const poll = async (db: SQL): Promise<'heard' | undefined> => {
    // What was set before this process first used the store is in what it reads from the store already.
    if (events.from() === undefined)
      await startAt(db)

    const read = await hear(db, events.from() ?? 0)

    for (const id of read.fresh)
      events.note(id)

    for (const at of read.read)
      deferred.delete(at)

    for (const [id, key, text, expiresAt] of read.heard) {
      for (const listener of listeners) {
        try {
          listener(id, key, text, expiresAt)
        }
        catch (error) {
          kayLog('error', `a watcher of the live value ${id} threw`, error)
        }
      }
    }

    return read.fresh.length > 0 ? 'heard' : undefined
  }

  const stop = () => {
    polling?.()
    polling = undefined
    listeners.clear()
  }

  closeWith(pg, () => {
    closed = true
    stop()
  })

  return {
    stop,
    hold(on) {
      held = on
      polling?.hold(on)
    },
    // After the writes made before it, and noting the last event before the rows are read, so a set between the two is heard.
    async entries() {
      return ordered(async () => {
        const db = await pg.db()

        if (events.from() === undefined)
          await startAt(db)

        // A row past its end is left out, though it stays in the table until the next purge.
        const rows = await query<{ id: string, key: string, value: string, expires_at: string | null }>(db, `SELECT id, key, value, (expires_at - ${NOW})::text AS expires_at FROM kay_live WHERE expires_at IS NULL OR expires_at > ${NOW}`)

        return rows.map((row): LiveEntry => row.expires_at === null ? [unescaped(row.id), unescaped(row.key), row.value] : [unescaped(row.id), unescaped(row.key), row.value, Date.now() + Number(row.expires_at)])
      })
    },
    // The end is stored on the database's clock, as the remaining time, so replicas whose clocks disagree forget a value together; the rows give it back on the reader's.
    set: async (id, key, text, expiresAt) => {
      await write('writing', id, escaped(key), async (tx) => {
        const remaining = expiresAt === undefined ? null : Math.max(0, Math.round(expiresAt - Date.now()))

        await query(tx, `INSERT INTO kay_live (id, key, value, expires_at) VALUES ($1, $2, $3, CASE WHEN $4::bigint IS NULL THEN NULL ELSE ${NOW} + $4::bigint END) ON CONFLICT (id, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`, [escaped(id), escaped(key), text, remaining])
      })

      purge()
    },
    // Only where the row has no end: a text another replica set meanwhile is kept.
    end: async (id, key, expiresAt) => write('dating', id, escaped(key), async (tx) => {
      await query(tx, `UPDATE kay_live SET expires_at = ${NOW} + $3::bigint WHERE id = $1 AND key = $2 AND expires_at IS NULL`, [escaped(id), escaped(key), Math.max(0, Math.round(expiresAt - Date.now()))])
    }),
    // One statement and one event for every row of the id still without an end.
    endAll: async (id, ttl) => write('dating', id, '', async (tx) => {
      await query(tx, `UPDATE kay_live SET expires_at = ${NOW} + $2::bigint WHERE id = $1 AND expires_at IS NULL`, [escaped(id), Math.max(0, Math.round(ttl))])
    }, WHOLE_ID + escaped(id)),
    delete: async (id, key) => write('deleting', id, escaped(key), async tx => query(tx, 'DELETE FROM kay_live WHERE id = $1 AND key = $2', [escaped(id), escaped(key)])),
    subscribe(listener) {
      listeners.add(listener)

      if (polling !== undefined || closed)
        return

      polling = pollerOf(pg).add({ every: POLL_MS, backoff: true, wanted: () => listeners.size > 0 && !closed, run: poll, failed: 'reading the live values the other processes set failed' }, false)

      if (held)
        polling.hold(true)
    },
  }
}
