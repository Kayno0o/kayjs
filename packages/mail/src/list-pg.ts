import type { SQL } from 'bun'
import type { PgJobsSource } from 'kay/library'
import type { Broadcast, BroadcastProgress, DeliveryState, ListStore, Proof, Subscriber } from './list-store'
import { connectionOf, privilegeRefused, relationsMissing } from 'kay/library'
import { DELIVERY_TRIES } from './list-store'

// The tables the Postgres store keeps its data in, for a pg-orm `ignoreTables` of an app that creates them with `createMailListTables`.
export const mailListTables = ['kay_mail_subscribers', 'kay_mail_broadcasts', 'kay_mail_deliveries'] as const

// A confirmation nobody clicked is forgotten after this long; a finished broadcast and its deliveries are kept this long.
const PENDING_KEPT_MS = 7 * 24 * 3_600_000
const BROADCAST_KEPT_MS = 30 * 24 * 3_600_000
// What replicas starting together take turns on while one creates the tables.
const MIGRATION_LOCK = 'kay_mail_lists'

interface SubscriberRow { id: string, list: string, email: string, status: 'pending' | 'confirmed', locale: string, created_at: string, confirmed_at: string | null, source: string | null, wording: string | null }
interface BroadcastRow { id: string, list: string, created_at: string, finished_at: string | null, message: string }

function subscriberOf(row: SubscriberRow): Subscriber {
  return { id: row.id, list: row.list, email: row.email, status: row.status, locale: row.locale, createdAt: Number(row.created_at), confirmedAt: row.confirmed_at === null ? undefined : Number(row.confirmed_at), source: row.source ?? undefined, wording: row.wording ?? undefined }
}

function broadcastOf(row: BroadcastRow): Broadcast {
  return { id: row.id, list: row.list, createdAt: Number(row.created_at), finishedAt: row.finished_at === null ? undefined : Number(row.finished_at), message: row.message }
}

async function rows<Row>(db: SQL, text: string, params: unknown[] = []): Promise<Row[]> {
  return db.unsafe<Row[]>(text, params)
}

// Creates the three tables and their indexes unless they exist, for an app whose role creates nothing: run it as the database's owner, in a boot script. `pgLists` creates them itself when its role may. Replicas running it together take turns.
export async function createMailListTables(source: PgJobsSource): Promise<void> {
  const db = connectionOf(source)

  try {
    if (!await relationsMissing(db, mailListTables))
      return

    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`
      await tx`CREATE TABLE IF NOT EXISTS kay_mail_subscribers (id text PRIMARY KEY, list text NOT NULL, email text NOT NULL, status text NOT NULL, locale text NOT NULL, created_at bigint NOT NULL, confirmed_at bigint, source text, wording text)`
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS kay_mail_subscribers_email ON kay_mail_subscribers (list, email)`
      await tx`CREATE INDEX IF NOT EXISTS kay_mail_subscribers_email_only ON kay_mail_subscribers (email)`
      await tx`CREATE INDEX IF NOT EXISTS kay_mail_subscribers_pending ON kay_mail_subscribers (status, created_at)`
      await tx`CREATE TABLE IF NOT EXISTS kay_mail_broadcasts (id text PRIMARY KEY, list text NOT NULL, created_at bigint NOT NULL, finished_at bigint, message text NOT NULL)`
      await tx`CREATE TABLE IF NOT EXISTS kay_mail_deliveries (broadcast text NOT NULL, subscriber text NOT NULL, state text NOT NULL, tries integer NOT NULL, at bigint NOT NULL, PRIMARY KEY (broadcast, subscriber))`
      await tx`CREATE INDEX IF NOT EXISTS kay_mail_deliveries_subscriber ON kay_mail_deliveries (subscriber)`
    })
  }
  finally {
    if (typeof source === 'string')
      await db.close()
  }
}

