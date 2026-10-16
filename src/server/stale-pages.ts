import type { ServedPage } from './render'
import { broadcast, onKeysInvalidated, onPagesInvalidated } from '../runtime/cache'

// Kept apart from the renders that read it, so `kay/cache` loads these alone: `invalidatePage` is exported there.
export interface Revalidation {
  // The invalidation count when the render of the page in place started: one named after that is not in it.
  renderedAfter: number
  // When its `revalidate` period runs out.
  staleAt: number
  // The invalidation count when `invalidatePage` last named it.
  invalidatedAt: number
  // After a render that failed, no request waits for another before this.
  retryAt: number
  running?: Promise<void> | undefined
}

// The prerendered pages of every `pages()` still running, by path as the routes serve it, held weakly: an app nothing reaches any more, one that only ever answered through `handle()` say, lets go of its own.
const served = new Set<WeakRef<Map<string, ServedPage>>>()
// Counts invalidations, telling one made before a render started from one made while it ran, which a clock may not.
let invalidations = 0

export function invalidationCount(): number {
  return invalidations
}

onPagesInvalidated((paths) => {
  markStale(path => paths.includes(path))
})

// A page that read a key an invalidation drops is stale as a path `invalidatePage` names is: no call beside `invalidate` or `collection.invalidate()` is needed for what a page was built from.
onKeysInvalidated((matches) => {
  const keys = new Set<string>()

  markStale((_, page) => {
    const hit = page.reads?.filter(matches) ?? []

    for (const key of hit)
      keys.add(key)

    return hit.length > 0
  })

  return [...keys]
})

// A page `stale` picks waits for a fresh render on its first request, as one the build rendered for another site.
// Tracked from now, for an app answering through `handle()`; `release` lets go of the pages as their app stops, so `invalidatePage` no longer reaches them, and `track` takes them back as it starts again.
export function trackPrerendered(pages: Map<string, ServedPage>, stale: (page: ServedPage) => boolean = () => false): { track: () => void, release: () => void } {
  const held = new WeakRef(pages)
  const track = () => void served.add(held)

  track()

  for (const page of pages.values()) {
    if (stale(page))
      revalidationOf(page).invalidatedAt = ++invalidations
  }

  return { track, release: () => void served.delete(held) }
}

// Marks the prerendered page at `path`, or every one the function matches, as `/blog/` + anything, stale: the next request for it waits for a fresh render instead of getting it as it was.
// Paths are as the routes serve them, without the base, a locale's under its segment; every process sharing a `sqliteCache` marks the same pages.
export function invalidatePage(path: string | ((path: string) => boolean)): void {
  const marked = markStale(typeof path === 'string' ? candidate => candidate === path : path)
  // A path given as it is reaches the other processes even when this one serves no such page.
  const paths = typeof path === 'string' ? [path] : marked

  if (paths.length > 0)
    broadcast({ pages: paths })
}

function markStale(matches: (path: string, page: ServedPage) => boolean): string[] {
  const paths: string[] = []

  for (const held of served) {
    const pages = held.deref()

    if (!pages) {
      served.delete(held)

      continue
    }

    for (const [path, page] of pages) {
      if (matches(path, page)) {
        revalidationOf(page).invalidatedAt = ++invalidations
        paths.push(path)
      }
    }
  }

  return paths
}

export function revalidationOf(page: ServedPage): Revalidation {
  return page.revalidation ??= { renderedAfter: invalidations, staleAt: page.revalidate === undefined ? Infinity : (page.renderedAt ?? 0) + page.revalidate * 1000, invalidatedAt: 0, retryAt: 0 }
}
