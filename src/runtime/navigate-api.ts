import type { CheckedHref } from './checks'
import { withBase } from './base'
import { follow } from './navigate'
import { leave, loadAgain, mayLeave, navigation, prefetched, swappable } from './navigation'
import { LOAD_NAME } from './swap'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

export interface NavigateOptions {
  // Replaces the current history entry instead of adding one.
  replace?: boolean | undefined
  // `'keep'` leaves the window scrolled where it is instead of going to the top, `'top'` goes to the top as a query change does not.
  scroll?: 'top' | 'keep' | undefined
  // `false` swaps without a view transition, whatever the stylesheets opt in to.
  transition?: boolean | undefined
}

// Query params to set on the current page, a null, undefined or empty one dropped.
export type QueryChanges = Readonly<Record<string, string | number | null | undefined>>

// Sets each param of `changes` on `params`, a null, undefined or empty one dropped and the others kept: the rule of `navigate({ query })` and of `withQuery`.
export function mergeQuery(params: URLSearchParams, changes: QueryChanges): void {
  for (const [name, value] of Object.entries(changes)) {
    if (value == null || value === '')
      params.delete(name)
    else
      params.set(name, String(value))
  }
}

// The current page with `query` merged into its own, keeping the scroll and the focus as `refresh()` does: a filter or a sort picked in place.
// Both forms resolve to `false` when a leave guard was declined, so the page stayed, and `true` otherwise.
// kept: free
export async function navigate(to: { query: QueryChanges }, options?: NavigateOptions): Promise<boolean>
// Goes to a page as following a link does: one of the app's swapped in place, under the site's mount point as a link is, another site's loaded. A literal path is checked as a link's is.
// Last, so a path no page serves is reported against it.
export async function navigate<const Href extends string>(href: Href & CheckedHref<Href>, options?: NavigateOptions): Promise<boolean>
export async function navigate(to: string | { query: QueryChanges }, options: NavigateOptions = {}): Promise<boolean> {
  return navigateTo(typeof to === 'string' && navigation.localize ? navigation.localize(to) : to, options, true)
}

// `navigate()`, with `hooked` off for a redirect an action's call asks for, which `onBeforeNavigate` cannot refuse as the action already ran: the leave guards still ask. That redirect is the server's final location, already under the base, so it is not put under it again.
export async function navigateTo(to: string | { query: QueryChanges }, options: NavigateOptions, hooked: boolean): Promise<boolean> {
  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined')
    return true

  navigation.flush?.()

  // A query change keeps the path and the other params, and leaves the hash out.
  const path = hooked && typeof to === 'string' ? withBase(to) : to
  const url = new URL(typeof path === 'string' ? path : location.pathname + location.search, location.href)

  // A `javascript:` URL, as one read from a query param could be, would run in the page; a `data:` one browsers refuse to load, and `vbscript:` is gone.
  if (url.protocol === 'javascript:')
    throw new TypeError('kay: navigate() refuses javascript:')

  if (typeof to !== 'string') {
    mergeQuery(url.searchParams, to.query)
  }

  // The handlers of `onBeforeNavigate` are asked for a page kay swaps in place only, as for a link.
  const inPlace = Boolean(navigation.hooks) && swappable(url)

  if (!await mayLeave(url, hooked && inPlace))
    return false

  navigation.navigations = (navigation.navigations ?? 0) + 1

  if (!inPlace) {
    leave(url)

    return true
  }

  await follow(url, typeof to === 'string' ? { ...options, intent: 'visit' } : { ...options, intent: 'query', focused: document.activeElement })

  return true
}

const warned = new Set<string>()

// The names the server would keep: anything else, a control character that makes `fetch` throw included, is left out, and an empty list asks for the whole page. Development warns of both.
export function checkedLoads(asked: readonly string[]): readonly string[] | undefined {
  const valid = asked.filter(name => LOAD_NAME.test(name))

  if (process.env.NODE_ENV !== 'production' && (asked.length === 0 || valid.length !== asked.length)) {
    const message = asked.length === 0 ? 'kay: refresh() was given no load names, so it refreshes the whole page.' : `kay: refresh() was given load names that are not bindings (${asked.filter(name => !valid.includes(name)).map(name => JSON.stringify(name)).join(', ')}): they are left out.`

    // Once for each distinct mistake, as a call site repeats it on every click.
    if (!warned.has(message)) {
      warned.add(message)
      console.warn(message)
    }
  }

  return valid.length === 0 ? undefined : valid
}

// Runs the page's loads again and shows what they return, keeping scroll, focus and every island whose props did not change.
// Named loads, the bindings of `const cart = await ...` in the page's or a layout's fence, are the ones sent and swapped: the server runs every load, and the rest of the page stays as it is, unless it shows them.
// kept: free
export async function refresh(loads?: string | readonly string[]): Promise<void> {
  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined')
    return

  if (!navigation.hooks) {
    loadAgain()

    return
  }

  prefetched.clear()
  const names = typeof loads === 'string' ? [loads] : loads

  await follow(new URL(location.href), { intent: 'refresh', focused: document.activeElement, loads: names === undefined ? names : checkedLoads(names) })
}
