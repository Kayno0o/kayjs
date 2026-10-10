import type { KayExtension } from '../config'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { findKayFiles } from '../build/files'
import { throughLinks } from '../build/links'

export interface Route {
  // Path pattern: `/todos/:id`, `/docs/*`, an optional param as `/blog/:page?`.
  pattern: string
  file: string
  params: string[]
  // The parameter a `[...name].kay` file binds to Elysia's `*`.
  catchAll?: string | undefined
  // Params a `[[name]]` segment makes optional.
  optional?: string[] | undefined
  // The matcher a `[name=matcher]` segment checks its param with, by param.
  matchers?: Record<string, string> | undefined
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

// A library's pages laid over the app's routes under `prefix`, `/auth` or `''` for the root, as an extension in `extensions` mounts them.
export interface RouteMount {
  dir: string
  prefix: string
}

// The nearest `_404.kay` and `_error.kay` up the directory tree.
export interface SpecialPages {
  notFound?: SpecialPage | undefined
  error?: SpecialPage | undefined
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
const TRAILING_SLASH = /\/$/
const EDGE_SLASHES = /^\/+|\/+$/g

// The route a file under the routes directory serves; files starting with `_` (layouts, partials) serve none.
export function routeOf(routesDir: string, file: string, prefix = ''): Omit<Route, 'layouts' | 'special' | 'guards'> | undefined {
  if (basename(file).startsWith('_'))
    return undefined

  const segments = [...prefix.split('/').slice(1), ...relative(routesDir, file).replace(KAY_EXTENSION, '').split(sep)].filter(segment => !GROUP_SEGMENT.test(segment))

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

      if (maybe[2] !== undefined)
        matchers[maybe[1]!] = maybe[2]

      return `:${maybe[1]}?`
    }

    const match = DYNAMIC_SEGMENT.exec(segment)

    if (!match)
      return segment

    params.push(match[2]!)

    if (match[3] !== undefined)
      matchers[match[2]!] = match[3]

