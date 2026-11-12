import type { NodeAt, Nodes, Optional, RouteKey, RoutesOf, UrlOptions } from './live'
import { withBase } from './base'
import { fieldText } from './call-body'

// Set by the server on every module it mounts under `/api`, and by the browser build on the stub standing in for one: where the module's routes are served.
export const API_MOUNT = Symbol.for('kay.api')

const PARAM_SEGMENT = /^:(.+)$/

export interface UrlInput {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
}

// Where a module's route is served: its params filled in, its query appended.
export function routeUrl(module: unknown, path: string, options: UrlInput = {}): string {
  const mount = (module as { [API_MOUNT]?: string } | undefined)?.[API_MOUNT]

  if (mount === undefined)
    throw new TypeError('kay: socket(), stream(), resource(), call() and apiUrl() take the default export of a module under src/api')

  const segments = path.split('/').map((segment) => {
    if (segment === '*')
      return String(options.params?.['*'] ?? '').split('/').map(part => encodeSegment(part, path)).join('/')

    const param = PARAM_SEGMENT.exec(segment)?.[1]

    if (param === undefined)
      return segment

    const value = options.params?.[param]

    if (value === undefined)
      throw new TypeError(`kay: ${path} takes the param ${param}`)

    if (value === '')
      throw new TypeError(`kay: ${path} cannot take an empty ${param}, it would reach the collection route`)

    return encodeSegment(String(value), path)
  })
  const query = new URLSearchParams()

  for (const [name, value] of Object.entries(options.query ?? {})) {
    for (const item of Array.isArray(value) ? value as unknown[] : [value]) {
      if (item !== undefined && item !== null)
        query.append(name, fieldText(item))
    }
  }

  const search = query.size > 0 ? `?${query}` : ''
  const joined = segments.join('/')

  return `${mount}${joined === '/' ? '' : joined}${search}`
}

// Every path a route of the module answers at, its websocket routes and its streams included, and `/` for the mount itself; any string for a module typed `unknown`.
export type ApiPath<Module> = unknown extends Module ? string : Nodes<RoutesOf<Module>> extends infer Found ? Found extends { path: infer Path, node: infer Node } ? Path extends '/' ? Path : [RouteKey<Node>] extends [never] ? never : Path : never : never

// What the routes answering at a path ask of its URL; the mount, which may answer nothing, takes any.
export type ApiUrlOptions<Module, Path> = unknown extends Module ? UrlInput : NodeAt<Module, Path> extends infer Node ? [RouteKey<Node>] extends [never] ? UrlInput : UrlOptions<Numbered<Node[RouteKey<Node>]>> : never

// A path param is text to Elysia, and a number fills it as it does in `route()`.
type Numbered<Route> = Route extends { params: infer Params } ? Omit<Route, 'params'> & { params: { [Name in keyof Params]: Params[Name] extends string ? Params[Name] | number : Params[Name] } } : Route

// Where a route of a module under `src/api` is served, its params filled in and its query appended, under the site's `base` in the browser: the path follows `apiPath`, so code naming a route never writes `/api/...`. On the server the module must be mounted, which a prerender never does.
// A handler passes its `request` for the module it runs in, which it cannot name inside its own chain.
// Given a module, the path is one of its routes and the options ask for its params, as `call()` does; given a `request`, any path goes.
// kept: request, it names a route of a module the running server mounted, which a prerender never loads.
export function apiUrl(request: Request, path?: string, options?: UrlInput): string
export function apiUrl(module: unknown): string
export function apiUrl<Module, const Path extends ApiPath<Module>>(module: Module, path: Path, ...options: Optional<ApiUrlOptions<Module, Path>>): string
export function apiUrl(module: unknown, path = '/', options: UrlInput = {}): string {
  return withBase(routeUrl(module, path, options))
}

// A dot segment would be resolved by the URL parser and reach the parent route.
function encodeSegment(value: string, path: string): string {
  if (value === '.' || value === '..')
    throw new TypeError(`kay: ${path} cannot take "${value}" as a param, it would reach the parent route`)

  return encodeURIComponent(value)
}
