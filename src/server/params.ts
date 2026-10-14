import type { TrailingSlash } from '../config'
import type { Route } from './routes'
import { join } from 'node:path'
import * as builtIn from '../runtime/params'
import { importModule } from './bundle'
import { decodePath, patternShapes, withoutSlash } from './routes'
import { projectSource } from './source'

const EDGE_SLASHES = /^\/+|\/+$/g

// Gives the param's value, or undefined to refuse the URL, which then falls through to the next page serving its path.
export type Matcher = (value: string) => unknown

// One path a route serves as the router registers it: params named by position, `/blog/:p2`, so pages naming the same segment apart share one router path.
export interface RouterShape {
  path: string
  // The route's param at each segment index of the path.
  positions: [number, string][]
}

// The project's own matchers live beside the routes directory, one default export per file: `src/params/even.ts`.
export function matcherFile(routesDir: string, name: string): string {
  return join(routesDir, '..', 'params', `${name}.ts`)
}

// Every matcher the routes name: the project's own file, else the one kay ships of that name.
export async function loadMatchers(routesDir: string, routes: Route[]): Promise<Map<string, Matcher>> {
  const matchers = new Map<string, Matcher>()
  const source = projectSource()

  for (const route of routes) {
    for (const name of Object.values(route.matchers ?? {})) {
      if (matchers.has(name))
        continue

      const file = matcherFile(routesDir, name)

      if (source.has(file)) {
        const matcher = (await importModule<{ default?: unknown }>(file)).default

        if (typeof matcher !== 'function')
          throw new TypeError(`kay: ${file} must export a matcher by default: export default (value: string) => value or undefined`)

        matchers.set(name, matcher as Matcher)

        continue
      }

      if (!Object.hasOwn(builtIn, name))
        throw new Error(`kay: ${route.file} names the matcher ${name}, which is neither ${file} nor one kay ships: ${Object.keys(builtIn).join(', ')}`)

      matchers.set(name, builtIn[name as keyof typeof builtIn])
    }
  }

  return matchers
}

// Under a static prefix, such as a locale's `/en`, the positions count its segments too; a pattern a locale translates names the route's params where it puts them.
export function routerShapes(route: Route, prefix = '', pattern = route.pattern): RouterShape[] {
  return patternShapes(pattern).map((shape) => {
    const positions: [number, string][] = []
    const path = (prefix === '' ? shape : `${prefix}${shape === '/' ? '' : shape}`).split('/').map((segment, index) => {
      if (segment === '*') {
        positions.push([index, route.catchAll!])

        return segment
      }

      if (!segment.startsWith(':'))
        return segment

      positions.push([index, segment.slice(1)])

      return `:p${index}`
    }).join('/')

    return { path, positions }
  })
}

// A candidate checking none of its params with a matcher takes whatever reaches it, so it is tried last.
export function isPlain({ route, shape }: { route: Route, shape: RouterShape }): boolean {
  return shape.positions.every(([, name]) => route.matchers?.[name] === undefined)
}

// The route's params from the router's positional ones, or `malformed` for an encoding that decodes to nothing; Elysia decodes named params, null when malformed, and leaves the catch-all encoded.
// A catch-all served with a trailing slash, as `trailingSlash: 'always'` serves it, reads the same as without.
export function positionalParams(shape: RouterShape, route: Route, raw: Record<string, string | null | undefined>): Record<string, string> | 'malformed' {
  const params: Record<string, string> = {}

  for (const [index, name] of shape.positions) {
    const value = name === route.catchAll ? decodePath(withoutSlash(`/${raw['*'] ?? ''}`).slice(1)) : raw[`p${index}`]

    if (typeof value !== 'string')
      return 'malformed'

    params[name] = value
  }

  return params
}

// The params as the page reads them, each matcher's value in place of its text; undefined when a matcher refuses one.
export function matchedParams(route: Route, params: Record<string, string>, matchers: Map<string, Matcher>): Record<string, unknown> | undefined {
  const matched: Record<string, unknown> = { ...params }

  for (const [name, matcher] of Object.entries(route.matchers ?? {})) {
    const value = params[name]

    // An optional param left out of the URL has nothing to check.
    if (value === undefined)
      continue

    matched[name] = matchers.get(matcher)!(value)

    if (matched[name] === undefined)
      return undefined
  }

  return matched
}

// A path `shapeParams` accepted, spelled as a visit to it reaches the guards: each static segment as the shape names it, a param's as sent, its slashes as the redirects leave them.
export function servedPath(shape: RouterShape, path: string, trailingSlash: TrailingSlash): string {
  const segments = path.split('/')
  const served: string[] = []

  for (const [index, segment] of shape.path.split('/').entries()) {
    if (segment === '*') {
      served.push(segments.slice(index).join('/'))

      break
    }

    served.push(segment.startsWith(':') ? segments[index]! : segment)
  }

  return slashSpelling(served.join('/') || '/', shape, trailingSlash)
}

// The spelling of a path a visit is redirected to: `/about/` to `/about`, or the other way with `always`, leading slashes collapsed, so `//host/` never leaves the site; a catch-all's own directory keeps one slash, as `/docs` is not one of its paths.
export function slashSpelling(pathname: string, shape: RouterShape, trailingSlash: TrailingSlash): string {
  if (trailingSlash === 'ignore' || pathname === '/')
    return pathname

  const path = `/${pathname.replace(EDGE_SLASHES, '')}`
  const directory = shape.path.endsWith('/*') && path.split('/').length === shape.path.split('/').length - 1

  return trailingSlash === 'always' || directory ? `${path}/` : path
}

// The params `path` gives the route through `shape`, decoded and matched as a request's are: undefined when the shape cannot serve the path or a matcher refuses it. Looser than the router, a catch-all taking an empty rest and a static segment its decoded text, which reads no params a valid page would not give.
export function shapeParams(shape: RouterShape, route: Route, path: string, matchers: Map<string, Matcher>): Record<string, unknown> | undefined {
  const pattern = shape.path.split('/')
  const segments = withoutSlash(path).split('/')
  const raw: Record<string, string | null> = {}

  for (const [index, segment] of pattern.entries()) {
    if (segment === '*') {
      raw['*'] = segments.slice(index).join('/')

      break
    }

    const value = segments[index]

    // The router gives no param an empty segment.
    if (value === undefined || (segment.startsWith(':') && value === ''))
      return undefined

    if (segment.startsWith(':'))
      raw[segment.slice(1)] = decodePath(value) ?? null
    else if (segment !== value && segment !== decodePath(value))
      return undefined
  }

  if (raw['*'] === undefined && segments.length !== pattern.length)
    return undefined

  const text = positionalParams(shape, route, raw)

  return text === 'malformed' ? undefined : matchedParams(route, text, matchers)
}
