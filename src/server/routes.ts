import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { findKayFiles } from '../build/files'

export interface Route {
  // Elysia path pattern: `/todos/:id`, `/docs/*`.
  pattern: string
  file: string
  params: string[]
  // The parameter a `[...name].kay` file binds to Elysia's `*`.
  catchAll?: string
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

const DYNAMIC_SEGMENT = /^\[(\.\.\.)?([A-Z_$][\w$]*)\]$/i
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

  const segments = relative(routesDir, file).replace(KAY_EXTENSION, '').split(sep)

  if (segments.at(-1) === 'index')
    segments.pop()

  const params: string[] = []
  let catchAll: string | undefined
  const parts = segments.map((segment) => {
    const match = DYNAMIC_SEGMENT.exec(segment)

    if (!match)
      return segment

    params.push(match[2]!)

    if (!match[1])
      return `:${match[2]}`

    catchAll = match[2]

    return '*'
  })

  return { pattern: `/${parts.join('/')}`, file, params, catchAll }
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

  refuseClashes(routesDir, routes)

  return routes
}

// Elysia serves one page per path, takes one param name per segment and misreads some characters in a file name: each stops the boot with its own message, rather than a page shadowing another or a raw router error.
function refuseClashes(routesDir: string, routes: Route[]): void {
  const byPath = new Map<string, Route>()
  const paramAt = new Map<string, { name: string, route: Route }>()

  for (const route of routes) {
    if (relative(routesDir, route.file).replace(KAY_EXTENSION, '').split(sep).some(segment => !DYNAMIC_SEGMENT.test(segment) && ROUTER_SYNTAX.test(segment)))
      throw new Error(`kay: ${route.file} has a :, * or ' in its name, which the router cannot serve; rename it`)

    const path = route.pattern.replace(PARAM_NAME, ':')
    const same = byPath.get(path)

    if (same)
      throw new Error(`kay: ${same.file} and ${route.file} both serve ${same.pattern}`)

    byPath.set(path, route)

    const segments = route.pattern.split('/')

    for (const [index, segment] of segments.entries()) {
      if (!segment.startsWith(':'))
        continue

      const prefix = segments.slice(0, index + 1).join('/').replace(PARAM_NAME, ':')
      const named = paramAt.get(prefix)

      if (named && named.name !== segment)
        throw new Error(`kay: ${named.route.file} and ${route.file} name the same segment ${named.name} and ${segment}; give it one name`)

      paramAt.set(prefix, { name: segment, route })
    }
  }
}

function layoutsOf(routesDir: string, file: string): string[] {
  return directoriesUp(routesDir, dirname(file)).map(dir => join(dir, LAYOUT)).filter(layout => existsSync(layout)).reverse()
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
