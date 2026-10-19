import { AsyncLocalStorage } from 'node:async_hooks'
import { freshPrefix, withIds } from './uid'

// The page the server is rendering: its token keeps ids apart from those of a page swapped out around a persistent island.
let page: { token: string, islands: number } | undefined
// A token to use in place of a random one, scoped to the render it wraps, so renders running together each keep their own.
const fixedToken = new AsyncLocalStorage<string>()

// Renders with the page's ids drawn from `token`, so two renders of a page that reads nothing give the same bytes.
export async function withPageToken<T>(token: string, run: () => Promise<T>): Promise<T> {
  return fixedToken.run(token, run)
}

// Whether a render already runs under a token, as a prerendered page's or a kept one's check does.
export function hasPageToken(): boolean {
  return fixedToken.getStore() !== undefined
}

// A page render on the server: its static components draw from the page, each island from a prefix of its own.
// A streamed block renders on its own, so under a fixed token its `salt`, the block's id, keeps its ids from those of the page.
export function pageIds<T>(run: () => T, salt?: string): T {
  const previous = page
  const fixed = fixedToken.getStore()
  const token = fixed === undefined ? `k${Math.random().toString(36).slice(2, 8)}` : `${fixed}${salt === undefined ? '' : `_${salt}`}`

  page = { token, islands: 0 }

  try {
    return withIds(`${page.token}-`, run)
  }
  finally {
    page = previous
  }
}

// The prefix of the next island the server renders, written on its slot.
export function islandPrefix(): string {
  return page ? `${page.token}-${page.islands++}-` : freshPrefix()
}
