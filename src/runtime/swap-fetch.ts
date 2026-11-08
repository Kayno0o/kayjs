import type { FetchedPage, LateParts } from './navigation'
import { LATE_PART_END, SHELL_END, STREAMED_HEADER } from './markers'
import { pageKey, prefetched } from './navigation'
import { LOADS_HEADER, NAVIGATE_HEADER, RELOAD_HEADER } from './swap'
import { bounded, inFlight, LATE } from './swap-flight'

const PREFETCH_TTL_MS = 30_000

// A page not answered after this long is loaded by the browser, which shows its own progress or error; a streamed page not sending a byte this long stops being read. `client.pageTimeout` sets it.
export const PAGE_TIMEOUT_MS = 10_000

export function pageTimeout(): number {
  return Number(document.querySelector<HTMLMetaElement>('meta[name="kay-page-timeout"]')?.content) || PAGE_TIMEOUT_MS
}

export const HTML = /^text\/html\b/
const ISOLATING_EMBEDDERS = new Set(['require-corp', 'credentialless'])
// What follows a policy's value, such as `; report-to="endpoint"`.
const POLICY_PARAMS = /;.*/

// Fetches a link's page ahead of the click, kept a few seconds for it.
// A link opting out, or a `rel=nofollow` one such as a sign-out, which may do something once fetched, is followed when clicked, never ahead.
export function prefetch(url: URL, link: Element): void {
  // The nearest `data-prefetch` decides, so an inner `eager` link stays prefetched under a container saying `false`.
  if (link.closest('[data-no-prefetch],[rel~=nofollow]') || link.closest('[data-prefetch]')?.getAttribute('data-prefetch') === 'false')
    return

  const key = pageKey(url)
  const held = prefetched.get(key)

  // A navigation fetching the page is the one request for it.
  if (inFlight.fetch?.key === key || (held && Date.now() - held.at < PREFETCH_TTL_MS))
    return

  // Pages past their time go now, as nothing else asks for them.
  for (const [other, { at }] of prefetched) {
    if (Date.now() - at >= PREFETCH_TTL_MS)
      prefetched.delete(other)
  }

  const page = fetchPage(url, undefined, undefined, true)

  prefetched.set(key, { at: Date.now(), page })
  void forgetFailed(key, page)
  // A streamed page nobody followed is not read on.
  setTimeout(() => void discard(key, page), PREFETCH_TTL_MS)
}

// The prefetched pages a navigation took, whose stream is its to read or stop.
const claimed = new WeakSet<Promise<FetchedPage>>()

async function discard(key: string, page: Promise<FetchedPage>): Promise<void> {
  if (prefetched.get(key)?.page === page)
    prefetched.delete(key)

  if (claimed.has(page))
    return

  try {
    (await page).late?.stop()
  }
  catch {}
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

// A page asked to stream ends at its shell, with the rest left to `late`; otherwise it is read whole.
export async function fetchPage(url: URL, signal?: AbortSignal, loads?: readonly string[], streaming = false): Promise<FetchedPage> {
  // The page asked for some of its loads is not the page: the browser's cache neither serves nor keeps it.
  const response = await fetch(pageKey(url), { headers: { accept: 'text/html', [NAVIGATE_HEADER]: '1', ...loads && { [LOADS_HEADER]: loads.join(',') } }, signal: signal ?? null, ...loads && { cache: 'no-store' } })
  const type = response.headers.get('content-type') ?? ''

  // A page that answers some of its loads is the same page still: a redirect, or another status, is for the whole page to show, since the placeholders it may hold stand for elements of the page asked.
  if (loads && (!response.ok || response.redirected || (response.url !== '' && pageKey(new URL(response.url)) !== pageKey(url)))) {
    void response.body?.cancel()

    return fetchPage(url, signal, undefined, streaming)
  }

  const full = response.headers.has(RELOAD_HEADER) || (isSecureContext && isolated(response.headers) !== crossOriginIsolated)

  // A file the browser loads itself once the swap gives up on it, so it is not read twice, as is a page a redirect took to another site, whose markup the swap never runs.
  if (!HTML.test(type) || !ownOrigin(response.url)) {
    void response.body?.cancel()

    return { url: response.url, type, html: '' }
  }

  // Only a response that says it streams is searched for the end of its shell.
  const streamed = response.headers.has(STREAMED_HEADER)

  if (streaming && streamed && response.body) {
    const { html, late } = await shellOf(response.body.getReader())

    return { url: response.url, type, html, ...late && { late }, ...full && { full } }
  }

  const text = await response.text()

  return { url: response.url, type, html: streamed ? text.replace(SHELL_END, '') : text, ...full && { full } }
}

async function cancelled(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  }
  catch {}
}

// Reads the body up to the end of the shell, which a page streaming `await` blocks marks right after it: what follows is read part by part, as the swap asks.
// A page without the mark is read to its end.
async function shellOf(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ html: string, late?: LateParts }> {
  const decoder = new TextDecoder()
  let text = ''

  for (;;) {
    const chunk = await reader.read()
    const before = text.length

    text += decoder.decode(chunk.value, { stream: !chunk.done })

    const end = text.indexOf(SHELL_END, Math.max(0, before - SHELL_END.length))

    if (end !== -1) {
      const after = text.slice(end + SHELL_END.length)
      // The parts that came with the shell are part of the page shown, folded in before its first paint.
      const done = after.lastIndexOf(LATE_PART_END)
      const cut = done === -1 ? 0 : done + LATE_PART_END.length
      let rest = after.slice(cut)
      const late: LateParts = {
        stopped: false,
        followed: false,
        async read() {
          for (;;) {
            const at = rest.indexOf(LATE_PART_END)

            if (at !== -1) {
              const part = rest.slice(0, at + LATE_PART_END.length)

              rest = rest.slice(at + LATE_PART_END.length)

              return part
            }

            const limit = pageTimeout()
            const next = await bounded(reader.read(), limit)

            if (next === LATE)
              throw new Error(`kay: the page stopped streaming for ${limit} ms`)

            if (next.done)
              return undefined

            rest += decoder.decode(next.value, { stream: true })
          }
        },
        stop() {
          late.stopped = true
          void cancelled(reader)
        },
      }

      return { html: text.slice(0, end) + after.slice(0, cut), late }
    }

    if (chunk.done)
      return { html: text }
  }
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
export async function pageFor(url: URL, signal: AbortSignal, loads?: readonly string[]): Promise<FetchedPage> {
  if (loads)
    return fetchPage(url, signal, loads)

  const key = pageKey(url)
  const held = prefetched.get(key)

  prefetched.delete(key)

  if (held && Date.now() - held.at < PREFETCH_TTL_MS) {
    claimed.add(held.page)

    try {
      return await held.page
    }
    catch {}
  }

  return fetchPage(url, signal, undefined, true)
}
