import type { TrailingSlash } from '../config'
import type { RequestContext } from './request-context'
import { decodePath } from './routes'

export type RouteKind = 'page' | 'action' | 'endpoint' | 'api' | 'socket' | 'file' | 'kay' | 'mounted'

// What a route reads of the request, each part a schema the `input` phase validates against.
export interface RouteInput {
  params?: unknown
  query?: unknown
  body?: unknown
  headers?: unknown
}

// One route kay serves, whatever it is: the table holds nothing else. `path` is Bun's syntax (`/blog/:slug`, `/docs/*`) as the router sees it, before the mount point and the slash the app asks for.
export interface RouteRecord {
  method: string
  path: string
  kind: RouteKind
  input?: RouteInput | undefined
  output?: unknown
  // Settings read by the phases (`maxSize`, `timeout`, `rateLimit`, `cors`...) and by plugins; resolved nearest first, which the slices moving routes onto the table fill in.
  options: Record<string, unknown>
  // The app, a library's name, or `kay`.
  owner: string
  // The locale a prefixed or translated path serves in.
  locale?: string | undefined
  handle?: ((context: RequestContext) => unknown) | undefined
  // A Response known at boot, which `Bun.serve` answers with no JS while no phase has anything to apply.
  static?: Response | undefined
}

export interface RouteEnv {
  base: string
  trailingSlash: TrailingSlash
}

// A record under one spelling of its path.
export interface Compiled {
  record: RouteRecord
  // The path as registered, the mount point and the slash included.
  path: string
  segments: string[]
  // Set for the other spelling of a page's path, which answers with a redirect to the served one.
  redirect: boolean
}

type Params = Record<string, string>

const EDGE_SLASHES = /^\/+/

// Every spelling a record is served under: a proxy may strip the mount point or not, so both are served; a page follows `trailingSlash`, the other spelling redirecting to it, and every other kind is served as written.
export function compileRecord(record: RouteRecord, env: RouteEnv): Compiled[] {
  const bases = env.base === '' ? [''] : ['', env.base]
  const catchAll = record.path.endsWith('/*')
  const policy = record.kind === 'page' && !catchAll ? env.trailingSlash : 'exact'
  const compiled: Compiled[] = []

  for (const base of bases) {
    const joined = record.path === '/' ? base : `${base}${record.path}`
    const bare = joined === '' ? '/' : joined
    const slashed = joined === '' ? '/' : `${joined}/`
    const spelling = (path: string, redirect: boolean) => compiled.push({ record, path, segments: path.split('/'), redirect })

    if (policy === 'exact' || (bare === '/' && slashed === '/')) {
      spelling(bare, false)

      continue
    }

    if (policy === 'ignore') {
      spelling(bare, false)
      spelling(slashed, false)

      continue
    }

    spelling(policy === 'always' ? slashed : bare, false)
    spelling(policy === 'always' ? bare : slashed, true)
  }

  return compiled
}

// Whether a path has params, which only a request for it needs read from the path.
export function isDynamic(path: string): boolean {
  return path.includes(':') || path.includes('*')
}

// The params a path gives the route, each decoded once as the path writes it: `%2F` is a slash in the value and never a segment. `null` when the path is not the route's, undefined when a value holds an escape that does not decode.
export function extractParams(segments: readonly string[], pathname: string): Params | null | undefined {
  const given = pathname.split('/')
  const params: Params = {}

  for (const [index, segment] of segments.entries()) {
    if (segment === '*') {
      // A catch-all's own directory (`/docs` for `/docs/*`) is not one of its paths.
      if (given.length <= index)
        return null

      const value = decodePath(given.slice(index).join('/'))

      if (value === undefined)
        return undefined

      params['*'] = value

      return params
    }

    const value = given[index]

    if (value === undefined)
      return null

    if (segment.startsWith(':')) {
      if (value === '')
        return null

      const decoded = decodePath(value)

      if (decoded === undefined)
        return undefined

      params[segment.slice(1)] = decoded

      continue
    }

    if (value !== segment)
      return null
  }

  return segments.length === given.length ? params : null
}

// How early a spelling is tried among the ones with params: a static segment before a param, a param before a catch-all.
function rank(segment: string | undefined): number {
  if (segment === undefined)
    return 3

  if (segment === '*')
    return 2

  return segment.startsWith(':') ? 1 : 0
}

function bySpecificity(a: Compiled, b: Compiled): number {
  for (let index = 0; index < Math.max(a.segments.length, b.segments.length); index++) {
    const difference = rank(a.segments[index]) - rank(b.segments[index])

    if (difference !== 0)
      return difference
  }

  return 0
}

type Methods = Map<string, Compiled>

export interface Match {
  compiled: Compiled
  // Undefined for a path whose param held an escape that does not decode.
  params: Params | undefined
}

// The records by method and path, for a request `Bun.serve`'s router did not match for kay: a rewritten one, or one that came through `fetch` alone.
export class RouteIndex {
  readonly #exact = new Map<string, Methods>()
  readonly #dynamic = new Map<string, Methods>()

  constructor(compiled: readonly Compiled[]) {
    // Sorted so the dynamic paths are tried most specific first, a Map keeping their order.
    for (const entry of [...compiled].sort(bySpecificity)) {
      const table = isDynamic(entry.path) ? this.#dynamic : this.#exact
      const methods = table.get(entry.path) ?? new Map<string, Compiled>()

      table.set(entry.path, methods)

      // The first record of a method keeps it, as the router tries them in order.
      if (!methods.has(entry.record.method))
        methods.set(entry.record.method, entry)
    }
  }

  match(method: string, pathname: string): Match | undefined {
    const exact = this.#exact.get(pathname)

    if (exact !== undefined) {
      const compiled = pick(exact, method)

      return compiled && { compiled, params: {} }
    }

    for (const [path, methods] of this.#dynamic) {
      const params = extractParams(path.split('/'), pathname)

      if (params === null)
        continue

      const compiled = pick(methods, method)

      if (compiled !== undefined)
        return { compiled, params }
    }

    return undefined
  }
}

// The record for a method: its own, else `ALL`, else a GET one for a HEAD.
function pick(methods: Methods, method: string): Compiled | undefined {
  return methods.get(method) ?? methods.get('ALL') ?? (method === 'HEAD' ? methods.get('GET') : undefined)
}

// The path a redirect from the other slash spelling goes to, from the one it was asked at: one slash more or less, and no leading `//`, which a browser reads as another host.
export function slashed(pathname: string, search: string): string {
  const path = `/${pathname.replace(EDGE_SLASHES, '')}`

  return `${path.endsWith('/') ? path.slice(0, -1) : `${path}/`}${search}`
}
