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

  return routes
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
