// @kayjs/spa client bootstrap:
// - Intercepts internal <a> clicks with AbortController cancellation (no dropped rapid clicks)
// - Diffs <head> stylesheets (zero-FOUC load-before-remove), <html lang>, <title>, meta/canonical tags
// - Preserves [data-persist] islands alive across View Transitions swaps
// - Restores scroll position on popstate, scrolls to #hash targets, manages focus & polite live announcements
// - Opt-in prefetch via [data-kay-prefetch] (bounded 8-entry / 15s TTL cache, respects Save-Data)

import { ANNOUNCER_ID, announce } from './announcer'
import { fetchKeyOf, getCachedHtml, getDocId, inflightPrefetch, isSameDocRegionState, nextDocId, prefetch, prefetchCache, setDocId } from './prefetch'

export { prefetch }

let activeController: AbortController | undefined
let currentDocKey = typeof location !== 'undefined' ? `${location.pathname}${location.search}` : ''

// Framework inline styles shipped in kay-island.css so SPA navigation never injects unhashed <style> tags.
const KAY_BUILTIN_STYLES = new Set([
  'kay-island,kay-slot{display:contents}',
  'kay-s{display:contents}',
])

// One-time token and OAuth redirect endpoints must hit the server once via normal navigation, never via SPA fetch.
const SKIP_SPA_PATH_RE = /(?:^|\/)auth\/(?:oauth(?:\/|$)|verify-email(?:\/|$)|magic-link\/verify(?:\/|$))/

// Inline <style> blocks present on initial document load already have their SHA-256 hashes in this document's CSP.
const initialInlineStyles = new Set<string>(
  typeof document !== 'undefined'
    ? [...document.querySelectorAll('style')].map(s => s.textContent ?? '').filter(Boolean)
    : [],
)

function hasStrictStyleCsp(csp: string | null | undefined): boolean {
  if (!csp)
    return false
  const directives = new Map<string, string>()
  for (const part of csp.split(';')) {
    const trimmed = part.trim()
    if (!trimmed)
      continue
    const space = trimmed.search(/\s/)
    const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
    const value = space === -1 ? '' : trimmed.slice(space + 1)
    if (!directives.has(name))
      directives.set(name, value)
  }
  const effective = directives.get('style-src-elem') ?? directives.get('style-src') ?? directives.get('default-src')
  return effective !== undefined && !effective.includes("'unsafe-inline'")
}

function hasBlockedInlineStyle(nextDoc: Document, csp: string | null | undefined): boolean {
  if (!hasStrictStyleCsp(csp))
    return false
  for (const style of nextDoc.querySelectorAll('style')) {
    const txt = style.textContent ?? ''
    if (txt && !KAY_BUILTIN_STYLES.has(txt) && !initialInlineStyles.has(txt))
      return true
  }
  return false
}

function isEligibleLink(link: HTMLAnchorElement): URL | undefined {
  if (link.target || link.hasAttribute('download') || link.hasAttribute('data-no-spa'))
    return undefined
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin)
    return undefined
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return undefined
  if (SKIP_SPA_PATH_RE.test(url.pathname))
    return undefined
  return url
}

function saveScrollState(): void {
  try {
    const prev = (history.state && typeof history.state === 'object') ? history.state as Record<string, unknown> : {}
    history.replaceState({ ...prev, __kayDoc: getDocId(), __kayScrollY: window.scrollY }, '')
  }
  catch {
    // Restricted history API environments (e.g. sandboxed iframes) ignore state updates.
  }
}

const SYNC_HEAD_SELECTOR = 'meta[name="description"],meta[name="robots"],meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"],link[rel="alternate"][hreflang],script[type="application/ld+json"]'

function resolveSuspenseTemplates(doc: Document): void {
  for (const tpl of doc.querySelectorAll<HTMLTemplateElement>('template[data-ks]')) {
    const id = tpl.dataset.ks
    if (!id)
      continue
    const slot = doc.getElementById(`k-s-${id}`)
    if (slot !== null) {
      slot.replaceWith(tpl.content)
      tpl.remove()
    }
  }
}

function focusPrimaryLandmark(): void {
  const target = document.querySelector<HTMLElement>('main') ?? document.querySelector<HTMLElement>('h1')
  if (target === null)
    return
  if (!target.hasAttribute('tabindex'))
    target.setAttribute('tabindex', '-1')
  try {
    target.focus({ preventScroll: true })
  }
  catch {
    target.focus()
  }
}

