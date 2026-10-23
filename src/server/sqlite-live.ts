import type { LiveStore } from '../runtime/live-value'
import { existsSync } from 'node:fs'
import { PURGE_STALE_MS } from '../runtime/cache'
import { kayLog } from '../runtime/log'
import { pollLoop } from '../runtime/poll-backoff'
import { openSqlite } from '../runtime/sqlite.server'
import { onReload } from './reload'

// How often a process reads what the others set while there is activity, and how long a message is kept for one that reads late.
const POLL_MS = 500
const EVENT_TTL_MS = 60_000
// Tells this process's own messages apart from the others'.
const PROCESS = crypto.randomUUID()

function openLive(path: string) {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_live (id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (id, key))')

  // A file made before the `ttl` option gains its column.
  if (!db.query<{ name: string }, []>('PRAGMA table_info(kay_live)').all().some(column => column.name === 'expires_at')) {
    try {
      db.run('ALTER TABLE kay_live ADD COLUMN expires_at INTEGER')
    }
    catch (error) {
      // Another process opening the same old file added it between the look and here.
      if (!(error instanceof Error && error.message.includes('duplicate column')))
        throw error
    }
  }

  db.run('CREATE TABLE IF NOT EXISTS kay_live_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL)')

  db.run('CREATE INDEX IF NOT EXISTS kay_live_events_at ON kay_live_events (at)')

  const insertEvent = db.query('INSERT INTO kay_live_events (origin, id, key, at) VALUES (?, ?, ?, ?)')
  const pruneEvents = db.query('DELETE FROM kay_live_events WHERE at < ?')
  const upsert = db.query('INSERT INTO kay_live (id, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (id, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
  const dateRow = db.query('UPDATE kay_live SET expires_at = ? WHERE id = ? AND key = ? AND expires_at IS NULL')
  const remove = db.query('DELETE FROM kay_live WHERE id = ? AND key = ?')
  // The row and its message go together, so a process that heard the message finds the row.
  const write = db.transaction((run: () => void, id: string, key: string) => {
    run()
    insertEvent.run(PROCESS, id, key, Date.now())
    pruneEvents.run(Date.now() - EVENT_TTL_MS)
  })

  return {
    db,
    // A row past its end is left out, though it stays in the file until the next purge.
    all: db.query<{ id: string, key: string, value: string, expires_at: number | null }, [number]>('SELECT id, key, value, expires_at FROM kay_live WHERE expires_at IS NULL OR expires_at > ?'),
    select: db.query<{ value: string, expires_at: number | null }, [string, string, number]>('SELECT value, expires_at FROM kay_live WHERE id = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)'),
    purge: db.query('DELETE FROM kay_live WHERE expires_at < ?'),
    set: (id: string, key: string, text: string, expiresAt: number | undefined) => write(() => upsert.run(id, key, text, expiresAt ?? null), id, key),
    end: (id: string, key: string, expiresAt: number) => write(() => dateRow.run(expiresAt, id, key), id, key),
    remove: (id: string, key: string) => write(() => remove.run(id, key), id, key),
    lastEvent: db.query<{ seq: number | null }, []>('SELECT max(seq) AS seq FROM kay_live_events'),
    eventsAfter: db.query<{ seq: number, id: string, key: string }, [number, string]>('SELECT seq, id, key FROM kay_live_events WHERE seq > ? AND origin != ? ORDER BY seq'),
  }
}

// Live values kept in a SQLite file: they survive restarts and deploys, and the processes on one machine share them, a process hearing within about half a second what another one set.
// The file is created by the first value set, so a module naming the store creates nothing in a build, a check or a test.
export function sqliteLive(path: string): LiveStore {
  let opened: ReturnType<typeof openLive> | undefined
  let closed = false
  let purged = 0
  // The last event before the rows were read, so a set between the two is heard.
  let before: number | undefined
  const polls: ReturnType<typeof pollLoop>[] = []
  const open = (create: boolean) => {
    if (closed)
      throw new Error('kay: the live values store was closed')

    if (opened === undefined && (create || existsSync(path)))
      opened = openLive(path)

    return opened
  }

  const stop = () => {
    for (const poll of polls)
      poll.stop()

    polls.length = 0
  }

  onReload(() => {
    closed = true
    stop()
    opened?.db.close()
  })

  let held = false
  const wake = () => {
    for (const poll of polls)
      poll.wake()
  }

  return {
    stop,
    hold(on) {
      held = on

      for (const poll of polls)
        poll.hold(on)
    },
    entries() {
      const live = open(false)

      before = live?.lastEvent.get()?.seq ?? 0

      return live?.all.all(Date.now()).map(row => row.expires_at === null ? [row.id, row.key, row.value] : [row.id, row.key, row.value, row.expires_at]) ?? []
    },
    set(id, key, text, expiresAt) {
      wake()

      const live = open(true)!
      const now = Date.now()

      if (now - purged > PURGE_STALE_MS) {
        purged = now
        live.purge.run(now)
      }

      return live.set(id, key, text, expiresAt)
    },
    end(id, key, expiresAt) {
      wake()

      return open(false)?.end(id, key, expiresAt)
    },
    delete(id, key) {
      wake()

      return open(false)?.remove(id, key)
    },
    subscribe(listener) {
      // What was set before this process opened a file that exists is in what it read from the store already.
      let seen = before ?? open(false)?.lastEvent.get()?.seq ?? 0

      const poll = pollLoop(POLL_MS, () => {
        const heard: [id: string, key: string, text: string | undefined, expiresAt: number | undefined][] = []

        try {
          const live = open(false)

          // `seen` moves only once every event is read, so a read failing part way starts again from the old one.
          let last = seen

          for (const event of live?.eventsAfter.all(seen, PROCESS) ?? []) {
            const row = live!.select.get(event.id, event.key, Date.now())

            heard.push([event.id, event.key, row?.value, row?.expires_at ?? undefined])
            last = event.seq
          }

          seen = last
        }
        catch (error) {
          kayLog('error', 'reading the live values the other processes set failed; trying again', error)

          return false
        }

        for (const [id, key, text, expiresAt] of heard) {
          try {
            listener(id, key, text, expiresAt)
          }
          catch (error) {
            kayLog('error', `a watcher of the live value ${id} threw`, error)
          }
        }

        return heard.length > 0
      })

      poll.hold(held)
      polls.push(poll)
    },
  }
}
