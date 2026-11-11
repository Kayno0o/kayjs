import type { SQL } from 'bun'
import type { RateStore } from '../runtime/action'
import type { KvStore } from './kv'
import type { NotificationRow, NotificationStore } from './notifications'
import type { PgHandle } from './pg-data'
import type { PushStore } from './push-store'
import type { DeletableSessionStore, SessionData } from './session'
import type { VitalCount, VitalReading, VitalsStore } from './vitals-store'
import { parse, stringify } from 'devalue'
import { kayLog } from '../runtime/log'
import { maintenance } from './maintenance'
import { rowsOf } from './pg-jobs'
import { limited, limitedStore, MAINTENANCE_TIMEOUT_MS } from './pg-limit'
import { closeWith, TimeoutError } from './pg-poll'
import { NOW, query } from './pg-sql'
import { compileMatch, matchesSession } from './session'
import { sha256 } from './sha256'
import { sharedKey } from './stamp'
import { WINDOW_DAYS } from './vitals-store'

// A store drops expired sessions once every so many writes, and a quiet site every hour.
const SWEEP_EVERY = 1000
const SWEEP_SESSIONS_MS = 60 * 60 * 1000
const SWEEP_RATES_MS = 60_000
const DELETE_PAGE = 500
const RATES_KEY_BYTES = 32
const RATES_KEY = 'rates_key'

// Sessions in Postgres, shared by every replica; `deleteWhere` reads the live sessions a page at a time, only the ones holding an object match's values in the database, and deletes the ones `match` accepts.
export function pgSessions(pg: PgHandle): DeletableSessionStore {
  let writes = 0

  const sweep = async () => {
    const db = await pg.db()

    await query(db, `DELETE FROM kay_sessions WHERE expires < ${NOW}`)
  }

  const sweepLogged = async () => {
    try {
      await limited('sweeping the sessions', sweep, MAINTENANCE_TIMEOUT_MS)
    }
    catch (error) {
      if (!(error instanceof TimeoutError))
        kayLog('error', 'dropping the expired sessions failed; trying again in an hour', error)
    }
  }

  // Started by the first call, so loading a config that names the store connects to nothing.
  const sweeping = maintenance('sessions', SWEEP_SESSIONS_MS, sweepLogged)
  const start = sweeping.start

  closeWith(pg, sweeping.stop)

  return limitedStore({
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

      // Off the write's path: `sweepLogged` logs its own failure, so the write neither waits for it nor fails with it.
      if (++writes % SWEEP_EVERY === 0)
        void sweepLogged()

      await query(db, `INSERT INTO kay_sessions (id, data, expires) VALUES ($1, $2, ${NOW} + $3::bigint) ON CONFLICT (id) DO UPDATE SET data = excluded.data, expires = excluded.expires`, [id, text, Math.round(maxAge)])
    },
    async delete(id) {
      const db = await pg.db()

      await db`DELETE FROM kay_sessions WHERE id = ${id}`
    },
    async deleteWhere(match) {
      const db = await pg.db()
      const { test, needles } = compileMatch(match)
      const narrowed = needles.map((_, index) => ` AND strpos(data, $${index + 2}) > 0`).join('')
      let deleted = 0
      let after = ''

      // A page at a time by id, so a store of many sessions is never held in memory whole.
      for (;;) {
        const page = await query<{ id: string, data: string }>(db, `SELECT id, data FROM kay_sessions WHERE expires >= ${NOW} AND id > $1${narrowed} ORDER BY id LIMIT ${DELETE_PAGE}`, [after, ...needles])

        if (page.length === 0)
          return deleted

        after = page.at(-1)!.id

        const ids = page.filter(row => matchesSession(row.data, test)).map(row => row.id)

        if (ids.length > 0) {
          await query(db, 'DELETE FROM kay_sessions WHERE id = ANY($1::text[])', [ids])
          deleted += ids.length
        }
      }
    },
  }, 'the sessions store', { ready: pg.db, slow: ['deleteWhere'] })
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
  const hashed = async (key: string) => sha256(key, { encoding: 'base64url', key: await keyOf() })

  return limitedStore({
    async hit(key, window, weight = 1) {
      const hash = await hashed(key)
      const db = await pg.db()

      if (Date.now() - swept > SWEEP_RATES_MS) {
        swept = Date.now()
        await query(db, `DELETE FROM kay_rates WHERE reset_at <= ${NOW}`)
      }

      // The row's old values are what both cases read: a closed window opens afresh, an open one counts the weight more.
      const [row] = await query<{ count: number, reset_at: string }>(db, `WITH t AS (SELECT ${NOW} AS now) INSERT INTO kay_rates (key, count, reset_at) SELECT $1, $2::integer, t.now + $3::bigint FROM t ON CONFLICT (key) DO UPDATE SET count = CASE WHEN kay_rates.reset_at <= (SELECT now FROM t) THEN $2::integer ELSE kay_rates.count + $2::integer END, reset_at = CASE WHEN kay_rates.reset_at <= (SELECT now FROM t) THEN (SELECT now FROM t) + $3::bigint ELSE kay_rates.reset_at END RETURNING count, reset_at`, [hash, weight, Math.round(window)])

      return { count: row!.count, resetAt: Number(row!.reset_at) }
    },
    async peek(key) {
      const hash = await hashed(key)
      const db = await pg.db()
      const [row] = await query<{ count: number, reset_at: string }>(db, `SELECT count, reset_at FROM kay_rates WHERE key = $1 AND reset_at > ${NOW}`, [hash])

      return row ? { count: row.count, resetAt: Number(row.reset_at) } : undefined
    },
    async refund(key, resetAt) {
      const hash = await hashed(key)
      const db = await pg.db()

      await query(db, 'UPDATE kay_rates SET count = GREATEST(count - 1, 0) WHERE key = $1 AND reset_at = $2::bigint', [hash, resetAt])
    },
    async reset(key) {
      const hash = await hashed(key)
      const db = await pg.db()

      await query(db, 'DELETE FROM kay_rates WHERE key = $1', [hash])
    },
  }, 'the rates store', { ready: pg.db })
}