async function prepareHeadStyles(nextDoc: Document): Promise<{ commit: () => void, abort: () => void }> {
  const currentLinks = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
  const currentByHref = new Map<string, HTMLLinkElement>()
  for (const el of currentLinks)
    currentByHref.set(el.getAttribute('href') ?? '', el)

  const nextHrefs = new Set<string>()
  const added: HTMLLinkElement[] = []
  const waitLoads: Promise<void>[] = []

  for (const nextEl of nextDoc.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const href = nextEl.getAttribute('href') ?? ''
    if (!href)
      continue
    nextHrefs.add(href)
    if (!currentByHref.has(href)) {
      const clone = document.createElement('link')
      clone.rel = 'stylesheet'
      clone.href = href
      waitLoads.push(new Promise<void>((resolve) => {
        clone.addEventListener('load', () => resolve(), { once: true })
        clone.addEventListener('error', () => resolve(), { once: true })
      }))
      document.head.appendChild(clone)
      added.push(clone)
    }
  }

  if (waitLoads.length > 0)
    await Promise.race([Promise.all(waitLoads), new Promise<void>(r => setTimeout(r, 1500))])

  return {
    abort() {
      for (const el of added)
        el.remove()
    },
    commit() {
      for (const [href, el] of currentByHref) {
        if (!nextHrefs.has(href))
          el.remove()
      }
      // Sync non-builtin <head> <style> tags (skipping kay-island/kay-s styles already covered by kay-island.css).
      const nextHeadStyles = new Set<string>()
      for (const nextStyle of nextDoc.head.querySelectorAll('style')) {
        const txt = nextStyle.textContent ?? ''
        if (txt && !KAY_BUILTIN_STYLES.has(txt))
          nextHeadStyles.add(txt)
      }
      const existingStyles = new Set<string>()
      for (const curStyle of document.head.querySelectorAll('style')) {
        const txt = curStyle.textContent ?? ''
        if (!KAY_BUILTIN_STYLES.has(txt) && !nextHeadStyles.has(txt))
          curStyle.remove()
        else if (txt)
          existingStyles.add(txt)
      }
      for (const nextStyle of nextDoc.head.querySelectorAll('style')) {
        const txt = nextStyle.textContent ?? ''
        if (txt && !KAY_BUILTIN_STYLES.has(txt) && !existingStyles.has(txt)) {
          document.head.appendChild(document.importNode(nextStyle, true))
          existingStyles.add(txt)
        }
      }
      // Sync <html lang>, <html dir>, <title>, and head metadata tags
      const nextLang = nextDoc.documentElement.getAttribute('lang')
      if (nextLang)
        document.documentElement.setAttribute('lang', nextLang)
      const nextDir = nextDoc.documentElement.getAttribute('dir')
      if (nextDir)
        document.documentElement.setAttribute('dir', nextDir)
      else
        document.documentElement.removeAttribute('dir')
      document.title = nextDoc.title

      for (const oldMeta of document.head.querySelectorAll(SYNC_HEAD_SELECTOR))
        oldMeta.remove()
      for (const nextMeta of nextDoc.head.querySelectorAll(SYNC_HEAD_SELECTOR))
        document.head.appendChild(document.importNode(nextMeta, true))
    },
  }
}

async function fetchPageHtml(fetchKey: string, signal: AbortSignal): Promise<{ html: string, url: string, csp: string | null | undefined } | undefined> {
  const cached = getCachedHtml(fetchKey)
  if (cached !== undefined) {
    prefetchCache.delete(fetchKey)
    return { html: cached.html, url: cached.url, csp: cached.csp }
  }
  const pending = inflightPrefetch.get(fetchKey)
  const prefetched = pending !== undefined ? await pending : undefined
  if (signal.aborted)
    return undefined
  if (prefetched !== undefined) {
    prefetchCache.delete(fetchKey)
    return { html: prefetched.html, url: prefetched.url, csp: prefetched.csp }
  }
  const res = await fetch(fetchKey, {
    headers: { 'x-kay-spa': '1' },
    signal,
  })
  if (signal.aborted)
    return undefined
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html'))
    return undefined
  return { html: await res.text(), url: res.url || fetchKey, csp: res.headers.get('content-security-policy') }
}

