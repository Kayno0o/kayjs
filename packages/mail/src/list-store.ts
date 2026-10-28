import type { Database } from 'bun:sqlite'
import type { SuppressionStore } from './suppressions'
import { openSqlite } from 'kay/library'
import { suppressionsIn } from './suppressions'

// Where the production server keeps its mailing lists, next to the job store.
export const LIST_FILE = 'data/mail-list.sqlite'

export interface Subscriber {
  id: string
  list: string
  email: string
  status: 'pending' | 'confirmed'
  locale: string
  createdAt: number
  confirmedAt: number | undefined
  // What the subscription is kept with as proof of consent: the page the form was on and the id of the notice it showed.
  source: string | undefined
  wording: string | undefined
}

// Where a subscription came from and which notice the visitor saw.
export interface Proof {
  source?: string | undefined
  wording?: string | undefined
}

export interface Broadcast {
  id: string
  list: string
  createdAt: number
  finishedAt: number | undefined
  // The mail as rendered once, a JSON text: each subscriber's is this with their own unsubscribe link.
  message: string
}

// A store answers synchronously (SQLite) or with a promise (Postgres): callers await every call.
type Maybe<T> = T | Promise<T>

// What the mailing lists keep their data in; `openLists` is the SQLite one, `pgLists` the Postgres one, both with the same semantics: a delivery is claimed before its mail goes, and removing or erasing a subscriber takes its deliveries with it.
export interface ListStore {
  // Whether the store was closed, which the sweep then leaves alone.
  readonly closed?: boolean
  // The address's row on the list, made pending when it has none, with the proof of the post that made it.
  ask: (list: string, email: string, id: string, locale: string, now?: number, proof?: Proof) => Maybe<Subscriber>
  // Forgets the confirmations nobody clicked in 7 days and the broadcasts finished 30 days ago with their deliveries, which the lists run when a store opens and every hour.
  sweep: (now?: number) => Maybe<void>
  // Whether the subscriber is confirmed after the call; one confirmed already stays as it is. A `issuedAt` confirms only a row asked before it, so the link of an earlier mail cannot confirm a later sign-up.
  confirm: (list: string, id: string, now?: number, issuedAt?: number) => Maybe<boolean>
  remove: (list: string, id: string) => Maybe<boolean>
  removeEmail: (list: string, email: string) => Maybe<boolean>
  // Takes the address off every list of the store, with its deliveries; how many rows went.
  erase: (email: string) => Maybe<number>
  // Every row of the address, whatever its list and state, oldest first.
  forEmail: (email: string) => Maybe<Subscriber[]>
  subscribers: (list: string) => Maybe<Subscriber[]>
  count: (list: string) => Maybe<number>
  addBroadcast: (id: string, list: string, message: string, now?: number) => Maybe<void>
  broadcast: (id: string) => Maybe<Broadcast | undefined>
  finish: (id: string, now?: number) => Maybe<unknown>
  next: (broadcast: Broadcast, limit: number) => Maybe<Subscriber[]>
  // Claims the recipient before the mail goes, so a process that dies inside the send is never followed by one sending it again; false when it was claimed already or left the list.
  claim: (broadcast: string, subscriber: string, now?: number) => Maybe<boolean>
  sent: (broadcast: string, subscriber: string, now?: number) => Maybe<unknown>
  release: (broadcast: string, subscriber: string, now?: number) => Maybe<unknown>
  progress: (broadcast: Broadcast) => Maybe<BroadcastProgress>
  // Bounces and complaints, as a `SuppressionStore` keeps them, which a store of an app's own may leave out: the mailer then keeps them in its `suppressionStore`, else the default file.
  suppress?: SuppressionStore['suppress'] | undefined
  suppressed?: SuppressionStore['suppressed'] | undefined
  lift?: SuppressionStore['lift'] | undefined
}

export type DeliveryState = 'sending' | 'sent' | 'retry' | 'failed'

