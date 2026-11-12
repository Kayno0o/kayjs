import { effect, onCleanup, ownSignal } from './reactive'

// Whether the browser has a network connection, as a value that follows it for as long as the island lives: `const connected = online()`, then `connected()`.
// The server, and the island's first render, read `fallback`, `true` by default; the browser's answer replaces it once mounted, so hydrating changes nothing.
// Offline here is what the browser reports (`navigator.onLine`): a connection that reaches no server can still read online.
// kept: free
export function online(fallback = true): () => boolean {
  const [connected, setConnected] = ownSignal(fallback)

  effect(() => {
    if (typeof navigator === 'undefined' || typeof window === 'undefined')
      return

    const up = () => setConnected(true)
    const down = () => setConnected(false)

    setConnected(navigator.onLine)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    onCleanup(() => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    })
  })

  return connected
}
