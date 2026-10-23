import type { Duration } from '../runtime/duration'
import { cached, invalidate } from '../runtime/cache'
import { durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { openSqlite } from '../runtime/sqlite.server'
import { appStore } from './app-store'
import { onReload } from './reload'

// One notification of a person's inbox, newest first in a list.
export interface Notification {
  id: string
  title: string
  // Where a click goes: a path of the site or an http(s) URL, nothing else is ever kept.
  url?: string | undefined
  // When it was stored, in milliseconds.
  at: number
  read: boolean
}

// What a store keeps of one: `expires` is when it goes, in milliseconds.
export interface StoredNotification {
  id: string
  title: string
  url?: string | undefined
  at: number
  expires: number
}

// What the app keeps of its people's notifications, `store.notifications` of kay.config.ts: one row each, so replicas share them. A method may answer with a promise.
export interface NotificationStore {
  // Keeps one for a person, and drops the person's oldest beyond `most`.
  add: (user: string, note: StoredNotification, most: number) => void | Promise<void>
  // A person's notifications that have not expired, newest first.
  list: (user: string, limit: number, now: number) => Notification[] | Promise<Notification[]>
  // How many of them are unread.
  unread: (user: string, now: number) => number | Promise<number>
  // Marks one read; false when the person has no such notification.
  markRead: (user: string, id: string, now: number) => boolean | Promise<boolean>
  // Marks every one read, answering how many were unread.
  markAllRead: (user: string, now: number) => number | Promise<number>
  // Deletes every notification of a person, answering how many went.
  erase: (user: string) => number | Promise<number>
  // Deletes every expired one, answering how many went.
  prune: (now: number) => number | Promise<number>
  // Stops what the store runs in the background and lets go of its file.
  close?: () => void
}

export interface NotifyOptions {
  // Words telling what happened, as text: it is never read as HTML. At most 200 characters.
  title: string
  // Where a click goes: a path of the site such as `/orders/12`, or an http(s) URL. Any other is dropped, the notification kept.
  url?: string | undefined
  // How long it is kept, `'90d'` by default.
  keep?: Duration | undefined
}

export const MAX_TITLE = 200
export const MAX_USER = 200
// The most one person keeps; the oldest go first.
export const MOST_PER_USER = 200
const DEFAULT_KEEP = '90d'
const INBOX_SIZE = 20
const PRUNE_EVERY_MS = 60 * 60 * 1000
const MAX_URL = 2000
const LOCAL_PATH = /^\/(?![/\\])[^\s\\]*$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/
const WEB_URL = /^https?:\/\//i

// The cache key a person's inbox is read under, so an `invalidate` of it reaches every tab showing it.
export function inboxKey(user: string): string {
  return `kay:inbox:${user}`
}

// `url` when it is a path of the site or an http(s) URL, else undefined: a `javascript:` or `data:` URL, a protocol-relative `//host` and a backslash path are never linked.
export function safeNotificationUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length > MAX_URL || CONTROL.test(url))
    return undefined

  if (LOCAL_PATH.test(url))
    return url

  if (!WEB_URL.test(url))
    return undefined

  return URL.canParse(url) ? url : undefined
}

function checkedUser(user: unknown): string {
  if (typeof user !== 'string' || user === '' || user.length > MAX_USER)
    throw new RangeError(`kay: a notification's user is the user's id, 1 to ${MAX_USER} characters; got ${typeof user === 'string' ? `${user.length} characters` : typeof user}`)

  return user
}

// Notifications kept in this process's memory, gone when it stops.
export function memoryNotifications(): NotificationStore {
  const users = new Map<string, (StoredNotification & { read: boolean })[]>()

  const own = (user: string, now: number) => {
    const rows = (users.get(user) ?? []).filter(row => row.expires > now)

    if (rows.length === 0)
      users.delete(user)
    else
      users.set(user, rows)

    return rows
  }

  return {
    add(user, note, most) {
      const rows = own(user, note.at)

      rows.push({ ...note, read: false })
      users.set(user, rows.slice(-most))
    },
    list: (user, limit, now) => own(user, now).toReversed().slice(0, limit).map(({ expires: _expires, ...note }) => note),
    unread: (user, now) => own(user, now).filter(row => !row.read).length,
    markRead(user, id, now) {
      const row = own(user, now).find(each => each.id === id)

      if (!row)
        return false

      row.read = true

      return true
    },
    markAllRead(user, now) {
      const rows = own(user, now).filter(row => !row.read)

      for (const row of rows)
        row.read = true

      return rows.length
    },
    erase(user) {
      const count = users.get(user)?.length ?? 0

      users.delete(user)

      return count
    },
    prune(now) {
      let dropped = 0

      for (const user of users.keys()) {
        const before = users.get(user)!.length

        dropped += before - own(user, now).length
      }

      return dropped
    },
  }
}