    if (match[1] === undefined)
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

// The app's pages, then each mounted library's that no page of the app serves the path of.
export async function scanRoutes(routesDir: string, mounts: RouteMount[] = []): Promise<Route[]> {
  const trees = routeTrees(routesDir, mounts)
  const routes: Route[] = []
  const read: LayoutsRead = new Map()
  const served = new Set<string>()

  for (const tree of trees) {
    const own: Route[] = []

    for (const file of existsSync(tree.dir) ? await findKayFiles(tree.dir) : []) {
      const route = routeOf(tree.dir, file, tree.prefix)

      if (route && !served.has(routerKey(route.pattern))) {
        const at = virtualDir(trees, dirname(file))

        own.push({ ...route, layouts: layoutsOf(trees, at, file, read), special: specialPagesOf(trees, at, read), guards: guardsOf(trees, at, read) })
      }
    }

    for (const route of own)
      served.add(routerKey(route.pattern))

    routes.push(...own)
  }

  return routes
}

// Two pages serving the same path stop the server, unless all but one check a param with a matcher, which a refused URL falls through; so does a name the router misreads.
// The server, the build and `kay check` call it; the editor, reading routes mid-edit, does not.
export function refuseClashes(routesDir: string, routes: Route[]): void {
  const plainAt = new Map<string, Route>()

  for (const route of routes) {
    if (relative(routesDir, route.file).replace(KAY_EXTENSION, '').split(sep).some(segment => !DYNAMIC_SEGMENT.test(segment) && !OPTIONAL_SEGMENT.test(segment) && !GROUP_SEGMENT.test(segment) && ROUTER_SYNTAX.test(segment)))
      throw new Error(`kay: ${route.file} has a :, * or ' in its name, which the router cannot serve; rename it`)

    for (const shape of patternShapes(route.pattern)) {
      // A shape with a matcher on one of its params refuses what it does not match; `/blog` from `[[page=integer]]` has none to.
      if (paramsIn(shape, route).some(name => route.matchers?.[name] !== undefined))
        continue

      const path = routerKey(shape)
      const same = plainAt.get(path)

      if (same)
        throw new Error(`kay: ${same.file} and ${route.file} both serve ${shape}; give one a matcher, [id=integer], for the other to take what it refuses`)

      plainAt.set(path, route)
    }
  }
}

// A router path with its params unnamed, `/blog/:` for `/blog/:slug` and `/blog/:p2` alike, a catch-all's `*` kept: what two paths compare by.
export function routerKey(path: string): string {
  return path.replace(PARAM_NAME, ':')
}

// A page's path as the `trailingSlash` setting writes it, for canonical links and the sitemap: with a slash under `always`, as it is otherwise.
export function slashedPath(path: string, trailingSlash: 'never' | 'always' | 'ignore' = 'never'): string {
  return trailingSlash === 'always' && !path.endsWith('/') ? `${path}/` : path
}

// A path without its trailing slash, `/` kept.
export function withoutSlash(path: string): string {
  return path.length > 1 ? path.replace(TRAILING_SLASH, '') : path
}

// The params a shape of the route's pattern names, in order.
export function paramsIn(shape: string, route: Pick<Route, 'catchAll'>): string[] {
  return shape.split('/').flatMap((segment) => {
    if (segment === '*')
      return [route.catchAll!]

    return segment.startsWith(':') ? [segment.slice(1)] : []
  })
}

// Whether each file read so far exports `layouts = false`, so a scan reads a layout once however many pages it wraps.
type LayoutsRead = Map<string, boolean>

function layoutsOf(trees: RouteMount[], at: string, file: string, read: LayoutsRead): string[] {
  if (exportsNoLayouts(file, read))
    return []

  const layouts = directoriesUp(at).flatMap(dir => fileAt(trees, dir, LAYOUT) ?? []).reverse()
  // The innermost layout that leaves its parents out starts the chain.
  const reset = layouts.findLastIndex(layout => exportsNoLayouts(layout, read))

  return reset === -1 ? layouts : layouts.slice(reset)
}

function exportsNoLayouts(file: string, read: LayoutsRead): boolean {
  let found = read.get(file)

  if (found === undefined)
    read.set(file, found = NO_LAYOUTS.test(readFileSync(file, 'utf8')))

  return found
}

function guardsOf(trees: RouteMount[], at: string, read: LayoutsRead): GuardFile[] {
  return directoriesUp(at).flatMap(dir => fileAt(trees, dir, GUARD) ?? []).reverse().map((file) => {
    const dir = virtualDir(trees, dirname(file))

    // A guard on the routes directory covers every layout, so its special pages render bare.
    return { file, special: dir === '' ? withoutLayouts(specialPagesOf(trees, dir, read)) : specialPagesOf(trees, parentOf(dir), read) }
  })
}

function withoutLayouts(special: SpecialPages): SpecialPages {
  return {
    notFound: special.notFound && { file: special.notFound.file, layouts: [] },
    error: special.error && { file: special.error.file, layouts: [] },
  }
}

// The special pages for a directory of the URL tree, `''` for the root, `/account` below it.
export function specialPagesOf(trees: RouteMount[], at: string, read: LayoutsRead = new Map()): SpecialPages {
  const nearest = (name: string): SpecialPage | undefined => {
    const file = directoriesUp(at).map(dir => fileAt(trees, dir, name)).find(path => path !== undefined)

    return file !== undefined ? { file, layouts: layoutsOf(trees, virtualDir(trees, dirname(file)), file, read) } : undefined
  }

  return { notFound: nearest(NOT_FOUND), error: nearest(ERROR) }
}

// The app's routes, then each library's laid over them, as the lookups above walk them.
export function routeTrees(routesDir: string, mounts: RouteMount[] = []): RouteMount[] {
  return [{ dir: routesDir, prefix: '' }, ...mounts]
}

// The routes each extension in `extensions` mounts, its directory as the project reaches it under `node_modules`, where a linked library's real path would name its actions after a path outside the project.
export function routeMounts(root: string, extensions: KayExtension[] = []): RouteMount[] {
  return extensions.flatMap(({ routes }) => routes ? [{ dir: throughLinks(root, resolve(root, routes.dir)), prefix: mountPrefix(routes.prefix) }] : [])
}

// `/auth` for `auth`, `/auth/` and `/auth`; `''` for the root.
function mountPrefix(prefix = '/'): string {
  const trimmed = prefix.replace(EDGE_SLASHES, '')

  return trimmed === '' ? '' : `/${trimmed}`
}

// The file a directory of the URL tree holds under `name`: the app's, else the first mounted library's.
function fileAt(trees: RouteMount[], at: string, name: string): string | undefined {
  for (const { dir, prefix } of trees) {
    if (at === prefix || at.startsWith(`${prefix}/`)) {
      const file = join(dir, at.slice(prefix.length), name)

      if (existsSync(file))
        return file
    }
  }

  return undefined
}

// Where a directory of one of the trees sits in the URL tree.
function virtualDir(trees: RouteMount[], dir: string): string {
  const tree = trees.find(({ dir: root }) => dir === root || dir.startsWith(root + sep))!
  const rest = relative(tree.dir, dir).split(sep).filter(Boolean).join('/')

  return rest === '' ? tree.prefix : `${tree.prefix}/${rest}`
}

// From `at` up to the root of the URL tree, both included: `/a/b`, `/a`, `''`.
function directoriesUp(at: string): string[] {
  const dirs = [at]
  let current = at

  while (current !== '') {
    current = parentOf(current)
    dirs.push(current)
  }

  return dirs
}

// The directory of the URL tree holding `at`: `/a` for `/a/b`, `''` for `/a`.
function parentOf(at: string): string {
  return at.slice(0, at.lastIndexOf('/'))
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
