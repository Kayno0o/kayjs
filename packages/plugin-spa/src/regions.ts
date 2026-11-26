// @kayjs/spa regions() client: a link or GET form with data-kay-target swaps one <Region> of the page, fetched alone.
// - a[data-kay-target] replaces the region; with data-kay-append the response is added to it and the clicked link goes (Load more)
// - form[data-kay-target] swaps on submit; with data-kay-live also while typing: one history entry per typing burst
// - [data-kay-sync="a b"] copies those query params of the current URL into links and fields outside the region
// - form[method=post][data-kay-target] posts through fetch, follows the redirect and swaps the region with the page it lands on
// - history push and back/forward re-fetch the region the entry changed; aria-busy while a fetch is slow
// - a swap runs in a view transition (not under reduced motion), keeps the scroll of [data-kay-keep-scroll] elements, resets the region's own, and moves aria-current to the links that match the new URL
// - a link to a #hash already on the page scrolls to it without a fetch; after a swap the page scrolls to the URL's hash
// - prefetch on hover and focus inside [data-kay-prefetch], through the cache spa() shares

import type { PrefetchEntry } from './prefetch'
import type { EntryScroll } from './swap'
import { announce } from './announcer'
import { fetchKeyOf, getCachedHtml, getDocId, inflightPrefetch, isSameDocRegionState, prefetch, prefetchCache } from './prefetch'
import { entryScroll, readScrolls, restoreScroll, saveScroll, swapInTransition, trackScroll, writeScrolls } from './swap'

const BUSY_DELAY = 150
const LIVE_DEBOUNCE = 200
const BURST_PAUSE = 1000

interface RegionState { __kayIdx: number, __kayDoc?: number | undefined, __kayRegion?: string | undefined }

function safeGetAttribute(el: Element, name: string): string | null {
  return Element.prototype.getAttribute.call(el, name)
}

interface Swap {
  url: URL
  region: string
  append?: boolean
  /** `burst`: pushed by the first change of a typing burst, replaced by the rest. */
  history: 'push' | 'replace' | 'burst' | 'none'
  /** Moves focus into the region (a link did it), not for a form the user is typing in. */
  focus?: boolean
  trigger?: Element
  /** Skips the prefetch cache: the region is redrawn because the server's state changed. */
  fresh?: boolean
  /** A form posted to `url`: the swap shows the page its redirect lands on. */
  post?: { form: HTMLFormElement, body: FormData }
  /** Where the post's redirect ended, once it did. */
  landed?: string
  /** The scroll a back or forward entry had, put back after the swap. */
  restore?: EntryScroll
}

function stateOf(state: unknown): RegionState | undefined {
  return typeof state === 'object' && state !== null && typeof (state as RegionState).__kayIdx === 'number' ? state as RegionState : undefined
}

const controllers = new Map<string, AbortController>()
let idx = stateOf(typeof history === 'undefined' ? undefined : history.state)?.__kayIdx ?? 0
let lastRegion = stateOf(typeof history === 'undefined' ? undefined : history.state)?.__kayRegion
// The page and query the document shows: an entry that differs from it only in its hash needs no fetch.
let shown = typeof location === 'undefined' ? '' : location.pathname + location.search
let burstOpen = false
let burstTimer: ReturnType<typeof setTimeout> | undefined
let liveTimer: ReturnType<typeof setTimeout> | undefined

function findRegion(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-kay-region="${name.replace(/["\\]/g, '\\$&')}"]`)
}

// A region's path from the outermost one around it: `results/sets` for `sets` inside `results`. The server renders through the outer ones.
function pathOf(region: HTMLElement): string {
  const names: string[] = []
  for (let el: Element | null = region; el !== null; el = el.parentElement?.closest('[data-kay-region]') ?? null)
    names.unshift(el.getAttribute('data-kay-region')!)
  return names.join('/')
}

async function load(swap: Swap, region: string, signal: AbortSignal): Promise<PrefetchEntry | undefined> {
  const { url, post } = swap
  const key = fetchKeyOf(url, region)
  const ready = swap.fresh === true || post !== undefined ? undefined : getCachedHtml(key) ?? await inflightPrefetch.get(key)
  if (ready !== undefined) {
    prefetchCache.delete(key)
    return ready
  }
  const res = await fetch(fetchKeyOf(url), { headers: { 'x-kay-region': region }, signal, ...(post === undefined ? {} : { method: 'POST', body: post.body }) })
  if (post !== undefined)
    swap.landed = res.url
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html'))
    return undefined
  return { html: await res.text(), url: res.url || fetchKeyOf(url), ts: Date.now(), region: res.headers.get('x-kay-region'), title: res.headers.get('x-kay-title') }
}

