import { createSignal, effect, onCleanup, ownSignal } from './reactive'

let shown: (() => boolean) | undefined

// Whether the tab shows, as one signal shared by whatever pauses while it is hidden; the listener is added on first use.
export function tabVisible(): boolean {
  if (!shown) {
    const [read, write] = createSignal(!document.hidden)

    document.addEventListener('visibilitychange', () => write(!document.hidden))
    shown = read
  }

  return shown()
}

// Whether the page is shown, `false` while its tab is in the background or its window minimised, as a value that follows it for as long as the island lives: `const shown = pageVisible()`, then `shown()`.
// The server, and the island's first render, read `fallback`, `true` by default; the browser's answer replaces it once mounted, so hydrating changes nothing.
// kept: free
export function pageVisible(fallback = true): () => boolean {
  const [visible, setVisible] = ownSignal(fallback)

  effect(() => {
    if (typeof document === 'undefined')
      return

    const change = () => setVisible(!document.hidden)

    change()
    document.addEventListener('visibilitychange', change)
    onCleanup(() => document.removeEventListener('visibilitychange', change))
  })

  return visible
}
