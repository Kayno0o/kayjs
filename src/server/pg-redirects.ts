import type { SQL } from 'bun'
import type { RedirectSet, RedirectSnapshot, RuntimeRedirect, RuntimeRules, RuntimeStatus } from './runtime-redirects'
import { query } from './pg-sql'
import { check, encoded, entry, isPattern, MAX_RUNTIME_REDIRECTS, plainPath, RedirectRefusedError, snapshotOf } from './runtime-redirects'

const COLUMNS = 'path, target, status, added_at::text AS added_at'
const LOCK = 'kay_redirects'
// The stored redirects are read again at most this often by the lookups of missing paths, so a flood of them costs one query a second, and a redirect another replica added is answered within it.
const SNAPSHOT_MS = 1000

interface Row { path: string, target: string, status: number, added_at: string }

// The redirects an editor added, in the `kay_redirects` table of the app's Postgres: the same rules as the SQLite set, checked and written under an advisory lock so two editors adding at once, from any replica, cannot make a loop between them.
export function pgRedirectSet(connect: () => Promise<SQL>): RedirectSet {
  let held: ({ at: number } & RedirectSnapshot) | undefined
  let loading: Promise<{ at: number } & RedirectSnapshot> | undefined

  const all = async (db: SQL): Promise<RuntimeRedirect[]> => {
    const rows = await query<Row>(db, `SELECT ${COLUMNS} FROM kay_redirects ORDER BY added_at DESC, path`)

    return rows.map(entry)
  }

  const refresh = async () => {
    const rows = await all(await connect())

    held = { at: Date.now(), ...snapshotOf(rows) }

    return held
  }

  // Runs `use` in one transaction holding the lock, over the stored redirects as a map that `use` keeps up to date as it writes.
  const write = async <T>(use: (tx: SQL, stored: Map<string, RuntimeRedirect>) => Promise<T>): Promise<T> => {
    const db = await connect()

    held = undefined

    try {
      return await db.begin(async (tx) => {
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK])

        return use(tx, new Map((await all(tx)).map(row => [row.from, row])))
      })
    }
    finally {
      held = undefined
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
      await query(tx, 'INSERT INTO kay_redirects (path, target, status, pattern, added_at) VALUES ($1, $2, $3::integer, $4::integer, $5::bigint) ON CONFLICT (path) DO UPDATE SET target = $2, status = $3::integer, pattern = $4::integer, added_at = $5::bigint', [key, to, status, isPattern(key) ? 1 : 0, added.addedAt])
      stored.set(key, added)
    }

    return added
  }

  return {
    async list() {
      return all(await connect())
    },
    async find(from) {
      const [row] = await query<Row>(await connect(), `SELECT ${COLUMNS} FROM kay_redirects WHERE path = $1`, [from])

      return row ? entry(row) : undefined
    },
    async patterns() {
      const rows = await query<Row>(await connect(), `SELECT ${COLUMNS} FROM kay_redirects WHERE pattern = 1 ORDER BY length(path) DESC, path`)

      return rows.map(entry)
    },
    async snapshot() {
      if (held !== undefined && Date.now() - held.at < SNAPSHOT_MS)
        return held

      loading ??= refresh()

      try {
        return await loading
      }
      finally {
        loading = undefined
      }
    },
    async add(from, to, status = 307, rules) {
      return write(async (tx, stored) => insert(tx, stored, from, to, status, rules))
    },
    async move(rawFrom, rawTo, rules) {
      return write(async (tx, stored) => {
        const from = plainPath(encoded(rawFrom))
        const to = plainPath(encoded(rawTo))

        // Nothing answers the page that exists again, and a redirect from it would make the way back a loop.
        await query(tx, 'DELETE FROM kay_redirects WHERE path = $1', [to])
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

      held = undefined

      return (await query<{ path: string }>(db, 'DELETE FROM kay_redirects WHERE path = $1 RETURNING path', [from])).length > 0
    },
  }
}
