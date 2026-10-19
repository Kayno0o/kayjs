import type { CheckedHref } from './checks'
import { withBase } from './base'
import { follow } from './navigate'
import { leave, mayLeave, navigation, prefetched, swappable } from './navigation'

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

// The current page with `query` merged into its own, keeping the scroll and the focus as `refresh()` does: a filter or a sort picked in place.
export async function navigate(to: { query: QueryChanges }, options?: NavigateOptions): Promise<void>
// Goes to a page as following a link does: one of the app's swapped in place, under the site's mount point as a link is, another site's loaded. A literal path is checked as a link's is.
// Last, so a path no page serves is reported against it.
export async function navigate<const Href extends string>(href: Href & CheckedHref<Href>, options?: NavigateOptions): Promise<void>
export async function navigate(to: string | { query: QueryChanges }, options: NavigateOptions = {}): Promise<void> {
  if (typeof document === 'undefined')
    return

  navigation.flush?.()

  // A query change keeps the path and the other params, and leaves the hash out.
  const url = new URL(typeof to === 'string' ? withBase(to) : location.pathname + location.search, location.href)

  // A `javascript:` URL, as one read from a query param could be, would run in the page; a `data:` one browsers refuse to load, and `vbscript:` is gone.
  if (url.protocol === 'javascript:')
    throw new TypeError('kay: navigate() refuses javascript:')

  if (typeof to !== 'string') {
    for (const [name, value] of Object.entries(to.query)) {
      if (value == null || value === '')
        url.searchParams.delete(name)
      else
        url.searchParams.set(name, String(value))
    }
  }

  if (!await mayLeave(url))
    return

  navigation.navigations = (navigation.navigations ?? 0) + 1

  if (!navigation.hooks || !swappable(url)) {
    leave(url)

    return
  }

  await follow(url, typeof to === 'string' ? { ...options, intent: 'visit' } : { ...options, intent: 'query', focused: document.activeElement })
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