export interface BroadcastProgress {
  sent: number
  failed: number
  retrying: number
  // Claimed and never settled: the process died inside the send, so the mail may or may not have left.
  unsure: number
  waiting: number
}

// A recipient is mailed this many times before it is given up on.
export const DELIVERY_TRIES = 3
// A confirmation nobody clicked is forgotten after this long.
const PENDING_KEPT_MS = 7 * 24 * 3_600_000
// A finished broadcast and its deliveries are kept this long.
const BROADCAST_KEPT_MS = 30 * 24 * 3_600_000

interface SubscriberRow { id: string, list: string, email: string, status: 'pending' | 'confirmed', locale: string, created_at: number, confirmed_at: number | null, source: string | null, wording: string | null }
interface BroadcastRow { id: string, list: string, created_at: number, finished_at: number | null, message: string }

function subscriberOf(row: SubscriberRow): Subscriber {
  return { id: row.id, list: row.list, email: row.email, status: row.status, locale: row.locale, createdAt: row.created_at, confirmedAt: row.confirmed_at ?? undefined, source: row.source ?? undefined, wording: row.wording ?? undefined }
}

function broadcastOf(row: BroadcastRow): Broadcast {
  return { id: row.id, list: row.list, createdAt: row.created_at, finishedAt: row.finished_at ?? undefined, message: row.message }
}

