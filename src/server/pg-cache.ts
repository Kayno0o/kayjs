import type { CacheStore } from '../runtime/cache'
import type { PgHandle } from './pg-data'
import { DEPS_PREFIX, readsOf, trackStore, untrackStore } from '../runtime/cache'
import { kayLog } from '../runtime/log'
import { rowsOf } from './pg-jobs'
import { NOW } from './pg-sql'
import { onReload } from './reload'

// How often a process reads what the others sharing a store invalidated, and how long a message is kept for one that reads late.
const POLL_MS = 500
const EVENT_TTL_MS = 60_000
// Tells this process's own messages apart from the others', whatever store instance wrote them.
const PROCESS = crypto.randomUUID()
// Ids this far behind the last one read are read again, as a transaction that began earlier may commit its event after a later one.
const OVERLAP = 100

// Values kept in Postgres: they survive restarts and deploys, and every replica shares them. Each process keeps its own copy in memory, and hears within about half a second what another one's `invalidate` or `invalidatePage` dropped.
// Every call answers with a promise, so `invalidate` drops the stored rows in the background, and a read right after it waits for that.
export function pgCache(pg: PgHandle): CacheStore {
  const listeners: ((message: string) => void)[] = []
  // The writes still running, which a listing of the keys waits for so an `invalidate` never misses a row being written.
  const writing = new Set<Promise<unknown>>()
  let poller: ReturnType<typeof setInterval> | undefined
  let seen: number | undefined
  const recent = new Set<number>()
  let polling = false
  // A streak of failed reads logs once, as the poll runs twice a second.
  let failing = false
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

  const poll = async () => {
    if (polling || listeners.length === 0)
      return

    polling = true

    try {
      const db = await pg.db()

      if (seen === undefined) {
        // What was published before this process first used the store is in what it reads from the store already.
        const [last] = await rowsOf<{ id: string | null }>(db`SELECT max(id)::text AS id FROM kay_events`)

        seen = Number(last?.id ?? 0)

        return
      }

      for (const event of await rowsOf<{ id: string, message: string }>(db`SELECT id::text, message FROM kay_events WHERE id > ${seen - OVERLAP}::bigint AND origin != ${PROCESS} ORDER BY id`)) {
        const id = Number(event.id)

        if (recent.has(id))
          continue

        recent.add(id)
        seen = Math.max(seen, id)

        for (const listener of listeners)
          listener(event.message)
      }

      for (const id of recent) {
        if (id <= seen - OVERLAP)
          recent.delete(id)
      }

      failing = false
    }
    catch (error) {
      if (!failing)
        kayLog('error', 'reading what the other processes invalidated failed; trying again', error)

      failing = true
    }
    finally {
      polling = false
    }
  }

  // Started by the first call that needs the database, so only an app that reads, writes or invalidates a value connects.
  const start = () => {
    if (poller !== undefined || closed)
      return

    poller = setInterval(() => void poll(), POLL_MS)
    poller.unref()
    void poll()
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
    clearInterval(poller)
    untrackStore(store)
  })

  return store
}
