import type { TrailingSlash } from '../config'
import type { RouteMatch } from './actions'
import type { ServedRoute } from './guards'

const PATH_END = /[?#]/
const SLASHES = /\/+/

// Whether a router pattern, `:name` params, `:name?` ones and a final `*`, takes the path.
function takes(pattern: string[], path: string[]): boolean {
  const [head, ...rest] = pattern

  if (head === undefined)
    return path.length === 0

  if (head === '*' || (head.startsWith(':') && head.endsWith('?') && takes(rest, path)))
    return true

  const [segment, ...remaining] = path

  return segment !== undefined && (head.startsWith(':') || head === segment) && takes(rest, remaining)
}

// A redirect to a page of the site written as a visit to it is answered, so a native post, a page swap or an island call lands in one response rather than one more hop through the trailing slash redirect.
// Only a path a page serves, no file, endpoint or API route, and only where `trailingSlash` says which spelling it has; a query and a hash go along, anything else stays as written.
export function redirectSpelling(trailingSlash: TrailingSlash, routes: ServedRoute[], match: RouteMatch, apart: () => string[]): (location: string) => string {
  if (trailingSlash === 'ignore')
    return location => location

  let others: string[] | undefined

  return (location) => {
    if (!location.startsWith('/') || location.startsWith('//'))
      return location

    const end = location.search(PATH_END)
    const path = end === -1 ? location : location.slice(0, end)

    if (path === '/' || path.includes('\\') || path.slice(path.lastIndexOf('/')).includes('.'))
      return location

    others ??= apart()

    if (others.some(pattern => takes(pattern.split(SLASHES).filter(Boolean), path.split(SLASHES).filter(Boolean))))
      return location

    for (const route of routes) {
      const served = match.posted(route, path)

      if (served)
        return served.path === undefined ? location : `${served.path}${end === -1 ? '' : location.slice(end)}`
    }

    return location
  }
}
