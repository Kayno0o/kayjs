import type { LiveStore } from '../runtime/live-value'
import { existsSync } from 'node:fs'
import { kayLog } from '../runtime/log'
import { openSqlite } from '../runtime/sqlite.server'
import { onReload } from './reload'

// How often a process reads what the others set, and how long a message is kept for one that reads late.
const POLL_MS = 500
const EVENT_TTL_MS = 60_000
// Tells this process's own messages apart from the others'.
const PROCESS = crypto.randomUUID()

function openLive(path: string) {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_live (id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (id, key))')
  db.run('CREATE TABLE IF NOT EXISTS kay_live_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL)')

  db.run('CREATE INDEX IF NOT EXISTS kay_live_events_at ON kay_live_events (at)')

  const insertEvent = db.query('INSERT INTO kay_live_events (origin, id, key, at) VALUES (?, ?, ?, ?)')
  const pruneEvents = db.query('DELETE FROM kay_live_events WHERE at < ?')
  const upsert = db.query('INSERT INTO kay_live (id, key, value) VALUES (?, ?, ?) ON CONFLICT (id, key) DO UPDATE SET value = excluded.value')
  const remove = db.query('DELETE FROM kay_live WHERE id = ? AND key = ?')
  // The row and its message go together, so a process that heard the message finds the row.
  const write = db.transaction((run: () => void, id: string, key: string) => {
    run()
    insertEvent.run(PROCESS, id, key, Date.now())
    pruneEvents.run(Date.now() - EVENT_TTL_MS)
  })

  return {
    db,
    all: db.query<{ id: string, key: string, value: string }, []>('SELECT id, key, value FROM kay_live'),
    select: db.query<{ value: string }, [string, string]>('SELECT value FROM kay_live WHERE id = ? AND key = ?'),
    set: (id: string, key: string, text: string) => write(() => upsert.run(id, key, text), id, key),
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
  // The last event before the rows were read, so a set between the two is heard.
  let before: number | undefined
  const polls: ReturnType<typeof setInterval>[] = []
  const open = (create: boolean) => {
    if (closed)
      throw new Error('kay: the live values store was closed')

    if (opened === undefined && (create || existsSync(path)))
      opened = openLive(path)

    return opened
  }

  onReload(() => {
    closed = true

    for (const poll of polls)
      clearInterval(poll)

    opened?.db.close()
  })

  return {
    entries() {
      const live = open(false)

      before = live?.lastEvent.get()?.seq ?? 0

      return live?.all.all().map(row => [row.id, row.key, row.value]) ?? []
    },
    set: (id, key, text) => open(true)!.set(id, key, text),
    delete: (id, key) => open(false)?.remove(id, key),
    subscribe(listener) {
      // What was set before this process opened a file that exists is in what it read from the store already.
      let seen = before ?? open(false)?.lastEvent.get()?.seq ?? 0

      const poll = setInterval(() => {
        try {
          const live = open(false)

          for (const event of live?.eventsAfter.all(seen, PROCESS) ?? []) {
            seen = event.seq
            listener(event.id, event.key, live!.select.get(event.id, event.key)?.value)
          }
        }
        catch (error) {
          kayLog('error', 'reading the live values the other processes set failed; trying again', error)
        }
      }, POLL_MS)

      poll.unref()
      polls.push(poll)
    },
  }
}
