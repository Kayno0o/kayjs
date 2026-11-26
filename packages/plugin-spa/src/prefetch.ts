// The fetch cache `spa()` and `regions()` share: a link inside [data-kay-prefetch] is fetched on hover or focus, and the swap that follows takes the answer from here.

export interface PrefetchEntry {
  html: string
  url: string
  ts: number
  /** The `x-kay-region` the server answered with: the region's HTML alone, not a whole page. */
  region: string | null
}

const PREFETCH_TTL = 15_000
const PREFETCH_MAX = 8
export const prefetchCache = new Map<string, PrefetchEntry>()
export const inflightPrefetch = new Map<string, Promise<PrefetchEntry | undefined>>()

/** The cache key of a page, or of one region of it. */
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
      const entry: PrefetchEntry = { html: await res.text(), url: res.url || clean.href, ts: Date.now(), region: res.headers.get('x-kay-region') }
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
