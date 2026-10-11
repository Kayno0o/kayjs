import type { CheckedHref } from './checks'
import { withBase, withoutBase } from './base'
import { prefetched, swapState, WORK_SCRIPT } from './swap'

// Swaps pages in place: a link or a form of the app fetches the next page from the server and puts it in this one, islands marked `persist` kept alive.
// Everything here runs in the browser only, started by the entry; without JavaScript links and forms load pages as they always did.
// This part only listens: the swap itself, in `./page-swap`, loads once a visitor points at a link, focuses a form or calls `navigate`, so a page nobody leaves never fetches it.

export interface NavigationHooks {
  // Hydrates the islands under a root, leaving those already hydrated alone.
  hydrate: (root: ParentNode) => unknown
  // Ends the islands under a root.
  dispose: (root: ParentNode) => void
}

export interface NavigateOptions {
  // Replaces the current history entry instead of adding one.
  replace?: boolean | undefined
}

// Query params to set on the current page, a null, undefined or empty one dropped.
export type QueryChanges = Readonly<Record<string, string | number | null | undefined>>

export interface Swap {
  // `push` adds a history entry, `replace` takes the current one's place, `none` leaves history alone, as going back does.
  history: 'push' | 'replace' | 'none'
  // Where the window scrolls to once swapped: the top or the URL's hash, a position going back restores, or where it is.
  scroll: 'top' | 'keep' | [number, number]
  // A refresh keeps every island whose component and props did not change, besides those marked `persist`.
  refresh?: boolean
  // The element to focus once swapped, found again by id or name; the new page's own otherwise.
  focus?: Element | null
  // A form the server refused a post of, and the control focused in it, by their index among the page's forms and the form's controls.
  refused?: { form: number, control: number }
}

// A guard `guardLeave` registers, which a leave asks once it holds unsaved changes.
export interface LeaveGuard {
  dirty: () => boolean
  confirm?: ((to: URL) => boolean | Promise<boolean>) | undefined
}

interface HistoryState {
  kay: true
  scroll: [number, number]
  // The entry's place in the session's history, which tells how far back or forward a traversal went; missing from an entry an older kay wrote.
  at?: number
}

type Eagerness = 'conservative' | 'moderate' | 'eager' | false

const HOVER_DELAY_MS = 200
const SKIPPED_PATHS = /^\/(?:_kay|api)(?:\/|$)/
const ACTION_PATH = /^\/_kay\/action\//
const SPECULATION = 'script[type="speculationrules"]'
const SCROLL_SAVE_MS = 150
const LEAVE_MESSAGE = 'This page has unsaved changes. Leave it anyway?'

// What the swap shares with this part: the entry's hooks, the page shown, by URL without its hash, since going back to an entry of the same page only scrolls, and the place of its entry.
// `released` lets a full load kay starts itself through `beforeunload`, as one the guards were asked about or one that is no leave.
export const navigation: { hooks?: NavigationHooks, shown: string, at: number, released: boolean } = { shown: '', at: 0, released: false }
export const leaveGuards = new Set<LeaveGuard>()
export const busyForms = new WeakSet<HTMLFormElement>()
// A form handed back to the browser after the swap could not send it, which the next submit event lets through.
export const nativeSubmits = new WeakSet<HTMLFormElement>()
// The forms kay set `novalidate` on to check them itself; an author's own `novalidate` still skips the check.
export const checkedForms = new WeakSet<HTMLFormElement>()

let eagerness: Eagerness = false
let scrollTimer: ReturnType<typeof setTimeout> | undefined
let swapModule: Promise<typeof import('./page-swap')> | undefined
// A traversal undone while the guards are asked about it: where it went, and how far.
let held: { url: URL, delta: number } | undefined
// A traversal the guards let through, made again.
let passing = false

// Takes over the links and forms of the app; called once by the entry.
export function startNavigation(given: NavigationHooks): void {
  if (navigation.hooks)
    return

  navigation.hooks = given
  swapState.started = true
  eagerness = speculationEagerness()

  navigation.shown = pageKey(new URL(location.href))

  const saved = history.state as HistoryState | null

  // An entry this script made before: a reload, or back from another site, where the browser no longer restores the scroll.
  if (saved?.kay) {
    navigation.at = saved.at ?? 0
    scrollTo(...saved.scroll)
  }
  else {
    history.replaceState(state(), '')
  }

  // The swap would never use what the browser prefetches for a full load, so it prefetches the same links itself.
  for (const script of document.querySelectorAll(SPECULATION))
    script.remove()

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
    navigation.released = true
    location.assign(url)

    return
  }

  const history = options.replace ? 'replace' : 'push'

  await follow(url, typeof to === 'string' ? { history, scroll: 'top' } : { history, scroll: 'keep', focus: document.activeElement })
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
  await follow(new URL(location.href), { history: 'none', scroll: 'keep', refresh: true, focus: document.activeElement })
}

async function loadSwap(): Promise<typeof import('./page-swap')> {
  return swapModule ??= import('./page-swap')
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
    leave(url, swap)

    return
  }

  await swapper.go(url, swap)
}

// Whether the page may be left for `to`: the first guard holding unsaved changes asks, once for them all.
export async function mayLeave(to: URL): Promise<boolean> {
  const guard = dirtyGuard()

  return guard ? (guard.confirm ?? askLeave)(to) : true
}

function dirtyGuard(): LeaveGuard | undefined {
  for (const guard of leaveGuards) {
    if (guard.dirty())
      return guard
  }

  return undefined
}

function askLeave(): boolean {
  // eslint-disable-next-line no-alert -- the default question is the browser's own, which an app replaces through `confirm`
  return confirm(LEAVE_MESSAGE)
}

