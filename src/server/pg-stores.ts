import type { RateStore } from '../runtime/action'
import type { PgHandle } from './pg-data'
import type { SessionData, SessionStore } from './session'
import type { VitalCount, VitalReading, VitalsStore } from './vitals-store'
import { parse, stringify } from 'devalue'
import { durationSeconds, legacyMs } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { rowsOf } from './pg-jobs'
import { NOW, query } from './pg-sql'
import { onReload } from './reload'
import { matchesSession } from './session'
import { sharedKey } from './stamp'
import { WINDOW_DAYS } from './vitals-store'

// A store drops expired sessions once every so many writes, and a quiet site every hour.
const SWEEP_EVERY = 1000
const SWEEP_SESSIONS_MS = 60 * 60 * 1000
const SWEEP_RATES_MS = 60_000
const RATES_KEY_BYTES = 32
const RATES_KEY = 'rates_key'

// Sessions in Postgres, shared by every replica; `deleteWhere` reads the live sessions and deletes the ones `match` returns true for.
export function pgSessions(pg: PgHandle): SessionStore & { deleteWhere: NonNullable<SessionStore['deleteWhere']> } {
  let timer: ReturnType<typeof setInterval> | undefined
  let writes = 0

  const sweep = async () => {
    const db = await pg.db()

    await query(db, `DELETE FROM kay_sessions WHERE expires < ${NOW}`)
  }

  const sweepLogged = async () => {
    try {
      await sweep()
    }
    catch (error) {
      kayLog('error', 'dropping the expired sessions failed; trying again in an hour', error)
    }
  }

  // Started by the first call, so loading a config that names the store connects to nothing.
  const start = () => {
    if (timer !== undefined)
      return

    timer = setInterval(() => void sweepLogged(), SWEEP_SESSIONS_MS)
    timer.unref()
    onReload(() => clearInterval(timer))
  }

  return {
    async get(id) {
      start()

      const db = await pg.db()
      const [row] = await query<{ data: string }>(db, `SELECT data FROM kay_sessions WHERE id = $1 AND expires >= ${NOW}`, [id])

      return row ? parse(row.data) as SessionData : undefined
    },
    async set(id, data, maxAge) {
      start()

      const db = await pg.db()
      const text = stringify(data)
      const seconds = durationSeconds(maxAge, 'a session\x27s maxAge')

      if (++writes % SWEEP_EVERY === 0)
        await sweep()

      await query(db, `INSERT INTO kay_sessions (id, data, expires) VALUES ($1, $2, ${NOW} + $3::bigint) ON CONFLICT (id) DO UPDATE SET data = excluded.data, expires = excluded.expires`, [id, text, Math.round(seconds * 1000)])
    },
    async delete(id) {
      const db = await pg.db()

      await db`DELETE FROM kay_sessions WHERE id = ${id}`
    },
    async deleteWhere(match) {
      const db = await pg.db()
      const live = await query<{ id: string, data: string }>(db, `SELECT id, data FROM kay_sessions WHERE expires >= ${NOW}`)
      const ids = live.filter(row => matchesSession(row.data, match)).map(row => row.id)

      if (ids.length > 0)
        await query(db, 'DELETE FROM kay_sessions WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))', [JSON.stringify(ids)])

      return ids.length
    },
  }
}

// Rate windows in Postgres, shared by every replica; a key is stored pseudonymised, by the app's secret or else by a random key every replica reads from the database.
export function pgRates(pg: PgHandle): RateStore {
  let swept = 0
  let ownKey: Buffer | undefined

  const keyOf = async (): Promise<Buffer> => {
    const shared = sharedKey('rates')

    if (shared !== undefined)
      return shared

    if (ownKey !== undefined)
      return ownKey

    const db = await pg.db()
    const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(RATES_KEY_BYTES))).toString('base64url')

    await db`INSERT INTO kay_meta (name, value) VALUES (${RATES_KEY}, ${fresh}) ON CONFLICT (name) DO NOTHING`

    const [row] = await rowsOf<{ value: string }>(db`SELECT value FROM kay_meta WHERE name = ${RATES_KEY}`)

    return ownKey = Buffer.from(row!.value, 'base64url')
  }
  const hashed = async (key: string) => new Bun.CryptoHasher('sha256', await keyOf()).update(key).digest('base64url')

  return {
    async hit(key, window, weight = 1) {
      const hash = await hashed(key)
      const db = await pg.db()
      const length = legacyMs(window, 'a rate window')

      if (Date.now() - swept > SWEEP_RATES_MS) {
        swept = Date.now()
        await query(db, `DELETE FROM kay_rates WHERE reset_at <= ${NOW}`)
      }

      // The row's old values are what both cases read: a closed window opens afresh, an open one counts the weight more.
      const [row] = await query<{ count: number, reset_at: string }>(db, `WITH t AS (SELECT ${NOW} AS now) INSERT INTO kay_rates (key, count, reset_at) SELECT $1, $2::integer, t.now + $3::bigint FROM t ON CONFLICT (key) DO UPDATE SET count = CASE WHEN kay_rates.reset_at <= (SELECT now FROM t) THEN $2::integer ELSE kay_rates.count + $2::integer END, reset_at = CASE WHEN kay_rates.reset_at <= (SELECT now FROM t) THEN (SELECT now FROM t) + $3::bigint ELSE kay_rates.reset_at END RETURNING count, reset_at`, [hash, weight, Math.round(length)])

      return { count: row!.count, resetAt: Number(row!.reset_at) }
    },
    async peek(key) {
      const hash = await hashed(key)
      const db = await pg.db()
      const [row] = await query<{ count: number, reset_at: string }>(db, `SELECT count, reset_at FROM kay_rates WHERE key = $1 AND reset_at > ${NOW}`, [hash])

      return row ? { count: row.count, resetAt: Number(row.reset_at) } : undefined
    },
  }
}

// Web Vitals counts in Postgres: one row per day, route, metric and bucket, so replicas add their views to the others' with one increment each.
export function pgVitals(pg: PgHandle): VitalsStore {
  let pruned = -1

  return {
    async add(route: string, readings: VitalReading[], day: number) {
      const db = await pg.db()

      // Once a day per process: what a day older than the window counted is of no use.
      if (day !== pruned) {
        pruned = day
        await db`DELETE FROM kay_vitals WHERE day < ${day - WINDOW_DAYS}::integer`
      }

      await db.begin(async (tx) => {
        for (const { vital, bucket } of readings)
          await tx`INSERT INTO kay_vitals (day, route, vital, bucket, count) VALUES (${day}::integer, ${route}, ${vital}, ${bucket}::integer, 1) ON CONFLICT (day, route, vital, bucket) DO UPDATE SET count = kay_vitals.count + 1`
      })
    },
    async counts(since: number) {
      const db = await pg.db()
      const rows = await rowsOf<Omit<VitalCount, 'count'> & { count: string }>(db`SELECT route, vital, bucket, SUM(count)::text AS count FROM kay_vitals WHERE day >= ${since}::integer GROUP BY route, vital, bucket`)

      return rows.map(row => ({ ...row, count: Number(row.count) }))
    },
  }
}
