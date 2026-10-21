import type { ContentLoader } from 'kay/content'
import type { LoaderOptions, Row, SavedEntry } from './shared'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { existsError, loadedOf, placeOf, scopeOf, seededKey, seedEntries, siblingName, tableOf, watcher } from './shared'

export type { LoaderOptions, SeedEntry } from './shared'

export interface SqliteLoaderOptions extends LoaderOptions {
  // The database file, created with its folder when missing, or a `bun:sqlite` `Database` the app opened.
  database: string | Database
}

// A collection's entries kept in one SQLite table of JSON entries: `collection(sqliteLoader({ name: 'posts', database: 'data/content.db', seed }), { schema })`. The table is created, and the seed written, when the first read or save comes; a save of several entries is one transaction.
export function sqliteLoader(options: SqliteLoaderOptions): ContentLoader {
  const { name, ttl } = options
  const table = tableOf(options.table)
  const key = seededKey(name)
  let opened: Database | undefined
  let ready: Promise<Database> | undefined
  // `data_version` moves when another connection committed, a process or the `sqlite3` tool, in any table of the file; the collection's rows are read and hashed only then, so a write to another collection or table invalidates nothing.
  let version: number | undefined
  let fingerprint = ''
  const watching = watcher(name, `${scopeOf(options.database)}/${table}`, options.watch, '1s', (force) => {
    const now = opened!.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version

    if (force || now !== version) {
      version = now
      fingerprint = String(Bun.hash(opened!.query<Row, [string]>(`SELECT place, data, body FROM ${table} WHERE collection = ? ORDER BY place`).all(name).map(row => `${row.place}\u0000${row.data}\u0000${row.body ?? ''}`).join('\u0001')))
    }

    return fingerprint
  })

  const open = async (): Promise<Database> => {
    if (opened !== undefined)
      return opened

    const { database } = options
    const db = typeof database === 'string' ? connection(database) : database

    db.run(`CREATE TABLE IF NOT EXISTS ${table} (collection TEXT NOT NULL, place TEXT NOT NULL, data TEXT NOT NULL, body TEXT, PRIMARY KEY (collection, place))`)

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

      db.transaction(() => {
        for (const entry of entries)
          upsert(db, entry, false)
      })()
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
