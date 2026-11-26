// The fetch cache `spa()` and `regions()` share: a link inside [data-kay-prefetch] is fetched on hover or focus, and the swap that follows takes the answer from here.

export interface PrefetchEntry {
  html: string
  url: string
  ts: number
  /** The `x-kay-region` the server answered with: the region's HTML alone, not a whole page. */
  region: string | null
  /** The percent-encoded `x-kay-title` of a region answer: the title the page has at this URL. */
  title: string | null
  /** Response Content-Security-Policy header, used by spa() to detect blocked destination <style> tags. */
  csp?: string | null | undefined
}

const PREFETCH_TTL = 15_000
const PREFETCH_MAX = 8
export const prefetchCache = new Map<string, PrefetchEntry>()
export const inflightPrefetch = new Map<string, Promise<PrefetchEntry | undefined>>()

// Document generation counter shared by spa() and regions() so popstate separates same-doc region swaps from cross-doc page navigations.
function initialDocId(): number {
  const st = typeof history === 'undefined' ? undefined : history.state as { __kayDoc?: unknown } | null
  return typeof st?.__kayDoc === 'number' ? st.__kayDoc : 0
}

let currentDocId = initialDocId()
let maxDocId = currentDocId

export function getDocId(): number {
  return currentDocId
}

export function setDocId(id: number): void {
  currentDocId = id
  if (id > maxDocId)
    maxDocId = id
}

export function nextDocId(): number {
  return ++maxDocId
}

export function isSameDocRegionState(state: unknown): boolean {
  if (typeof state !== 'object' || state === null)
    return false
  const s = state as { __kayIdx?: unknown, __kayDoc?: unknown }
  return typeof s.__kayIdx === 'number' && (s.__kayDoc === undefined || s.__kayDoc === currentDocId)
}

/** The cache key of a page, or of one region of it, given by its path from the outermost region (`results/sets`). */
export function fetchKeyOf(url: URL, region?: string): string {
  const key = `${url.origin}${url.pathname}${url.search}`
  return region === undefined ? key : `${region} ${key}`
}

export function getCachedHtml(href: string): PrefetchEntry | undefined {
  const hit = prefetchCache.get(href)
  if (hit === undefined)
    return undefined
  if (Date.now() - hit.ts > PREFETCH_TTL) {
    prefetchCache.delete(href)
    return undefined
  }
  return hit
}

function putCachedHtml(href: string, entry: PrefetchEntry): void {
  prefetchCache.delete(href)
  prefetchCache.set(href, entry)
  if (prefetchCache.size > PREFETCH_MAX) {
    const oldest = prefetchCache.keys().next()
    if (!oldest.done)
      prefetchCache.delete(oldest.value)
  }
}

export async function prefetch(url: string, region?: string): Promise<void> {
  const clean = new URL(url, location.href)
  clean.hash = ''
  const key = fetchKeyOf(clean, region)
  if (getCachedHtml(key) !== undefined || inflightPrefetch.has(key))
    return
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (conn?.saveData)
    return

  const task = (async (): Promise<PrefetchEntry | undefined> => {
    try {
      const res = await fetch(clean.href, { headers: region === undefined ? { 'x-kay-spa': '1' } : { 'x-kay-region': region } })
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html'))
        return undefined
      const entry: PrefetchEntry = { html: await res.text(), url: res.url || clean.href, ts: Date.now(), region: res.headers.get('x-kay-region'), title: res.headers.get('x-kay-title'), csp: res.headers.get('content-security-policy') }
      putCachedHtml(key, entry)
      return entry
    }
    catch {
      return undefined
    }
    finally {
      inflightPrefetch.delete(key)
    }
  })()
  inflightPrefetch.set(key, task)
  await task
}
