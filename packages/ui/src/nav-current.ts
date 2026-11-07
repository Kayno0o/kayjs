import { addressHref } from './tab-nav'

const TRAILING_SLASHES = /\/+$/

// A path with a trailing slash is the same page as without one.
const trimmed = (path: string) => path.length > 1 ? path.replace(TRAILING_SLASHES, '') : path

// How a navigation link stands to the page on screen, `current` being its path or its URL: `page` for the page itself, `true` for a section holding it, nothing else.
// The home page holds every path, so only an exact match marks it.
export function navMark(href: string, current: string | URL): 'page' | 'true' | undefined {
  const own = trimmed(addressHref(href))
  const here = trimmed(typeof current === 'string' ? current : current.pathname)

  if (own === here)
    return 'page'

  return own !== '/' && here.startsWith(`${own}/`) ? 'true' : undefined
}