interface Row {
  id: string
  title: string
  url: string | null
  at: number
  read_at: number | null
}

function noteOf(row: Row): Notification {
  return { id: row.id, title: row.title, ...row.url === null ? {} : { url: row.url }, at: row.at, read: row.read_at !== null }
}

// Notifications kept in a SQLite file every process of the machine opening it shares, one row each.
// The file is opened by the first call that needs it, so loading a config that names it, to build or check, creates nothing.
export function sqliteNotifications(path: string): NotificationStore {
  let opened: NotificationStore | undefined
  let closed = false
  const open = (): NotificationStore => {
    if (closed)
      throw new Error('kay: the notifications store was closed')

    return opened ??= openNotifications(path)
  }

  onReload(() => opened?.close?.())

  return {
    add: async (user, note, most) => open().add(user, note, most),
    list: async (user, limit, now) => open().list(user, limit, now),
    unread: async (user, now) => open().unread(user, now),
    markRead: async (user, id, now) => open().markRead(user, id, now),
    markAllRead: async (user, now) => open().markAllRead(user, now),
    erase: async user => open().erase(user),
    prune: async now => open().prune(now),
    close: () => {
      closed = true
      opened?.close?.()
    },
  }
}

function openNotifications(path: string): NotificationStore {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT, at INTEGER NOT NULL, expires INTEGER NOT NULL, read_at INTEGER)')
  db.run('CREATE INDEX IF NOT EXISTS kay_notifications_user ON kay_notifications (user_id, seq)')
  db.run('CREATE INDEX IF NOT EXISTS kay_notifications_expires ON kay_notifications (expires)')

  const insert = db.query('INSERT INTO kay_notifications (id, user_id, title, url, at, expires) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
  const trim = db.query('DELETE FROM kay_notifications WHERE user_id = ?1 AND seq <= (SELECT seq FROM kay_notifications WHERE user_id = ?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2)')
  const read = db.query<Row, [string, number, number]>('SELECT id, title, url, at, read_at FROM kay_notifications WHERE user_id = ?1 AND expires > ?2 ORDER BY seq DESC LIMIT ?3')
  const count = db.query<{ unread: number }, [string, number]>('SELECT count(*) AS unread FROM kay_notifications WHERE user_id = ?1 AND expires > ?2 AND read_at IS NULL')
  const markOne = db.query('UPDATE kay_notifications SET read_at = ?3 WHERE user_id = ?1 AND id = ?2 AND expires > ?3 AND read_at IS NULL')
  const markAll = db.query('UPDATE kay_notifications SET read_at = ?2 WHERE user_id = ?1 AND expires > ?2 AND read_at IS NULL')
  const exists = db.query<{ found: number }, [string, string, number]>('SELECT 1 AS found FROM kay_notifications WHERE user_id = ?1 AND id = ?2 AND expires > ?3')
  const erase = db.query('DELETE FROM kay_notifications WHERE user_id = ?1')
  const prune = db.query('DELETE FROM kay_notifications WHERE expires <= ?1')
  const timer = setInterval(() => prune.run(Date.now()), PRUNE_EVERY_MS)

  timer.unref()
  prune.run(Date.now())

  return {
    add(user, note, most) {
      insert.run(note.id, user, note.title, note.url ?? null, note.at, note.expires)
      trim.run(user, most)
      prune.run(note.at)
    },
    list: (user, limit, now) => read.all(user, now, limit).map(noteOf),
    unread: (user, now) => count.get(user, now)?.unread ?? 0,
    markRead(user, id, now) {
      markOne.run(user, id, now)

      return exists.get(user, id, now) !== null
    },
    markAllRead: (user, now) => markAll.run(user, now).changes,
    erase: user => erase.run(user).changes,
    prune: now => prune.run(now).changes,
    close: () => {
      clearInterval(timer)
      db.close()
    },
  }
}

