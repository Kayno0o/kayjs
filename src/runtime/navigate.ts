import type { HeadElement, HistoryState, NavigationHooks, Swap } from './navigation'
import { dirtyGuard, dropScrollSave, historyState, leave, mayLeave, navigation, onScroll, pageKey, restoreScroll, saveScroll, swappable } from './navigation'

// Swaps pages in place: a link or a form of the app fetches the next page from the server and puts it in this one, islands marked `persist` kept alive.
// Everything here runs in the browser only, started by the entry; without JavaScript links and forms load pages as they always did.
// This part only listens: the swap itself, in `./page-swap`, loads once a visitor points at a link or calls `navigate`, and the forms' listener, in `./form-submits`, once the page shows a form, one takes focus or is posted, so a page nobody leaves never fetches the one and a page with no form never fetches the other.

// Defined by the build of the navigation-only entry, whose boot wires the forms' listener it bundles.
declare const KAY_NAV_ENTRY: true | undefined

const PREFETCH = 'meta[name="kay-prefetch"]'
// An action's path, before any query or fragment.
const ACTION_PATH = /^[^?#]*\/_kay\/action\//

let swapModule: Promise<typeof import('./page-swap')> | undefined
let formsModule: Promise<typeof import('./form-submits')> | undefined
// Set once the forms' listener runs, which takes every submit from then on.
let formsListen = false
// The forms posted before it ran, each held once: a second press while it loads posts nothing more, as `submitted` runs once a form and the listener's own `busyForms` only takes over after.
const heldForms = new WeakSet<HTMLFormElement>()
// A traversal undone while the guards are asked about it: where it went, and how far.
let held: { url: URL, delta: number } | undefined
// A traversal the guards let through, made again.
let passing = false
// How eagerly the page prefetches, as its `kay-prefetch` meta says, until the first pointer or focus on a link loads the code prefetching by it.
let rules: string | undefined
let prefetchModule: Promise<typeof import('./prefetch')> | undefined

// Takes over the links and forms of the app; called once by the entry.
export function startNavigation(given: NavigationHooks): void {
  if (navigation.hooks)
    return

  navigation.hooks = given

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

  // The swap would never use what the browser prefetches for a full load, so a page shipping it carries no speculation rules and it prefetches the same links itself, from code loaded once a link is first pointed at.
  rules = document.querySelector<HTMLMetaElement>(PREFETCH)?.content

  for (const element of document.head.children as HTMLCollectionOf<HeadElement>)
    element._$s = element.outerHTML

  // The navigation-only entry's boot listens to the forms itself, as every page it runs on posts one.
  if (typeof KAY_NAV_ENTRY === 'undefined') {
    wakeShownForms()
    document.addEventListener('kay:navigate', wakeShownForms)
    document.addEventListener('submit', onEarlySubmit)
  }

  history.scrollRestoration = 'manual'
  document.addEventListener('click', onClick)
  document.addEventListener('focusin', onFocus)
  window.addEventListener('popstate', onPopState)
  // `pagehide` saves the scroll for a full load only: back or forward between entries of this document fires `popstate` once the entry already changed, too late to save the one left, so the entry is kept up to date as the page scrolls.
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('pagehide', saveScroll)
  // Pointing at a link, or pressing one on a touch screen, is the moment to fetch the swap: the click follows.
  document.addEventListener('pointerover', onPointLink, { passive: true })
  document.addEventListener('pointerdown', onPointLink, { passive: true })
}

export async function loadSwap(): Promise<typeof import('./page-swap')> {
  return swapModule ??= import('./page-swap')
}

async function loadFormSubmits(): Promise<typeof import('./form-submits')> {
  // A condition Bun folds before it splits chunks: an import left in the navigation-only entry, which bundles the module, would split that entry in three.
  return typeof KAY_NAV_ENTRY === 'undefined' ? formsModule ??= import('./form-submits') : Promise.reject(new Error('unreachable'))
}

// Until the forms' listener runs, which then takes the forms a swap brings or a focus lands in itself.
function wakeShownForms(): void {
  if (!formsListen && document.forms.length > 0)
    void wakeForms()
}

// The forms' listener, for the page's forms, the one taking focus or the submit held for it; one that fails to load leaves them to the browser, which posts them in full.
async function wakeForms(form?: HTMLFormElement, posted?: { submitter: HTMLElement | null }): Promise<void> {
  try {
    const forms = await loadFormSubmits()

    formsListen = true

    if (posted)
      forms.submitted(form!, posted.submitter)
    else if (form)
      forms.focused(form)
    else
      forms.listenToForms()
  }
  catch {
    formsListen = true

    // Its submit event fires a second time, as no other way posts the form with what its button adds.
    if (posted)
      HTMLFormElement.prototype.requestSubmit.call(form!, posted.submitter)
  }
}

// A post to an action before the forms' listener runs, as from a form an island rendered that nothing focused, held until the listener loads.
function onEarlySubmit(event: SubmitEvent): void {
  const form = event.target as HTMLFormElement
  const { submitter } = event

  // A cheaper test than the forms' listener's: a post to another site naming an action's path still reaches the browser, its submit event fired again.
  if (formsListen || event.defaultPrevented || !ACTION_PATH.test(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? '') || (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? '').toLowerCase() !== 'post' || form.closest('[data-reload]') || submitter?.hasAttribute('data-reload') || !['', '_self'].includes(submitter?.getAttribute('formtarget') ?? form.getAttribute('target') ?? ''))
    return

  event.preventDefault()

  if (!heldForms.has(form)) {
    heldForms.add(form)
    void wakeForms(form, { submitter })
  }
}

// Fetched ahead of the click it hints at; one that fails to load leaves each click to load its page fully.
async function preloadSwap(): Promise<void> {
  try {
    await loadSwap()
  }
  catch {}
}

// Loads the prefetch code on the first touch of a link, which it then handles as it would have listening, as it does each touch that came while it loaded: one that fails to load leaves the links unprefetched, each click still swapping.
async function wakePrefetch(event: Event): Promise<void> {
  try {
    prefetchModule ??= loadPrefetch()
    ;(await prefetchModule).replay(event)
  }
  catch {}
}

async function loadPrefetch(): Promise<typeof import('./prefetch')> {
  const module = await import('./prefetch')

  module.startPrefetch(rules)
  rules = undefined

  return module
}

// Swaps the page in, or loads it fully when the swap cannot load: the browser keeps a module that failed as failed, so retrying is no use.
export async function follow(url: URL, swap: Swap): Promise<void> {
  if (navigation.stale && (swap.intent === 'visit' || swap.intent === 'traverse')) {
    leave(url, swap.intent === 'traverse')

    return
  }

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

export function linkIn(element: Element | null): HTMLAnchorElement | undefined {
  const link = element?.closest?.('a[href]')

  return link instanceof HTMLAnchorElement ? link : undefined
}

export function linkOf(event: Event): HTMLAnchorElement | undefined {
  return linkIn(event.target as Element | null)
}

// A link the swap may follow: a plain click on one of the app's pages, opening in this tab, with nothing opting it out.
export function followable(link: HTMLAnchorElement): URL | undefined {
  if ((link.target !== '' && link.target !== '_self') || link.hasAttribute('download') || link.closest('[data-reload]'))
    return undefined

  const url = new URL(link.href)

  if (!swappable(url))
    return undefined

  // A jump within the page is the browser's own.
  return url.hash !== '' && url.pathname === location.pathname && url.search === location.search ? undefined : url
}

// A click nothing has taken and no key or button turns into something else.
export function plainClick(event: MouseEvent): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function onClick(event: MouseEvent): void {
  if (!plainClick(event))
    return

  const link = linkOf(event)
  const url = link && followable(link)

  if (!url)
    return

  event.preventDefault()
  void followAsked(url, { intent: 'visit', link })
}

export async function followAsked(url: URL, swap: Swap): Promise<void> {
  if (await mayLeave(url))
    await follow(url, swap)
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

  if (pageKey(url) === navigation.shown) {
    restoreScroll(swap.saved, url.hash)

    return
  }

  // Entries of one path that only their query tells apart are one page to the visitor, as following a query param is.
  if (navigation.shown !== '' && new URL(navigation.shown).pathname === url.pathname)
    swap.focused = document.activeElement

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

  if (link && followable(link)) {
    void preloadSwap()

    if (rules !== undefined)
      void wakePrefetch(event)
  }
}

function onFocus(event: FocusEvent): void {
  if (rules !== undefined && linkOf(event))
    void wakePrefetch(event)

  if (typeof KAY_NAV_ENTRY === 'undefined' && !formsListen) {
    const form = event.target instanceof Element ? event.target.closest('form') : null

    if (form)
      void wakeForms(form)
  }
}
