import type { NavLink } from './defaults'
import { onSite, ORIGIN, parseAddress as parse } from './tab-nav'

const TRAILING_SLASHES = /\/+$/

// A path with a trailing slash is the same page as without one.
const trimmed = (path: string) => path.length > 1 ? path.replace(TRAILING_SLASHES, '') : path

// Every enabled link of a navigation, the children under each included, parsed once: what `navMark` weighs a link against.
export function navAddresses(...lists: readonly (readonly NavLink[] | undefined)[]): URL[] {
  const found: URL[] = []

  for (const link of lists.flatMap(list => list ?? [])) {
    const own = link.disabled ? undefined : parse(link.href)

    if (own)
      found.push(own)

    found.push(...navAddresses(link.children))
  }

  return found
}

// Whether the page `here` holds every param the link `own` sets; a link to another origin is never the page.
function holds(own: URL, here: URL): boolean {
  return onSite(own, here) && trimmed(own.pathname) === trimmed(here.pathname) && [...own.searchParams].every(([name, value]) => here.searchParams.getAll(name).includes(value))
}

// How a navigation link stands to the page on screen, `current` being its path or its URL: `page` for the page itself, `true` for a section holding it, nothing else.
// A link with a query is the page only when the page holds that query, as `currentTab` reads it, and when no link of `siblings` (`navAddresses` of the navigation) sets more of the page's params on that path: `/settings?tab=billing` takes the page from `/settings`.
// The home page holds every path, so only an exact match marks it; a link with a query is never a section, and a link to another site or a malformed one is never current.
export function navMark(href: string, current: string | URL, siblings: readonly URL[] = []): 'page' | 'true' | undefined {
  const here = typeof current === 'string' ? new URL(current, ORIGIN) : current
  const own = parse(href)

  if (!own)
    return undefined

  if (holds(own, here)) {
    const params = [...own.searchParams].length

    return siblings.some(other => [...other.searchParams].length > params && holds(other, here)) ? undefined : 'page'
  }

  const path = trimmed(own.pathname)

  return onSite(own, here) && own.search === '' && path !== '/' && trimmed(here.pathname).startsWith(`${path}/`) ? 'true' : undefined
}