// A store of the app's own may hold what `notify` would not have kept, so the link is checked again as it is read.
function linkedOnly(notes: Notification[]): Notification[] {
  return notes.map(({ url, ...note }) => {
    const link = safeNotificationUrl(url)

    return link === undefined ? note : { ...note, url: link }
  })
}

let fallback: NotificationStore | undefined

// The app's `store.notifications`, else this process's memory.
export function notificationStore(): NotificationStore {
  return appStore()?.notifications ?? (fallback ??= memoryNotifications())
}

// Tells every tab showing the person's inbox, in this process and the others sharing a cache store, that it changed.
function changed(user: string): void {
  invalidate(inboxKey(user))
}

// Puts a notification in a person's inbox, which the `Bell` of kayjs-ui shows with its unread count and updates in every open tab. `user` is the id kayjs-auth, or whatever names the request's user, gives.
// The store is the app's `store.notifications`, which `sqliteData` and `pgData` fill; with none it is this process's memory. A notification is dropped after `keep`, 90 days by default.
export async function notify(user: string, { title, url, keep = DEFAULT_KEEP }: NotifyOptions): Promise<Notification> {
  const id = checkedUser(user)
  const text = typeof title === 'string' ? title.trim() : ''

  if (text === '' || text.length > MAX_TITLE)
    throw new RangeError(`kay: a notification's title is 1 to ${MAX_TITLE} characters; got ${typeof title === 'string' ? `${text.length} characters` : typeof title}`)

  const link = safeNotificationUrl(url)

  if (url !== undefined && link === undefined)
    kayLog('warn', `notify() dropped the url of a notification for ${id}: only a path of the site or an http(s) URL is linked`)

  const at = Date.now()
  const note: StoredNotification = { id: crypto.randomUUID(), title: text, ...link === undefined ? {} : { url: link }, at, expires: at + Math.round(durationSeconds(keep, 'notify\'s keep') * 1000) }

  await notificationStore().add(id, note, MOST_PER_USER)
  changed(id)

  return { id: note.id, title: note.title, ...link === undefined ? {} : { url: link }, at, read: false }
}

// What the `Bell` shows of a person's inbox: the unread count and the newest notifications.
export interface Inbox {
  unread: number
  items: Notification[]
}

// A person's inbox, read and changed from the server: the `Bell` goes through the same calls.
export const notifications = {
  // The newest first, `limit` of them (20 by default).
  async list(user: string, { limit = 20 }: { limit?: number | undefined } = {}): Promise<Notification[]> {
    return linkedOnly(await notificationStore().list(checkedUser(user), limit, Date.now()))
  },
  // The unread count and the newest notifications, kept in this process's memory and followed by every open page that read it: `notify`, `markRead`, `markAllRead` and `erase` drop it in every process sharing a cache store, so a route reading it through `resource()` shows the change in every tab.
  async inbox(user: string): Promise<Inbox> {
    const id = checkedUser(user)

    return cached(inboxKey(id), '5m', async () => {
      const store = notificationStore()
      const now = Date.now()

      return { unread: await store.unread(id, now), items: linkedOnly(await store.list(id, INBOX_SIZE, now)) }
    }, { live: true, store: false })
  },
  async unread(user: string): Promise<number> {
    return notificationStore().unread(checkedUser(user), Date.now())
  },
  async markRead(user: string, id: string): Promise<boolean> {
    const found = await notificationStore().markRead(checkedUser(user), id, Date.now())

    if (found)
      changed(user)

    return found
  },
  async markAllRead(user: string): Promise<number> {
    const count = await notificationStore().markAllRead(checkedUser(user), Date.now())

    if (count > 0)
      changed(user)

    return count
  },
  // Deletes every notification of a person, for the function that erases them on request: [Privacy](privacy.md).
  async erase(user: string): Promise<number> {
    const count = await notificationStore().erase(checkedUser(user))

    changed(user)

    return count
  },
}