// The region's inner HTML and the page title: the answer itself when the server sent the region alone, else the region cut out of a full page (a prerendered page, a proxy that dropped the header).
function contentOf(entry: PrefetchEntry, path: string): { content: DocumentFragment, title: string | undefined } | undefined {
  const template = document.createElement('template')
  if (entry.region === path) {
    template.innerHTML = entry.html
    // The title is HTML text, percent-encoded in the header: a textarea unescapes it.
    const unescape = document.createElement('textarea')
    unescape.innerHTML = entry.title === null ? '' : decodeURIComponent(entry.title)
    return { content: template.content, title: entry.title === null ? undefined : unescape.value }
  }
  const page = new DOMParser().parseFromString(entry.html, 'text/html')
  const found = page.querySelector(`[data-kay-region="${path.split('/').at(-1)!.replace(/["\\]/g, '\\$&')}"]`)
  if (found === null)
    return undefined
  template.innerHTML = found.innerHTML
  return { content: template.content, title: page.title === '' ? undefined : page.title }
}

function record(url: URL, name: string, mode: 'push' | 'replace' | 'burst'): void {
  clearTimeout(burstTimer)
  // A replace inside the region the entry was made for keeps that region, so back and forward restore the whole of it.
  const before = stateOf(history.state)?.__kayRegion
  const around = mode === 'replace' && before !== undefined && before !== name && findRegion(before)?.contains(findRegion(name)) === true ? before : name
  let push = mode === 'push' || (mode === 'burst' && !burstOpen)
  if (mode === 'burst') {
    burstOpen = true
    burstTimer = setTimeout(() => { burstOpen = false }, BURST_PAUSE)
  }
  else {
    burstOpen = false
  }
  const next = `${url.pathname}${url.search}${url.hash}`
  if (next === `${location.pathname}${location.search}${location.hash}`)
    push = false
  const prev = (typeof history.state === 'object' && history.state !== null ? history.state : {}) as Record<string, unknown>
  const docId = getDocId()
  if (push) {
    // The entry left behind is stamped first, so back and forward can tell it from a page of another document.
    history.replaceState({ ...prev, __kayDoc: docId, __kayIdx: idx }, '')
    idx++
    history.pushState({ __kayDoc: docId, __kayIdx: idx, __kayRegion: around }, '', next)
  }
  else {
    history.replaceState({ ...prev, __kayDoc: docId, __kayIdx: idx, __kayRegion: around }, '', next)
  }
  lastRegion = around
  shown = url.pathname + url.search
}

function focusNode(el: Element | null | undefined): void {
  if (el === null || el === undefined)
    return
  if (!el.hasAttribute('tabindex'))
    el.setAttribute('tabindex', '-1')
  ;(el as HTMLElement).focus({ preventScroll: true })
}

// Links and fields the app marked data-kay-sync follow the URL the swap just set.
function syncParams(): void {
  const params = new URL(location.href).searchParams
  for (const el of document.querySelectorAll<HTMLElement>('[data-kay-sync]')) {
    if (el instanceof HTMLAnchorElement) {
      const url = new URL(el.href, location.href)
      if (url.origin !== location.origin)
        continue
      for (const name of (el.getAttribute('data-kay-sync') ?? '').split(/\s+/).filter(Boolean)) {
        url.searchParams.delete(name)
        for (const value of params.getAll(name))
          url.searchParams.append(name, value)
      }
      el.setAttribute('href', `${url.pathname}${url.search}${url.hash}`)
    }
    else if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && el !== document.activeElement) {
      el.value = params.get(el.name) ?? ''
    }
  }
}

// The links that point at the page the swap landed on say so; the ones that did and no longer do stop.
function syncCurrent(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (link.origin === location.origin && link.hash === '' && link.pathname + link.search === location.pathname + location.search)
      link.setAttribute('aria-current', 'page')
    else if (link.getAttribute('aria-current') === 'page')
      link.removeAttribute('aria-current')
  }
}

function elementOfHash(hash: string): HTMLElement | null {
  const raw = hash.slice(1)
  let id: string
  try {
    id = decodeURIComponent(raw)
  }
  catch {
    id = raw
  }
  return id === '' ? null : document.getElementById(id)
}

