// @kayjs/spa client bootstrap:
// - Intercepts internal <a> clicks with AbortController cancellation (no dropped rapid clicks)
// - Diffs <head> stylesheets (zero-FOUC load-before-remove), <html lang>, <title>, meta/canonical tags
// - Preserves [data-persist] islands alive across View Transitions swaps
// - Restores scroll position on popstate, scrolls to #hash targets, manages focus & polite live announcements
// - Opt-in prefetch via [data-kay-prefetch] (bounded 8-entry / 15s TTL cache, respects Save-Data)

import { ANNOUNCER_ID, announce } from './announcer'
import { fetchKeyOf, getCachedHtml, inflightPrefetch, prefetch, prefetchCache } from './prefetch'

export { prefetch }

let activeController: AbortController | undefined
let currentDocKey = typeof location !== 'undefined' ? `${location.pathname}${location.search}` : ''

function isEligibleLink(link: HTMLAnchorElement): URL | undefined {
  if (link.target || link.hasAttribute('download') || link.hasAttribute('data-no-spa'))
    return undefined
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin)
    return undefined
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return undefined
  return url
}

function saveScrollState(): void {
  try {
    const prev = (history.state && typeof history.state === 'object') ? history.state as Record<string, unknown> : {}
    history.replaceState({ ...prev, __kayScrollY: window.scrollY }, '')
  }
  catch {}
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
      // Ensure required inline core <style> tags (e.g. kay-island display:contents) exist if navigating from an island-less page.
      const existingStyles = new Set([...document.head.querySelectorAll('style')].map(s => s.textContent ?? ''))
      for (const nextStyle of nextDoc.head.querySelectorAll('style')) {
        const txt = nextStyle.textContent ?? ''
        if (txt && !existingStyles.has(txt))
          document.head.appendChild(document.importNode(nextStyle, true))
      }
      // Sync <html lang>, <title>, and head metadata tags
      const nextLang = nextDoc.documentElement.getAttribute('lang')
      if (nextLang)
        document.documentElement.setAttribute('lang', nextLang)
      document.title = nextDoc.title

      for (const oldMeta of document.head.querySelectorAll(SYNC_HEAD_SELECTOR))
        oldMeta.remove()
      for (const nextMeta of nextDoc.head.querySelectorAll(SYNC_HEAD_SELECTOR))
        document.head.appendChild(document.importNode(nextMeta, true))
    },
  }
}

export async function navigate(url: string, push = true, restoreScrollY?: number): Promise<void> {
  // Abort any in-flight navigation so rapid clicks always win immediately
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller

  const targetUrl = new URL(url, location.href)
  const hash = targetUrl.hash
  const fetchKey = fetchKeyOf(targetUrl)

  try {
    let html: string
    let finalUrl: string

    const cached = getCachedHtml(fetchKey)
    if (cached !== undefined) {
      html = cached.html
      finalUrl = cached.url
      prefetchCache.delete(fetchKey)
    }
    else {
      const pending = inflightPrefetch.get(fetchKey)
      const prefetched = pending !== undefined ? await pending : undefined
      if (controller.signal.aborted)
        return
      if (prefetched !== undefined) {
        html = prefetched.html
        finalUrl = prefetched.url
        prefetchCache.delete(fetchKey)
      }
      else {
        const res = await fetch(fetchKey, {
          headers: { 'x-kay-spa': '1' },
          signal: controller.signal,
        })
        if (controller.signal.aborted)
          return
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) {
          location.assign(url)
          return
        }
        html = await res.text()
        finalUrl = res.url || fetchKey
      }
    }

    if (controller.signal.aborted)
      return

    const nextDoc = new DOMParser().parseFromString(html, 'text/html')
    resolveSuspenseTemplates(nextDoc)
    const headPrep = await prepareHeadStyles(nextDoc)
    if (controller.signal.aborted) {
      headPrep.abort()
      return
    }

    const nextFullUrl = hash && !finalUrl.includes('#') ? `${finalUrl}${hash}` : finalUrl
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
      if (push)
        history.pushState({ __kayScrollY: 0 }, '', nextFullUrl)
      currentDocKey = `${nextParsed.pathname}${nextParsed.search}`

      if (typeof restoreScrollY === 'number') {
        window.scrollTo(0, restoreScrollY)
      }
      else if (hash.length > 1) {
        let anchorId = hash.slice(1)
        try {
          anchorId = decodeURIComponent(anchorId)
        }
        catch {}
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

  window.addEventListener('popstate', (event) => {
    const nextDocKey = `${location.pathname}${location.search}`
    if (nextDocKey === currentDocKey)
      return
    const st = event.state as { __kayScrollY?: number, __kayIdx?: number } | null
    // An entry a region swap made belongs to regions().
    if (typeof st?.__kayIdx === 'number')
      return
    void navigate(location.href, false, typeof st?.__kayScrollY === 'number' ? st.__kayScrollY : 0)
  })
}
