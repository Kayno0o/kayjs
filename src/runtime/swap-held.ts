import type { FetchedIsland } from './fetch-island'
import { ISLAND } from './markers'

const SERVER_ISLAND = 'slot[data-kay-server]'

// A deferred server island already fetched shows its render while the next page's copy of it is fetched, rather than the inert copy standing in for it: a post back to the same page keeps the island on screen, and the scroll with it. It stays inert until the fetch answers, and one the next page renders another copy of is replaced by it at once.
export function holdFetched(old: Element, body: Element): void {
  const fetched = new Map<string | undefined, FetchedIsland>()
  const active = document.activeElement

  for (const live of old.querySelectorAll<FetchedIsland>(SERVER_ISLAND)) {
    if (live._$b !== undefined && !live.hasAttribute('inert'))
      fetched.set(live.dataset.kayServer, live)
  }

  for (const placeholder of fetched.size === 0 ? [] : body.querySelectorAll<FetchedIsland>(SERVER_ISLAND)) {
    const live = fetched.get(placeholder.dataset.kayServer)
    const markup = placeholder.innerHTML

    if (live === undefined || live._$b !== markup)
      continue

    const focused = active instanceof HTMLElement && live.contains(active) ? active : undefined

    placeholder.replaceChildren(...live.childNodes)
    placeholder._$b = markup

    // The morph may keep the live element rather than the placeholder, so both carry it.
    if (focused) {
      live._$f = focused
      placeholder._$f = focused
    }

    // An island of the held render still waiting to hydrate never does: the next render replaces it.
    for (const island of placeholder.querySelectorAll<HTMLElement>(ISLAND)) {
      delete island.dataset.component
      delete island.dataset.chunk
    }
  }
}
