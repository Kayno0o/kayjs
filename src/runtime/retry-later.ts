// The reconnect of every connection a page opens, apart from connection.ts so the cached values a page follows reach it without the rest of that module.

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
