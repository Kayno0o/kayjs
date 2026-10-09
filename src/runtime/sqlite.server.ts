import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

// A SQLite file several processes of the machine share, its directory created as needed, as `data/` is on a fresh checkout.
export function openSqlite(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })

  // Loaded here rather than imported, which would load it as a compiled server starts, for 0.4 MiB, whether it ever opens a file or not.
  const sqlite = process.getBuiltinModule('bun:sqlite') as typeof import('bun:sqlite')
  const db = new sqlite.Database(path, { create: true })

  db.run('PRAGMA journal_mode = WAL')
  // Another process writing waits its turn rather than failing the write.
  db.run('PRAGMA busy_timeout = 5000')

  return db
}
