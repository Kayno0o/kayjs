import type { ContentLoader } from 'kay/content'
import type { LoaderOptions, Row, SavedEntry } from './shared'
import { SQL } from 'bun'
import { existsError, loadedOf, placeOf, seededKey, seedEntries, tableOf } from './shared'

export type { LoaderOptions, SeedEntry } from './shared'

export interface PostgresLoaderOptions extends LoaderOptions {
  // A connection URL, or the Bun `SQL` the app already has: a pg-orm app passes `db.sql`.
  sql: string | SQL
}

// Any statement runner of Bun's SQL: the client, or a transaction's.
type Runner = Pick<SQL, 'unsafe'>

// The lock `CREATE TABLE` and the seed take, so processes starting together do not race on the table.
const LOCK = 7_624_881

// A collection's entries kept in one Postgres table of JSON entries: `collection(postgresLoader({ name: 'posts', sql: db.sql, seed }), { schema })`. The table is created, and the seed written, when the first read or save comes; a save of several entries is one transaction.
export function postgresLoader(options: PostgresLoaderOptions): ContentLoader {
  const { name, body, ttl } = options
  const table = tableOf(options.table)
  const key = seededKey(name)
  let ready: Promise<SQL> | undefined

  const open = async (): Promise<SQL> => {
    const client = typeof options.sql === 'string' ? new SQL(options.sql) : options.sql

    await client.begin(async (tx) => {
      await tx.unsafe('SELECT pg_advisory_xact_lock($1)', [LOCK])
      await tx.unsafe(`CREATE TABLE IF NOT EXISTS ${table} (collection text NOT NULL, place text NOT NULL, data jsonb NOT NULL, body text, PRIMARY KEY (collection, place))`)

      if (options.seed === undefined)
        return

      const marked = await tx.unsafe<unknown[]>(`INSERT INTO ${table} (collection, place, data) VALUES ($1, '', '{}'::jsonb) ON CONFLICT DO NOTHING RETURNING place`, [key])

      if (marked.length === 0)
        return

      for (const entry of await seedEntries(options.seed))
        await tx.unsafe(`INSERT INTO ${table} (collection, place, data, body) VALUES ($1, $2, $3::text::jsonb, $4) ON CONFLICT DO NOTHING`, [name, placeOf(entry), JSON.stringify(entry.data), entry.body ?? null])
    })

    return client
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

  const upsert = async (run: Runner, entry: SavedEntry, create: boolean) => {
    const place = placeOf(entry)
    const conflict = create ? 'DO NOTHING' : 'DO UPDATE SET data = excluded.data, body = excluded.body'
    const written = await run.unsafe<unknown[]>(`INSERT INTO ${table} (collection, place, data, body) VALUES ($1, $2, $3::text::jsonb, $4) ON CONFLICT (collection, place) ${conflict} RETURNING place`, [name, place, JSON.stringify(entry.data), entry.body ?? null])

    if (create && written.length === 0)
      throw existsError(name, place)
  }

  return {
    name,
    ...body === undefined ? {} : { body },
    ...ttl === undefined ? {} : { ttl },
    load: async () => {
      const sql = await database()

      return (await sql.unsafe<Row[]>(`SELECT place, data::text AS data, body FROM ${table} WHERE collection = $1 ORDER BY place`, [name])).map(loadedOf)
    },
    count: async () => {
      const sql = await database()
      const [row] = await sql.unsafe<{ total: number }[]>(`SELECT count(*)::int AS total FROM ${table} WHERE collection = $1`, [name])

      return row!.total
    },
    get: async (place) => {
      const sql = await database()
      const [row] = await sql.unsafe<Row[]>(`SELECT place, data::text AS data, body FROM ${table} WHERE collection = $1 AND place = $2`, [name, place])

      return row === undefined ? undefined : loadedOf(row)
    },
    save: async (entry) => {
      await upsert(await database(), entry, entry.create === true)
    },
    saveMany: async (entries) => {
      const sql = await database()

      await sql.begin(async (tx) => {
        for (const entry of entries)
          await upsert(tx, entry, false)
      })
    },
    remove: async (entry) => {
      const sql = await database()

      await sql.unsafe(`DELETE FROM ${table} WHERE collection = $1 AND place = $2`, [name, placeOf(entry)])
    },
  }
}