// Values by key in Postgres, shared by every replica: `once` is one statement, so only one replica takes a key however many ask at once.
export function pgKv(pg: PgHandle): KvStore {
  let swept = 0

  const sweep = async (db: SQL) => {
    if (Date.now() - swept > SWEEP_RATES_MS) {
      swept = Date.now()
      await query(db, `DELETE FROM kay_kv WHERE expires_at IS NOT NULL AND expires_at <= ${NOW}`)
    }
  }

  return limitedStore({
    async get(key) {
      const db = await pg.db()
      const [row] = await query<{ value: string }>(db, `SELECT value FROM kay_kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > ${NOW})`, [key])

      return row?.value
    },
    async set(key, value, ttlMs) {
      const db = await pg.db()

      await sweep(db)
      await query(db, `INSERT INTO kay_kv (key, value, expires_at) VALUES ($1, $2, CASE WHEN $3::bigint IS NULL THEN NULL ELSE ${NOW} + $3::bigint END) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`, [key, value, ttlMs === undefined ? null : Math.round(ttlMs)])
    },
    async delete(key) {
      const db = await pg.db()
      const [row] = await query<{ live: boolean }>(db, `DELETE FROM kay_kv WHERE key = $1 RETURNING (expires_at IS NULL OR expires_at > ${NOW}) AS live`, [key])

      return row?.live === true
    },
    async once(key, ttlMs) {
      const db = await pg.db()

      await sweep(db)

      const taken = await query<{ key: string }>(db, `INSERT INTO kay_kv (key, value, expires_at) VALUES ($1, '1', ${NOW} + $2::bigint) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at WHERE kay_kv.expires_at IS NOT NULL AND kay_kv.expires_at <= ${NOW} RETURNING key`, [key, Math.round(ttlMs)])

      return taken.length > 0
    },
  }, 'the kv store', { ready: pg.db })
}

// Web Vitals counts in Postgres: one row per day, route, metric and bucket, so replicas add their views to the others' with one increment each.
export function pgVitals(pg: PgHandle): VitalsStore {
  let pruned = -1

  return limitedStore({
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
  }, 'the vitals store', { ready: pg.db })
}

