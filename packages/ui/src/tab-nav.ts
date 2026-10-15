// Stands in for the origin while a relative `current` is read as a URL; nothing outside this file sees it.
const ORIGIN = 'http://kay.invalid'

// Whether `href` is the page `current` names: the same string, or, against a URL, the same path with every param the link sets matching.
export function isCurrentTab(href: string, current: string | URL): boolean {
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
