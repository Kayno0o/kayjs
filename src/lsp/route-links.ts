import type { Span } from '../compiler/ast'
import type { Route } from '../server/routes'

// A route path written as a string where kay reads one: a link, a form action or a navigation, never one built with `{}`.
const ROUTE_PATH = /(?<![\w-])(?:(?:href|action)=|(?:navigate|redirect)\()\s*["'`](\/(?!\/)[^"'`{}$\s?#]*)(?=[?#"'`])/g

export interface RouteLink extends Span {
  file: string
}

// How many of the pattern's segments are params, which the route naming the path outright wins over.
function looseness(pattern: string): number {
  return pattern.split('/').filter(segment => segment.startsWith(':') || segment === '*').length
}

function matches(parts: string[], segments: string[]): boolean {
  const [part, ...rest] = parts

  if (part === undefined)
    return segments.length === 0

  if (part === '*')
    return segments.length > 0

  if (part.endsWith('?'))
    return matches(rest, segments) || (segments.length > 0 && matches(rest, segments.slice(1)))

  return segments.length > 0 && (part.startsWith(':') || part === segments[0]) && matches(rest, segments.slice(1))
}

// The page serving a path: its static route before a param's, the locale prefix a path may carry left off.
export function routeAt(path: string, routes: Route[], locales: string[]): Route | undefined {
  const segments = path.split('/').filter(Boolean)
  const prefixed = segments[0] !== undefined && locales.includes(segments[0])

  for (const candidate of prefixed ? [segments, segments.slice(1)] : [segments]) {
    const found = routes.filter(route => matches(route.pattern.split('/').filter(Boolean), candidate)).toSorted((a, b) => looseness(a.pattern) - looseness(b.pattern))[0]

    if (found)
      return found
  }

  return undefined
}

// The route paths a component's text writes, each with the file of the page serving it: a path nothing serves has no link.
export function routeLinks(source: string, routes: Route[], locales: string[]): RouteLink[] {
  return [...source.matchAll(ROUTE_PATH)].flatMap((match) => {
    const route = routeAt(match[1]!, routes, locales)
    const start = match.index + match[0].length - match[1]!.length

    return route ? [{ start, end: start + match[1]!.length, file: route.file }] : []
  })
}
