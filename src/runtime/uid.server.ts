import { AsyncLocalStorage } from 'node:async_hooks'
import { freshPrefix, withIds } from './uid'

// The page the server is rendering: its token keeps ids apart from those of a page swapped out around a persistent island.
let page: { token: string, islands: number, kept: Map<string, number> } | undefined
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

  page = { token, islands: 0, kept: new Map() }

  try {
    return withIds(`${page.token}-`, run)
  }
  finally {
    page = previous
  }
}

// Islands rendered inside the slots of a `persist` island, which stay in the DOM with it: they count from its prefix, not from the page's.
let inSlots: { prefix: string, islands: number } | undefined

export function withSlotIslands<T>(prefix: string, run: () => T): T {
  const previous = inSlots

  inSlots = { prefix, islands: 0 }

  try {
    return run()
  }
  finally {
    inSlots = previous
  }
}

// The prefix of the next island the server renders, written on its slot.
// A `persist` island takes it from its key instead of its place, so the page that replaces one at the same URL, with the same token, cannot give another island the ids the kept one still holds.
export function islandPrefix(persist?: string): string {
  if (!page)
    return freshPrefix()

  if (inSlots)
    return `${inSlots.prefix}${inSlots.islands++}-`

  if (persist === undefined)
    return `${page.token}-${page.islands++}-`

  const seen = page.kept.get(persist) ?? 0

  page.kept.set(persist, seen + 1)

  return `${page.token}-p${Bun.hash(persist).toString(36)}${seen === 0 ? '' : `_${seen}`}-`
}
