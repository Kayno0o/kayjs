import type { NavLink } from './defaults'
import { addressHref, ORIGIN } from './tab-nav'

const TRAILING_SLASHES = /\/+$/

// A path with a trailing slash is the same page as without one.
const trimmed = (path: string) => path.length > 1 ? path.replace(TRAILING_SLASHES, '') : path

// Every enabled link of a navigation, the children under each included: what `navMark` weighs a link against.
export function navHrefs(...lists: readonly (readonly NavLink[] | undefined)[]): string[] {
  const hrefs: string[] = []

  for (const link of lists.flatMap(list => list ?? [])) {
    if (!link.disabled)
      hrefs.push(link.href)

    hrefs.push(...navHrefs(link.children))
  }

  return hrefs
}

// A link's address read against the page, a malformed one reading as a path of its own text.
function addressOf(href: string, here: URL): URL {
  try {
    return new URL(addressHref(href), here)
  }
  catch {
    return new URL('/', here)
  }
}

// Whether the page `here` holds every param the link `own` sets.
function holds(own: URL, here: URL): boolean {
  return trimmed(own.pathname) === trimmed(here.pathname) && [...own.searchParams].every(([name, value]) => here.searchParams.getAll(name).includes(value))
}

// How a navigation link stands to the page on screen, `current` being its path or its URL: `page` for the page itself, `true` for a section holding it, nothing else.
// A link with a query is the page only when the page holds that query, as `currentTab` reads it, and when no link of `siblings` (every link of the navigation) sets more of the page's params on that path: `/settings?tab=billing` takes the page from `/settings`.
// The home page holds every path, so only an exact match marks it; a link with a query is never a section.
export function navMark(href: string, current: string | URL, siblings: readonly string[] = []): 'page' | 'true' | undefined {
  const here = typeof current === 'string' ? new URL(current, ORIGIN) : current
  const own = addressOf(href, here)

  if (holds(own, here)) {
    const params = [...own.searchParams].length

    return siblings.some((other) => {
      const sibling = addressOf(other, here)

      return [...sibling.searchParams].length > params && holds(sibling, here)
    })
      ? undefined
      : 'page'
  }

  const path = trimmed(own.pathname)

  return own.search === '' && path !== '/' && trimmed(here.pathname).startsWith(`${path}/`) ? 'true' : undefined
}
