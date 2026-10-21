import type { ContentLoader } from 'kay/content'
import type { LoaderOptions, Row, SavedEntry } from './shared'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { existsError, loadedOf, placeOf, seededKey, seedEntries, tableOf } from './shared'

export type { LoaderOptions, SeedEntry } from './shared'

export interface SqliteLoaderOptions extends LoaderOptions {
  // The database file, created with its folder when missing, or a `bun:sqlite` `Database` the app opened.
  database: string | Database
}

// A collection's entries kept in one SQLite table of JSON entries: `collection(sqliteLoader({ name: 'posts', database: 'data/content.db', seed }), { schema })`. The table is created, and the seed written, when the first read or save comes; a save of several entries is one transaction.
export function sqliteLoader(options: SqliteLoaderOptions): ContentLoader {
  const { name, body, ttl } = options
  const table = tableOf(options.table)
  const key = seededKey(name)
  let opened: Database | undefined
  let ready: Promise<Database> | undefined

  const open = async (): Promise<Database> => {
    if (opened !== undefined)
      return opened

    const { database } = options
    const db = typeof database === 'string' ? connect(database) : database

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
    ...body === undefined ? {} : { body },
    ...ttl === undefined ? {} : { ttl },
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
    },
    saveMany: async (entries) => {
      const db = await database()

      db.transaction(() => {
        for (const entry of entries)
          upsert(db, entry, false)
      })()
    },
    remove: async (entry) => {
      const db = await database()

      db.query(`DELETE FROM ${table} WHERE collection = ? AND place = ?`).run(name, placeOf(entry))
    },
  }
}

function connect(path: string): Database {
  if (path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path, { create: true })

  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')

  return db
}
