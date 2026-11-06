import type { SQL } from 'bun'
import type { RedirectSet, RedirectSnapshot, RuntimeRedirect, RuntimeRules, RuntimeStatus } from './runtime-redirects'
import { privilegeRefused } from './pg-jobs'
import { escaped, query, unescaped } from './pg-sql'
import { check, encoded, entry, isPattern, MAX_RUNTIME_REDIRECTS, plainPath, RedirectRefusedError, snapshotOf } from './runtime-redirects'

const COLUMNS = 'path, target, status, added_at::text AS added_at'
const LOCK = 'kay_redirects'
// The stored redirects are read again at most this often by the lookups of missing paths, so a flood of them costs one query a second, and a redirect another replica added is answered within it.
const SNAPSHOT_MS = 1000
// A read of the redirects that takes longer is left running, and the lookups answer with the last ones read (none before a first read) for RETRY_MS, so a database that does not answer holds no 404 for more than this once.
const BOUND_MS = 1000
const RETRY_MS = 5000

interface Row { path: string, target: string, status: number, added_at: string }
type Held = { at: number } & RedirectSnapshot

const decoded = (row: Row): RuntimeRedirect => entry({ ...row, path: unescaped(row.path), target: unescaped(row.target) })

// The redirects an editor added, in the `kay_redirects` table of the app's Postgres: the same rules as the SQLite set, checked and written under an advisory lock so two editors adding at once, from any replica, cannot make a loop between them.
// `connect` answers undefined for a database without the tables, which holds no redirect; `failed` hears a read of the redirects that did not complete.
// A `readOnly` set holds no redirect for a role that may not read the table.
export function pgRedirectSet(connect: () => Promise<SQL | undefined>, failed: (error: unknown) => void = () => undefined, readOnly = false): RedirectSet {
  let held: Held | undefined
  let loading: Promise<Held | undefined> | undefined
  // Counts the writes, so a read that started before one never stores what it read.
  let generation = 0
  let degraded = false
  let retryAt = 0

  const read = async (db: SQL, text: string, values: string[] = []): Promise<Row[]> => {
    try {
      return await query<Row>(db, text, values)
    }
    catch (error) {
      if (readOnly && privilegeRefused(error))
        return []

      throw error
    }
  }

  const all = async (db: SQL): Promise<RuntimeRedirect[]> => (await read(db, `SELECT ${COLUMNS} FROM kay_redirects ORDER BY added_at DESC, path`)).map(decoded)

  // Never rejects: a read that failed is told to `failed` and leaves the lookups on the redirects held.
  const refresh = async (started: number): Promise<Held | undefined> => {
    try {
      const db = await connect()
      const fresh: Held = { at: Date.now(), ...snapshotOf(db ? await all(db) : []) }

      if (started === generation) {
        held = fresh
        degraded = false
      }

      return fresh
    }
    catch (error) {
      degraded = true
      retryAt = Date.now() + RETRY_MS
      failed(error)

      return undefined
    }
    finally {
      if (started === generation)
        loading = undefined
    }
  }

  const changed = (): void => {
    generation++
    held = undefined
    loading = undefined
  }

  // Runs `use` in one transaction holding the lock, over the stored redirects as a map that `use` keeps up to date as it writes.
  const write = async <T>(use: (tx: SQL, stored: Map<string, RuntimeRedirect>) => Promise<T>): Promise<T> => {
    const db = await connect()

    if (!db)
      throw new Error('kay: the redirects added while the site runs need the tables of the app\'s database, which kay creates on a write.')

    changed()

    try {
      return await db.begin(async (tx) => {
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK])

        return use(tx, new Map((await all(tx)).map(row => [row.from, row])))
      })
    }
    finally {
      changed()
    }
  }

  const insert = async (tx: SQL, stored: Map<string, RuntimeRedirect>, rawFrom: string, rawTo: string, status: RuntimeStatus, rules: RuntimeRules): Promise<RuntimeRedirect> => {
    const to = status === 410 ? '' : encoded(rawTo)
    const from = encoded(rawFrom)

    check({ list: () => [...stored.values()], find: path => stored.get(path) }, from, to, status, rules)

    // The path as a visit is looked up: `/old/` and `/old?x=1` are `/old`.
    const key = plainPath(from)

    if (!stored.has(key) && stored.size >= MAX_RUNTIME_REDIRECTS)
      throw new RedirectRefusedError(`the set holds ${MAX_RUNTIME_REDIRECTS} redirects, the most there is room for: remove some, or move them to kay.config.ts`)

    const added = { from: key, to, status, addedAt: Date.now() }

    if (rules.dryRun !== true) {
      await query(tx, 'INSERT INTO kay_redirects (path, target, status, pattern, added_at) VALUES ($1, $2, $3::integer, $4::integer, $5::bigint) ON CONFLICT (path) DO UPDATE SET target = $2, status = $3::integer, pattern = $4::integer, added_at = $5::bigint', [escaped(key), escaped(to), status, isPattern(key) ? 1 : 0, added.addedAt])
      stored.set(key, added)
    }

    return added
  }

  return {
    async list() {
      const db = await connect()

      return db ? all(db) : []
    },
    async find(from) {
      const db = await connect()
      const [row] = db ? await read(db, `SELECT ${COLUMNS} FROM kay_redirects WHERE path = $1`, [escaped(from)]) : []

      return row ? decoded(row) : undefined
    },
    async patterns() {
      const db = await connect()
      const rows = db ? await read(db, `SELECT ${COLUMNS} FROM kay_redirects WHERE pattern = 1 ORDER BY length(path) DESC, path`) : []

      return rows.map(decoded)
    },
    async snapshot() {
      if (held !== undefined && Date.now() - held.at < SNAPSHOT_MS)
        return held

      const stale = held ?? snapshotOf([])

      // After a read that did not complete, the lookups never wait for the next one.
      if (degraded) {
        if (loading === undefined && Date.now() >= retryAt)
          loading = refresh(generation)

        return stale
      }

      const reading = loading ??= refresh(generation)
      let timer: Timer | undefined
      const late = new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, BOUND_MS, undefined)
        timer.unref()
      })
      const fresh = await Promise.race([reading, late])

      clearTimeout(timer)

      if (fresh === undefined && !degraded) {
        degraded = true
        retryAt = Date.now() + RETRY_MS
        failed(new Error(`the redirects were not read within ${BOUND_MS} ms`))
      }

      return fresh ?? stale
    },
    async add(from, to, status = 307, rules) {
      return write(async (tx, stored) => insert(tx, stored, from, to, status, rules))
    },
    async move(rawFrom, rawTo, rules) {
      return write(async (tx, stored) => {
        const from = plainPath(encoded(rawFrom))
        const to = plainPath(encoded(rawTo))

        // Nothing answers the page that exists again, and a redirect from it would make the way back a loop.
        await query(tx, 'DELETE FROM kay_redirects WHERE path = $1', [escaped(to)])
        stored.delete(to)

        for (const row of stored.values()) {
          if (row.status !== 410 && row.to.startsWith('/') && plainPath(row.to) === from)
            await insert(tx, stored, row.from, rawTo, row.status, rules)
        }

        return insert(tx, stored, rawFrom, rawTo, 307, rules)
      })
    },
    async remove(from) {
      const db = await connect()

      if (!db)
        return false

      changed()

      try {
        return (await query<{ path: string }>(db, 'DELETE FROM kay_redirects WHERE path = $1 RETURNING path', [escaped(from)])).length > 0
      }
      finally {
        changed()
      }
    },
  }
}
