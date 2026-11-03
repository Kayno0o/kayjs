import { ownSignal } from './reactive'

// The one place a connection is retried and its state kept: the reconnect, the backoff, the listeners and the status of `socket()`, `stream()`, the cached values a page follows and the live values.
// A leaf: only modules that open a connection import it, never the call result or the action call, which every page loads.

const MAX_RECONNECT_MS = 30_000
// How often a visible tab the browser says is offline tries anyway, as `navigator.onLine` can be wrong, behind some VPNs for one.
const OFFLINE_RETRY_MS = 60_000

export interface RetryOptions {
  // The backoff of the first attempt, doubled by each after it up to 30 seconds.
  firstMs: number
  // Whether a tab the browser says is offline waits for the network too, and not only for a hidden tab to show.
  waitOnline: boolean
}

// Runs `run` after the attempt's backoff, shortened by up to half at random so the clients a restart dropped together come back apart, and not before the tab is visible (and online, with `waitOnline`) again; gives what cancels it.
export function retryLater(attempt: number, run: () => void, { firstMs, waitOnline }: RetryOptions): () => void {
  const delay = Math.min(firstMs * 2 ** attempt, MAX_RECONNECT_MS)
  const asleep = () => typeof document !== 'undefined' && (document.hidden || (waitOnline && navigator.onLine === false))
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
    timer = setTimeout(run, Math.random() * firstMs)
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

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'done' | 'failed' | 'closed'

// The state a source that opens, delivers values and drops keeps: the listener set and the last value, the status as a signal and the backoff of a reconnect.
// `open` makes one attempt, and `lost()` says it dropped: it retries after the backoff while `reconnect` is set, else fails the connection.
export function connection<T>(open: () => void, reconnect: boolean, idle = false) {
  const [last, setLast] = ownSignal<T | undefined>(undefined, { equals: false })
  const [status, setStatus] = ownSignal<ConnectionState>(idle ? 'idle' : 'connecting')
  const listeners = listenerSet<T>()
  let attempt = 0
  let cancel: (() => void) | undefined

  return {
    last,
    status,
    on: listeners.on,
    // Delivers a value to every listener; one that throws leaves the others and the connection alone.
    receive: (value: T) => {
      setLast(value)
      listeners.emit(value)
    },
    forget: () => setLast(undefined),
    // Leaves the state to `next` unless `close()` came first.
    set: setStatus,
    // The connection is back: the next drop starts the backoff over.
    reset: () => {
      attempt = 0
    },
    // The attempt dropped: tried again after the backoff, else failed.
    lost: () => {
      if (!reconnect) {
        setStatus('failed')

        return
      }

      setStatus('connecting')
      cancel = retryLater(attempt++, open, { firstMs: 500, waitOnline: true })
    },
    // Cancels the retry waiting.
    stop: () => cancel?.(),
  }
}
