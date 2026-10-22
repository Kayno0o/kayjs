import type { SQL } from 'bun'
import type { CacheStore } from '../runtime/cache'
import type { PgHandle } from './pg-data'
import { DEPS_PREFIX, readsOf, trackStore, untrackStore } from '../runtime/cache'
import { rowsOf } from './pg-jobs'
import { EVENT_TTL_MS, eventWindow, POLL_MS, pollerOf } from './pg-poll'
import { NOW } from './pg-sql'
import { onReload } from './reload'

// Tells this process's own messages apart from the others', whatever store instance wrote them.
const PROCESS = crypto.randomUUID()

// Values kept in Postgres: they survive restarts and deploys, and every replica shares them. Each process keeps its own copy in memory, and hears within about half a second what another one's `invalidate` or `invalidatePage` dropped.
// Every call answers with a promise, so `invalidate` drops the stored rows in the background, and a read right after it waits for that.
export function pgCache(pg: PgHandle): CacheStore {
  const listeners: ((message: string) => void)[] = []
  // The writes still running, which a listing of the keys waits for so an `invalidate` never misses a row being written.
  const writing = new Set<Promise<unknown>>()
  let stopPolling: (() => void) | undefined
  const events = eventWindow()
  let closed = false

  const write = async <Result>(work: Promise<Result>): Promise<Result> => {
    writing.add(work)

    try {
      return await work
    }
    finally {
      writing.delete(work)
    }
  }

  const poll = async (db: SQL) => {
    const from = events.from()

    if (from === undefined) {
      // What was published before this process first used the store is in what it reads from the store already.
      const [last] = await rowsOf<{ id: string | null }>(db`SELECT max(id)::text AS id FROM kay_events`)

      events.start([Number(last?.id ?? 0)])

      return
    }

    // Ordered by the table column: a bare `id` is the text of the select list, where '100' sorts before '99'.
    for (const event of await rowsOf<{ id: string, message: string }>(db`SELECT id::text, message FROM kay_events WHERE id > ${from}::bigint AND origin != ${PROCESS} ORDER BY kay_events.id`)) {
      const id = Number(event.id)

      if (events.has(id))
        continue

      events.note(id)

      for (const listener of listeners)
        listener(event.message)
    }
  }

  // Started by the first call that needs the database, so only an app that reads, writes or invalidates a value connects.
  const start = () => {
    if (stopPolling !== undefined || closed)
      return

    stopPolling = pollerOf(pg).add({ every: POLL_MS, wanted: () => listeners.length > 0, run: poll, failed: 'reading what the other processes invalidated failed' }, true)
  }

  const store: CacheStore = {
    async get(key) {
      start()

      const db = await pg.db()
      const [row] = await rowsOf<{ value: string, fresh_until: string }>(db`SELECT value, fresh_until FROM kay_cache WHERE key = ${key}`)

      return row ? { text: row.value, freshUntil: Number(row.fresh_until) } : undefined
    },
    // Registered with `write` before the connection is reached, so a listing of the keys right after waits for it.
    async set(key, text, freshUntil) {
      start()

      const end = text.startsWith(DEPS_PREFIX) ? text.indexOf('\n') : -1
      const reads = end > 0 ? text.slice(DEPS_PREFIX.length, end) : null

      await write((async () => {
        const db = await pg.db()

        await rowsOf(db`INSERT INTO kay_cache (key, value, fresh_until, reads) VALUES (${key}, ${text}, ${Math.round(freshUntil)}::bigint, ${reads}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, fresh_until = excluded.fresh_until, reads = excluded.reads`)
      })())
    },
    async delete(key) {
      await write((async () => {
        const db = await pg.db()

        await rowsOf(db`DELETE FROM kay_cache WHERE key = ${key}`)
      })())
    },
    async dependencies() {
      const db = await pg.db()
      const rows = await rowsOf<{ key: string, reads: string }>(db`SELECT key, reads FROM kay_cache WHERE reads IS NOT NULL`)

      return new Map(rows.map(row => [row.key, readsOf(row.reads)]))
    },
    async keys() {
      start()
      await Promise.all(writing)

      const db = await pg.db()

      return (await rowsOf<{ key: string }>(db`SELECT key FROM kay_cache`)).map(row => row.key)
    },
    async publish(message) {
      start()

      const db = await pg.db()

      await rowsOf(db.unsafe(`INSERT INTO kay_events (origin, message, at) VALUES ($1, $2, ${NOW})`, [PROCESS, message]))
      await rowsOf(db.unsafe(`DELETE FROM kay_events WHERE at < ${NOW} - ${EVENT_TTL_MS}`))
    },
    subscribe(listener) {
      listeners.push(listener)
    },
  }

  trackStore(store)
  // A reload ends the polling for the module that named the store; the module running again names a store of its own.
  onReload(() => {
    closed = true
    stopPolling?.()
    untrackStore(store)
  })

  return store
}
