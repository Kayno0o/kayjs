import type { CheckedHref } from './checks'
import type { HistoryState, NavigationHooks, Swap } from './navigation'
import { withBase, withoutBase } from './base'
import { actionUrl, busyForms, dirtyGuard, dropScrollSave, historyState, leave, mayLeave, nativeSubmits, navigation, onScroll, pageKey, prefetched, restoreScroll, saveScroll, submitNatively, swappable, takeFormCheck, takeFormChecks } from './navigation'

// Swaps pages in place: a link or a form of the app fetches the next page from the server and puts it in this one, islands marked `persist` kept alive.
// Everything here runs in the browser only, started by the entry; without JavaScript links and forms load pages as they always did.
// This part only listens: the swap itself, in `./page-swap`, loads once a visitor points at a link or calls `navigate`, and form posting, in `./forms`, once a form takes focus or is submitted, so a page nobody leaves never fetches them.

export interface NavigateOptions {
  // Replaces the current history entry instead of adding one.
  replace?: boolean | undefined
}

// Query params to set on the current page, a null, undefined or empty one dropped.
export type QueryChanges = Readonly<Record<string, string | number | null | undefined>>

type Eagerness = 'conservative' | 'moderate' | 'eager' | false

const HOVER_DELAY_MS = 200
const SPECULATION = 'script[type="speculationrules"]'

let eagerness: Eagerness = false
let swapModule: Promise<typeof import('./page-swap')> | undefined
let formsModule: Promise<typeof import('./forms')> | undefined
// A traversal undone while the guards are asked about it: where it went, and how far.
let held: { url: URL, delta: number } | undefined
// A traversal the guards let through, made again.
let passing = false

// Takes over the links and forms of the app; called once by the entry.
export function startNavigation(given: NavigationHooks): void {
  if (navigation.hooks)
    return

  navigation.hooks = given
  navigation.navigate = navigate
  navigation.refresh = refresh
  eagerness = speculationEagerness()

  navigation.shown = pageKey(new URL(location.href))

  const saved = history.state as HistoryState | null

  // An entry this script made before: a reload, or back from another site, where the browser no longer restores the scroll.
  if (saved?.kay) {
    navigation.at = saved.at ?? 0
    scrollTo(...saved.scroll)
  }
  else {
    history.replaceState(historyState(), '')
  }

  // The swap would never use what the browser prefetches for a full load, so it prefetches the same links itself.
  for (const script of document.querySelectorAll(SPECULATION))
    script.remove()

  navigation.head = Array.from(document.head.children, element => [element, element.outerHTML])

  takeFormChecks(document)
  history.scrollRestoration = 'manual'
  document.addEventListener('click', onClick)
  document.addEventListener('submit', onSubmit)
  document.addEventListener('focusin', onFormFocus)
  window.addEventListener('popstate', onPopState)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('pagehide', saveScroll)
  // Pointing at a link, or pressing one on a touch screen, is the moment to fetch the swap: the click follows.
  document.addEventListener('pointerover', onPointLink, { passive: true })
  document.addEventListener('pointerdown', onPointLink, { passive: true })

  if (eagerness === 'conservative') {
    document.addEventListener('pointerdown', onPrefetchHint, { passive: true })
  }
  else if (eagerness !== false) {
    document.addEventListener('pointerover', onHover, { passive: true })
    document.addEventListener('focusin', onPrefetchHint)
  }
}

// The current page with `query` merged into its own, keeping the scroll and the focus as `refresh()` does: a filter or a sort picked in place.
export async function navigate(to: { query: QueryChanges }, options?: NavigateOptions): Promise<void>
// Goes to a page as following a link does: one of the app's swapped in place, under the site's mount point as a link is, another site's loaded. A literal path is checked as a link's is.
// Last, so a path no page serves is reported against it.
export async function navigate<const Href extends string>(href: Href & CheckedHref<Href>, options?: NavigateOptions): Promise<void>
export async function navigate(to: string | { query: QueryChanges }, options: NavigateOptions = {}): Promise<void> {
  if (typeof document === 'undefined')
    return

  // A query change keeps the path and the other params, and leaves the hash out.
  const url = new URL(typeof to === 'string' ? withBase(to) : location.pathname + location.search, location.href)

  if (typeof to !== 'string') {
    for (const [name, value] of Object.entries(to.query)) {
      if (value === null || value === undefined || value === '')
        url.searchParams.delete(name)
      else
        url.searchParams.set(name, String(value))
    }
  }

  if (!await mayLeave(url))
    return

  if (!navigation.hooks || !swappable(url)) {
    leave(url)

    return
  }

  const replace = options.replace === true

  await follow(url, typeof to === 'string' ? { intent: 'visit', replace } : { intent: 'query', replace, focused: document.activeElement })
}

// Runs the page's loads again and shows what they return, keeping scroll, focus and every island whose props did not change.
export async function refresh(): Promise<void> {
  if (typeof document === 'undefined')
    return

  if (!navigation.hooks) {
    navigation.released = true
    location.reload()

    return
  }

  prefetched.clear()
  await follow(new URL(location.href), { intent: 'refresh', focused: document.activeElement })
}

async function loadSwap(): Promise<typeof import('./page-swap')> {
  return swapModule ??= import('./page-swap')
}

async function loadForms(): Promise<typeof import('./forms')> {
  return formsModule ??= import('./forms')
}

