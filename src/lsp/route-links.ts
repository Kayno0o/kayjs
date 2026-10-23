import type { Span } from '../compiler/ast'
import type { Route } from '../server/routes'
import * as builtIn from '../runtime/params'
import { decodePath } from '../server/routes'

// A route path written as a string where kay reads one: a link, a form action or a navigation, never one built with `{}`.
const ROUTE_PATH = /(?<![\w-])(?:(?:href|action)=|(?:navigate|redirect)\()\s*["'`](\/(?!\/)[^"'`{}$\s?#]*)(?=[?#"'`])/g

const ROUTE_WORDS = /(?:href|action)=|navigate\(|redirect\(/

// Whether a text writes a place where a route path can be, so the route table is read from disk for no other.
export function mentionsRoute(source: string): boolean {
  return ROUTE_WORDS.test(source)
}

export interface RouteLink extends Span {
  file: string
}

// How many of the pattern's segments are params, which the route naming the path outright wins over.
function looseness(pattern: string): number {
  return pattern.split('/').filter(segment => segment.startsWith(':') || segment === '*').length
}

// A param the route's matcher refuses is no match; the matchers kay ships are run, a project's own cannot be and take whatever reaches them, and a file of `own` shadows the shipped matcher of its name.
function accepts(route: Route, own: ReadonlySet<string>, name: string, value: string): boolean {
  const matcher = route.matchers?.[name]

  if (matcher === undefined || own.has(matcher) || !Object.hasOwn(builtIn, matcher))
    return true

  const decoded = decodePath(value)

  return decoded !== undefined && (builtIn[matcher as keyof typeof builtIn] as (value: string) => unknown)(decoded) !== undefined
}

function matches(route: Route, own: ReadonlySet<string>, parts: string[], segments: string[]): boolean {
  const [part, ...rest] = parts

  if (part === undefined)
    return segments.length === 0

  if (part === '*')
    return segments.length > 0 && (route.catchAll === undefined || accepts(route, own, route.catchAll, segments.join('/')))

  if (part.endsWith('?'))
    return matches(route, own, rest, segments) || (segments.length > 0 && accepts(route, own, part.slice(1, -1), segments[0]!) && matches(route, own, rest, segments.slice(1)))

  if (segments.length === 0)
    return false

  if (part.startsWith(':'))
    return accepts(route, own, part.slice(1), segments[0]!) && matches(route, own, rest, segments.slice(1))

  return part === segments[0] && matches(route, own, rest, segments.slice(1))
}

// The order the router tries routes serving one path in: fewest params, a param before a catch-all, a matched param before a plain one.
function rank(route: Route): number[] {
  return [looseness(route.pattern), route.pattern.includes('*') ? 1 : 0, route.matchers === undefined ? 1 : 0]
}

function byRank(a: Route, b: Route): number {
  const right = rank(b)

  return rank(a).reduce((difference, value, index) => difference || value - right[index]!, 0)
}

// The page serving a path: its static route before a param's, the locale prefix a path may carry left off.
export function routeAt(path: string, routes: Route[], locales: string[], own: ReadonlySet<string> = new Set()): Route | undefined {
  const segments = path.split('/').filter(Boolean)
  const prefixed = segments[0] !== undefined && locales.includes(segments[0])

  for (const candidate of prefixed ? [segments, segments.slice(1)] : [segments]) {
    const found = routes.filter(route => matches(route, own, route.pattern.split('/').filter(Boolean), candidate)).toSorted(byRank)[0]

    if (found)
      return found
  }

  return undefined
}

// The route paths a component's text writes, each with the file of the page serving it: a path nothing serves has no link.
export function routeLinks(source: string, routes: Route[], locales: string[], own: ReadonlySet<string> = new Set()): RouteLink[] {
  return [...source.matchAll(ROUTE_PATH)].flatMap((match) => {
    const route = routeAt(match[1]!, routes, locales, own)
    const start = match.index + match[0].length - match[1]!.length

    return route ? [{ start, end: start + match[1]!.length, file: route.file }] : []
  })
}