// The lists in one SQLite file, shared by the processes of the machine opening it. Addresses are stored once per list, in the form `normalizeAddress` gives; the file is readable by the server's user alone.
export function openLists(path: string) {
  const db: Database = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_mail_subscribers (id TEXT PRIMARY KEY, list TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, locale TEXT NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER, source TEXT, wording TEXT)')
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS kay_mail_subscribers_email ON kay_mail_subscribers (list, email)')
  db.run('CREATE INDEX IF NOT EXISTS kay_mail_subscribers_email_only ON kay_mail_subscribers (email)')
  db.run('CREATE TABLE IF NOT EXISTS kay_mail_broadcasts (id TEXT PRIMARY KEY, list TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, message TEXT NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS kay_mail_deliveries (broadcast TEXT NOT NULL, subscriber TEXT NOT NULL, state TEXT NOT NULL, tries INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (broadcast, subscriber))')
  db.run('CREATE INDEX IF NOT EXISTS kay_mail_subscribers_pending ON kay_mail_subscribers (status, created_at)')
  db.run('CREATE INDEX IF NOT EXISTS kay_mail_deliveries_subscriber ON kay_mail_deliveries (subscriber)')

  const insertPending = db.query('INSERT OR IGNORE INTO kay_mail_subscribers (id, list, email, status, locale, created_at, source, wording) VALUES (?1, ?2, ?3, \'pending\', ?4, ?5, ?6, ?7)')
  const byEmail = db.query<SubscriberRow, [string, string]>('SELECT * FROM kay_mail_subscribers WHERE list = ?1 AND email = ?2')
  const byId = db.query<SubscriberRow, [string, string]>('SELECT * FROM kay_mail_subscribers WHERE list = ?1 AND id = ?2')
  const confirmRow = db.query('UPDATE kay_mail_subscribers SET status = \'confirmed\', confirmed_at = ?3 WHERE list = ?1 AND id = ?2 AND status = \'pending\' AND created_at <= ?4')
  const deleteDeliveries = db.query('DELETE FROM kay_mail_deliveries WHERE subscriber = ?1')
  const deleteSubscriber = db.query('DELETE FROM kay_mail_subscribers WHERE list = ?1 AND id = ?2')
  const byEmailId = db.query<{ id: string }, [string, string]>('SELECT id FROM kay_mail_subscribers WHERE list = ?1 AND email = ?2')
  const idsOfEmail = db.query<{ id: string }, [string]>('SELECT id FROM kay_mail_subscribers WHERE email = ?1')
  const rowsOfEmail = db.query<SubscriberRow, [string]>('SELECT * FROM kay_mail_subscribers WHERE email = ?1 ORDER BY created_at, id')
  const deleteEmail = db.query('DELETE FROM kay_mail_subscribers WHERE email = ?1')
  const sweepPending = db.query('DELETE FROM kay_mail_subscribers WHERE status = \'pending\' AND created_at < ?1')
  const confirmed = db.query<SubscriberRow, [string]>('SELECT * FROM kay_mail_subscribers WHERE list = ?1 AND status = \'confirmed\' ORDER BY confirmed_at, id')
  const count = db.query<{ total: number }, [string]>('SELECT COUNT(*) AS total FROM kay_mail_subscribers WHERE list = ?1 AND status = \'confirmed\'')

  const kept = suppressionsIn(db)

  const insertBroadcast = db.query('INSERT INTO kay_mail_broadcasts (id, list, created_at, message) VALUES (?1, ?2, ?3, ?4)')
  const getBroadcast = db.query<BroadcastRow, [string]>('SELECT * FROM kay_mail_broadcasts WHERE id = ?1')
  const finishBroadcast = db.query('UPDATE kay_mail_broadcasts SET finished_at = ?2 WHERE id = ?1 AND finished_at IS NULL')
  const oldBroadcasts = db.query<{ id: string }, [number]>('SELECT id FROM kay_mail_broadcasts WHERE finished_at IS NOT NULL AND finished_at < ?1')
  const deleteBroadcastDeliveries = db.query('DELETE FROM kay_mail_deliveries WHERE broadcast = ?1')
  const deleteBroadcast = db.query('DELETE FROM kay_mail_broadcasts WHERE id = ?1')

  // A subscriber still confirmed and not yet mailed this broadcast, or whose last try failed and may go again.
  const next = db.query<SubscriberRow, [string, string, number, number]>('SELECT s.* FROM kay_mail_subscribers s LEFT JOIN kay_mail_deliveries d ON d.broadcast = ?1 AND d.subscriber = s.id WHERE s.list = ?2 AND s.status = \'confirmed\' AND s.confirmed_at <= ?3 AND (d.subscriber IS NULL OR d.state = \'retry\') ORDER BY s.id LIMIT ?4')
  const claimRow = db.query('INSERT INTO kay_mail_deliveries (broadcast, subscriber, state, tries, at) SELECT ?1, ?2, \'sending\', 1, ?3 WHERE EXISTS (SELECT 1 FROM kay_mail_subscribers WHERE id = ?2 AND status = \'confirmed\') ON CONFLICT (broadcast, subscriber) DO UPDATE SET state = \'sending\', tries = tries + 1, at = ?3 WHERE kay_mail_deliveries.state = \'retry\' AND EXISTS (SELECT 1 FROM kay_mail_subscribers WHERE id = ?2 AND status = \'confirmed\')')
  const settleRow = db.query('UPDATE kay_mail_deliveries SET state = ?3, at = ?4 WHERE broadcast = ?1 AND subscriber = ?2 AND state = \'sending\'')
  const releaseRow = db.query(`UPDATE kay_mail_deliveries SET state = CASE WHEN tries >= ${DELIVERY_TRIES} THEN 'failed' ELSE 'retry' END, at = ?3 WHERE broadcast = ?1 AND subscriber = ?2 AND state = 'sending'`)
  const states = db.query<{ state: DeliveryState, total: number }, [string]>('SELECT state, COUNT(*) AS total FROM kay_mail_deliveries WHERE broadcast = ?1 GROUP BY state')
  const waitingFor = db.query<{ total: number }, [string, string, number]>('SELECT COUNT(*) AS total FROM kay_mail_subscribers s LEFT JOIN kay_mail_deliveries d ON d.broadcast = ?1 AND d.subscriber = s.id WHERE s.list = ?2 AND s.status = \'confirmed\' AND s.confirmed_at <= ?3 AND d.subscriber IS NULL')

  const remove = db.transaction((list: string, id: string): boolean => {
    deleteDeliveries.run(id)

    return deleteSubscriber.run(list, id).changes > 0
  })

  const removeEmail = db.transaction((list: string, email: string): boolean => {
    const found = byEmailId.get(list, email)

    return found != null && remove(list, found.id)
  })

  const erase = db.transaction((email: string): number => {
    for (const { id } of idsOfEmail.all(email))
      deleteDeliveries.run(id)

    return deleteEmail.run(email).changes
  })

  const sweepBroadcasts = db.transaction((before: number) => {
    for (const { id } of oldBroadcasts.all(before)) {
      deleteBroadcastDeliveries.run(id)
      deleteBroadcast.run(id)
    }
  })

  sweepPending.run(Date.now() - PENDING_KEPT_MS)
  sweepBroadcasts.immediate(Date.now() - BROADCAST_KEPT_MS)

  let closed = false

  return {
    close: () => {
      closed = true
      db.close()
    },
    get closed() {
      return closed
    },
    sweep(now = Date.now()): void {
      sweepPending.run(now - PENDING_KEPT_MS)
      sweepBroadcasts.immediate(now - BROADCAST_KEPT_MS)
    },
    // The address's row on the list, made pending when it has none.
    ask(list: string, email: string, id: string, locale: string, now = Date.now(), proof: Proof = {}): Subscriber {
      insertPending.run(id, list, email, locale, now, proof.source ?? null, proof.wording ?? null)

      const row = byEmail.get(list, email)

      if (row == null)
        throw new Error('kayjs-mail: the subscriber row was removed while it was being added')

      return subscriberOf(row)
    },
    find(list: string, id: string): Subscriber | undefined {
      const row = byId.get(list, id)

      return row ? subscriberOf(row) : undefined
    },
    // Whether the subscriber is confirmed after the call; one confirmed already stays as it is.
    confirm(list: string, id: string, now = Date.now(), issuedAt = Number.MAX_SAFE_INTEGER): boolean {
      confirmRow.run(list, id, now, issuedAt)

      return byId.get(list, id)?.status === 'confirmed'
    },
    remove,
    // Immediate, as these read before they write and two processes may share the file.
    removeEmail: removeEmail.immediate,
    erase: erase.immediate,
    forEmail: (email: string): Subscriber[] => rowsOfEmail.all(email).map(subscriberOf),
    subscribers: (list: string): Subscriber[] => confirmed.all(list).map(subscriberOf),
    count: (list: string): number => count.get(list)!.total,
    addBroadcast(id: string, list: string, message: string, now = Date.now()): void {
      insertBroadcast.run(id, list, now, message)
    },
    broadcast(id: string): Broadcast | undefined {
      const row = getBroadcast.get(id)

      return row ? broadcastOf(row) : undefined
    },
    finish: (id: string, now = Date.now()) => finishBroadcast.run(id, now),
    next: (broadcast: Broadcast, limit: number): Subscriber[] => next.all(broadcast.id, broadcast.list, broadcast.createdAt, limit).map(subscriberOf),
    // Claims the recipient before the mail goes, so a process that dies inside the send is never followed by one sending it again; false when it was claimed already or left the list.
    claim: (broadcast: string, subscriber: string, now = Date.now()): boolean => claimRow.run(broadcast, subscriber, now).changes > 0,
    sent: (broadcast: string, subscriber: string, now = Date.now()) => settleRow.run(broadcast, subscriber, 'sent', now),
    release: (broadcast: string, subscriber: string, now = Date.now()) => releaseRow.run(broadcast, subscriber, now),
    ...kept,
    progress(broadcast: Broadcast): BroadcastProgress {
      const counts = new Map(states.all(broadcast.id).map(row => [row.state, row.total]))

      return { sent: counts.get('sent') ?? 0, failed: counts.get('failed') ?? 0, retrying: counts.get('retry') ?? 0, unsure: counts.get('sending') ?? 0, waiting: waitingFor.get(broadcast.id, broadcast.list, broadcast.createdAt)!.total }
    },
  }
}
