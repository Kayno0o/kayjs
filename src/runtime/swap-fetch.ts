import type { FetchedPage } from './navigation'
import { pageKey, prefetched } from './navigation'
import { NAVIGATE_HEADER, RELOAD_HEADER } from './swap'

const PREFETCH_TTL_MS = 30_000

// A page not answered after this long is loaded by the browser, which shows its own progress or error.
export const PAGE_TIMEOUT_MS = 10_000

export const HTML = /^text\/html\b/
const ISOLATING_EMBEDDERS = new Set(['require-corp', 'credentialless'])
// What follows a policy's value, such as `; report-to="endpoint"`.
const POLICY_PARAMS = /;.*/

// Fetches a link's page ahead of the click, kept a few seconds for it.
// A link opting out, or a `rel=nofollow` one such as a sign-out, which may do something once fetched, is followed when clicked, never ahead.
export function prefetch(url: URL, link: Element): void {
  if (link.closest('[data-no-prefetch],[rel~=nofollow]'))
    return

  const key = pageKey(url)
  const held = prefetched.get(key)

  if (held && Date.now() - held.at < PREFETCH_TTL_MS)
    return

  // Pages past their time go now, as nothing else asks for them.
  for (const [other, { at }] of prefetched) {
    if (Date.now() - at >= PREFETCH_TTL_MS)
      prefetched.delete(other)
  }

  const page = fetchPage(url)

  prefetched.set(key, { at: Date.now(), page })
  void forgetFailed(key, page)
}

// A prefetch that fails is fetched again by the navigation that wants it.
async function forgetFailed(key: string, page: Promise<FetchedPage>): Promise<void> {
  try {
    await page
  }
  catch {
    if (prefetched.get(key)?.page === page)
      prefetched.delete(key)
  }
}

async function fetchPage(url: URL, signal?: AbortSignal): Promise<FetchedPage> {
  const response = await fetch(pageKey(url), { headers: { accept: 'text/html', [NAVIGATE_HEADER]: '1' }, signal: signal ?? null })
  const type = response.headers.get('content-type') ?? ''

  const full = response.headers.has(RELOAD_HEADER) || (isSecureContext && isolated(response.headers) !== crossOriginIsolated)

  // A file the browser loads itself once the swap gives up on it, so it is not read twice, as is a page a redirect took to another site, whose markup the swap never runs.
  if (!HTML.test(type) || !ownOrigin(response.url)) {
    void response.body?.cancel()

    return { url: response.url, type, html: '' }
  }

  return { url: response.url, type, html: await response.text(), ...full && { full } }
}

export function ownOrigin(url: string): boolean {
  return new URL(url, location.href).origin === location.origin
}

// Whether a page with these headers is cross-origin isolated, as a secure document is with both policies set so.
function isolated(headers: Headers): boolean {
  const value = (name: string) => headers.get(name)?.replace(POLICY_PARAMS, '').trim()

  return value('cross-origin-opener-policy') === 'same-origin' && ISOLATING_EMBEDDERS.has(value('cross-origin-embedder-policy') ?? '')
}

// The page a navigation shows: one prefetched in the last few seconds, else fetched now.
export async function pageFor(url: URL, signal: AbortSignal): Promise<FetchedPage> {
  const key = pageKey(url)
  const held = prefetched.get(key)

  prefetched.delete(key)

  if (held && Date.now() - held.at < PREFETCH_TTL_MS) {
    try {
      return await held.page
    }
    catch {}
  }

  return fetchPage(url, signal)
}
