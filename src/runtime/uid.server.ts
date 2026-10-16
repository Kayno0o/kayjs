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

// A page render on the server: its static components draw from the page, each island from a prefix of its own.
export function pageIds<T>(run: () => T): T {
  const previous = page

  page = { token: fixedToken.getStore() ?? `k${Math.random().toString(36).slice(2, 8)}`, islands: 0 }

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