// Fetched ahead of the click it hints at; one that fails to load leaves each click to load its page fully.
async function preloadSwap(): Promise<void> {
  try {
    await loadSwap()
  }
  catch {}
}

// Swaps the page in, or loads it fully when the swap cannot load: the browser keeps a module that failed as failed, so retrying is no use.
async function follow(url: URL, swap: Swap): Promise<void> {
  let swapper: typeof import('./page-swap')

  try {
    swapper = await loadSwap()
  }
  catch {
    // Going back made its entry already; a refresh loads the URL shown, which the browser replaces rather than adds an entry for.
    leave(url, swap.intent === 'traverse')

    return
  }

  await swapper.go(url, swap)
}

// How eagerly the server's speculation rules prefetch, which the swap follows.
function speculationEagerness(): Eagerness {
  const script = document.querySelector(SPECULATION)

  try {
    return (JSON.parse(script?.textContent ?? '') as { prefetch: { eagerness: Eagerness }[] }).prefetch[0]?.eagerness ?? false
  }
  catch {
    return false
  }
}

function linkOf(event: Event): HTMLAnchorElement | undefined {
  const link = (event.target as Element | null)?.closest?.('a[href]')

  return link instanceof HTMLAnchorElement ? link : undefined
}

// A link the swap may follow: a plain click on one of the app's pages, opening in this tab, with nothing opting it out.
function followable(link: HTMLAnchorElement): URL | undefined {
  if ((link.target !== '' && link.target !== '_self') || link.hasAttribute('download') || link.closest('[data-reload]'))
    return undefined

  const url = new URL(link.href)

  if (!swappable(url))
    return undefined

  // A jump within the page is the browser's own.
  if (url.hash !== '' && url.pathname === location.pathname && url.search === location.search)
    return undefined

  return url
}

function onClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return

  const link = linkOf(event)
  const url = link && followable(link)

  if (!url)
    return

  event.preventDefault()
  void followAsked(url)
}

async function followAsked(url: URL): Promise<void> {
  if (await mayLeave(url))
    await follow(url, { intent: 'visit' })
}

function onPopState(event: PopStateEvent): void {
  dropScrollSave()

  const saved = event.state as HistoryState | null
  const url = new URL(location.href)
  const swap: Swap = { intent: 'traverse', saved: saved?.kay ? saved.scroll : undefined }

  // Back on the page left, the traversal undone, whose guard asks now.
  if (held) {
    void traverseAsked(held.url, held.delta)
    held = undefined

    return
  }

  // Leaving with unsaved changes goes back to the page left first, so it keeps its URL while asked. An entry kay did not write tells no place, so it is let through.
  if (!passing && saved?.at !== undefined && saved.at !== navigation.at && pageKey(url) !== navigation.shown && dirtyGuard()) {
    held = { url, delta: saved.at - navigation.at }
    history.go(-held.delta)

    return
  }

  passing = false

  if (saved?.at !== undefined)
    navigation.at = saved.at

  if (pageKey(url) === navigation.shown)
    restoreScroll(swap.saved, url.hash)
  else
    void follow(url, swap)
}

async function traverseAsked(url: URL, delta: number): Promise<void> {
  if (await mayLeave(url)) {
    passing = true
    history.go(delta)
  }
}

function onPointLink(event: PointerEvent): void {
  const link = linkOf(event)

  if (link && followable(link))
    void preloadSwap()
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined

function onHover(event: PointerEvent): void {
  clearTimeout(hoverTimer)

  const link = linkOf(event)

  if (link)
    hoverTimer = setTimeout((target: HTMLAnchorElement) => void prefetch(target), eagerness === 'eager' ? 0 : HOVER_DELAY_MS, link)
}

function onPrefetchHint(event: Event): void {
  const link = linkOf(event)

  if (link)
    void prefetch(link)
}

async function prefetch(link: HTMLAnchorElement): Promise<void> {
  const url = link.closest('[data-no-prefetch]') ? undefined : followable(link)

  if (!url)
    return

  try {
    ;(await loadSwap()).prefetch(url)
  }
  catch {}
}

function onSubmit(event: SubmitEvent): void {
  const form = event.target as HTMLFormElement

  if (nativeSubmits.has(form)) {
    nativeSubmits.delete(form)

    return
  }

  if (event.defaultPrevented)
    return

  const url = actionUrl(form, event.submitter)

  if (!url)
    return

  event.preventDefault()

  if (busyForms.has(form))
    return

  void submit(form, event.submitter, url)
}

// The form is busy from its submit on, so a second submit while form posting or its checks load posts nothing.
async function submit(form: HTMLFormElement, submitter: HTMLElement | null, url: URL): Promise<void> {
  busyForms.add(form)

  let forms: typeof import('./forms')

  try {
    forms = await loadForms()
  }
  catch {
    busyForms.delete(form)
    submitNatively(form, submitter)

    return
  }

  await forms.submit(form, submitter, url)
}

// An island may render a form after the page loaded, taken once it gets focus.
function onFormFocus(event: FocusEvent): void {
  const form = event.target instanceof Element ? event.target.closest('form') : null

  if (form) {
    const url = actionUrl(form, null)

    takeFormCheck(form)
    void preloadChecks(url && withoutBase(url.pathname))
  }
}

// A form taking focus is about to be posted: form posting and its checks load then, so a page with no form never fetches them.
async function preloadChecks(action: string | undefined): Promise<void> {
  try {
    await (await loadForms()).preloadChecks(action)
  }
  catch {}
}
