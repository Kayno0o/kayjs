import type { SQL } from 'bun'
import type { Pending } from './missing-hits'
import type { MissingPath, MissingStore, Reason } from './not-found'
import type { PgSource } from './pg-jobs'
import { kayLog } from '../runtime/log'
import { FLUSH_MS, holdHit, HOUR_MS, MAX_AGE_MS, MAX_PATHS, MAX_PENDING, MAX_REFERRERS } from './missing-hits'
import { connectionOf, privilegeRefused, relationsMissing } from './pg-jobs'
import { pgRedirectSet } from './pg-redirects'
import { escaped, query } from './pg-sql'
import { onReload } from './reload'
import { MAX_RUNTIME_REDIRECTS } from './runtime-redirects'

// What replicas starting together take turns on while one creates the tables, the one `pgData` takes.
const MIGRATION_LOCK = 'kay_data'
// Serializes the writes of the log across replicas, so the eviction past `MAX_PATHS` counts what the others wrote.
const WRITE_LOCK = 'kay_missing'
const REDIRECTS_LOCK = 'kay_redirects'
// A read-only store looks again for the tables this often.
const ABSENT_MS = 1000

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
      await query(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [WRITE_LOCK])
      await query(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [REDIRECTS_LOCK])

      // The rows the tables hold stay as they are, and the old ones fill what room the limits leave, the most hit first.
      const kept = new Set((await query<{ path: string }>(tx, 'SELECT path FROM kay_missing')).map(row => row.path))
      const taken = new Set<string>()

      for (const row of [...legacy.missing].sort((a, b) => b.hits - a.hits)) {
        if (kept.has(row.path) || kept.size + taken.size >= MAX_PATHS)
          continue

        await query(tx, 'INSERT INTO kay_missing (path, hits, first_at, last_at, target, reason) VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5, $6) ON CONFLICT (path) DO NOTHING', [row.path, row.hits, row.first_at, row.last_at, row.target, row.reason])
        taken.add(row.path)
      }

      const hosts = new Map<string, number>()

      for (const row of [...legacy.referrers].sort((a, b) => b.hits - a.hits)) {
        const held = hosts.get(row.path) ?? 0

        if (!taken.has(row.path) || held >= MAX_REFERRERS)
          continue

        await query(tx, 'INSERT INTO kay_missing_referrers (path, host, hits) VALUES ($1, $2, $3::bigint) ON CONFLICT (path, host) DO NOTHING', [row.path, row.host, row.hits])
        hosts.set(row.path, held + 1)
      }

      const [stored] = await query<{ total: string }>(tx, 'SELECT COUNT(*)::text AS total FROM kay_redirects')
      let room = MAX_RUNTIME_REDIRECTS - Number(stored!.total)

      for (const row of legacy.redirects) {
        if (room <= 0)
          break

        const added = await query(tx, 'INSERT INTO kay_redirects (path, target, status, pattern, added_at) VALUES ($1, $2, $3::integer, $4::integer, $5::bigint) ON CONFLICT (path) DO NOTHING RETURNING path', [escaped(row.path), escaped(row.target), row.status, row.pattern, row.added_at])

        room -= added.length
      }
    })
  }
  finally {
    if (typeof source === 'string')
      await db.close()
  }
}