async function apply(region: HTMLElement, found: { content: DocumentFragment, title: string | undefined }, swap: Swap, finalUrl: URL): Promise<void> {
  const { content, title } = found
  // A typing burst and an append stay put: a transition freezes the page, and the field being typed in with it.
  const animate = !swap.append && swap.history !== 'burst' && swap.fresh !== true
  await swapInTransition(() => {
    if (swap.history !== 'none') {
      saveScroll()
      record(finalUrl, swap.region, swap.history)
    }
    const kept = readScrolls(false)
    const first = content.firstElementChild
    if (swap.append) {
      if (swap.trigger !== undefined && region.contains(swap.trigger))
        swap.trigger.remove()
      region.append(content)
    }
    else {
      // A fetch for a region about to be replaced must not land in the new one.
      for (const inner of region.querySelectorAll('[data-kay-region]'))
        controllers.get(inner.getAttribute('data-kay-region')!)?.abort()
      region.replaceChildren(content)
      writeScrolls(kept)
      if (swap.history !== 'none' && !region.hasAttribute('data-kay-keep-scroll'))
        region.scrollTop = 0
    }
    if (title !== undefined)
      document.title = title
    syncParams()
    syncCurrent()
    if (swap.restore !== undefined)
      restoreScroll(swap.restore)
    else if (!swap.append && swap.history !== 'none')
      elementOfHash(finalUrl.hash)?.scrollIntoView()
    if (swap.focus === true)
      focusNode(swap.append ? first : region)
    const label = region.getAttribute('aria-label')
    if (label !== null)
      announce(label)
    window.dispatchEvent(new CustomEvent('kay:region', { detail: { name: swap.region, url: location.href } }))
  }, animate)
}

// Resolves false when the region could not be swapped: no such region, a failed fetch, or an answer without it.
async function swapRegion(swap: Swap): Promise<boolean> {
  const name = swap.region
  if (findRegion(name) === null)
    return false
  controllers.get(name)?.abort()
  const controller = new AbortController()
  controllers.set(name, controller)
  const path = pathOf(findRegion(name)!)
  const busy = setTimeout(() => findRegion(name)?.setAttribute('aria-busy', 'true'), BUSY_DELAY)
  try {
    const entry = await load(swap, path, controller.signal)
    if (controller.signal.aborted)
      return true
    const content = entry === undefined ? undefined : contentOf(entry, path)
    const region = findRegion(name)
    if (entry === undefined || content === undefined || region === null)
      return false
    const finalUrl = entry.url ? new URL(entry.url, location.href) : swap.url
    if (finalUrl.origin !== location.origin)
      return false
    if (swap.url.hash && !finalUrl.hash)
      finalUrl.hash = swap.url.hash
    await apply(region, content, swap, finalUrl)
    return true
  }
  catch (err) {
    return controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')
  }
  finally {
    clearTimeout(busy)
    if (controllers.get(name) === controller) {
      controllers.delete(name)
      findRegion(name)?.removeAttribute('aria-busy')
    }
  }
}

// A swap a link, a form or history asked for: what cannot be swapped loads the whole page. A form already posted loads the page its redirect reached, never posts twice; one whose post never got an answer posts the plain way.
async function navigate(swap: Swap): Promise<void> {
  if (await swapRegion(swap))
    return
  if (swap.post === undefined)
    location.assign(swap.url.href)
  else if (swap.landed)
    location.assign(swap.landed)
  else
    swap.post.form.submit()
}

/** Redraws region `name` from the server at the current address, with no history entry and focus left where it is; rejects when the page has no such region, the fetch fails or the answer lacks it. */
export async function refreshRegion(name: string): Promise<void> {
  if (!await swapRegion({ url: new URL(location.href), region: name, history: 'none', fresh: true }))
    throw new Error(`kay: region "${name}" could not be redrawn from ${location.href}: render a <Region name="${name}"> on this page, and check the server answers it.`)
}

function formMethod(form: HTMLFormElement, submitter?: HTMLElement | null): string {
  const rawMethod = (submitter !== null && submitter !== undefined ? safeGetAttribute(submitter, 'formmethod') : null)
    ?? safeGetAttribute(form, 'method')
    ?? 'get'
  return rawMethod.toLowerCase()
}

function formAction(form: HTMLFormElement, submitter?: HTMLElement | null): URL {
  // Read raw attributes via Element.prototype.getAttribute so <input name="action"> cannot DOM-clobber form.action.
  const rawAction = (submitter !== null && submitter !== undefined ? safeGetAttribute(submitter, 'formaction') : null)
    ?? safeGetAttribute(form, 'action')
    ?? ''
  return new URL(rawAction, location.href)
}