export async function navigate(url: string, push = true, restoreScrollY?: number, targetDocId?: number): Promise<void> {
  // Abort any in-flight navigation so rapid clicks always win immediately
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller

  const targetUrl = new URL(url, location.href)
  const hash = targetUrl.hash
  const fetchKey = fetchKeyOf(targetUrl)

  try {
    const fetched = await fetchPageHtml(fetchKey, controller.signal)
    if (controller.signal.aborted)
      return
    if (fetched === undefined) {
      location.assign(url)
      return
    }
    const { html, url: finalUrl, csp } = fetched

    const nextDoc = new DOMParser().parseFromString(html, 'text/html')
    resolveSuspenseTemplates(nextDoc)

    const nextFullUrl = hash && !finalUrl.includes('#') ? `${finalUrl}${hash}` : finalUrl
    if (hasBlockedInlineStyle(nextDoc, csp)) {
      if (push)
        location.assign(nextFullUrl)
      else
        location.reload()
      return
    }

    const headPrep = await prepareHeadStyles(nextDoc)
    if (controller.signal.aborted) {
      headPrep.abort()
      return
    }

    const nextParsed = new URL(nextFullUrl, location.href)

    const applySwap = () => {
      if (push)
        saveScrollState()

      const existingAnnouncer = document.getElementById(ANNOUNCER_ID)

      // Preserve live [data-persist] elements (e.g. persistent audio player or counter island) across navigations
      const persisted = new Map<string, Element>()
      for (const el of document.querySelectorAll('[data-persist]')) {
        const key = el.getAttribute('data-persist')
        if (key)
          persisted.set(key, el)
      }

      headPrep.commit()

      for (const incoming of nextDoc.querySelectorAll('[data-persist]')) {
        const key = incoming.getAttribute('data-persist')
        const existing = key ? persisted.get(key) : undefined
        if (existing !== undefined)
          incoming.replaceWith(existing)
      }

      if (existingAnnouncer !== null)
        nextDoc.body.appendChild(existingAnnouncer)

      document.body.replaceWith(nextDoc.body)
      if (push) {
        const newDocId = nextDocId()
        setDocId(newDocId)
        history.pushState({ __kayDoc: newDocId, __kayScrollY: 0 }, '', nextFullUrl)
      }
      else {
        setDocId(targetDocId ?? nextDocId())
      }
      currentDocKey = `${nextParsed.pathname}${nextParsed.search}`

      if (typeof restoreScrollY === 'number') {
        window.scrollTo(0, restoreScrollY)
      }
      else if (hash.length > 1) {
        let anchorId = hash.slice(1)
        try {
          anchorId = decodeURIComponent(anchorId)
        }
        catch {
          // Malformed percent-encoding in hash: use the raw fragment id.
        }
        const anchor = document.getElementById(anchorId)
        if (anchor !== null)
          anchor.scrollIntoView()
        else
          window.scrollTo(0, 0)
      }
      else {
        window.scrollTo(0, 0)
      }

      focusPrimaryLandmark()
      announce(document.title)

      window.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: nextFullUrl } }))
    }

    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
    if (typeof doc.startViewTransition === 'function')
      doc.startViewTransition(applySwap)
    else
      applySwap()
  }
  catch (err) {
    if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError'))
      return
    location.assign(url)
  }
  finally {
    if (activeController === controller)
      activeController = undefined
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return
    const target = event.target as Element | null
    const link = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link)
      return
    const url = isEligibleLink(link)
    if (url === undefined)
      return
    if (url.pathname === location.pathname && url.search === location.search && url.hash)
      return

    event.preventDefault()
    void navigate(url.href, true)
  })

  const onIntent = (event: Event) => {
    const target = event.target as Element | null
    const link = target?.closest?.('a[href]') as HTMLAnchorElement | null
    // A region link prefetches its region alone, in regions().
    if (!link || link.hasAttribute('data-no-prefetch') || link.hasAttribute('data-kay-target'))
      return
    // Prefetch is strictly opt-in via [data-kay-prefetch] so side-effecting links like /logout are never prefetched
    if (link.closest('[data-kay-prefetch]') === null)
      return
    const url = isEligibleLink(link)
    if (url === undefined)
      return
    if (url.pathname === location.pathname && url.search === location.search)
      return
    void prefetch(url.href)
  }

  document.addEventListener('pointerover', onIntent, { passive: true })
  document.addEventListener('focusin', onIntent, { passive: true })

  // A region swap moves the address too, so a later #hash entry of that address is no new page.
  window.addEventListener('kay:region', () => { currentDocKey = `${location.pathname}${location.search}` })
  window.addEventListener('popstate', (event) => {
    const nextDocKey = `${location.pathname}${location.search}`
    if (nextDocKey === currentDocKey)
      return
    const st = event.state as { __kayScrollY?: number, __kayIdx?: number, __kayDoc?: number } | null
    // Only same-document region swaps belong to regions(); cross-document entries (even with __kayIdx) belong to spa().
    if (isSameDocRegionState(st))
      return
    const targetDocId = typeof st?.__kayDoc === 'number' ? st.__kayDoc : undefined
    void navigate(location.href, false, typeof st?.__kayScrollY === 'number' ? st.__kayScrollY : 0, targetDocId)
  })
}
