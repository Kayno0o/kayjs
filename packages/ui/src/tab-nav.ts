// Stands in for the origin while a relative `current` is read as a URL; nothing outside this file sees it.
const ORIGIN = 'http://kay.invalid'

// A tab bar link, with the sub-pages that also mark it current.
export interface TabLink {
  href: string
  // Marks the link current on every page under its path, so `/traffic` stays current on `/traffic/requests/12`.
  prefix?: boolean | undefined
  // Paths whose pages, and the pages under them, also mark the link current.
  also?: readonly string[] | undefined
}

// The link to the page `current` names, the one setting the most params when several match, so `/a?view=chart` wins over `/a` on that view.
// With none matching, a link whose `prefix` or `also` holds the page of a URL `current` marks it, the longest path winning.
export function currentTab(links: readonly TabLink[], current: string | URL): string | undefined {
  const set = (href: string) => [...new URL(href, ORIGIN).searchParams].length
  const exact = links.filter(link => isCurrentTab(link.href, current)).reduce<string | undefined>((best, { href }) => best === undefined || set(href) > set(best) ? href : best, undefined)

  if (exact !== undefined || typeof current === 'string')
    return exact

  const under = (path: string) => {
    const base = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

    return current.pathname === base || current.pathname.startsWith(`${base}/`) ? base.length : -1
  }

  let best: string | undefined
  let longest = -1

  for (const { href, prefix, also = [] } of links) {
    for (const path of prefix === true ? [new URL(href, ORIGIN).pathname, ...also] : also) {
      const length = under(path)

      if (length > longest) {
        best = href
        longest = length
      }
    }
  }

  return best
}

// Whether `href` is the page `current` names: the same string, or, against a URL, the same path with every param the link sets matching.
function isCurrentTab(href: string, current: string | URL): boolean {
  if (typeof current === 'string')
    return href === current

  const target = new URL(href, current)

  return target.pathname === current.pathname && [...target.searchParams].every(([name, value]) => current.searchParams.getAll(name).includes(value))
}

// `href` carrying each param `keep` names from `current`, unless the link sets that param itself; a relative `href` stays relative.
export function keptHref(href: string, current: string | URL, keep: readonly string[]): string {
  const from = (typeof current === 'string' ? new URL(current, ORIGIN) : current).searchParams
  const hashAt = href.indexOf('#')
  const hash = hashAt === -1 ? '' : href.slice(hashAt)
  const before = hashAt === -1 ? href : href.slice(0, hashAt)
  const queryAt = before.indexOf('?')
  const path = queryAt === -1 ? before : before.slice(0, queryAt)
  const params = new URLSearchParams(queryAt === -1 ? '' : before.slice(queryAt + 1))

  for (const name of keep) {
    if (params.has(name))
      continue

    for (const value of from.getAll(name))
      params.append(name, value)
  }

  const search = params.toString()

  return `${path}${search ? `?${search}` : ''}${hash}`
}