// Notifications in Postgres, one row each, so replicas share a person's inbox; the clock a notification expires by is the caller's, as the store only compares.
export function pgNotifications(pg: PgHandle): NotificationStore {
  const counted = async (text: string, values: (string | number)[]) => {
    const db = await pg.db()
    const [row] = await query<{ count: string }>(db, `WITH changed AS (${text} RETURNING 1) SELECT count(*)::text AS count FROM changed`, values)

    return Number(row?.count ?? 0)
  }

  const sweep = async () => {
    try {
      await limited('sweeping the notifications', async () => counted('DELETE FROM kay_notifications WHERE expires <= $1::bigint', [Date.now()]), MAINTENANCE_TIMEOUT_MS)
    }
    catch (error) {
      if (!(error instanceof TimeoutError))
        kayLog('error', 'dropping the expired notifications failed; trying again in an hour', error)
    }
  }

  // Started by the first call, so loading a config that names the store connects to nothing.
  const sweeping = maintenance('notifications', SWEEP_SESSIONS_MS, sweep)
  const start = sweeping.start

  closeWith(pg, sweeping.stop)

  return limitedStore({
    async add(user, note, most) {
      start()

      const db = await pg.db()

      await query(db, 'INSERT INTO kay_notifications (id, user_id, title, url, at, expires) VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint)', [note.id, user, note.title, note.url ?? null, note.createdAt, note.expiresAt])
      await query(db, 'DELETE FROM kay_notifications WHERE user_id = $1 AND seq <= (SELECT seq FROM kay_notifications WHERE user_id = $1 ORDER BY seq DESC LIMIT 1 OFFSET $2::integer)', [user, most])
      await query(db, 'DELETE FROM kay_notifications WHERE expires <= $1::bigint', [note.createdAt])
    },
    async list(user, limit, now) {
      start()

      const db = await pg.db()
      const rows = await query<{ id: string, title: string, url: string | null, at: string, read: boolean }>(db, 'SELECT id, title, url, at::text, (read_at IS NOT NULL) AS read FROM kay_notifications WHERE user_id = $1 AND expires > $2::bigint ORDER BY seq DESC LIMIT $3::integer', [user, now, limit])

      return rows.map((row): NotificationRow => ({ id: row.id, title: row.title, ...row.url === null ? {} : { url: row.url }, createdAt: Number(row.at), read: row.read }))
    },
    async unread(user, now) {
      const db = await pg.db()
      const [row] = await query<{ count: string }>(db, 'SELECT count(*)::text AS count FROM kay_notifications WHERE user_id = $1 AND expires > $2::bigint AND read_at IS NULL', [user, now])

      return Number(row?.count ?? 0)
    },
    async markRead(user, id, now) {
      const db = await pg.db()

      await query(db, 'UPDATE kay_notifications SET read_at = $3::bigint WHERE user_id = $1 AND id = $2 AND expires > $3::bigint AND read_at IS NULL', [user, id, now])

      const [row] = await query<{ found: number }>(db, 'SELECT 1 AS found FROM kay_notifications WHERE user_id = $1 AND id = $2 AND expires > $3::bigint', [user, id, now])

      return row !== undefined
    },
    async markAllRead(user, now) {
      return counted('UPDATE kay_notifications SET read_at = $2::bigint WHERE user_id = $1 AND expires > $2::bigint AND read_at IS NULL', [user, now])
    },
    async erase(user) {
      return counted('DELETE FROM kay_notifications WHERE user_id = $1', [user])
    },
    async prune(now) {
      return counted('DELETE FROM kay_notifications WHERE expires <= $1::bigint', [now])
    },
  }, 'the notifications store', { ready: pg.db, slow: ['prune'] })
}

// Push subscriptions in Postgres, one row each by endpoint, so replicas share them.
export function pgPush(pg: PgHandle): PushStore {
  const counted = async (text: string, values: (string | number)[]) => {
    const db = await pg.db()
    const [row] = await query<{ count: string }>(db, `WITH changed AS (${text} RETURNING 1) SELECT count(*)::text AS count FROM changed`, values)

    return Number(row?.count ?? 0)
  }

  return limitedStore({
    async add(user, subscription, most) {
      const db = await pg.db()

      // One transaction under a lock on the person, so two devices subscribing at once leave at most `most`, the newest.
      await db.begin(async (tx) => {
        await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`kay_push_subscriptions\n${user}`])
        await query(tx, 'INSERT INTO kay_push_subscriptions (endpoint, user_id, p256dh, auth, at) VALUES ($1, $2, $3, $4, $5::bigint) ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, at = EXCLUDED.at', [subscription.endpoint, user, subscription.p256dh, subscription.auth, subscription.createdAt])
        await query(tx, 'DELETE FROM kay_push_subscriptions WHERE user_id = $1 AND endpoint NOT IN (SELECT endpoint FROM kay_push_subscriptions WHERE user_id = $1 ORDER BY at DESC, endpoint DESC LIMIT $2::integer)', [user, most])
      })
    },
    async list(user) {
      const db = await pg.db()
      const rows = await query<{ endpoint: string, p256dh: string, auth: string, at: string }>(db, 'SELECT endpoint, p256dh, auth, at::text FROM kay_push_subscriptions WHERE user_id = $1 ORDER BY kay_push_subscriptions.at DESC, endpoint DESC', [user])

      return rows.map(({ at, ...row }) => ({ ...row, createdAt: Number(at) }))
    },
    async delete(endpoint, user) {
      return await (user === undefined ? counted('DELETE FROM kay_push_subscriptions WHERE endpoint = $1', [endpoint]) : counted('DELETE FROM kay_push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, user])) > 0
    },
    async erase(user) {
      return counted('DELETE FROM kay_push_subscriptions WHERE user_id = $1', [user])
    },
    async touch(endpoint, at) {
      await counted('UPDATE kay_push_subscriptions SET at = $2::bigint WHERE endpoint = $1', [endpoint, at])
    },
    // Idleness counts from the later of a row's date and the first call, kept in `kay_meta`, so rows stored before the purge existed are not taken for idle.
    async prune(before) {
      const db = await pg.db()

      await query(db, 'INSERT INTO kay_meta (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', ['push_purge_since', String(Date.now())])

      const [row] = await query<{ value: string }>(db, 'SELECT value FROM kay_meta WHERE name = $1', ['push_purge_since'])

      return Number(row?.value) >= before ? 0 : counted('DELETE FROM kay_push_subscriptions WHERE at < $1::bigint', [before])
    },
  }, 'the push subscriptions store', { ready: pg.db })
}