// The paths visitors found nothing at, and the redirects editors added, kept in the app's Postgres (`kay_missing`, `kay_missing_referrers` and `kay_redirects`), as the SQLite store keeps them in its file: shared by every replica, so a deploy loses nothing.
// The tables are made by the first use unless `pgData` made them, and a role that may create nothing has the owner run `createDataTables`.
// A `readOnly` store creates nothing: it answers empty while the tables are missing (looked for again every second) or the role may not read them, and counts no hit; `kay dev` and the reads of a screen use it, so only a production server that counts a 404 makes the tables.
export function pgMissingStore(source: PgSource, closedByReload = true, readOnly = false): MissingStore {
  const db = connectionOf(source)
  const pending = new Map<string, Pending>()
  let writing: Promise<void> | undefined
  let draining = false
  let ready: Promise<void> | undefined
  let absentAt: number | undefined
  let purgedAt = 0
  let timer: Timer | undefined
  // A write that failed in the background, which the next hit throws for the caller to tell of.
  let failure: unknown
  let closed = false
  let told = false

  // A failed creation is tried again by the next use rather than kept.
  const connect = async (): Promise<SQL | undefined> => {
    if (readOnly) {
      if (ready)
        return db

      if (absentAt !== undefined && Date.now() - absentAt < ABSENT_MS)
        return undefined

      if (await relationsMissing(db, NOT_FOUND_TABLE_NAMES)) {
        absentAt = Date.now()

        return undefined
      }

      absentAt = undefined
      ready = Promise.resolve()

      return db
    }

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
  const purge = async (tx: SQL, now: number): Promise<boolean> => {
    if (now - purgedAt < HOUR_MS)
      return false

    await query(tx, 'DELETE FROM kay_missing WHERE last_at < $1::bigint', [now - MAX_AGE_MS])
    await query(tx, 'DELETE FROM kay_missing_referrers WHERE path NOT IN (SELECT path FROM kay_missing)')

    return true
  }

  const record = async (batch: [string, Pending][]): Promise<void> => {
    const connected = await connect()

    if (!connected)
      return

    const now = Date.now()
    let purged = false

    await connected.begin(async (tx) => {
      await query(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [WRITE_LOCK])
      purged = await purge(tx, now)

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

    if (purged)
      purgedAt = now
  }

  // Writes what is held back, one write at a time: what is counted meanwhile waits in `pending` for the next, so a flood of paths holds one connection of the pool, not one per 256 of them.
  // A read after it sees every hit.
  const flush = async (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined

    while (pending.size > 0 || writing) {
      if (writing) {
        await writing

        continue
      }

      const batch = [...pending]

      pending.clear()
      writing = record(batch)

      try {
        await writing
      }
      finally {
        writing = undefined
      }
    }
  }

  // Runs a read after the held hits are written; `empty` is what a database without the tables, or a role that may not read them in a read-only store, holds.
  const reading = async <T>(empty: T, use: (db: SQL) => Promise<T>): Promise<T> => {
    await flush()

    const connected = await connect()

    if (!connected)
      return empty

    try {
      return await use(connected)
    }
    catch (error) {
      if (readOnly && privilegeRefused(error))
        return empty

      throw error
    }
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
  // One at a time too: the hits that arrive while it runs are written by its next round.
  const background = async (): Promise<void> => {
    if (draining)
      return

    draining = true

    try {
      await flush()
    }
    catch (error) {
      failure = error
    }
    finally {
      draining = false
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

      // Past a few batches held back (a database slower than the flood), a new path is not counted: the log keeps at most MAX_PATHS anyway.
      if (closed || readOnly || (pending.size >= MAX_PENDING * 4 && !pending.has(path)))
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
      return reading([], async (connected) => {
        const rows = await query<MissingRow>(connected, 'SELECT path, hits::text, first_at::text, last_at::text, target, reason FROM kay_missing ORDER BY hits DESC, last_at DESC')
        const hosts = await query<{ path: string, host: string, hits: string }>(connected, 'SELECT path, host, hits::text FROM kay_missing_referrers ORDER BY hits DESC, host')
        const byPath = new Map<string, MissingPath['referrers']>()

        for (const { path, host: key, hits } of hosts) {
          const slash = key.indexOf('/')

          byPath.set(path, [...byPath.get(path) ?? [], slash === -1 ? { host: key, hits: Number(hits) } : { host: key.slice(0, slash), page: key.slice(slash), hits: Number(hits) }])
        }

        return rows.map(row => ({ path: row.path, hits: Number(row.hits), firstAt: Number(row.first_at), lastAt: Number(row.last_at), target: row.target ?? undefined, reason: (row.reason ?? undefined) as Reason | undefined, referrers: byPath.get(row.path) ?? [] }))
      })
    },
    async forget(path) {
      return reading(false, async (connected) => {
        await query(connected, 'DELETE FROM kay_missing_referrers WHERE path = $1', [path])

        return (await query<{ path: string }>(connected, 'DELETE FROM kay_missing WHERE path = $1 RETURNING path', [path])).length > 0
      })
    },
    async clear() {
      return reading(0, async (connected) => {
        const [row] = await query<{ total: string }>(connected, 'WITH removed AS (DELETE FROM kay_missing RETURNING 1) SELECT COUNT(*)::text AS total FROM removed')

        await query(connected, 'DELETE FROM kay_missing_referrers WHERE path NOT IN (SELECT path FROM kay_missing)')

        return Number(row?.total ?? 0)
      })
    },
    redirects: pgRedirectSet(connect, (error) => {
      if (told)
        return

      told = true
      kayLog('warn', `the redirects added while the site runs cannot be read from the app's Postgres database: ${error instanceof Error ? error.message : String(error)}; the last ones read keep answering`)
    }, readOnly),
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
