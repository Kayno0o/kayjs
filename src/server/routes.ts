import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { findKayFiles } from '../build/files'

export interface Route {
  // Path pattern: `/todos/:id`, `/docs/*`, an optional param as `/blog/:page?`.
  pattern: string
  file: string
  params: string[]
  // The parameter a `[...name].kay` file binds to Elysia's `*`.
  catchAll?: string
  // Params a `[[name]]` segment makes optional.
  optional?: string[]
  // The matcher a `[name=matcher]` segment checks its param with, by param.
  matchers?: Record<string, string>
  // `_layout.kay` files wrapping the page, outermost first.
  layouts: string[]
  special: SpecialPages
  // `_guard.ts` files covering the page and its actions, outermost first.
  guards: GuardFile[]
}

// A request a guard refuses gets the nearest special pages outside the guard's directory, wrapped by the layouts outside it, so nothing it protects renders.
export interface GuardFile {
  file: string
  special: SpecialPages
}

// A page rendered in place of another, wrapped by the layouts of its own directory.
export interface SpecialPage {
  file: string
  layouts: string[]
}

// The nearest `_404.kay` and `_error.kay` up the directory tree.
export interface SpecialPages {
  notFound?: SpecialPage
  error?: SpecialPage
}

const DYNAMIC_SEGMENT = /^\[(\.\.\.)?([A-Z_$][\w$]*)(?:=([A-Z_$][\w$-]*))?\]$/i
const OPTIONAL_SEGMENT = /^\[\[([A-Z_$][\w$]*)(?:=([A-Z_$][\w$-]*))?\]\]$/i
// `(marketing)`: groups pages for their layouts and guards, adding nothing to the URL.
const GROUP_SEGMENT = /^\(.+\)$/
// A file exporting this is not wrapped by the layouts above it: a page by none, a layout by its parent directories' ones.
const NO_LAYOUTS = /^export\s+const\s+layouts\s*=\s*false\b/m
const KAY_EXTENSION = /\.kay$/
const LAYOUT = '_layout.kay'
const NOT_FOUND = '_404.kay'
const ERROR = '_error.kay'
const GUARD = '_guard.ts'
// What Elysia reads as a parameter, a wildcard or breaks the code it generates on, in a static segment.
const ROUTER_SYNTAX = /[:*']/
const PARAM_NAME = /:[^/]+/g

// The route a file under the routes directory serves; files starting with `_` (layouts, partials) serve none.
export function routeOf(routesDir: string, file: string): Omit<Route, 'layouts' | 'special' | 'guards'> | undefined {
  if (basename(file).startsWith('_'))
    return undefined

  const segments = relative(routesDir, file).replace(KAY_EXTENSION, '').split(sep).filter(segment => !GROUP_SEGMENT.test(segment))

  if (segments.at(-1) === 'index')
    segments.pop()

  const params: string[] = []
  const optional: string[] = []
  const matchers: Record<string, string> = {}
  let catchAll: string | undefined
  const parts = segments.map((segment) => {
    const maybe = OPTIONAL_SEGMENT.exec(segment)

    if (maybe) {
      params.push(maybe[1]!)
      optional.push(maybe[1]!)

      if (maybe[2])
        matchers[maybe[1]!] = maybe[2]

      return `:${maybe[1]}?`
    }

    const match = DYNAMIC_SEGMENT.exec(segment)

    if (!match)
      return segment

    params.push(match[2]!)

    if (match[3])
      matchers[match[2]!] = match[3]

    if (!match[1])
      return `:${match[2]}`

    catchAll = match[2]

    return '*'
  })

  return { pattern: `/${parts.join('/')}`, file, params, catchAll, ...optional.length > 0 && { optional }, ...Object.keys(matchers).length > 0 && { matchers } }
}

// The concrete paths a pattern serves, each optional segment present and left out: `/blog/:page?` serves `/blog` and `/blog/:page`.
export function patternShapes(pattern: string): string[] {
  let shapes = ['']

  for (const segment of pattern.split('/').slice(1)) {
    shapes = segment.endsWith('?')
      ? shapes.flatMap(shape => [shape, `${shape}/${segment.slice(0, -1)}`])
      : shapes.map(shape => `${shape}/${segment}`)
  }

  return shapes.map(shape => shape === '' ? '/' : shape)
}

// Every path the routes serve, one per optional segment present or not, for what a public file or a built-in route must not take.
export function servedPaths(routes: Route[]): Set<string> {
  return new Set(routes.flatMap(route => patternShapes(route.pattern)))
}

export async function scanRoutes(routesDir: string): Promise<Route[]> {
  if (!existsSync(routesDir))
    return []

  const routes: Route[] = []

  for (const file of await findKayFiles(routesDir)) {
    const route = routeOf(routesDir, file)

    if (route)
      routes.push({ ...route, layouts: layoutsOf(routesDir, file), special: specialPagesOf(routesDir, dirname(file)), guards: guardsOf(routesDir, file) })
  }

  return routes
}

// Two pages serving the same path stop the server, unless all but one check a param with a matcher, which a refused URL falls through; so does a name the router misreads.
// The server and the build call it; `kay check` and the editor read routes mid-edit and leave it out.
export function refuseClashes(routesDir: string, routes: Route[]): void {
  const plainAt = new Map<string, Route>()

  for (const route of routes) {
    if (relative(routesDir, route.file).replace(KAY_EXTENSION, '').split(sep).some(segment => !DYNAMIC_SEGMENT.test(segment) && !OPTIONAL_SEGMENT.test(segment) && !GROUP_SEGMENT.test(segment) && ROUTER_SYNTAX.test(segment)))
      throw new Error(`kay: ${route.file} has a :, * or ' in its name, which the router cannot serve; rename it`)

    for (const shape of patternShapes(route.pattern)) {
      // A shape with a matcher on one of its params refuses what it does not match; `/blog` from `[[page=integer]]` has none to.
      if (paramsIn(shape, route).some(name => route.matchers?.[name] !== undefined))
        continue

      const path = shape.replace(PARAM_NAME, ':')
      const same = plainAt.get(path)

      if (same)
        throw new Error(`kay: ${same.file} and ${route.file} both serve ${shape}; give one a matcher, [id=integer], for the other to take what it refuses`)

      plainAt.set(path, route)
    }
  }
}

// The params a shape of the route's pattern names, in order.
export function paramsIn(shape: string, route: Pick<Route, 'catchAll'>): string[] {
  return shape.split('/').flatMap((segment) => {
    if (segment === '*')
      return [route.catchAll!]

    return segment.startsWith(':') ? [segment.slice(1)] : []
  })
}

function layoutsOf(routesDir: string, file: string): string[] {
  if (exportsNoLayouts(file))
    return []

  const layouts = directoriesUp(routesDir, dirname(file)).map(dir => join(dir, LAYOUT)).filter(layout => existsSync(layout)).reverse()
  // The innermost layout that leaves its parents out starts the chain.
  const reset = layouts.findLastIndex(exportsNoLayouts)

  return reset === -1 ? layouts : layouts.slice(reset)
}

function exportsNoLayouts(file: string): boolean {
  return NO_LAYOUTS.test(readFileSync(file, 'utf8'))
}

function guardsOf(routesDir: string, file: string): GuardFile[] {
  return directoriesUp(routesDir, dirname(file)).filter(dir => existsSync(join(dir, GUARD))).reverse().map(dir => ({
    file: join(dir, GUARD),
    // A guard on the routes directory covers every layout, so its special pages render bare.
    special: dir === routesDir ? withoutLayouts(specialPagesOf(routesDir, dir)) : specialPagesOf(routesDir, dirname(dir)),
  }))
}

function withoutLayouts(special: SpecialPages): SpecialPages {
  return {
    notFound: special.notFound && { file: special.notFound.file, layouts: [] },
    error: special.error && { file: special.error.file, layouts: [] },
  }
}

export function specialPagesOf(routesDir: string, dir: string): SpecialPages {
  const nearest = (name: string): SpecialPage | undefined => {
    const file = directoriesUp(routesDir, dir).map(ancestor => join(ancestor, name)).find(path => existsSync(path))

    return file ? { file, layouts: layoutsOf(routesDir, file) } : undefined
  }

  return { notFound: nearest(NOT_FOUND), error: nearest(ERROR) }
}

// From `dir` up to the routes directory, both included.
function directoriesUp(routesDir: string, dir: string): string[] {
  const dirs: string[] = []

  for (let current = dir; current.startsWith(routesDir); current = dirname(current)) {
    dirs.push(current)

    if (current === routesDir)
      break
  }

  return dirs
}

// A percent-encoded URL path, or undefined when the encoding is malformed (`/100%`).
export function decodePath(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return undefined
  }
}
