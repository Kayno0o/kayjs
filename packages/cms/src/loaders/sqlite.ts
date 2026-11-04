import type { ContentLoader } from 'kay/content'
import type { LoaderOptions, Row, SavedEntry } from './shared'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { contentFile, existsError, loadedOf, placeOf, scopeOf, seededKey, seedEntries, siblingName, swappedData, tableOf, watcher } from './shared'

export type { LoaderOptions, SeedEntry } from './shared'

export interface SqliteLoaderOptions extends LoaderOptions {
  // The database file, created with its folder when missing, or a `bun:sqlite` `Database` the app opened. The file of the app's `store: sqliteData(path)` when left out, else `data/content.sqlite`.
  database?: string | Database | undefined
}

// A collection's entries kept in one SQLite table of JSON entries: `collection(sqliteLoader({ name: 'posts', seed }), { schema })`. The table is created, and the seed written, when the first read or save comes; a save of several entries is one transaction.
export function sqliteLoader(options: SqliteLoaderOptions): ContentLoader {
  const { name, ttl } = options
  const table = tableOf(options.table)
  const key = seededKey(name)
  let opened: Database | undefined
  let ready: Promise<Database> | undefined
  // The counter table and the triggers are named after the table, quoted like it.
  const named = (suffix: string) => `"${table.slice(1, -1)}${suffix}"`
  const counter = named('_changes')
  // Triggers on the table count the writes of each collection, whoever made them, a process or the `sqlite3` tool; the signature is that count alone, so the other writes of a file shared with the app's sessions, rates and jobs cost the watcher nothing.
  const watching = watcher(name, `${scopeOf(options.database ?? 'the app\'s store')}/${table}`, options.watch, '1s', () => String(opened!.query<{ n: number }, [string]>(`SELECT n FROM ${counter} WHERE collection = ?`).get(name)?.n ?? 0))

  const bump = (collection: string, only = '') => `INSERT INTO ${counter} (collection, n) ${only === '' ? `VALUES (${collection}, 1)` : `SELECT ${collection}, 1 WHERE ${only}`} ON CONFLICT (collection) DO UPDATE SET n = n + 1`

  // A row moved to another collection counts for both. When the triggers are installed or replaced, every collection is counted once, so a watcher that read the rows earlier, and missed a write made while no trigger existed (a process of an older kay), sees a change.
  const installTriggers = (db: Database) => {
    const triggers = [
      [named('_changes_insert'), 'INSERT', bump('NEW.collection')],
      [named('_changes_change'), 'UPDATE', `${bump('NEW.collection')}; ${bump('OLD.collection', 'OLD.collection IS NOT NEW.collection')}`],
      [named('_changes_delete'), 'DELETE', bump('OLD.collection')],
    ] as const

    if (triggers.every(([trigger]) => db.query('SELECT 1 FROM sqlite_master WHERE type = \'trigger\' AND name = ?').get(trigger.slice(1, -1)) !== null))
      return

    db.transaction(() => {
      db.run(`DROP TRIGGER IF EXISTS ${named('_changes_update')}`)

      for (const [trigger, event, body] of triggers)
        db.run(`CREATE TRIGGER IF NOT EXISTS ${trigger} AFTER ${event} ON ${table} BEGIN ${body}; END`)

      db.run(`INSERT INTO ${counter} (collection, n) SELECT collection, 1 FROM ${table} GROUP BY collection ON CONFLICT (collection) DO UPDATE SET n = n + 1`)
    }).immediate()
  }

  const open = async (): Promise<Database> => {
    if (opened !== undefined)
      return opened

    const database = options.database ?? contentFile()
    const db = typeof database === 'string' ? connection(database) : database

    db.run(`CREATE TABLE IF NOT EXISTS ${table} (collection TEXT NOT NULL, place TEXT NOT NULL, data TEXT NOT NULL, body TEXT, PRIMARY KEY (collection, place))`)
    db.run(`CREATE TABLE IF NOT EXISTS ${counter} (collection TEXT PRIMARY KEY, n INTEGER NOT NULL)`)

    installTriggers(db)

    if (options.seed !== undefined && db.query(`SELECT 1 FROM ${table} WHERE collection = ?`).get(key) === null) {
      const seed = await seedEntries(options.seed)
      const write = db.transaction(() => {
        if (db.query(`INSERT INTO ${table} (collection, place, data) VALUES (?, '', '{}') ON CONFLICT DO NOTHING`).run(key).changes === 0)
          return

        const insert = db.query(`INSERT INTO ${table} (collection, place, data, body) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)

        for (const entry of seed)
          insert.run(name, placeOf(entry), JSON.stringify(entry.data), entry.body ?? null)
      })

      write()
    }

    opened = db
    await watching.start()

    return db
  }

  // A failed start is tried again by the next call.
  const database = async () => {
    ready ??= open()

    try {
      return await ready
    }
    catch (error) {
      ready = undefined

      throw error
    }
  }

  const upsert = (db: Database, entry: SavedEntry, create: boolean) => {
    const place = placeOf(entry)

    if (entry.expect !== undefined) {
      const stored = db.query<{ data: string }, [string, string]>(`SELECT data FROM ${table} WHERE collection = ? AND place = ?`).get(name, place)

      db.query(`UPDATE ${table} SET data = ? WHERE collection = ? AND place = ?`).run(swappedData(name, stored?.data, { ...entry, expect: entry.expect }), name, place)

      return
    }

    const conflict = create ? 'DO NOTHING' : 'DO UPDATE SET data = excluded.data, body = excluded.body'
    const { changes } = db.query(`INSERT INTO ${table} (collection, place, data, body) VALUES (?, ?, ?, ?) ON CONFLICT (collection, place) ${conflict}`).run(name, place, JSON.stringify(entry.data), entry.body ?? null)

    if (create && changes === 0)
      throw existsError(name, place)
  }

  return {
    name,
    ...ttl === undefined ? {} : { ttl },
    // Looked at by hand only, so no timer.
    sibling: kind => sqliteLoader({ ...options, name: siblingName(name, kind), seed: undefined, watch: false }),
    load: async () => {
      const db = await database()

      return db.query<Row, [string]>(`SELECT place, data, body FROM ${table} WHERE collection = ? ORDER BY place`).all(name).map(loadedOf)
    },
    count: async () => {
      const db = await database()

      return db.query<{ total: number }, [string]>(`SELECT count(*) AS total FROM ${table} WHERE collection = ?`).get(name)!.total
    },
    get: async (place) => {
      const db = await database()
      const row = db.query<Row, [string, string]>(`SELECT place, data, body FROM ${table} WHERE collection = ? AND place = ?`).get(name, place)

      return row === null ? undefined : loadedOf(row)
    },
    save: async (entry) => {
      const db = await database()

      upsert(db, entry, entry.create === true)
      await watching.settle()
    },
    saveMany: async (entries) => {
      const db = await database()

      // Immediate, so the read of a swapped entry and its write see no commit between them.
      db.transaction(() => {
        for (const entry of entries)
          upsert(db, entry, false)
      }).immediate()
      await watching.settle()
    },
    remove: async (entry) => {
      const db = await database()

      db.query(`DELETE FROM ${table} WHERE collection = ? AND place = ?`).run(name, placeOf(entry))
      await watching.settle()
    },
  }
}

// The databases opened from a path, one per path, so a retried start or a second collection reuses it.
const connections = new Map<string, Database>()

function connection(path: string): Database {
  let db = connections.get(path)

  if (db === undefined) {
    db = connect(path)
    connections.set(path, db)
  }

  return db
}

function connect(path: string): Database {
  if (path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path, { create: true })

  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')

  return db
}
