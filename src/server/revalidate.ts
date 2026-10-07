import type { ServedPage } from './render'
import { broadcast, onPagesInvalidated } from '../runtime/cache'
import { compressText } from './compress'
import { pageEtag, storedHeaders } from './prerender'

interface Revalidation {
  // The invalidation count when the render of the page in place started: one named after that is not in it.
  renderedAfter: number
  // When its `revalidate` period runs out.
  staleAt: number
  // The invalidation count when `invalidatePage` last named it.
  invalidatedAt: number
  // After a render that failed, no request waits for another before this.
  retryAt: number
  running?: Promise<void>
}

const revalidations = new WeakMap<ServedPage, Revalidation>()
// The prerendered pages of every `pages()`, by path as the routes serve it.
const served = new Set<Map<string, ServedPage>>()
// After a render that failed, the longest a page waits before the next request tries again.
const RETRY_MS = 60_000
// Counts invalidations, telling one made before a render started from one made while it ran, which a clock may not.
let invalidations = 0

onPagesInvalidated((paths) => {
  markStale(path => paths.includes(path))
})

export function trackPrerendered(pages: Map<string, ServedPage>): void {
  served.add(pages)
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

function markStale(matches: (path: string) => boolean): string[] {
  const paths: string[] = []

  for (const pages of served) {
    for (const [path, page] of pages) {
      if (matches(path)) {
        revalidationOf(page).invalidatedAt = ++invalidations
        paths.push(path)
      }
    }
  }

  return paths
}

function revalidationOf(page: ServedPage): Revalidation {
  let revalidation = revalidations.get(page)

  if (!revalidation) {
    const renderedAt = page.renderedAt ?? 0

    revalidations.set(page, revalidation = { renderedAfter: invalidations, staleAt: page.revalidate === undefined ? Infinity : renderedAt + page.revalidate * 1000, invalidatedAt: 0, retryAt: 0 })
  }

  return revalidation
}

// A page `invalidatePage` named since its render is rendered again before this resolves, concurrent requests waiting for the same render. One older than its `revalidate` period is rendered again in the background, every request getting the page as it was until that lands.
export async function revalidateStale(page: ServedPage, render: () => Promise<Response>, report: (error: unknown) => void): Promise<void> {
  const revalidation = revalidationOf(page)
  const outdated = () => revalidation.invalidatedAt > revalidation.renderedAfter && Date.now() >= revalidation.retryAt

  // A render already running may have started before the page was named, and then lands outdated still: a second one follows it.
  for (let attempt = 0; attempt < 2 && outdated(); attempt++)
    await (revalidation.running ??= rerender(page, render, revalidation, report))

  if (!revalidation.running && Date.now() >= revalidation.staleAt)
    revalidation.running = rerender(page, render, revalidation, report)
}

async function rerender(page: ServedPage, render: () => Promise<Response>, revalidation: Revalidation, report: (error: unknown) => void): Promise<void> {
  const started = invalidations
  const period = page.revalidate === undefined ? Infinity : page.revalidate * 1000
  const failed = () => {
    revalidation.retryAt = Date.now() + Math.min(period, RETRY_MS)
    revalidation.staleAt = revalidation.retryAt
  }

  try {
    const response = await render()

    // The render reported its error already; the page as it was stays up.
    if (response.status >= 500) {
      failed()

      return
    }

    const html = await response.text()
    const encoded = await compressText(html)

    // All at once, so no request reads the new html with the old tag.
    Object.assign(page, { html, encoded, status: response.status, headers: Object.entries(storedHeaders(response.headers)), etag: pageEtag(html), renderedAt: Date.now() })
    revalidation.renderedAfter = started
    revalidation.staleAt = Date.now() + period
  }
  catch (error) {
    failed()
    report(error)
  }
  finally {
    revalidation.running = undefined
  }
}
