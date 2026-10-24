import { openSqlite } from '../runtime/sqlite.server'
import { appStore } from './app-store'
import { inMemory } from './memory-mark'
import { onReload } from './reload'

// One browser's push subscription: where the push service takes a message and the keys it is encrypted for.
export interface PushSubscriptionRecord {
  endpoint: string
  // The browser's public key and auth secret, base64url.
  p256dh: string
  auth: string
  // When it was stored, in milliseconds.
  at: number
}

// What the app keeps of its people's push subscriptions, `store.push` of kay.config.ts: one row each, so replicas share them. A method may answer with a promise.
export interface PushStore {
  // Keeps a subscription for a person, replacing the one at the same endpoint (whoever it was kept for), and drops the person's oldest beyond `most`.
  add: (user: string, subscription: PushSubscriptionRecord, most: number) => void | Promise<void>
  // A person's subscriptions, newest first.
  list: (user: string) => PushSubscriptionRecord[] | Promise<PushSubscriptionRecord[]>
  // Deletes the subscription at an endpoint, only a person's own when `user` is given; false when none went.
  remove: (endpoint: string, user?: string) => boolean | Promise<boolean>
  // Deletes every subscription of a person, answering how many went.
  erase: (user: string) => number | Promise<number>
  close?: () => void
}

// Subscriptions kept in this process's memory, gone when it stops.
export function memoryPush(): PushStore {
  const rows = new Map<string, PushSubscriptionRecord & { user: string }>()

  return inMemory({
    add(user, subscription, most) {
      rows.delete(subscription.endpoint)
      rows.set(subscription.endpoint, { ...subscription, user })

      const own = [...rows.values()].filter(row => row.user === user)

      for (const row of own.slice(0, Math.max(0, own.length - most)))
        rows.delete(row.endpoint)
    },
    list: user => [...rows.values()].filter(row => row.user === user).toReversed().map(({ user: _user, ...subscription }) => subscription),
    remove(endpoint, user) {
      const row = rows.get(endpoint)

      if (row === undefined || (user !== undefined && row.user !== user))
        return false

      rows.delete(endpoint)

      return true
    },
    erase(user) {
      let count = 0

      for (const row of rows.values()) {
        if (row.user === user) {
          rows.delete(row.endpoint)
          count++
        }
      }

      return count
    },
  })
}

interface Row {
  endpoint: string
  p256dh: string
  auth: string
  at: number
}

// Subscriptions kept in a SQLite file every process of the machine opening it shares, one row each. The file is opened by the first call that needs it.
export function sqlitePush(path: string): PushStore {
  let opened: PushStore | undefined
  let closed = false
  const open = (): PushStore => {
    if (closed)
      throw new Error('kay: the push subscriptions store was closed')

    return opened ??= openPush(path)
  }

  onReload(() => opened?.close?.())

  return {
    add: async (user, subscription, most) => open().add(user, subscription, most),
    list: async user => open().list(user),
    remove: async (endpoint, user) => open().remove(endpoint, user),
    erase: async user => open().erase(user),
    close: () => {
      closed = true
      opened?.close?.()
    },
  }
}

function openPush(path: string): PushStore {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, at INTEGER NOT NULL)')
  db.run('CREATE INDEX IF NOT EXISTS kay_push_subscriptions_user ON kay_push_subscriptions (user_id, at)')

  const insert = db.query('INSERT OR REPLACE INTO kay_push_subscriptions (endpoint, user_id, p256dh, auth, at) VALUES (?1, ?2, ?3, ?4, ?5)')
  const trim = db.query('DELETE FROM kay_push_subscriptions WHERE user_id = ?1 AND endpoint NOT IN (SELECT endpoint FROM kay_push_subscriptions WHERE user_id = ?1 ORDER BY at DESC, rowid DESC LIMIT ?2)')
  const list = db.query<Row, [string]>('SELECT endpoint, p256dh, auth, at FROM kay_push_subscriptions WHERE user_id = ?1 ORDER BY at DESC, rowid DESC')
  const drop = db.query('DELETE FROM kay_push_subscriptions WHERE endpoint = ?1')
  const dropOwn = db.query('DELETE FROM kay_push_subscriptions WHERE endpoint = ?1 AND user_id = ?2')
  const erase = db.query('DELETE FROM kay_push_subscriptions WHERE user_id = ?1')

  return {
    add(user, subscription, most) {
      insert.run(subscription.endpoint, user, subscription.p256dh, subscription.auth, subscription.at)
      trim.run(user, most)
    },
    list: user => list.all(user),
    remove: (endpoint, user) => (user === undefined ? drop.run(endpoint) : dropOwn.run(endpoint, user)).changes > 0,
    erase: user => erase.run(user).changes,
    close: () => db.close(),
  }
}

let fallback: PushStore | undefined

// The app's `store.push`, else this process's memory.
export function pushStore(): PushStore {
  return appStore()?.push ?? (fallback ??= memoryPush())
}
