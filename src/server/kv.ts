import type { MaybePromise, StoreBase } from '../runtime/store-base'
import { KayError } from '../compiler/errors'
import { PURGE_STALE_MS } from '../runtime/cache'
import { kayLog } from '../runtime/log'
import { openSqlite } from '../runtime/sqlite.server'
import { appStore, storeSetups } from './app-store'
import { inMemory } from './memory-mark'
import { onReload } from './reload'

// What a library or an app keeps that is a value under a key and nothing else: a flag with an end, a marker, a document fetched once.
// A key holds a string; `ttlMs` is how long it lives from the write, and a key written without one lives until it is deleted.
export interface KvStore extends StoreBase {
  get: (key: string) => MaybePromise<string | undefined>
  set: (key: string, value: string, ttlMs?: number) => MaybePromise<void>
  // Resolves with whether there was a live value.
  delete: (key: string) => MaybePromise<boolean>
  // Takes the key for `ttlMs` when no live value holds it: true for the one call that took it, however many processes ask at once.
  once: (key: string, ttlMs: number) => MaybePromise<boolean>
}

// A `KvStore` under one namespace, which every key is written under so two users of the store never meet.
export interface Kv {
  get: (key: string) => Promise<string | undefined>
  set: (key: string, value: string, ttlMs?: number) => Promise<void>
  delete: (key: string) => Promise<boolean>
  once: (key: string, ttlMs: number) => Promise<boolean>
}

const SWEEP_EVERY = 500
// The keys the process's own fallback holds, as many as the OAuth documents it once kept in a map of its own.
const FALLBACK_KEYS = 500
// The value `once` writes: nothing reads it.
const TAKEN = '1'

// Values kept in this process's memory; with `max`, a write past that many keys drops the expired ones, then the oldest written.
export function memoryKv(max?: number): KvStore {
  const entries = new Map<string, { value: string, until: number | undefined }>()
  let writes = 0
  const live = (key: string, now: number) => {
    const entry = entries.get(key)

    return entry !== undefined && (entry.until === undefined || entry.until > now) ? entry : undefined
  }
  const write = (key: string, value: string, ttlMs: number | undefined, now: number) => {
    if (++writes % SWEEP_EVERY === 0) {
      for (const [held, entry] of entries) {
        if (entry.until !== undefined && entry.until <= now)
          entries.delete(held)
      }
    }

    // Deleted first so a rewritten key counts as the newest.
    entries.delete(key)
    entries.set(key, { value, until: ttlMs === undefined ? undefined : now + ttlMs })

    if (max === undefined || entries.size <= max)
      return

    for (const [held, entry] of entries) {
      if (entry.until !== undefined && entry.until <= now)
        entries.delete(held)
    }

    for (const held of entries.keys()) {
      if (entries.size <= max)
        break

      entries.delete(held)
    }
  }

  return inMemory({
    get: key => live(key, Date.now())?.value,
    set: (key, value, ttlMs) => write(key, value, ttlMs, Date.now()),
    delete(key) {
      const existed = live(key, Date.now()) !== undefined

      entries.delete(key)

      return existed
    },
    once(key, ttlMs) {
      const now = Date.now()

      if (live(key, now) !== undefined)
        return false

      write(key, TAKEN, ttlMs, now)

      return true
    },
    close: () => entries.clear(),
  })
}

function openKv(path: string) {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)')
  // The sweep deletes by `expires_at`, so an index keeps it off a scan of every key.
  db.run('CREATE INDEX IF NOT EXISTS kay_kv_expires ON kay_kv (expires_at)')

  const select = db.query<{ value: string }, [string, number]>('SELECT value FROM kay_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)')
  const upsert = db.query('INSERT INTO kay_kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
  const remove = db.query<{ expires_at: number | null }, [string]>('DELETE FROM kay_kv WHERE key = ? RETURNING expires_at')
  // The row is taken when none is there or the one there has ended: a live one makes the update a no-op, which returns nothing.
  const take = db.query<{ key: string }, [string, string, number, number]>('INSERT INTO kay_kv (key, value, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at WHERE kay_kv.expires_at IS NOT NULL AND kay_kv.expires_at <= ?4 RETURNING key')
  const sweep = db.query('DELETE FROM kay_kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
  let swept = 0
  const sweeping = (now: number) => {
    if (now - swept > PURGE_STALE_MS) {
      swept = now
      sweep.run(now)
    }
  }

  return {
    close: () => db.close(),
    get: (key: string) => select.get(key, Date.now())?.value,
    set(key: string, value: string, ttlMs?: number) {
      const now = Date.now()

      sweeping(now)
      upsert.run(key, value, ttlMs === undefined ? null : now + ttlMs)
    },
    delete(key: string) {
      const row = remove.get(key)

      return row !== null && (row.expires_at === null || row.expires_at > Date.now())
    },
    once(key: string, ttlMs: number) {
      const now = Date.now()

      sweeping(now)

      return take.get(key, TAKEN, now + ttlMs, now) !== null
    },
  }
}

// Values kept in a SQLite file, shared by every process of the machine opening it.
// The file is opened by the first call, so loading a config that names the store, to build or check, creates nothing.
export function sqliteKv(path: string): KvStore {
  let opened: ReturnType<typeof openKv> | undefined
  let closed = false

  // A reload closes the file for the module that named the store; the module running again names a store of its own.
  onReload(() => opened?.close())

  const file = () => {
    if (closed)
      throw new KayError('store-closed', 'kay: the kv store was closed')

    return opened ??= openKv(path)
  }

  return {
    get: key => file().get(key),
    set: (key, value, ttlMs) => file().set(key, value, ttlMs),
    delete: key => file().delete(key),
    once: (key, ttlMs) => file().once(key, ttlMs),
    close() {
      closed = true
      opened?.close()
    },
  }
}

let fallback: { store: KvStore, setups: number } | undefined

// The store setup already told once, whichever namespace asked first.
let warnedSetups: number | undefined

function inMemoryKv(namespace: string): KvStore {
  if (fallback?.setups !== storeSetups())
    fallback = { store: memoryKv(FALLBACK_KEYS), setups: storeSetups() }

  // An app that names stores but no `kv` shares nothing between its processes through this one: a signed-out cookie or a single-use ticket is known to the process that took it only.
  if (appStore() !== undefined) {
    if (warnedSetups !== storeSetups()) {
      warnedSetups = storeSetups()
      kayLog('warn', `the app's store has no kv, so values a library keeps across requests, "${namespace}" first (signed-out cookies, single-use tickets, fetched documents), are kept in this process only: add kv to the store, which sqliteData and pgData fill`)
    }
  }

  return fallback.store
}

// The app's `store.kv`, else this process's memory: a library keeping a value across requests asks for its own namespace, and an app on `sqliteData` or `pgData` shares it between processes with nothing to write.
// `store` names the one to use instead, as a test or a library given its own does.
export function kv(namespace: string, store?: KvStore): Kv {
  const kept = () => store ?? appStore()?.kv ?? inMemoryKv(namespace)
  const keyed = (key: string) => `${namespace}\n${key}`

  return {
    get: async key => kept().get(keyed(key)),
    set: async (key, value, ttlMs) => kept().set(keyed(key), value, ttlMs),
    delete: async key => kept().delete(keyed(key)),
    once: async (key, ttlMs) => kept().once(keyed(key), ttlMs),
  }
}