// The mailing lists in the app's Postgres, shared by every process of every replica: `mail.list(name, { store: pgLists(db) })`, `db` a Bun `SQL`, a pg-orm `Database` or a connection URL as `pgData` takes. Keep one `pgLists(db)` and give it to every list, so they share its connection.
// The tables are created on first use, which takes a role that may create tables; with one that may not, `createMailListTables` run by the owner makes them and `mailListTables` goes in pg-orm's `ignoreTables`.
export function pgLists(source: PgJobsSource): ListStore & { close: () => Promise<void> } {
  const db = connectionOf(source)
  let ready: Promise<SQL> | undefined

  const create = async (): Promise<SQL> => {
    if (!await relationsMissing(db, mailListTables))
      return db

    try {
      await createMailListTables(db)
    }
    catch (error) {
      if (privilegeRefused(error))
        throw new Error('kayjs-mail: pgLists needs its kay_mail_* tables, and its role may not create them: run `await createMailListTables(db)` from kayjs-mail as the database\'s owner, and list `mailListTables` in pg-orm\'s `ignoreTables`', { cause: error })

      throw error
    }

    return db
  }

  // A failed creation is tried again by the next call rather than kept.
  const connected = async (): Promise<SQL> => {
    ready ??= create()

    try {
      return await ready
    }
    catch (error) {
      ready = undefined

      throw error
    }
  }

  const query = async <Row>(text: string, params: unknown[] = []): Promise<Row[]> => rows<Row>(await connected(), text, params)

  // The subscribers' ids whose rows the statement locks, so a claim of a delivery waits for the removal and finds the subscriber gone.
  const removeWhere = async (where: string, params: unknown[]): Promise<number> => {
    const connection = await connected()

    return connection.begin(async (tx) => {
      const found = await rows<{ id: string }>(tx, `SELECT id FROM kay_mail_subscribers WHERE ${where} FOR UPDATE`, params)

      if (found.length === 0)
        return 0

      const ids = found.map(row => row.id)

      await rows(tx, 'DELETE FROM kay_mail_deliveries WHERE subscriber = ANY($1::text[])', [ids])

      return (await rows(tx, 'DELETE FROM kay_mail_subscribers WHERE id = ANY($1::text[]) RETURNING id', [ids])).length
    })
  }

  const confirmedExists = 'EXISTS (SELECT 1 FROM kay_mail_subscribers WHERE id = $2 AND status = \'confirmed\' FOR SHARE)'

  let closed = false

  return {
    close: async () => {
      if (typeof source === 'string') {
        closed = true
        await db.close()
      }
    },
    get closed() {
      return closed
    },
    async sweep(now = Date.now()): Promise<void> {
      const connection = await connected()

      await connection.begin(async (tx) => {
        await rows(tx, 'DELETE FROM kay_mail_subscribers WHERE status = \'pending\' AND created_at < $1::bigint', [now - PENDING_KEPT_MS])
        await rows(tx, 'DELETE FROM kay_mail_deliveries WHERE broadcast IN (SELECT id FROM kay_mail_broadcasts WHERE finished_at IS NOT NULL AND finished_at < $1::bigint)', [now - BROADCAST_KEPT_MS])
        await rows(tx, 'DELETE FROM kay_mail_broadcasts WHERE finished_at IS NOT NULL AND finished_at < $1::bigint', [now - BROADCAST_KEPT_MS])
      })
    },
    async ask(list, email, id, locale, now = Date.now(), proof: Proof = {}): Promise<Subscriber> {
      await query('INSERT INTO kay_mail_subscribers (id, list, email, status, locale, created_at, source, wording) VALUES ($1, $2, $3, \'pending\', $4, $5::bigint, $6, $7) ON CONFLICT DO NOTHING', [id, list, email, locale, now, proof.source ?? null, proof.wording ?? null])

      const [row] = await query<SubscriberRow>('SELECT * FROM kay_mail_subscribers WHERE list = $1 AND email = $2', [list, email])

      if (row === undefined)
        throw new Error('kayjs-mail: the subscriber row was removed while it was being added')

      return subscriberOf(row)
    },
    async confirm(list, id, now = Date.now(), issuedAt = Number.MAX_SAFE_INTEGER): Promise<boolean> {
      await query('UPDATE kay_mail_subscribers SET status = \'confirmed\', confirmed_at = $3::bigint WHERE list = $1 AND id = $2 AND status = \'pending\' AND created_at <= $4::bigint', [list, id, now, issuedAt])

      return (await query('SELECT 1 FROM kay_mail_subscribers WHERE list = $1 AND id = $2 AND status = \'confirmed\'', [list, id])).length > 0
    },
    async remove(list, id): Promise<boolean> {
      return await removeWhere('list = $1 AND id = $2', [list, id]) > 0
    },
    async removeEmail(list, email): Promise<boolean> {
      return await removeWhere('list = $1 AND email = $2', [list, email]) > 0
    },
    async erase(email): Promise<number> {
      return removeWhere('email = $1', [email])
    },
    async forEmail(email): Promise<Subscriber[]> {
      return (await query<SubscriberRow>('SELECT * FROM kay_mail_subscribers WHERE email = $1 ORDER BY created_at, id', [email])).map(subscriberOf)
    },
    async subscribers(list): Promise<Subscriber[]> {
      return (await query<SubscriberRow>('SELECT * FROM kay_mail_subscribers WHERE list = $1 AND status = \'confirmed\' ORDER BY confirmed_at, id', [list])).map(subscriberOf)
    },
    async count(list): Promise<number> {
      const [row] = await query<{ total: string }>('SELECT COUNT(*) AS total FROM kay_mail_subscribers WHERE list = $1 AND status = \'confirmed\'', [list])

      return Number(row!.total)
    },
    async addBroadcast(id, list, message, now = Date.now()): Promise<void> {
      await query('INSERT INTO kay_mail_broadcasts (id, list, created_at, message) VALUES ($1, $2, $3::bigint, $4)', [id, list, now, message])
    },
    async broadcast(id): Promise<Broadcast | undefined> {
      const [row] = await query<BroadcastRow>('SELECT * FROM kay_mail_broadcasts WHERE id = $1', [id])

      return row ? broadcastOf(row) : undefined
    },
    async finish(id, now = Date.now()): Promise<void> {
      await query('UPDATE kay_mail_broadcasts SET finished_at = $2::bigint WHERE id = $1 AND finished_at IS NULL', [id, now])
    },
    async next(broadcast, limit): Promise<Subscriber[]> {
      return (await query<SubscriberRow>('SELECT s.* FROM kay_mail_subscribers s LEFT JOIN kay_mail_deliveries d ON d.broadcast = $1 AND d.subscriber = s.id WHERE s.list = $2 AND s.status = \'confirmed\' AND s.confirmed_at <= $3::bigint AND (d.subscriber IS NULL OR d.state = \'retry\') ORDER BY s.id LIMIT $4::integer', [broadcast.id, broadcast.list, broadcast.createdAt, limit])).map(subscriberOf)
    },
    // The same claim as the SQLite store's: one statement, locking the subscriber's row so an erase or an unsubscribe in between either comes first (nothing is claimed) or waits and removes the claim with the subscriber.
    async claim(broadcast, subscriber, now = Date.now()): Promise<boolean> {
      const claimed = await query<{ subscriber: string }>(`INSERT INTO kay_mail_deliveries (broadcast, subscriber, state, tries, at) SELECT $1::text, $2::text, 'sending', 1, $3::bigint WHERE ${confirmedExists} ON CONFLICT (broadcast, subscriber) DO UPDATE SET state = 'sending', tries = kay_mail_deliveries.tries + 1, at = $3::bigint WHERE kay_mail_deliveries.state = 'retry' AND ${confirmedExists} RETURNING subscriber`, [broadcast, subscriber, now])

      return claimed.length > 0
    },
    async sent(broadcast, subscriber, now = Date.now()): Promise<void> {
      await query('UPDATE kay_mail_deliveries SET state = \'sent\', at = $3::bigint WHERE broadcast = $1 AND subscriber = $2 AND state = \'sending\'', [broadcast, subscriber, now])
    },
    async release(broadcast, subscriber, now = Date.now()): Promise<void> {
      await query(`UPDATE kay_mail_deliveries SET state = CASE WHEN tries >= ${DELIVERY_TRIES} THEN 'failed' ELSE 'retry' END, at = $3::bigint WHERE broadcast = $1 AND subscriber = $2 AND state = 'sending'`, [broadcast, subscriber, now])
    },
    async progress(broadcast): Promise<BroadcastProgress> {
      const counts = new Map((await query<{ state: DeliveryState, total: string }>('SELECT state, COUNT(*) AS total FROM kay_mail_deliveries WHERE broadcast = $1 GROUP BY state', [broadcast.id])).map(row => [row.state, Number(row.total)]))
      const [waiting] = await query<{ total: string }>('SELECT COUNT(*) AS total FROM kay_mail_subscribers s LEFT JOIN kay_mail_deliveries d ON d.broadcast = $1 AND d.subscriber = s.id WHERE s.list = $2 AND s.status = \'confirmed\' AND s.confirmed_at <= $3::bigint AND d.subscriber IS NULL', [broadcast.id, broadcast.list, broadcast.createdAt])

      return { sent: counts.get('sent') ?? 0, failed: counts.get('failed') ?? 0, retrying: counts.get('retry') ?? 0, unsure: counts.get('sending') ?? 0, waiting: Number(waiting!.total) }
    },
  }
}
