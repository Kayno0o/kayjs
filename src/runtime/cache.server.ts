import type { CacheStore } from './cache'
import { existsSync } from 'node:fs'
import { onReload } from '../server/reload'
import { ALL_READS, trackStore, untrackStore } from './cache'
import { kayLog } from './log'
import { openSqlite } from './sqlite.server'

// How often a process reads what the others sharing a store invalidated, and how long a message is kept for one that reads late.
const POLL_MS = 500
const EVENT_TTL_MS = 60_000
// Tells this process's own messages apart from the others', whatever store instance wrote them.
const PROCESS = crypto.randomUUID()

export { invalidatePage } from '../server/stale-pages'
export type { CachedFunction, CacheFunctionOptions, CacheOptions, CacheStore, CacheTag } from './cache'
export { cache, cached, cacheTag, invalidate } from './cache'

// The keys a stored line names, or every key when it does not parse, which no invalidation then misses.
function readsOf(line: string): string[] {
  try {
    return JSON.parse(line) as string[]
  }
  catch {
    return [ALL_READS]
  }
}

// The file with its tables, triggers and statements ready.
function openCache(path: string) {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fresh_until INTEGER NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS kay_events (id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL)')

  // The keys each value was built from live in a table of their own, so an invalidation reads those and not the values. Triggers keep it in step with whichever process writes the rows, one of an older version included.
  const hadDeps = db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'kay_cache_deps\'').get() !== null
  const reads = (row: string) => `substr(${row}.value, 7, instr(${row}.value, char(10)) - 7)`
  const built = (row: string) => `${row}.value LIKE '#deps %' AND instr(${row}.value, char(10)) > 0`

  db.run('CREATE TABLE IF NOT EXISTS kay_cache_deps (key TEXT PRIMARY KEY, reads TEXT NOT NULL)')

  for (const event of ['INSERT', 'UPDATE'])
    db.run(`CREATE TRIGGER IF NOT EXISTS kay_cache_deps_${event.toLowerCase()} AFTER ${event} ON kay_cache BEGIN DELETE FROM kay_cache_deps WHERE key = NEW.key; INSERT INTO kay_cache_deps SELECT NEW.key, ${reads('NEW')} WHERE ${built('NEW')}; END`)

  db.run('CREATE TRIGGER IF NOT EXISTS kay_cache_deps_delete AFTER DELETE ON kay_cache BEGIN DELETE FROM kay_cache_deps WHERE key = OLD.key; END')

  // Rows an older version wrote have their keys in the value alone.
  if (!hadDeps)
    db.run(`INSERT OR REPLACE INTO kay_cache_deps SELECT key, ${reads('kay_cache')} FROM kay_cache WHERE ${built('kay_cache')}`)

  return {
    db,
    select: db.query<{ value: string, fresh_until: number }, [string]>('SELECT value, fresh_until FROM kay_cache WHERE key = ?'),
    upsert: db.query('INSERT INTO kay_cache (key, value, fresh_until) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, fresh_until = excluded.fresh_until'),
    remove: db.query('DELETE FROM kay_cache WHERE key = ?'),
    names: db.query<{ key: string }, []>('SELECT key FROM kay_cache'),
    allDeps: db.query<{ key: string, reads: string }, []>('SELECT key, reads FROM kay_cache_deps'),
    insertEvent: db.query('INSERT INTO kay_events (origin, message, at) VALUES (?, ?, ?)'),
    pruneEvents: db.query('DELETE FROM kay_events WHERE at < ?'),
    lastEvent: db.query<{ id: number | null }, []>('SELECT max(id) AS id FROM kay_events'),
    eventsAfter: db.query<{ id: number, message: string }, [number, string]>('SELECT id, message FROM kay_events WHERE id > ? AND origin != ? ORDER BY id'),
  }
}

// Values kept in a SQLite file: they survive restarts and deploys, and the processes on one machine share them. Each process keeps its own copy in memory, and hears within about half a second what another one's `invalidate` or `invalidatePage` dropped.
// The file is created by the first value set or invalidation published, so a module naming the store creates nothing in a build, a check or a test: a read opens a file that exists and finds nothing in one that does not.
export function sqliteCache(path: string): CacheStore {
  let opened: ReturnType<typeof openCache> | undefined
  let closed = false
  const polls: ReturnType<typeof setInterval>[] = []
  const open = (create: boolean) => {
    if (closed)
      throw new Error('kay: the cache store was closed')

    if (opened === undefined && (create || existsSync(path)))
      opened = openCache(path)

    return opened
  }

  const store: CacheStore = {
    get(key) {
      const row = open(false)?.select.get(key)

      return row ? { text: row.value, freshUntil: row.fresh_until } : undefined
    },
    set(key, text, freshUntil) {
      open(true)!.upsert.run(key, text, freshUntil)
    },
    delete(key) {
      open(false)?.remove.run(key)
    },
    dependencies() {
      return new Map(open(false)?.allDeps.all().map(row => [row.key, readsOf(row.reads)]))
    },
    keys() {
      return open(false)?.names.all().map(row => row.key) ?? []
    },
    publish(message) {
      const { insertEvent, pruneEvents } = open(true)!

      insertEvent.run(PROCESS, message, Date.now())
      pruneEvents.run(Date.now() - EVENT_TTL_MS)
    },
    subscribe(listener) {
      // What was published before this process opened a file that exists is in what it reads from the store already; a file made later, by this process or another, holds only what came after.
      let seen = open(false)?.lastEvent.get()?.id ?? 0

      const poll = setInterval(() => {
        try {
          for (const event of open(false)?.eventsAfter.all(seen, PROCESS) ?? []) {
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
  // A reload closes the file for the module that named the store, whichever module first used it; the module running again names a store of its own.
  onReload(() => {
    closed = true

    for (const poll of polls)
      clearInterval(poll)

    untrackStore(store)
    opened?.db.close()
  })

  return store
}
