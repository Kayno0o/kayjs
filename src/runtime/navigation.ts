import { withBase, withoutBase } from './base'

// The state of navigation in the browser, which the listeners of `./navigate`, the swap and form posting loaded later, and action calls share: none of them imports another for it.

export interface NavigationHooks {
  // Hydrates the islands under a root, leaving those already hydrated alone.
  hydrate: (root: ParentNode) => unknown
  // Ends the islands under a root.
  dispose: (root: ParentNode) => void
}

export interface FetchedPage {
  url: string
  type: string
  html: string
  // A page the browser loads itself from another one: one asking for it, or one whose cross-origin isolation differs from this document's, which cannot change in place.
  full?: true
}

// Why a page is swapped in, which the swap's `POLICIES` read everything else off.
// `visit` follows a link, `query` changes the current page's query, `traverse` goes back or forward, `refresh` runs the page's loads again, `redirect` shows the page a post sent the browser back to, `refusal` the page a refused post rendered, `error` an error page a post answered.
export type Intent = 'visit' | 'query' | 'traverse' | 'refresh' | 'redirect' | 'refusal' | 'error'

export interface Swap {
  intent: Intent
  // Takes the current history entry's place, as `navigate(href, { replace: true })` asks.
  replace?: boolean | undefined
  // The position a traversal's entry saved.
  saved?: [number, number] | undefined
  // The element focused before, found again by id or name once swapped: a traversal sets it between entries of one path, which keep the focus.
  focused?: Element | null
  // A form the server refused a post of, and the control focused in it, by their index among the page's forms and the form's controls.
  refused?: { form: number, control: number }
}

// A guard `guardLeave` registers, which a leave asks once it holds unsaved changes.
export interface LeaveGuard {
  dirty: () => boolean
  confirm?: ((to: URL) => boolean | Promise<boolean>) | undefined
}

// A head element the server put in, holding as `_$s` how it put it, which the swap tells what a script changed or added since by: those of the page loaded first are read as navigation starts.
export interface HeadElement extends Element {
  _$s?: string
}

export interface HistoryState {
  kay: true
  scroll: [number, number]
  // The entry's place in the session's history, which tells how far back or forward a traversal went; missing from an entry an older kay wrote.
  at?: number
}

const SKIPPED_PATHS = /^\/(?:_kay|api)(?:\/|$)/
const ACTION_PATH = /^\/_kay\/action\//
const HASH = /#.*/
const SCROLL_SAVE_MS = 150
const LEAVE_MESSAGE = 'This page has unsaved changes. Leave it anyway?'

// `hooks`, `navigate` and `refresh` are set once the swap took over the app's links, which an action call then shows its effects through.
// `shown` is the page shown, by URL without its hash, since going back to an entry of the same page only scrolls; `at` the place of its entry; `page` how many other pages were shown since, which an action call's outcome belongs to one of; `current` the latest swap started, which an earlier one gives way to; `visits` how many swaps to another path started, unset before the first, which an answer the page awaited reads to tell whether the visitor went elsewhere meanwhile.
// `released` lets a full load kay starts itself through `beforeunload`, as one the guards were asked about or one that is no leave.
export const navigation: {
  hooks?: NavigationHooks
  navigate?: (href: string) => Promise<void>
  refresh?: () => Promise<void>
  shown: string
  at: number
  page: number
  current: number
  visits?: number
  released: boolean
  // Lands the query param writes held back to be spaced out, which run before the address is read to leave or change it.
  flush?: () => void
  // Development: set while `kay dev` refreshes the page for an edit, where a field the edit leaves as it was keeps what was typed into it.
  typed?: boolean
} = { shown: '', at: 0, page: 0, current: 0, released: false }

// Pages fetched ahead of a click, by URL; an action may change what they show, so each post forgets them.
export const prefetched = new Map<string, { at: number, page: Promise<FetchedPage> }>()
export const leaveGuards = new Set<LeaveGuard>()
export const busyForms = new WeakSet<HTMLFormElement>()
// A form handed back to the browser after the swap could not send it, which the next submit event lets through.
export const nativeSubmits = new WeakSet<HTMLFormElement>()
// The forms kay set `novalidate` on to check them itself; an author's own `novalidate` still skips the check.
export const checkedForms = new WeakSet<HTMLFormElement>()

let scrollTimer: ReturnType<typeof setTimeout> | undefined

// Whether the page may be left for `to`: the first guard holding unsaved changes asks, once for them all.
export async function mayLeave(to: URL): Promise<boolean> {
  const guard = dirtyGuard()

  return guard ? (guard.confirm ?? askLeave)(to) : true
}

export function dirtyGuard(): LeaveGuard | undefined {
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

// A full load instead, taking the place of the current entry when `replace`, as one going back already made.
export function leave(target: URL, replace = false): void {
  navigation.released = true

  location[replace ? 'replace' : 'assign'](target)
}

export function historyState(): HistoryState {
  return { kay: true, scroll: [scrollX, scrollY], at: navigation.at }
}

// The scroll position goes in the entry as it changes, a while after it stops, for going back and forward to restore it.
export function onScroll(): void {
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(saveScroll, SCROLL_SAVE_MS)
}

// A save pending would land on the entry a traversal just reached.
export function dropScrollSave(): void {
  clearTimeout(scrollTimer)
}

export function saveScroll(): void {
  clearTimeout(scrollTimer)
  history.replaceState(historyState(), '')
}

// The position an entry saved, else the element the hash points at, else the top.
export function restoreScroll(saved: [number, number] | undefined, hash: string): void {
  if (saved) {
    scrollTo(...saved)

    return
  }

  const anchor = hash === '' ? null : document.getElementById(fragment(hash))

  if (anchor)
    anchor.scrollIntoView()
  else
    scrollTo(0, 0)
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

export function pageKey(url: URL): string {
  return url.href.replace(HASH, '')
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

// Where a form posts when the swap posts it: one of the app's actions, in this tab, with nothing opting it out.
export function swappedActionUrl(form: HTMLFormElement, submitter: HTMLElement | null): URL | undefined {
  const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
  const url = new URL(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? '', location.href)
  const target = submitter?.getAttribute('formtarget') ?? form.target

  if (method !== 'post' || url.origin !== location.origin || (target !== '' && target !== '_self') || form.closest('[data-reload]') || submitter?.hasAttribute('data-reload'))
    return undefined

  return ACTION_PATH.test(withoutBase(url.pathname)) ? url : undefined
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

export function takeFormCheck(form: HTMLFormElement): void {
  if (form.noValidate)
    return

  try {
    if (!swappedActionUrl(form, null))
      return
  }
  catch {
    // An action the page cannot resolve is left to the browser, which posts it natively.
    return
  }

  form.noValidate = true
  checkedForms.add(form)
}
