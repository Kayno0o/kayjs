import type { Database } from 'bun:sqlite'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

// A SQLite file several processes of the machine share, its directory created as needed, as `data/` is on a fresh checkout.
// A new file is readable by the server's user alone, as are the journal files SQLite makes beside it with its mode.
export function openSqlite(path: string): Database {
  if (path !== ':memory:' && path !== '') {
    mkdirSync(dirname(path), { recursive: true })
    closeSync(openSync(path, 'a', 0o600))
  }

  // Loaded here rather than imported, which would load it as a compiled server starts, for 0.4 MiB, whether it ever opens a file or not.
  const sqlite = process.getBuiltinModule('bun:sqlite') as typeof import('bun:sqlite')
  const db = new sqlite.Database(path, { create: true })

  // Set first, as switching to WAL needs a lock and fails at once on a file another process holds without it.
  db.run('PRAGMA busy_timeout = 5000')
  switchToWal(db)
  // A commit waits on no disk sync, only checkpoints do: under WAL a power cut may lose the last writes, never corrupt the file.
  db.run('PRAGMA synchronous = NORMAL')

  return db
}

// The switch can answer busy without waiting on the timeout, while another process opening the file at the same moment holds it, so it is tried again for as long.
function switchToWal(db: Database): void {
  const until = Date.now() + 5000

  for (;;) {
    try {
      db.run('PRAGMA journal_mode = WAL')

      return
    }
    catch (error) {
      if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() > until)
        throw error

      Bun.sleepSync(10)
    }
  }
}
