import type { SQL } from 'bun'
import type { Pending } from './missing-hits'
import type { MissingPath, MissingStore, Reason } from './not-found'
import type { PgSource } from './pg-jobs'
import { FLUSH_MS, holdHit, HOUR_MS, MAX_AGE_MS, MAX_PATHS, MAX_PENDING, MAX_REFERRERS } from './missing-hits'
import { connectionOf, privilegeRefused, relationsMissing } from './pg-jobs'
import { pgRedirectSet } from './pg-redirects'
import { query } from './pg-sql'
import { onReload } from './reload'

// What replicas starting together take turns on while one creates the tables, the one `pgData` takes.
const MIGRATION_LOCK = 'kay_data'
// Serializes the writes of the log across replicas, so the eviction past `MAX_PATHS` counts what the others wrote.
const WRITE_LOCK = 'kay_missing'

export const NOT_FOUND_TABLE_NAMES = ['kay_missing', 'kay_missing_referrers', 'kay_redirects'] as const

export const NOT_FOUND_TABLES = [
  'CREATE TABLE IF NOT EXISTS kay_missing (path text PRIMARY KEY, hits bigint NOT NULL, first_at bigint NOT NULL, last_at bigint NOT NULL, target text, reason text)',
  'CREATE TABLE IF NOT EXISTS kay_missing_referrers (path text NOT NULL, host text NOT NULL, hits bigint NOT NULL, PRIMARY KEY (path, host))',
  'CREATE TABLE IF NOT EXISTS kay_redirects (path text PRIMARY KEY, target text NOT NULL, status integer NOT NULL, pattern integer NOT NULL, added_at bigint NOT NULL)',
] as const

interface MissingRow { path: string, hits: string, first_at: string, last_at: string, target: string | null, reason: string | null }

async function createNotFoundTables(db: SQL): Promise<void> {
  await db.begin(async (tx) => {
    await query(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK])

    for (const statement of NOT_FOUND_TABLES)
      await tx.unsafe(statement)
  })
}

// Creates the tables unless they exist: a role that may create nothing is told to have the owner run `createDataTables`.
async function ensureTables(db: SQL): Promise<void> {
  if (!await relationsMissing(db, NOT_FOUND_TABLE_NAMES))
    return

  try {
    await createNotFoundTables(db)
  }
  catch (error) {
    if (privilegeRefused(error))
      throw new Error('kay: the 404 log needs the tables kay_missing, kay_missing_referrers and kay_redirects, and the role may not create them: run `await createDataTables(db)` from kay/server as the database\'s owner, and list `dataTableNames` from kay/server in pg-orm\'s `ignoreTables`', { cause: error })

    throw error
  }
}

// What a `data/not-found.sqlite` held, for a Postgres store to take over.
export interface LegacyRows {
  missing: { path: string, hits: number, first_at: number, last_at: number, target: string | null, reason: string | null }[]
  referrers: { path: string, host: string, hits: number }[]
  redirects: { path: string, target: string, status: number, pattern: number, added_at: number }[]
}

// Adds the rows of an old local log to the tables, leaving what the tables hold as it is.
export async function importNotFoundRows(source: PgSource, legacy: LegacyRows): Promise<void> {
  const db = connectionOf(source)

  try {
    await ensureTables(db)

    await db.begin(async (tx) => {
      for (const row of legacy.missing)
        await query(tx, 'INSERT INTO kay_missing (path, hits, first_at, last_at, target, reason) VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5, $6) ON CONFLICT (path) DO NOTHING', [row.path, row.hits, row.first_at, row.last_at, row.target, row.reason])

      for (const row of legacy.referrers)
        await query(tx, 'INSERT INTO kay_missing_referrers (path, host, hits) VALUES ($1, $2, $3::bigint) ON CONFLICT (path, host) DO NOTHING', [row.path, row.host, row.hits])

      for (const row of legacy.redirects)
        await query(tx, 'INSERT INTO kay_redirects (path, target, status, pattern, added_at) VALUES ($1, $2, $3::integer, $4::integer, $5::bigint) ON CONFLICT (path) DO NOTHING', [row.path, row.target, row.status, row.pattern, row.added_at])
    })
  }
  finally {
    if (typeof source === 'string')
      await db.close()
  }
}

