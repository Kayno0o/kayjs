// @kayjs/spa regions() client: a link or GET form with data-kay-target swaps one <Region> of the page, fetched alone.
// - a[data-kay-target] replaces the region; with data-kay-append the response is added to it and the clicked link goes (Load more)
// - form[data-kay-target] swaps on submit; with data-kay-live also while typing: one history entry per typing burst
// - [data-kay-sync="a b"] copies those query params of the current URL into links and fields outside the region
// - history push and back/forward re-fetch the region the entry changed; aria-busy while a fetch is slow
// - prefetch on hover and focus inside [data-kay-prefetch], through the cache spa() shares

import type { PrefetchEntry } from './prefetch'
import { announce } from './announcer'
import { fetchKeyOf, getCachedHtml, inflightPrefetch, prefetch, prefetchCache } from './prefetch'

const BUSY_DELAY = 150
const LIVE_DEBOUNCE = 200
const BURST_PAUSE = 1000

interface RegionState { __kayIdx: number, __kayRegion?: string | undefined }

interface Swap {
  url: URL
  region: string
  append?: boolean
  /** `burst`: pushed by the first change of a typing burst, replaced by the rest. */
  history: 'push' | 'replace' | 'burst' | 'none'
  /** Moves focus into the region (a link did it), not for a form the user is typing in. */
  focus?: boolean
  trigger?: Element
}

function stateOf(state: unknown): RegionState | undefined {
  return typeof state === 'object' && state !== null && typeof (state as RegionState).__kayIdx === 'number' ? state as RegionState : undefined
}

const controllers = new Map<string, AbortController>()
let idx = stateOf(typeof history === 'undefined' ? undefined : history.state)?.__kayIdx ?? 0
let lastRegion = stateOf(typeof history === 'undefined' ? undefined : history.state)?.__kayRegion
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

async function load(url: URL, region: string, signal: AbortSignal): Promise<PrefetchEntry | undefined> {
  const key = fetchKeyOf(url, region)
  const ready = getCachedHtml(key) ?? await inflightPrefetch.get(key)
  if (ready !== undefined) {
    prefetchCache.delete(key)
    return ready
  }
  const res = await fetch(fetchKeyOf(url), { headers: { 'x-kay-region': region }, signal })
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html'))
    return undefined
  return { html: await res.text(), url: res.url, ts: Date.now(), region: res.headers.get('x-kay-region'), title: res.headers.get('x-kay-title') }
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
  if (push) {
    // The entry left behind is stamped first, so back and forward can tell it from a page of another document.
    history.replaceState({ ...prev, __kayIdx: idx }, '')
    idx++
    history.pushState({ __kayIdx: idx, __kayRegion: around }, '', next)
  }
  else {
    history.replaceState({ ...prev, __kayIdx: idx, __kayRegion: around }, '', next)
  }
  lastRegion = around
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

function apply(region: HTMLElement, found: { content: DocumentFragment, title: string | undefined }, swap: Swap): void {
  const { content, title } = found
  if (swap.history !== 'none')
    record(swap.url, swap.region, swap.history)
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
  }
  if (title !== undefined)
    document.title = title
  syncParams()
  if (swap.focus === true)
    focusNode(swap.append ? first : region)
  const label = region.getAttribute('aria-label')
  if (label !== null)
    announce(label)
  window.dispatchEvent(new CustomEvent('kay:region', { detail: { name: swap.region, url: location.href } }))
}

async function swapRegion(swap: Swap): Promise<void> {
  const name = swap.region
  if (findRegion(name) === null) {
    location.assign(swap.url.href)
    return
  }
  controllers.get(name)?.abort()
  const controller = new AbortController()
  controllers.set(name, controller)
  const path = pathOf(findRegion(name)!)
  const busy = setTimeout(() => findRegion(name)?.setAttribute('aria-busy', 'true'), BUSY_DELAY)
  try {
    const entry = await load(swap.url, path, controller.signal)
    if (controller.signal.aborted)
      return
    const content = entry === undefined ? undefined : contentOf(entry, path)
    const region = findRegion(name)
    if (content === undefined || region === null) {
      location.assign(swap.url.href)
      return
    }
    apply(region, content, swap)
  }
  catch (err) {
    if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError'))
      return
    location.assign(swap.url.href)
  }
  finally {
    clearTimeout(busy)
    if (controllers.get(name) === controller) {
      controllers.delete(name)
      findRegion(name)?.removeAttribute('aria-busy')
    }
  }
}

function formUrl(form: HTMLFormElement, submitter?: HTMLElement | null): URL {
  const url = new URL(form.action, location.href)
  const params = new URLSearchParams()
  for (const [key, value] of new FormData(form, submitter ?? undefined)) {
    if (typeof value === 'string')
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
    if (url.origin !== location.origin || missingRegion(name, `<a href="${link.getAttribute('href')}">`))
      return
    event.preventDefault()
    const append = link.hasAttribute('data-kay-append')
    void swapRegion({ url, region: name, append, history: append ? 'replace' : 'push', focus: true, trigger: link })
  }, true)

  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement
    const name = form.getAttribute?.('data-kay-target')
    if (event.defaultPrevented || name === null || name === undefined || form.method !== 'get' || missingRegion(name, '<form>'))
      return
    event.preventDefault()
    clearTimeout(liveTimer)
    void swapRegion({ url: formUrl(form, (event as SubmitEvent).submitter), region: name, history: 'push' })
  }, true)

  document.addEventListener('input', (event) => {
    const form = (event.target as Element | null)?.closest?.<HTMLFormElement>('form[data-kay-live][data-kay-target]')
    if (form === null || form === undefined || form.method !== 'get')
      return
    clearTimeout(liveTimer)
    liveTimer = setTimeout(() => {
      const name = form.getAttribute('data-kay-target')!
      if (!missingRegion(name, '<form>'))
        void swapRegion({ url: formUrl(form), region: name, history: 'burst' })
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

  // spa() skips these entries: they carry __kayIdx.
  window.addEventListener('popstate', (event) => {
    const state = stateOf(event.state)
    if (state === undefined)
      return
    const name = state.__kayIdx < idx ? lastRegion : state.__kayRegion
    idx = state.__kayIdx
    lastRegion = state.__kayRegion
    burstOpen = false
    if (name === undefined)
      return
    void swapRegion({ url: new URL(location.href), region: name, history: 'none' })
  })
}
