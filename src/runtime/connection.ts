import type { ApiError } from './api-error'
import type { ConnectionStatus } from './live'
import { ownSignal, untrack } from './reactive'

// The one place a connection is retried and its state kept: the reconnect, the backoff, the listeners and the status of `socket()`, `stream()`, the cached values a page follows and the live values.
// A leaf: only modules that open a connection import it, never the call result or the action call, which every page loads.

const RECONNECT_MS = 500
const MAX_RECONNECT_MS = 30_000
// How often a visible tab the browser says is offline tries anyway, as `navigator.onLine` can be wrong, behind some VPNs for one.
const OFFLINE_RETRY_MS = 60_000

// Runs `run` after the attempt's backoff, shortened by up to half at random so the clients a restart dropped together come back apart, and not before the tab is visible and online again; gives what cancels it.
export function retryLater(attempt: number, run: () => void): () => void {
  const delay = Math.min(RECONNECT_MS * 2 ** attempt, MAX_RECONNECT_MS)
  const asleep = () => typeof document !== 'undefined' && (document.hidden || navigator.onLine === false)
  // Read only once asleep, which a browser alone can be.
  const wakers = () => [[globalThis, 'online'], [document, 'visibilitychange']] as const
  let waiting = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let fallback: ReturnType<typeof setTimeout> | undefined

  function stopWaiting() {
    clearTimeout(fallback)

    if (!waiting)
      return

    waiting = false

    for (const [target, type] of wakers())
      target.removeEventListener(type, wake)
  }

  function rest() {
    clearTimeout(fallback)

    if (!document.hidden) {
      fallback = setTimeout(() => {
        stopWaiting()
        run()
      }, OFFLINE_RETRY_MS)
    }
  }

  function wake() {
    if (asleep()) {
      rest()

      return
    }

    stopWaiting()
    // The clients a network coming back, or a tab shown, wake together come back apart too.
    timer = setTimeout(run, Math.random() * RECONNECT_MS)
  }

  timer = setTimeout(() => {
    if (!asleep()) {
      run()

      return
    }

    waiting = true

    for (const [target, type] of wakers())
      target.addEventListener(type, wake)

    rest()
  }, delay - Math.random() * delay / 2)

  return () => {
    clearTimeout(timer)
    stopWaiting()
  }
}

// A set of listeners to call with a value, one throwing leaving the others alone; `on` gives what removes a listener.
export function listenerSet<T>(): { on: (listener: (value: T) => void) => () => void, emit: (value: T) => void } {
  const all = new Set<(value: T) => void>()

  return {
    on: (listener) => {
      all.add(listener)

      return () => void all.delete(listener)
    },
    emit: (value) => {
      for (const listener of all) {
        try {
          listener(value)
        }
        catch (error) {
          console.error(error)
        }
      }
    },
  }
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

  const stop = () => {
    waiting = false
    cancel?.()
  }

  // Leaves the state to `next` unless `close()` came first.
  const set = (next: ConnectionStatus) => {
    if (status() === 'closed' && next !== 'closed')
      return

    if (next === 'open')
      setError(undefined)

    setStatus(next)
  }

  const fail = (failure: ApiError) => {
    if (status() === 'closed')
      return

    setError(failure)
    setStatus('failed')
  }

  return {
    last,
    status,
    pending: () => status() === 'connecting',
    error,
    on: listeners.on,
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
          fail(failure)

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
}
