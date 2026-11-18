import type { Action } from './action'
import type { ApiError } from './api-error'
import type { LoadStatus, Reader } from './live'

// Where a collection stands against the server, which `sync.status()` reads: `loading` until the browser's copy is read, `synced` when nothing is queued and the server is reachable, `unsynced` while writes wait, `offline` when the server cannot be reached, `signed-out` when it asked for a sign-in, `unavailable` where the browser keeps no IndexedDB.
export type LocalSyncStatus = 'loading' | 'synced' | 'unsynced' | 'offline' | 'signed-out' | 'unavailable'

// What the island sees of a write the server did not take as it was: refused (`rejected`, the row went back to what the server last gave) or met a newer row (`conflict`, `kept` is the row now shown, undefined when the server's own).
export interface LocalIssue<Row> {
  id: number
  kind: 'rejected' | 'conflict'
  key: string
  op: 'put' | 'remove'
  // The status the server refused with; 409 for a conflict, whose `data` is the server's row.
  status?: number | undefined
  // The text to show for the issue, as an `ApiError`'s message reads.
  message: string
  errors?: Record<string, string> | undefined
  data?: unknown
  mine?: Row | undefined
  theirs?: Row | undefined
  kept?: Row | undefined
  createdAt: Date
}

export interface LocalConflict<Row> {
  key: string
  // The row as the server last gave it to this browser, undefined for a row made here.
  base: Row | undefined
  // The queued write's row, undefined when it was a removal.
  mine: Row | undefined
  // The server's row now, which its action answered `ctx.deny(409, { data: row })` with.
  theirs: Row
}

// The callbacks a collection takes in its options, and as methods of the same names: `onX` after a transition, one object argument. One that throws is logged and leaves the collection alone.
export interface LocalHooks<Row> {
  // A read of the server was taken in, or the queue was sent and the collection stands `synced`; `value` is the rows held then.
  onData?: ((event: { value: readonly Row[] }) => void) | undefined
  /** @deprecated Write `onData`, which hands `value` where this hands `rows`. Removed in 1.108.0; `deprecated-source-readers` rewrites it. */
  onSync?: ((event: { rows: readonly Row[] }) => void) | undefined
  // A write the server did not take as it was: once for each new issue (it is in `issues()` then), not for those kept from an earlier visit.
  onIssue?: ((event: { issue: LocalIssue<Row> }) => void) | undefined
  // The server could not be read, or the browser keeps no IndexedDB: once for each failure, as `error()` is set.
  onError?: ((event: { error: ApiError }) => void) | undefined
}

export interface LocalOptions<Row extends object, Key extends keyof Row & string> extends LocalHooks<Row> {
  // The field naming a row: a string or a number.
  key: Key
  // The server's rows, read while online: after loading, after the queue was sent and on `sync()`. The signal aborts when the read takes over 30 seconds, so pass it to the call (`call(api, '/', { signal }).orThrow()`).
  read: (signal: AbortSignal) => Promise<readonly Row[]> | readonly Row[]
  // The action a write of a row replays through, so its guards, schema and limits apply as to any call.
  put: Action<Row, unknown>
  remove?: Action<Pick<Row, Key>, unknown> | undefined
  // Changing it forgets the rows held in the browser, which are read again; the queue is kept.
  version?: number | undefined
  // Chooses the row to keep when the server's action answered 409 with its own: the default takes the server's row and puts this write's changed fields on it. Undefined takes the server's row as it is.
  conflict?: ((conflict: LocalConflict<Row>) => Row | undefined) | undefined
}

// `sync()` sends the queue and reads the server's rows again; its properties read where the collection stands against the server.
export interface LocalSync {
  (): Promise<void>
  // Where the collection stands against the server.
  status: () => LocalSyncStatus
  // Writes the server has not taken yet.
  queued: () => number
}

export interface Local<Row, Key extends keyof Row> extends Reader<readonly Row[], LoadStatus> {
  // The rows held, in key order, reactive; empty until the browser's copy is read.
  data: () => readonly Row[]
  /** @deprecated Write `data()`. Removed in 1.108.0; `deprecated-source-readers` rewrites it. */
  rows: () => readonly Row[]
  get: (key: Row[Key]) => Row | undefined
  // Both keep the change in the browser at once and resolve then; the server gets it when it can.
  put: (row: Row) => Promise<void>
  remove: (key: Row[Key]) => Promise<void>
  /** @deprecated Write `sync.queued()`. Removed in 1.108.0; `deprecated-source-readers` rewrites it. */
  unsynced: () => number
  /** @deprecated Write `sync.status()`. Removed in 1.108.0; `deprecated-source-readers` rewrites it. */
  syncStatus: () => LocalSyncStatus
  // `loading` until the browser's copy is read, then `ready`, or `failed` while `error()` is set; `idle` is never read. Whether writes wait for the server is `sync.status()`, not a failure.
  status: () => LoadStatus
  // Whether the browser's copy is still being read.
  pending: () => boolean
  // The last failure to read the server, or that the browser keeps no IndexedDB, kept until a read succeeds. A write waiting for the server is no error: it shows in `sync.status()`, and a refused one in `issues()`.
  error: () => ApiError | undefined
  // Reads the server and sends the queue now, skipping the wait; does nothing unless the last read failed or the server could not be reached, nor while the server asks for a sign-in.
  retry: () => void
  // Called after a sync, with `{ value }` the rows held; returns what stops it.
  onData: (listener: (event: { value: readonly Row[] }) => void) => () => void
  /** @deprecated Write `onData`, which hands `value` where this hands `rows`. Removed in 1.108.0; `deprecated-source-readers` rewrites it. */
  onSync: (listener: (event: { rows: readonly Row[] }) => void) => () => void
  // Called with each new issue; returns what stops it.
  onIssue: (listener: (event: { issue: LocalIssue<Row> }) => void) => () => void
  // Called when a read of the server failed; returns what stops it.
  onError: (listener: (event: { error: ApiError }) => void) => () => void
  issues: () => readonly LocalIssue<Row>[]
  dismiss: (id: number) => Promise<void>
  // Sends the queue and reads the server's rows again; `sync.status()` and `sync.queued()` read where that stands.
  sync: LocalSync
  // Forgets this collection's rows, queue and issues in the browser.
  clear: () => Promise<void>
}
