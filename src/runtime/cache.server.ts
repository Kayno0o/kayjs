import type { CacheStore } from './cache'
import { onReload } from '../server/reload'
import { trackStore, untrackStore } from './cache'
import { kayLog } from './log'
import { openSqlite } from './sqlite.server'

// How often a process reads what the others sharing a store invalidated, and how long a message is kept for one that reads late.
const POLL_MS = 500
const EVENT_TTL_MS = 60_000
// Tells this process's own messages apart from the others', whatever store instance wrote them.
const PROCESS = crypto.randomUUID()

export { invalidatePage } from '../server/revalidate'
export type { CacheOptions, CacheStore } from './cache'
export { cached, invalidate } from './cache'

// Values kept in a SQLite file: they survive restarts and deploys, and the processes on one machine share them. Each process keeps its own copy in memory, and hears within about half a second what another one's `invalidate` or `invalidatePage` dropped.
export function sqliteCache(path: string): CacheStore {
  const db = openSqlite(path)
  const polls: ReturnType<typeof setInterval>[] = []

  db.run('CREATE TABLE IF NOT EXISTS kay_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fresh_until INTEGER NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS kay_events (id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL)')

  const select = db.query<{ value: string, fresh_until: number }, [string]>('SELECT value, fresh_until FROM kay_cache WHERE key = ?')
  const upsert = db.query('INSERT INTO kay_cache (key, value, fresh_until) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, fresh_until = excluded.fresh_until')
  const remove = db.query('DELETE FROM kay_cache WHERE key = ?')
  const names = db.query<{ key: string }, []>('SELECT key FROM kay_cache')
  const insertEvent = db.query('INSERT INTO kay_events (origin, message, at) VALUES (?, ?, ?)')
  const pruneEvents = db.query('DELETE FROM kay_events WHERE at < ?')
  const lastEvent = db.query<{ id: number | null }, []>('SELECT max(id) AS id FROM kay_events')
  const eventsAfter = db.query<{ id: number, message: string }, [number, string]>('SELECT id, message FROM kay_events WHERE id > ? AND origin != ? ORDER BY id')

  const store: CacheStore = {
    get(key) {
      const row = select.get(key)

      return row ? { text: row.value, freshUntil: row.fresh_until } : undefined
    },
    set(key, text, freshUntil) {
      upsert.run(key, text, freshUntil)
    },
    delete(key) {
      remove.run(key)
    },
    keys() {
      return names.all().map(row => row.key)
    },
    publish(message) {
      insertEvent.run(PROCESS, message, Date.now())
      pruneEvents.run(Date.now() - EVENT_TTL_MS)
    },
    subscribe(listener) {
      // What was published before this process opened the store is in what it reads from the store already.
      let seen = lastEvent.get()?.id ?? 0

      const poll = setInterval(() => {
        try {
          for (const event of eventsAfter.all(seen, PROCESS)) {
            seen = event.id
            listener(event.message)
          }
        }
        catch (error) {
          kayLog('error', 'reading what the other processes invalidated failed; trying again', error)
        }
      }, POLL_MS)

      poll.unref()
      polls.push(poll)
    },
  }

  trackStore(store)
  // A reload runs the module that opened the store again, which opens its own.
  onReload(() => {
    for (const poll of polls)
      clearInterval(poll)

    untrackStore(store)
    db.close()
  })

  return store
}