// A full load instead, taking the place of the entry going back already made.
export function leave(target: URL, swap: Swap): void {
  navigation.released = true

  if (swap.history === 'none')
    location.replace(target)
  else
    location.assign(target)
}

function state(): HistoryState {
  return { kay: true, scroll: [scrollX, scrollY], at: navigation.at }
}

// The entry a swap adds or replaces, holding where the page it leaves was scrolled to.
export function writeHistory(swap: Swap, target: URL): void {
  if (swap.history === 'push') {
    navigation.at++
    history.pushState(state(), '', target)
  }
  else if (swap.history === 'replace') {
    history.replaceState(state(), '', target)
  }
}

// The scroll position goes in the entry as it changes, a while after it stops, for going back and forward to restore it.
function onScroll(): void {
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(saveScroll, SCROLL_SAVE_MS)
}

export function saveScroll(): void {
  clearTimeout(scrollTimer)
  history.replaceState(state(), '')
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

// A page of this app: same origin, under its mount point, and none of kay's own routes or the API's.
export function swappable(url: URL): boolean {
  if (url.origin !== location.origin)
    return false

  const mount = withBase('/')

  if (mount !== '/' && url.pathname !== mount.slice(0, -1) && !url.pathname.startsWith(mount))
    return false

  return !SKIPPED_PATHS.test(withoutBase(url.pathname))
}

function linkOf(event: Event): HTMLAnchorElement | undefined {
  const link = (event.target as Element | null)?.closest?.('a[href]')

  return link instanceof HTMLAnchorElement ? link : undefined
}

// A link the swap may follow: a plain click on one of the app's pages, opening in this tab, with nothing opting it out.
export function followable(link: HTMLAnchorElement): URL | undefined {
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
    await follow(url, { history: 'push', scroll: 'top' })
}

function onPopState(event: PopStateEvent): void {
  // A save pending would land on the entry just reached.
  clearTimeout(scrollTimer)

  const saved = event.state as HistoryState | null
  const url = new URL(location.href)
  const swap: Swap = { history: 'none', scroll: saved?.kay ? saved.scroll : 'top' }

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
    restoreScroll(swap, url.hash)
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

export function pageKey(url: URL): string {
  const hash = url.href.indexOf('#')

  return hash === -1 ? url.href : url.href.slice(0, hash)
}

// The element id a hash points at, kept as written when it is no valid escape, as `#100%` is.
function fragment(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1))
  }
  catch {
    return hash.slice(1)
  }
}

export function restoreScroll(swap: Swap, hash: string): void {
  if (swap.scroll === 'keep')
    return

  if (Array.isArray(swap.scroll)) {
    scrollTo(...swap.scroll)

    return
  }

  const anchor = hash === '' ? null : document.getElementById(fragment(hash))

  if (anchor)
    anchor.scrollIntoView()
  else
    scrollTo(0, 0)
}

function actionUrl(form: HTMLFormElement, submitter: HTMLElement | null): URL | undefined {
  const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
  const url = new URL(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? '', location.href)
  const target = submitter?.getAttribute('formtarget') ?? form.target

  if (method !== 'post' || url.origin !== location.origin || (target !== '' && target !== '_self') || form.closest('[data-reload]') || submitter?.hasAttribute('data-reload'))
    return undefined

  return ACTION_PATH.test(withoutBase(url.pathname)) ? url : undefined
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

// The form is busy from its submit on, so a second submit while the swap or its checks load posts nothing.
async function submit(form: HTMLFormElement, submitter: HTMLElement | null, url: URL): Promise<void> {
  busyForms.add(form)

  let swapper: typeof import('./page-swap')

  try {
    swapper = await loadSwap()
  }
  catch {
    busyForms.delete(form)
    submitNatively(form, submitter)

    return
  }

  await swapper.submit(form, submitter, url)
}

// The browser posts the form, as it would have without the swap.
export function submitNatively(form: HTMLFormElement, submitter: HTMLElement | null): void {
  navigation.released = true
  nativeSubmits.add(form)
  form.requestSubmit(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null)
}

// Forms posting to an action are checked by kay once it runs, so the schema's own messages show rather than the browser's for the constraints their fields write for a visit without JavaScript.
export function takeFormChecks(root: ParentNode): void {
  for (const form of root.querySelectorAll('form'))
    takeFormCheck(form)
}

function takeFormCheck(form: HTMLFormElement): void {
  if (form.noValidate)
    return

  try {
    if (!actionUrl(form, null))
      return
  }
  catch {
    // An action the page cannot resolve is left to the browser, which posts it natively.
    return
  }

  form.noValidate = true
  checkedForms.add(form)
}

// An island may render a form after the page loaded, taken once it gets focus.
function onFormFocus(event: FocusEvent): void {
  const form = event.target instanceof Element ? event.target.closest('form') : null

  if (form) {
    takeFormCheck(form)
    void preloadChecks()
    void startWork(form)
  }
}

// A form posting to an action with `proofOfWork` starts on its challenge as the visitor fills it in, so its post seldom waits for it.
async function startWork(form: HTMLFormElement): Promise<void> {
  const url = actionUrl(form, null)

  if (!url || !document.querySelector(`script[${WORK_SCRIPT}]`))
    return

  try {
    (await import('./work.client')).startWork(withoutBase(url.pathname))
  }
  catch {}
}

// A form taking focus is about to be posted: the swap and the form checks load then, so a page with no form never fetches them.
async function preloadChecks(): Promise<void> {
  try {
    await (await loadSwap()).preloadChecks()
  }
  catch {}
}
