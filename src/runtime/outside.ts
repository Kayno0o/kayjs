// Whether a link leaves the site, shared by the server markup, the islands and the Markdown pipeline.

// Starts a path or an anchor of the site, with nothing a browser reads as another host: `//host`, `/\host`, or a tab or line break it drops after the first slash.
const SAME_SITE = /^(?:[#?]|\/(?![/\\\t\n\r]))/
// Where a link that may leave the site starts, for a compiler to tell a static href that never does: an absolute http(s) URL, or one a browser reads as a host, with a tab or line break dropped.
const LEAVING = /^[\0-\x20]*(?:[/\\][\t\n\r]*[/\\]|h[\t\n\r]*t[\t\n\r]*t[\t\n\r]*p[\t\n\r]*(?:s[\t\n\r]*)?:)/i
// The unknown site's stand-in, where a relative href resolves to the origin an absolute one never has.
const UNKNOWN = 'http://kay-site.invalid'

export const OUTSIDE_ATTRIBUTES = ' target="_blank" rel="noopener"'
export const OUTSIDE_TARGET = ' target="_blank"'

export function mayLeaveSite(href: string): boolean {
  return LEAVING.test(href)
}

// A browser's opaque origin, `null` on `file:` and `about:blank`, is no site: it reads as an unknown one.
function originOf(site: string | undefined): URL {
  try {
    return new URL(site ?? UNKNOWN)
  }
  catch {
    return new URL(UNKNOWN)
  }
}

// Whether `href` goes to another origin than `site`, an absolute http(s) URL or a host-relative one; with no known `site`, any absolute http(s) URL does. `mailto:`, `tel:`, a `#hash` and a path of the site stay.
export function leavesSite(href: unknown, site: string | undefined): boolean {
  if (typeof href !== 'string' || SAME_SITE.test(href))
    return false

  try {
    const base = originOf(site)
    const url = new URL(href, base)

    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== base.origin
  }
  catch {
    return false
  }
}
