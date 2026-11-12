import type { ApiError } from './api-error'
import type { ConnectionHooks, ConnectionStatus } from './live'
import { listenerSet } from './listener-set'
import { ownSignal, untrack } from './reactive'
import { retryLater } from './retry-later'

// The one place a connection is retried and its state kept: the reconnect, the backoff, the listeners and the status of `socket()`, `stream()`, the cached values a page follows and the live values.
// A leaf: only modules that open a connection import it, never the call result or the action call, which every page loads.

// `on`, handing each value as `{ value }`, the shape every hook takes.
export function onData<T>(on: (listener: (value: T) => void) => () => void): (listener: (event: { value: T }) => void) => () => void {
  return listener => on(value => listener({ value }))
}

// What `ended()` of a stream is: it resolves with the last value once the connection ran to its end (undefined when it sent none), rejects with its failure, or with an `AbortError` when `close()` came first.
export function ended<T>(link: ReturnType<typeof connection<T>>) {
  return async () => new Promise<T | undefined>((resolve, reject) => link.settled((final) => {
    if (final === 'done')
      resolve(untrack(link.last))
    else
      reject(final === 'failed' ? untrack(link.error) : new DOMException('The stream was closed before its end', 'AbortError'))
  }))
}

const finished = (status: ConnectionStatus) => status === 'done' || status === 'failed' || status === 'closed'

// The hooks of a source, as methods and from the options it was given: `onData` and `onOpen` (the listener set `opened` its source keeps), and `onError` and `onClose`, which it installs by wrapping the `set` and `fail` of `link`, so a live value, which has none of them, carries none of this.
// A run tells `onClose` once: a `close()` after its end, or a second end, is none; `onError` comes first.
export function connectionHooks<T>(link: ReturnType<typeof connection<T>>, onOpen: (listener: (event: { reconnected: boolean }) => void) => () => void, given?: ConnectionHooks<never>, on = link.on) {
  const errors = listenerSet<{ error: ApiError }>()
  const closes = listenerSet<{ status: 'done' | 'failed' | 'closed' }>()
  const { set, fail } = link
  const hooks = { onData: onData(on), onOpen, onError: errors.on, onClose: closes.on }

  link.set = (next) => {
    const was = untrack(link.status)

    set(next)

    if (finished(next) && !finished(was))
      closes.emit({ status: next })
  }
  link.fail = (failure) => {
    const was = untrack(link.status)

    fail(failure)

    if (!finished(was)) {
      errors.emit({ error: failure })
      closes.emit({ status: 'failed' })
    }
  }

  if (given) {
    for (const name of ['onData', 'onOpen', 'onError', 'onClose'] as const) {
      if (given[name])
        (hooks[name] as (listener: unknown) => unknown)(given[name])
    }
  }

  return hooks
}

// The state a source that opens, delivers values and drops keeps: the listener set and the last value, the status and the last failure as signals and the backoff of a reconnect.
// `open` makes one attempt, and `lost()` says it dropped: it retries after the backoff while `reconnect` is set, else fails the connection.
export function connection<T>(open: () => void, reconnect: boolean, idle = false) {
  const [last, setLast] = ownSignal<T | undefined>(undefined, { equals: false })
  const [status, setStatus] = ownSignal<ConnectionStatus>(idle ? 'idle' : 'connecting')
  const [error, setError] = ownSignal<ApiError | undefined>(undefined)
  const listeners = listenerSet<T>()
  let attempt = 0
  let cancel: (() => void) | undefined
  let waiting = false
  const ends: ((status: ConnectionStatus) => void)[] = []

  const stop = () => {
    waiting = false
    cancel?.()
  }

  const flush = (now: ConnectionStatus) => {
    if (now === 'done' || now === 'failed' || now === 'closed') {
      for (const then of ends.splice(0))
        then(now)
    }
  }

  // Leaves the state to `next` unless `close()` came first.
  const set = (next: ConnectionStatus) => {
    if (status() === 'closed' && next !== 'closed')
      return

    if (next === 'open')
      setError(undefined)

    setStatus(next)
    flush(next)
  }

  const fail = (failure: ApiError) => {
    if (status() === 'closed')
      return

    setError(failure)
    setStatus('failed')
    flush('failed')
  }

  const link = {
    last,
    status,
    pending: () => status() === 'connecting',
    error,
    on: listeners.on,
    // Calls `then` with how the connection ended (`done`, `failed` or `closed`), at once when it has.
    settled: (then: (status: ConnectionStatus) => void) => {
      ends.push(then)
      flush(untrack(status))
    },
    // Delivers a value to every listener; one that throws leaves the others and the connection alone.
    receive: (value: T) => {
      setLast(value)
      listeners.emit(value)
    },
    forget: () => setLast(undefined),
    set,
    // Ends the connection as failed, the failure kept for `error()` until it opens again.
    fail,
    // The connection is back: the next drop starts the backoff over.
    reset: () => {
      attempt = 0
    },
    // A start by the app, which a `close()` before it does not hold back; the caller runs `stop()` first, which cancels a pending retry.
    restart: () => {
      attempt = 0
      setStatus('connecting')
    },
    // The attempt dropped: tried again after the backoff, else failed with `failure`, which a connection that may not reconnect always gets.
    lost: (failure?: ApiError) => {
      if (!reconnect) {
        if (failure)
          link.fail(failure)

        return
      }

      if (failure)
        setError(failure)

      setStatus('connecting')
      waiting = true
      cancel = retryLater(attempt++, () => {
        waiting = false
        open()
      })
    },
    // Cancels the retry waiting.
    stop,
    // Tries again now: a retry waiting for its backoff is made at once, and a failed connection starts over by `again`, `open` unless given. Anything else is left as it is.
    retry: (again = open) => {
      if (untrack(status) === 'failed') {
        attempt = 0
        setStatus('connecting')
        again()
      }
      else if (waiting) {
        stop()
        open()
      }
    },
  }

  return link
}
