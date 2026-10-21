// Whether a link leaves the site, shared by the server markup, the islands and the Markdown pipeline.

// Starts a path or an anchor of the site, with nothing a browser reads as another host: `//host`, `/\host`, or a tab or line break it drops after the first slash.
const SAME_SITE = /^(?:[#?]|\/(?![/\\\t\n\r]))/
// Where a link that may leave the site starts, for a compiler to tell a static href that never does: an absolute http(s) URL, or one a browser reads as a host, with a tab or line break dropped.
const LEAVING = /^[\0-\x20]*(?:[/\\][\t\n\r]*[/\\]|h[\t\n\r]*t[\t\n\r]*t[\t\n\r]*p[\t\n\r]*(?:s[\t\n\r]*)?:)/i
// The unknown site's stand-in, where a relative href resolves to the origin an absolute one never has.
const UNKNOWN = 'http://kay-site.invalid'

export const OUTSIDE_ATTRIBUTES = ' target="_blank" rel="noopener"'
export const OUTSIDE_TARGET = ' target="_blank"'

// The meta a page writes under `links: { outside: 'same-tab' }`, for an island to read.
const SAME_TAB_META = 'meta[name="kay-same-tab-links"]'

// Whether the page an island runs in keeps links leaving the site in the same tab; false where there is no document.
export function browserKeepsSameTab(): boolean {
  return typeof document !== 'undefined' && document.querySelector(SAME_TAB_META) !== null
}

// The origin an island compares links with; `undefined` where there is no location, which takes any absolute link as leaving.
export function browserOrigin(): string | undefined {
  return typeof location === 'undefined' ? undefined : location.origin
}

export function mayLeaveSite(href: string): boolean {
  return LEAVING.test(href)
}

// The last site's URL, as a page renders every link against the same one.
let known: { site: string | undefined, base: URL } | undefined

// A browser's opaque origin, `null` on `file:` and `about:blank`, is no site: it reads as an unknown one.
function baseOf(site: string | undefined): URL {
  if (known && known.site === site)
    return known.base

  let base: URL

  try {
    base = new URL(site ?? UNKNOWN)
  }
  catch {
    base = new URL(UNKNOWN)
  }

  known = { site, base }

  return base
}

// Whether `href` goes to another origin than `site`, an absolute http(s) URL or a host-relative one; with no known `site`, any absolute http(s) URL does. `mailto:`, `tel:`, a `#hash` and a path of the site stay.
export function leavesSite(href: unknown, site: string | undefined): boolean {
  if (typeof href !== 'string' || SAME_SITE.test(href))
    return false

  try {
    const base = baseOf(site)
    const url = new URL(href, base)

    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== base.origin
  }
  catch {
    return false
  }
}
