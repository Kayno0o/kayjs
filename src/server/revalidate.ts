import type { ServedPage } from './render'
import type { Revalidation } from './stale-pages'
import { compressText, compressTextStrongest } from './compress'
import { readsOf } from './page-reads'
import { pageEtag, storedHeaders } from './prerendered'
import { invalidationCount, markPageStale, revalidationOf } from './stale-pages'

// After a render that failed, the longest a page waits before the next request tries again.
const RETRY_MS = 60_000

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

async function strengthen(page: ServedPage, html: string): Promise<void> {
  try {
    const encoded = await compressTextStrongest(html)

    // A render landing meanwhile keeps its own.
    if (page.html === html)
      page.encoded = encoded
  }
  catch {}
}

async function rerender(page: ServedPage, render: () => Promise<Response>, revalidation: Revalidation, report: (error: unknown) => void): Promise<void> {
  const started = invalidationCount()
  const period = page.revalidate === undefined ? Infinity : page.revalidate * 1000
  const failed = () => {
    revalidation.retryAt = Date.now() + Math.min(period, RETRY_MS)
    revalidation.staleAt = revalidation.retryAt
  }

  try {
    // The body is read within the scope, as a streamed block reads what it needs while it is read.
    const { result: { response, html }, reads, invalidated } = await readsOf(async () => {
      const rendered = await render()

      return { response: rendered, html: rendered.status >= 500 ? '' : await rendered.text() }
    })

    // The render reported its error already; the page as it was stays up.
    if (response.status >= 500) {
      failed()

      return
    }

    const encoded = await compressText(html)

    // All at once, so no request reads the new html with the old tag.
    Object.assign(page, { reads, html, encoded, status: response.status, headers: Object.entries(storedHeaders(response.headers)), etag: pageEtag(html), renderedAt: Date.now() })
    revalidation.renderedAfter = started
    revalidation.staleAt = Date.now() + period

    // A key the render read was invalidated before its reads were on the page, which no invalidation could find it by.
    if (invalidated)
      markPageStale(page)

    // The request waiting goes out with the quick copies; the next get the build's, as small as a page `kay build` wrote.
    void strengthen(page, html)
  }
  catch (error) {
    failed()
    report(error)
  }
  finally {
    revalidation.running = undefined
  }
}