function formUrl(form: HTMLFormElement, submitter?: HTMLElement | null): URL {
  const url = formAction(form, submitter)
  // A field left empty stays out of the address, so it names only the filters in use.
  const params = new URLSearchParams()
  for (const [key, value] of new FormData(form, submitter ?? undefined)) {
    if (typeof value === 'string' && value !== '')
      params.append(key, value)
  }
  url.search = params.toString()
  return url
}

function missingRegion(name: string, element: string): boolean {
  if (findRegion(name) !== null)
    return false
  console.error(`kay: ${element} targets the region "${name}", and this page has no <Region name="${name}">: add it, or fix the name. The link loads the whole page instead.`)
  return true
}

function linkOf(event: Event): HTMLAnchorElement | null {
  return (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href][data-kay-target]') ?? null
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return
    const link = linkOf(event)
    if (link === null || link.target !== '' || link.hasAttribute('download'))
      return
    const url = new URL(link.href, location.href)
    const name = link.getAttribute('data-kay-target')!
    const append = link.hasAttribute('data-kay-append')
    if (url.origin !== location.origin || missingRegion(name, `<a href="${link.getAttribute('href')}">`))
      return
    event.preventDefault()
    // A hash already on the page is a scroll, with the address keeping its page.
    if (!append && url.pathname === location.pathname && elementOfHash(url.hash) !== null) {
      location.hash = url.hash
      return
    }
    void navigate({ url, region: name, append, history: append ? 'replace' : 'push', focus: true, trigger: link })
  }, true)

  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement
    if (!(form instanceof HTMLFormElement))
      return
    const submitter = (event as SubmitEvent).submitter
    const name = safeGetAttribute(form, 'data-kay-target')
    const method = formMethod(form, submitter)
    if (event.defaultPrevented || name === null || (method !== 'get' && method !== 'post') || missingRegion(name, '<form>'))
      return
    event.preventDefault()
    clearTimeout(liveTimer)
    if (method === 'get')
      void navigate({ url: formUrl(form, submitter), region: name, history: 'push' })
    else
      void navigate({ url: formAction(form, submitter), region: name, history: 'push', post: { form, body: new FormData(form, submitter ?? undefined) } })
  }, true)

  document.addEventListener('input', (event) => {
    const form = (event.target as Element | null)?.closest?.<HTMLFormElement>('form[data-kay-live][data-kay-target]')
    if (form === null || form === undefined || formMethod(form) !== 'get')
      return
    clearTimeout(liveTimer)
    liveTimer = setTimeout(() => {
      const name = safeGetAttribute(form, 'data-kay-target')!
      if (!missingRegion(name, '<form>'))
        void navigate({ url: formUrl(form), region: name, history: 'burst' })
    }, LIVE_DEBOUNCE)
  })

  const onIntent = (event: Event) => {
    const link = linkOf(event)
    if (link === null || link.hasAttribute('data-no-prefetch') || link.closest('[data-kay-prefetch]') === null)
      return
    const url = new URL(link.href, location.href)
    if (url.origin === location.origin && `${url.pathname}${url.search}` !== `${location.pathname}${location.search}`)
      {
      const region = findRegion(link.getAttribute('data-kay-target')!)
      if (region !== null)
        void prefetch(url.href, pathOf(region))
    }
  }
  document.addEventListener('pointerover', onIntent, { passive: true })
  document.addEventListener('focusin', onIntent, { passive: true })

  // Keep region state aligned when spa() swaps to another document (including popstate back to a document with prior region entries).
  window.addEventListener('kay:navigate', () => {
    shown = location.pathname + location.search
    const st = stateOf(history.state)
    idx = st?.__kayIdx ?? 0
    lastRegion = st?.__kayRegion
    burstOpen = false
  })
  window.addEventListener('popstate', (event) => {
    if (!isSameDocRegionState(event.state))
      return
    const state = stateOf(event.state)
    const sameDocument = location.pathname + location.search === shown
    shown = location.pathname + location.search
    if (state === undefined)
      return
    const name = state.__kayIdx < idx ? lastRegion : state.__kayRegion
    idx = state.__kayIdx
    lastRegion = state.__kayRegion
    burstOpen = false
    const restore = entryScroll(event.state)
    if (name === undefined || sameDocument) {
      // With spa() the browser leaves the scroll to the page, a swap or not.
      if (restore !== undefined && history.scrollRestoration === 'manual')
        restoreScroll(restore)
      return
    }
    void navigate({ url: new URL(location.href), region: name, history: 'none', ...(restore === undefined ? {} : { restore }) })
  })
  trackScroll()
}
