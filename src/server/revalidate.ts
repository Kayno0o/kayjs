import type { ServedPage } from './render'
import { compressText } from './compress'
import { pageEtag, storedHeaders } from './prerender'

interface Revalidation {
  staleAt: number
  running: boolean
}

const revalidations = new WeakMap<ServedPage, Revalidation>()
// After a render that failed, the longest a page waits before the next request tries again.
const RETRY_MS = 60_000

// Once a page with a `revalidate` period is older than it, renders it again in the background, one render at a time; until that lands, every request gets the page as it was.
export function revalidateStale(page: ServedPage, render: () => Promise<Response>, report: (error: unknown) => void): void {
  if (page.revalidate === undefined)
    return

  const period = page.revalidate * 1000
  let revalidation = revalidations.get(page)

  if (!revalidation)
    revalidations.set(page, revalidation = { staleAt: (page.renderedAt ?? 0) + period, running: false })

  if (revalidation.running || Date.now() < revalidation.staleAt)
    return

  revalidation.running = true
  void rerender(page, render, period, revalidation, report)
}

async function rerender(page: ServedPage, render: () => Promise<Response>, period: number, revalidation: Revalidation, report: (error: unknown) => void): Promise<void> {
  try {
    const response = await render()

    // The render reported its error already; the page as it was stays up.
    if (response.status >= 500) {
      revalidation.staleAt = Date.now() + Math.min(period, RETRY_MS)

      return
    }

    const html = await response.text()
    const encoded = await compressText(html)

    // All at once, so no request reads the new html with the old tag.
    Object.assign(page, { html, encoded, status: response.status, headers: Object.entries(storedHeaders(response.headers)), etag: pageEtag(html), renderedAt: Date.now() })
    revalidation.staleAt = Date.now() + period
  }
  catch (error) {
    revalidation.staleAt = Date.now() + Math.min(period, RETRY_MS)
    report(error)
  }
  finally {
    revalidation.running = false
  }
}
