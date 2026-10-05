import type { CacheStore } from './cache'
import { Database } from 'bun:sqlite'
import { trackStore } from './cache'

export type { CacheOptions, CacheStore } from './cache'
export { cached, invalidate } from './cache'

// Values kept in a SQLite file: they survive restarts and deploys, and the processes on one machine share them. Each process still keeps its own copy in memory, so an `invalidate` in one reaches the others once their copy is past its ttl.
export function sqliteCache(path: string): CacheStore {
  const db = new Database(path, { create: true })

  db.run('PRAGMA journal_mode = WAL')
  // Another process writing waits its turn rather than failing the write.
  db.run('PRAGMA busy_timeout = 5000')
  db.run('CREATE TABLE IF NOT EXISTS kay_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fresh_until INTEGER NOT NULL)')

  const select = db.query<{ value: string, fresh_until: number }, [string]>('SELECT value, fresh_until FROM kay_cache WHERE key = ?')
  const upsert = db.query('INSERT INTO kay_cache (key, value, fresh_until) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, fresh_until = excluded.fresh_until')
  const remove = db.query('DELETE FROM kay_cache WHERE key = ?')
  const names = db.query<{ key: string }, []>('SELECT key FROM kay_cache')

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
  }

  trackStore(store)

  return store
}
