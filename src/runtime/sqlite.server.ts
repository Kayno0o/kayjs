import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'

// A SQLite file several processes of the machine share, its directory created as needed, as `data/` is on a fresh checkout.
export function openSqlite(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path, { create: true })

  db.run('PRAGMA journal_mode = WAL')
  // Another process writing waits its turn rather than failing the write.
  db.run('PRAGMA busy_timeout = 5000')

  return db
}