// The paths visitors found nothing at, and the redirects editors added, kept in the app's Postgres (`kay_missing`, `kay_missing_referrers` and `kay_redirects`), as the SQLite store keeps them in its file: shared by every replica, so a deploy loses nothing.
// The tables are made by the first use unless `pgData` made them, and a role that may create nothing has the owner run `createDataTables`.
export function pgMissingStore(source: PgSource, closedByReload = true): MissingStore {
  const db = connectionOf(source)
  const pending = new Map<string, Pending>()
  const inflight = new Set<Promise<void>>()
  let ready: Promise<void> | undefined
  let purgedAt = 0
  let timer: Timer | undefined
  // A write that failed in the background, which the next hit throws for the caller to tell of.
  let failure: unknown
  let closed = false

  // A failed creation is tried again by the next use rather than kept.
  const connect = async (): Promise<SQL> => {
    ready ??= ensureTables(db)

    try {
      await ready
    }
    catch (error) {
      ready = undefined

      throw error
    }

    return db
  }

  // At most once an hour, and on the first write, so a site nobody mistypes a URL of keeps nothing old and one that gets many hits pays one delete.
  const purge = async (tx: SQL, now: number): Promise<void> => {
    if (now - purgedAt < HOUR_MS)
      return

    purgedAt = now
    await query(tx, 'DELETE FROM kay_missing WHERE last_at < $1::bigint', [now - MAX_AGE_MS])
    await query(tx, 'DELETE FROM kay_missing_referrers WHERE path NOT IN (SELECT path FROM kay_missing)')
  }

  const record = async (batch: [string, Pending][]): Promise<void> => {
    const connected = await connect()

    await connected.begin(async (tx) => {
      await query(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [WRITE_LOCK])
      await purge(tx, Date.now())

      for (const [path, { hits: seen, firstAt, lastAt, referrers, suggest }] of batch) {
        const [known] = await query<{ hits: string }>(tx, 'SELECT hits::text FROM kay_missing WHERE path = $1', [path])
        const [total] = known ? [] : await query<{ total: string }>(tx, 'SELECT COUNT(*)::text AS total FROM kay_missing')

        if (total !== undefined && Number(total.total) >= MAX_PATHS) {
          const [evicted] = await query<{ path: string }>(tx, 'DELETE FROM kay_missing WHERE path = (SELECT path FROM kay_missing ORDER BY hits, last_at LIMIT 1) RETURNING path')

          if (evicted)
            await query(tx, 'DELETE FROM kay_missing_referrers WHERE path = $1', [evicted.path])
        }

        const [bumped] = await query<{ hits: string, target: string | null }>(tx, 'INSERT INTO kay_missing (path, hits, first_at, last_at) VALUES ($1, $4::bigint, $2::bigint, $3::bigint) ON CONFLICT (path) DO UPDATE SET hits = kay_missing.hits + $4::bigint, last_at = $3::bigint RETURNING hits::text, target', [path, firstAt, lastAt, seen])
        const hits = Number(bumped!.hits)

        // A single hit may be a typo or a scanner's guess, so only a path asked for twice is worth the matching.
        if (hits >= 2 && hits - seen < 2 && bumped!.target === null) {
          const found = suggest(path)

          if (found)
            await query(tx, 'UPDATE kay_missing SET target = $2, reason = $3 WHERE path = $1', [path, found.target, found.reason])
        }

        for (const [host, more] of referrers) {
          const [stored] = await query<{ hits: string }>(tx, 'SELECT hits::text FROM kay_missing_referrers WHERE path = $1 AND host = $2', [path, host])
          const [many] = stored ? [] : await query<{ total: string }>(tx, 'SELECT COUNT(*)::text AS total FROM kay_missing_referrers WHERE path = $1', [path])

          if (stored || Number(many!.total) < MAX_REFERRERS)
            await query(tx, 'INSERT INTO kay_missing_referrers (path, host, hits) VALUES ($1, $2, $3::bigint) ON CONFLICT (path, host) DO UPDATE SET hits = kay_missing_referrers.hits + $3::bigint', [path, host, more])
        }
      }
    })
  }

  // Writes what is held back, and waits for the writes already under way, so a read after it sees every hit.
  const flush = async (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined

    if (pending.size > 0) {
      const batch = [...pending]

      pending.clear()

      const writing = record(batch)

      inflight.add(writing)

      try {
        await writing
      }
      finally {
        inflight.delete(writing)
      }
    }

    await Promise.all(inflight)
  }

  const settle = async (): Promise<void> => {
    closed = true

    try {
      await flush()
    }
    catch {
      // The held hits go with the connection.
    }

    if (typeof source === 'string')
      await db.close()
  }

  // Writes in the background, a failure being thrown by the next hit.
  const background = async (): Promise<void> => {
    try {
      await flush()
    }
    catch (error) {
      failure = error
    }
  }

  // A reload runs the module that opened the store again, which opens its own.
  if (closedByReload)
    onReload(settle)

  return {
    hit(path, referrer, suggest) {
      if (failure !== undefined) {
        const error = failure

        failure = undefined
        pending.clear()

        throw error
      }

      if (closed)
        return

      holdHit(pending, path, referrer, suggest)

      if (pending.size >= MAX_PENDING) {
        void background()
      }
      else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          void background()
        }, FLUSH_MS)

        timer.unref()
      }
    },
    async list() {
      await flush()

      const connected = await connect()
      const rows = await query<MissingRow>(connected, 'SELECT path, hits::text, first_at::text, last_at::text, target, reason FROM kay_missing ORDER BY hits DESC, last_at DESC')
      const hosts = await query<{ path: string, host: string, hits: string }>(connected, 'SELECT path, host, hits::text FROM kay_missing_referrers ORDER BY hits DESC, host')
      const byPath = new Map<string, MissingPath['referrers']>()

      for (const { path, host: key, hits } of hosts) {
        const slash = key.indexOf('/')

        byPath.set(path, [...byPath.get(path) ?? [], slash === -1 ? { host: key, hits: Number(hits) } : { host: key.slice(0, slash), page: key.slice(slash), hits: Number(hits) }])
      }

      return rows.map(row => ({ path: row.path, hits: Number(row.hits), firstAt: Number(row.first_at), lastAt: Number(row.last_at), target: row.target ?? undefined, reason: (row.reason ?? undefined) as Reason | undefined, referrers: byPath.get(row.path) ?? [] }))
    },
    async forget(path) {
      await flush()

      const connected = await connect()

      await query(connected, 'DELETE FROM kay_missing_referrers WHERE path = $1', [path])

      return (await query<{ path: string }>(connected, 'DELETE FROM kay_missing WHERE path = $1 RETURNING path', [path])).length > 0
    },
    async clear() {
      await flush()

      const connected = await connect()
      const [row] = await query<{ total: string }>(connected, 'WITH removed AS (DELETE FROM kay_missing RETURNING 1) SELECT COUNT(*)::text AS total FROM removed')

      await query(connected, 'DELETE FROM kay_missing_referrers WHERE path NOT IN (SELECT path FROM kay_missing)')

      return Number(row?.total ?? 0)
    },
    redirects: pgRedirectSet(connect),
    close: settle,
  }
}

// Whether the database already holds the log's tables, which a read that must create nothing asks first.
export async function notFoundTablesExist(source: PgSource): Promise<boolean> {
  const db = connectionOf(source)

  try {
    return !await relationsMissing(db, NOT_FOUND_TABLE_NAMES)
  }
  finally {
    if (typeof source === 'string')
      await db.close()
  }
}
