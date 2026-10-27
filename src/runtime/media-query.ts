import { effect, onCleanup, ownSignal } from './reactive'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

// Whether a CSS media query matches, as a value that follows it for as long as the island lives: `const narrow = mediaQuery('(max-width: 40rem)')`, then `narrow()`.
// The query is read once. The server, and the island's first render, read `fallback`; the browser's answer replaces it once mounted, so hydrating changes nothing.
export function mediaQuery(query: string, fallback = false): () => boolean {
  const [matches, setMatches] = ownSignal(fallback)

  effect(() => {
    if (typeof matchMedia !== 'function')
      return

    const list = matchMedia(query)
    const change = (event: MediaQueryListEvent) => setMatches(event.matches)

    setMatches(list.matches)
    list.addEventListener('change', change)
    onCleanup(() => list.removeEventListener('change', change))
  })

  return matches
}

// Whether the visitor asked for less motion (`prefers-reduced-motion: reduce`), following a change while the page is open; `fallback` is what the server renders, `false` (motion) by default.
export function reducedMotion(fallback = false): () => boolean {
  return mediaQuery(REDUCED_MOTION, fallback)
}
