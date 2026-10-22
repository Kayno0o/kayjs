import type { KayExtension } from '../config'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { findKayFiles, findProjectFiles, KAY_FILE, scriptLoader, TS_FILE } from '../build/files'
import { GLOB_CALL, globbedFiles } from '../build/glob'
import { fences, packageRoot } from '../build/libraries'
import { throughLinks } from '../build/links'
import { KayError } from '../compiler/errors'
import { TRAILING_SLASH } from '../runtime/base'

const chains = new WeakMap<string[], { file: string, files: string[], key: string }>()

// A route's layouts then its page, built once for the route instead of on every request it serves, with the one string telling the chain apart from another.
export function routeChain(route: { layouts: string[], file: string }): { files: string[], key: string } {
  const known = chains.get(route.layouts)

  if (known?.file === route.file)
    return known

  const files = [...route.layouts, route.file]
  const chain = { file: route.file, files, key: files.join('\0') }

  chains.set(route.layouts, chain)

  return chain
}

// The layouts then the file of every page a route, a guard or a failure may render, for the head of each to be written ahead.
export function styleChains(routes: Route[]): string[][] {
  const chains: string[][] = []

  for (const route of routes) {
    chains.push(routeChain(route).files)

    for (const special of [route.special, ...route.guards.map(guard => guard.special)]) {
      for (const page of [special.notFound, special.error]) {
        if (page !== undefined)
          chains.push([...page.layouts, page.file], [page.file])
      }
    }
  }

  return chains
}

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
  // `_actions.kay` files of the page's directory and above, outermost first: modules of actions no page renders, which components import too.
  actionModules?: string[] | undefined
  // What each of `actionModules`' actions are behind, as a layout's.
  actionAccess?: LayoutAccess<GuardFile>[] | undefined
  // What each layout's actions are behind, as `layouts` lists them, read at scan time since a compiled server has no source to read.
  layoutAccess?: LayoutAccess<GuardFile>[] | undefined
  special: SpecialPages
  // `_guard.ts` files covering the page and its actions, outermost first.
  guards: GuardFile[]
  // No guard is asked of it on a site with `requireGuards`: it sets `guards: false`, or a library serves it.
  open?: true | undefined
  // The extension giving the editor serves it: one of its own screens, which renders no editor over it in edit mode.
  editorOwn?: true | undefined
}

// What a layout's actions run: the guards of its own directory and above, none when it sets `guards: false`, and `open` when it does or a library serves it.
export interface LayoutAccess<Guard> {
  guards: Guard[]
  open?: true | undefined
}

// A file under the routes directory answering GET with what its `GET` returns: `llms.txt.ts` serves `/llms.txt`.
export interface Endpoint {
  // The router path: `/llms.txt`, or `/feeds/:slug` for `feeds/[slug].json.ts`, whose last param ends in its `suffix`, `.json`.
  pattern: string
  file: string
  params: string[]
  suffix?: string | undefined
  guards: GuardFile[]
  open?: true | undefined
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
  // The extension giving the editor holds it, as `Route`'s.
  editorOwn?: true | undefined
}

// A library's pages laid over the app's routes under `prefix`, `/auth` or `''` for the root, as an extension in `extensions` mounts them.
export interface RouteMount {
  dir: string
  prefix: string
  // The extension gives the editor too.
  editor?: true | undefined
  // Set on the trees of API modules: where the API is mounted, `/api` unless `apiPath` moves it.
  apiPath?: string | undefined
  // A layout the extension wraps every page in, outside the app's own: the mount serves no page and holds no other layout.
  outer?: string | undefined
  // Set with `outer`: the layout wraps only the pages reaching one of these files, or for `'context'` a template that reads `ctx`.
  reaching?: string[] | 'context' | undefined
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
// A file whose `page` sets `layouts: false` is not wrapped by the layouts above it: a page by none, a layout by its parent directories' ones; a page setting `guards: false` runs none of the guards above it, nor do its actions, and a layout setting it opens its own actions.
const PAGE_EXPORT = /^export\s+const\s+page\s*=\s*\{/m
const FALSE_KEY = /(?:([A-Za-z_$][\w$]*)|'([^'\n]*)'|"([^"\n]*)")\s*:\s*false(?![\w$])/y
const SPACE = /\s/
const LAYOUT = '_layout.kay'
const ACTIONS = '_actions.kay'
const NOT_FOUND = '_404.kay'
const ERROR = '_error.kay'
const GUARD = '_guard.ts'
// What Elysia reads as a parameter, a wildcard or breaks the code it generates on, in a static segment.
const ROUTER_SYNTAX = /[:*']/
// `llms.txt.ts` or `[slug].json.ts`: an extension of its own before `.ts`, which a module of helpers beside the pages has not; nor is a test or a declaration file an endpoint.
const ENDPOINT_FILE = /\.[a-z\d]+\.ts$/i
const NOT_ENDPOINT = /\.(?:test|spec|d)\.ts$/
const SUFFIXED_PARAM = /^(\[\[?[^[\]]+\]\]?)(\.[\w.-]+)$/

// The methods of an Elysia instance's routes that answer requests, as `kay routes` and the dev tool list them.
// The methods that read, which a route answering GET answers too.
export const READ_METHODS = new Set(['GET', 'HEAD'])
export const ROUTE_METHODS = /^(?:get|post|put|patch|delete|head|options|all|ws)$/i
const BRACKETS = /[[\]]/
const PARAM_NAME = /:[^/]+/g
const EDGE_SLASHES = /^\/+|\/+$/g
const LEADING_SLASHES = /^\/+/
// What a decoded segment must escape before the URL parser reads it as one segment, tab and line breaks included, which it would drop: the rest it encodes itself where a browser would.
const SEGMENT_ESCAPES = /[%/\\?#\t\n\r]/g
// The characters `encodeURIComponent` keeps, and the slash between segments.
const UNRESERVED_PATH = /^[\w\-.!~*'()/]*$/

// The route a file under the routes directory serves; files starting with `_` (layouts, partials) serve none.
export function routeOf(routesDir: string, file: string, prefix = ''): Omit<Route, 'layouts' | 'special' | 'guards'> | undefined {
  if (basename(file).startsWith('_'))
    return undefined

  const segments = [...prefix.split('/').slice(1), ...relative(routesDir, file).replace(KAY_FILE, '').split(sep)].filter(segment => !GROUP_SEGMENT.test(segment))

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
  await loadContextReader(mounts)

  const trees = routeTrees(routesDir, mounts)
  const routes: Route[] = []
  const read = readFor(trees)
  const served = new Set<string>()
  const access = new Map<string, LayoutAccess<GuardFile>>()
  const accessOf = (layout: string) => {
    let found = access.get(layout)

    if (!found)
      access.set(layout, found = layoutAccess(trees, layout, read))

    return found
  }

  for (const tree of pageTrees(trees)) {
    const own: Route[] = []

    for (const file of existsSync(tree.dir) ? await findKayFiles(tree.dir) : []) {
      const route = routeOf(tree.dir, file, tree.prefix)

      if (route && !served.has(routerKey(route.pattern))) {
        const at = virtualDir(trees, dirname(file))
        const open = setsFalse(file, 'guards', read)

        const layouts = layoutsOf(trees, at, file, read)
        const mounted = tree !== trees[0]

        const actionModules = directoriesUp(at).flatMap(dir => fileAt(trees, dir, ACTIONS) ?? []).reverse()

        own.push({ ...route, layouts, layoutAccess: layouts.map(accessOf), ...actionModules.length > 0 && { actionModules, actionAccess: actionModules.map(accessOf) }, special: specialPagesOf(trees, at, read), guards: open ? [] : guardsOf(trees, at, read), ...(open || mounted) && { open: true }, ...tree.editor && { editorOwn: true } })
      }
    }

    for (const route of own)
      served.add(routerKey(route.pattern))

    routes.push(...own)
  }

  return routes
}

// The app's endpoint files, then each mounted library's that the app has none of at the same path.
export async function scanEndpoints(routesDir: string, mounts: RouteMount[] = []): Promise<Endpoint[]> {
  const trees = routeTrees(routesDir, mounts)
  const endpoints: Endpoint[] = []
  const read = readFor(trees)
  const served = new Set<string>()

  for (const tree of pageTrees(trees)) {
    const own: Endpoint[] = []

    for (const file of existsSync(tree.dir) ? await findProjectFiles(tree.dir, ENDPOINT_FILE) : []) {
      const endpoint = endpointOf(tree.dir, file, tree.prefix)

      if (endpoint && !served.has(endpointKey(endpoint))) {
        const open = setsFalse(file, 'guards', read)

        own.push({ ...endpoint, guards: open ? [] : guardsOf(trees, virtualDir(trees, dirname(file)), read), ...(open || tree !== trees[0]) && { open: true } })
      }
    }

    for (const endpoint of own)
      served.add(endpointKey(endpoint))

    endpoints.push(...own)
  }

  return endpoints
}

// Named as a page is, `[name]` taking a segment, with its extension kept in the path; the last param may carry the extension, `[slug].json`.
function endpointOf(routesDir: string, file: string, prefix: string): Omit<Endpoint, 'guards'> | undefined {
  if (basename(file).startsWith('_') || NOT_ENDPOINT.test(file))
    return undefined

  const name = file.replace(TS_FILE, '')
  const suffixed = SUFFIXED_PARAM.exec(basename(name))
  const route = routeOf(routesDir, suffixed ? join(dirname(name), suffixed[1]!) : name, prefix)

  if (!route)
    return undefined

  if (route.catchAll !== undefined || route.optional || route.matchers)
    throw new KayError('route-invalid', `kay: ${file} answers one path per set of params, so each of its params is a plain [name] segment, with no ..., [[ ]] or matcher`)

  if (route.pattern.split('/').some(segment => !segment.startsWith(':') && (BRACKETS.test(segment) || ROUTER_SYNTAX.test(segment))))
    throw new KayError('route-invalid', `kay: ${file} has a [, ], :, * or ' in its name outside a [name] param, which the router cannot serve; rename it`)

  return { pattern: route.pattern, file, params: route.params, ...suffixed && { suffix: suffixed[2] } }
}

// Where an endpoint answers: `/feeds/:slug.json` for `feeds/[slug].json.ts`.
export function endpointPath(endpoint: Pick<Endpoint, 'pattern' | 'suffix'>): string {
  return endpoint.pattern + (endpoint.suffix ?? '')
}

// Where an API module's route answers, a module's `/` at its mount.
export function apiRoutePath(mount: string, path: string): string {
  return mount + (path === '/' ? '' : path)
}

// What two endpoints compare by: their router path, params unnamed, and the extension of the last.
export function endpointKey(endpoint: Pick<Endpoint, 'pattern' | 'suffix'>): string {
  return `${routerKey(endpoint.pattern)}${endpoint.suffix ?? ''}`
}

// A page whose file name holds what the router reads as syntax stops the server.
export function refuseRouteNames(routesDir: string, routes: Route[]): void {
  for (const route of routes) {
    if (relative(routesDir, route.file).replace(KAY_FILE, '').split(sep).some(segment => !DYNAMIC_SEGMENT.test(segment) && !OPTIONAL_SEGMENT.test(segment) && !GROUP_SEGMENT.test(segment) && ROUTER_SYNTAX.test(segment)))
      throw new KayError('route-invalid', `kay: ${route.file} has a :, * or ' in its name, which the router cannot serve; rename it`)
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

// The keys each file read so far sets to `false` in its `page`, so a scan reads a layout once however many pages it wraps.
type LayoutsRead = Map<string, Set<string>>

// The project root of the mounts `routeMounts` built, which the walk expands an `import.meta.glob` pattern against as the build does.
const mountRoots = new WeakMap<RouteMount, string>()
const globRoots = new WeakMap<LayoutsRead, string>()

function readFor(trees: RouteMount[]): LayoutsRead {
  const read: LayoutsRead = new Map()
  const root = trees.map(tree => mountRoots.get(tree)).find(found => found !== undefined)

  if (root !== undefined)
    globRoots.set(read, root)

  return read
}

// The layouts around a page, outermost first. The one loading the values of `ctx` stays first even for a page leaving the chain, as it has no place in what it draws.
function layoutsOf(trees: RouteMount[], at: string, file: string, read: LayoutsRead): string[] {
  const chain = ownLayouts(trees, at, file, read)
  const loading = trees.flatMap(tree => tree.reaching === 'context' && tree.outer !== undefined && reaches([file, ...chain], 'context', read) ? [tree.outer] : [])

  return [...loading, ...chain]
}

function ownLayouts(trees: RouteMount[], at: string, file: string, read: LayoutsRead): string[] {
  if (setsFalse(file, 'layouts', read))
    return []

  const layouts = directoriesUp(at).flatMap(dir => fileAt(trees, dir, LAYOUT) ?? []).reverse()
  // The innermost layout that leaves its parents out starts the chain.
  const reset = layouts.findLastIndex(layout => setsFalse(layout, 'layouts', read))

  if (reset !== -1)
    return layouts.slice(reset)

  const outers = trees.flatMap(tree => tree.outer !== undefined && tree.reaching !== 'context' && (tree.reaching === undefined || reaches([file, ...layouts], tree.reaching, read)) ? [tree.outer] : [])

  return [...outers, ...layouts]
}

// Every specifier a module names, static or dynamic; one in a comment or a string only adds a file the walk follows for nothing.
const IMPORT = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g
const importsRead = new WeakMap<LayoutsRead, Map<string, string[]>>()
const reachRead = new WeakMap<LayoutsRead, Map<string, boolean>>()

function realFile(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// The files a module imports that the walk follows, whether through an import or an `import.meta.glob` pattern: components anywhere, scripts of the app only.
function importsOf(file: string, read: LayoutsRead): string[] {
  let memo = importsRead.get(read)

  if (memo === undefined)
    importsRead.set(read, memo = new Map<string, string[]>())

  let found = memo.get(file)

  if (found === undefined) {
    found = []
    memo.set(file, found)

    let source = ''

    try {
      source = readFileSync(file, 'utf8')
    }
    catch {}

    const followed = (real: string) => KAY_FILE.test(real) || (TS_FILE.test(real) && !real.split(sep).includes('node_modules'))

    // Text such as `from 'Bob'` matches too, so each specifier resolves on its own and one that does not is skipped.
    for (const [, specifier] of source.matchAll(IMPORT)) {
      try {
        const real = realFile(Bun.resolveSync(specifier!, dirname(file)))

        if (followed(real))
          found.push(real)
      }
      catch {}
    }

    try {
      for (const path of source.includes(GLOB_CALL) ? globbedFiles(KAY_FILE.test(file) ? fences(source) : source, file, globRoots.get(read) ?? packageRoot(dirname(file)), KAY_FILE.test(file) ? 'ts' : scriptLoader(file)) ?? [] : []) {
        const real = realFile(path)

        if (followed(real))
          found.push(real)
      }
    }
    catch {
      // A glob the build cannot read, which the build or the check reports as it reaches the module.
    }
  }

  return found
}

// Whether the import graph from `starts` reaches one of `targets`, or a template reading `ctx` for `'context'`.
function reaches(starts: string[], targets: string[] | 'context', read: LayoutsRead): boolean {
  let memo = reachRead.get(read)

  if (memo === undefined)
    reachRead.set(read, memo = new Map<string, boolean>())

  const files = targets === 'context' ? undefined : new Set(targets.map(realFile))
  const wanted = files === undefined ? (file: string) => readsContext(file, read) : (file: string) => files.has(file)
  const key = targets === 'context' ? targets : targets.join('\0')

  return starts.some((start) => {
    const at = `${key}\0${start}`
    let found = memo.get(at)

    if (found === undefined)
      memo.set(at, found = walk(realFile(start), wanted, read))

    return found
  })
}

function walk(start: string, wanted: (file: string) => boolean, read: LayoutsRead): boolean {
  const seen = new Set<string>()
  const queue = [start]

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (wanted(file))
      return true

    if (!seen.has(file)) {
      seen.add(file)
      queue.push(...importsOf(file, read))
    }
  }

  return false
}

// The compiler stays out of a served app, so it loads once a scan meets the mount reading `ctx`.
let contextReader: ((source: string) => boolean) | undefined

function loadedFirst(): never {
  throw new KayError('route-invalid', 'kay: the templates reading ctx are read before scanRoutes loaded the compiler')
}

async function loadContextReader(mounts: RouteMount[]): Promise<void> {
  if (contextReader === undefined && mounts.some(mount => mount.reaching === 'context'))
    contextReader = (await import('./context-reads')).readsImplicitContext
}

const contextRead = new WeakMap<LayoutsRead, Map<string, boolean>>()

// Whether the template of a `.kay` file reads `ctx` with no `ctx` of its own, as the compiler decides when it imports the one of kay.
function readsContext(file: string, read: LayoutsRead): boolean {
  if (!KAY_FILE.test(file))
    return false

  let memo = contextRead.get(read)

  if (memo === undefined)
    contextRead.set(read, memo = new Map<string, boolean>())

  let found = memo.get(file)

  if (found === undefined) {
    const reader = contextReader ?? loadedFirst()

    try {
      found = reader(readFileSync(file, 'utf8'))
    }
    catch {
      found = false
    }

    memo.set(file, found)
  }

  return found
}

function setsFalse(file: string, key: string, read: LayoutsRead): boolean {
  let found = read.get(file)

  if (found === undefined)
    read.set(file, found = falseKeys(readFileSync(file, 'utf8')))

  return found.has(key)
}

// The guards a layout's actions run, its own directory's and above whichever page it wraps; a library's are open, as its pages are.
function layoutAccess(trees: RouteMount[], layout: string, read: LayoutsRead): LayoutAccess<GuardFile> {
  if (setsFalse(layout, 'guards', read))
    return { guards: [], open: true }

  // An outer layout has no place in the URL tree: it wraps every page, so the guards from the root cover it.
  const at = trees.some(tree => tree.outer === layout) ? '' : virtualDir(trees, dirname(layout))

  return { guards: guardsOf(trees, at, read), ...!layout.startsWith(trees[0]!.dir + sep) && { open: true } }
}

// The keys set to `false` in the object literal `head` opens, `export const page = { ... }` unless named, read without parsing the module: the server never loads a compiler.
export function falseKeys(source: string, head = PAGE_EXPORT): Set<string> {
  const keys = new Set<string>()

  for (const at of entryStarts(source, head)) {
    FALSE_KEY.lastIndex = at
    const key = FALSE_KEY.exec(source)
    // The literal itself, not an expression starting with it: a comma or the closing brace follows.
    const next = key ? source[codeAfter(source, FALSE_KEY.lastIndex)] : undefined

    if (key && (next === ',' || next === '}'))
      keys.add(key[1] ?? key[2] ?? key[3]!)
  }

  return keys
}

export interface UnreadSetting {
  // The setting's key, or `...` for a spread or a computed key, which may carry any.
  key: string
  // Where the entry starts in the source.
  index: number
}

// A getter, setter, async or generator method may lead the key: the entry is then not a literal, so it is reported.
const SETTING_KEY = /(?:(?:async|get|set)\s+(?=[\w$'"*]))?\*?\s*(?:([A-Z_$][\w$]*)|'([^'\n]*)'|"([^"\n]*)")\s*/iy
const LITERAL_SETTING = /(?:[A-Za-z_$][\w$]*|'[^'\n]*'|"[^"\n]*")\s*:\s*(?:true|false)(?![\w$])/y
const LITERAL_SETTINGS = new Set(['guards', 'layouts'])

// The entries of the object literal `head` opens that kay does not read as written: a spread or a computed key, which may carry `guards` or `layouts`, and a `guards` or `layouts` set to anything but a literal `true` or `false`, which the server ignores.
export function unreadSettings(source: string, head = PAGE_EXPORT): UnreadSetting[] {
  const found: UnreadSetting[] = []

  for (const index of entryStarts(source, head)) {
    if (source.startsWith('...', index) || source[index] === '[') {
      found.push({ key: '...', index })

      continue
    }

    SETTING_KEY.lastIndex = index
    const key = SETTING_KEY.exec(source)
    const name = key ? key[1] ?? key[2] ?? key[3]! : undefined

    if (name === undefined || !LITERAL_SETTINGS.has(name))
      continue

    // Written as the server reads it, key, colon and value with no comment or parenthesis between.
    LITERAL_SETTING.lastIndex = index
    const literal = LITERAL_SETTING.test(source) && [',', '}'].includes(source[codeAfter(source, LITERAL_SETTING.lastIndex)]!)

    if (!literal)
      found.push({ key: name, index })
  }

  return found
}

// Where each entry of the object literal `head` opens starts, past its brace or a comma: a key, a spread, or the bracket of a computed key.
function entryStarts(source: string, head: RegExp): number[] {
  const starts: number[] = []
  const found = codeMatch(source, head)

  if (!found)
    return starts

  let depth = 1
  // Where a key of the object itself may start: past its brace or a comma.
  let atKey = true

  for (let i = found.index + found[0].length; i < source.length && depth > 0; i++) {
    const char = source[i]!
    const end = literalEnd(source, i)

    if (end !== -1) {
      if (depth === 1 && atKey && (char === '\'' || char === '"'))
        starts.push(i)

      if (char !== '/')
        atKey = false

      i = end
    }
    else if (char === '{' || char === '(' || char === '[') {
      if (depth === 1 && atKey && char === '[')
        starts.push(i)

      depth++
      atKey = false
    }
    else if (char === '}' || char === ')' || char === ']') {
      depth--
    }
    else if (depth === 1 && char === ',') {
      atKey = true
    }
    else if (!SPACE.test(char)) {
      if (depth === 1 && atKey)
        starts.push(i)

      atKey = false
    }
  }

  return starts
}

// The first match of `pattern` in code, not in a comment, a string or a template literal.
function codeMatch(source: string, pattern: RegExp): RegExpExecArray | undefined {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  // Where the code read so far ends.
  let code = 0

  for (let found = global.exec(source); found; found = global.exec(source)) {
    while (code < found.index) {
      const end = literalEnd(source, code)

      code = end === -1 ? code + 1 : end + 1
    }

    if (code === found.index)
      return found

    global.lastIndex = code
  }

  return undefined
}

// Where the code past `start` resumes, after spaces and comments.
function codeAfter(source: string, start: number): number {
  let at = start

  while (at < source.length) {
    if (SPACE.test(source[at]!))
      at++
    else if (source[at] === '/' && (source[at + 1] === '/' || source[at + 1] === '*'))
      at = literalEnd(source, at) + 1
    else
      break
  }

  return at
}

// Where the comment, string or template literal starting at `start` ends, its last character; -1 when none starts there.
function literalEnd(source: string, start: number): number {
  const char = source[start]

  if (char === '/' && (source[start + 1] === '/' || source[start + 1] === '*')) {
    const end = source[start + 1] === '/' ? source.indexOf('\n', start) : source.indexOf('*/', start + 2) + 1

    return end <= 0 ? source.length : end
  }

  if (char !== '\'' && char !== '"' && char !== '`')
    return -1

  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
    }
    else if (source[i] === char) {
      return i
    }
    else if (char === '`' && source.startsWith('${', i)) {
      i = closingBrace(source, i + 2)
    }
  }

  return source.length
}

// The brace closing a block opened before `start`, past the literals it holds.
function closingBrace(source: string, start: number): number {
  let depth = 1

  for (let i = start; i < source.length; i++) {
    const end = literalEnd(source, i)

    if (end !== -1)
      i = end
    else if (source[i] === '{')
      depth++
    else if (source[i] === '}' && --depth === 0)
      return i
  }

  return source.length
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
    notFound: special.notFound && { ...special.notFound, layouts: [] },
    error: special.error && { ...special.error, layouts: [] },
  }
}

// The special pages for a directory of the URL tree, `''` for the root, `/account` below it.
export function specialPagesOf(trees: RouteMount[], at: string, read: LayoutsRead = readFor(trees)): SpecialPages {
  const nearest = (name: string): SpecialPage | undefined => {
    for (const dir of directoriesUp(at)) {
      const tree = treeHolding(trees, dir, name)

      if (tree) {
        const file = join(tree.dir, dir.slice(tree.prefix.length), name)

        return { file, layouts: layoutsOf(trees, virtualDir(trees, dirname(file)), file, read), ...tree.editor && { editorOwn: true } }
      }
    }

    return undefined
  }

  return { notFound: nearest(NOT_FOUND), error: nearest(ERROR) }
}

// The app's routes, then each library's laid over them, as the lookups above walk them.
export function routeTrees(routesDir: string, mounts: RouteMount[] = []): RouteMount[] {
  return [{ dir: routesDir, prefix: '' }, ...mounts]
}

// The prefix of an outer layout's mount, which no URL starts with.
const OUTER_PREFIX = '/\0outer'

// The layout kay mounts first when an extension gives a `context`, loading its values for the pages reaching a template that reads `ctx`.
const CONTEXT_LAYOUT = `${import.meta.dir}/context-layout/_layout.kay`

function outerMount(layout: string, reaching?: string[] | 'context'): RouteMount {
  return { dir: dirname(layout), prefix: OUTER_PREFIX, outer: layout, ...reaching !== undefined && { reaching } }
}

// The files a layout's `reaching` names, which must exist: a typo would wrap no page and say nothing.
function reachingFiles(root: string, files: string[], verify: boolean): string[] {
  return files.map((file) => {
    const found = resolve(root, file)

    if (verify && !existsSync(found))
      throw new KayError('route-invalid', `kay: the layout of an extension reaches ${file}, which does not exist`)

    return found
  })
}

// An extension's layout is a `_layout.kay` alone in its directory, which is mounted as a tree of its own.
function checkedLayout(root: string, layout: string, verify: boolean): string {
  const file = resolve(root, layout)

  if (basename(file) !== LAYOUT || (verify && !existsSync(file)))
    throw new KayError('route-invalid', `kay: the layout ${layout} of an extension is not an existing ${LAYOUT}`)

  return file
}

// The routes each extension in `extensions` mounts, its directory as the project reaches it under `node_modules`, where a linked library's real path would name its actions after a path outside the project.
// `verify` is false in an executable, whose library code names the folders it was bundled from and whose routes are embedded already.
export function routeMounts(root: string, extensions: KayExtension[] = [], verify = true): RouteMount[] {
  const contexts = extensions.some(extension => extension.context !== undefined) ? [outerMount(CONTEXT_LAYOUT, 'context')] : []

  const mounts = [...contexts, ...extensions.flatMap(({ routes, editor, layout }) => [
    ...routes ? [{ dir: throughLinks(root, resolve(root, routes.dir)), prefix: mountPrefix(routes.prefix), ...editor !== undefined && { editor: true as const } }] : [],
    ...layout === undefined ? [] : [typeof layout === 'string' ? outerMount(throughLinks(root, checkedLayout(root, layout, verify))) : outerMount(throughLinks(root, checkedLayout(root, layout.file, verify)), reachingFiles(root, layout.reaching, verify))],
  ])]

  for (const mount of mounts)
    mountRoots.set(mount, root)

  return mounts
}

// The API directories each extension in `extensions` mounts, reached as its routes are.
export function apiMounts(root: string, extensions: KayExtension[] = []): RouteMount[] {
  return extensions.flatMap(({ api }) => api ? [{ dir: throughLinks(root, resolve(root, api.dir)), prefix: mountPrefix(api.prefix) }] : [])
}

// The prefixes under `/_kay` that extensions serve API modules at, which are no files of kay's own.
export function kayApiPrefixes(extensions: KayExtension[] = []): string[] {
  return extensions.flatMap(({ api }) => api === undefined ? [] : [mountPrefix(api.prefix)]).filter(prefix => prefix.startsWith('/_kay/'))
}

// The paths under `apiPath` that extensions moved under `/_kay`, from the prefix they had to where their modules are served now.
export function movedApiPrefixes(extensions: KayExtension[] = []): { former: string, prefix: string }[] {
  return extensions.flatMap(({ api }) => api?.former === undefined ? [] : [{ former: mountPrefix(api.former), prefix: mountPrefix(api.prefix) }])
}

// The editor an extension in `extensions` gives, reached as its routes are; a site edits through one.
export function extensionEditor(root: string, extensions: KayExtension[] = []): string | undefined {
  const giving = extensions.filter(extension => extension.editor !== undefined)

  if (giving.length > 1)
    throw new KayError('route-invalid', `kay: the extensions ${giving.map(extension => extension.name).join(' and ')} each give an editor, and a page shows one: list one of them in extensions`)

  return giving[0] && throughLinks(root, resolve(root, giving[0].editor!))
}

// `/auth` for `auth`, `/auth/` and `/auth`; `''` for the root.
function mountPrefix(prefix = '/'): string {
  const trimmed = prefix.replace(EDGE_SLASHES, '')

  return trimmed === '' ? '' : `/${trimmed}`
}

// The file a directory of the URL tree holds under `name`: the app's, else the first mounted library's.
export function fileAt(trees: RouteMount[], at: string, name: string): string | undefined {
  const tree = treeHolding(trees, at, name)

  return tree && join(tree.dir, at.slice(tree.prefix.length), name)
}

// The trees that serve pages and endpoints: an outer layout's mount holds one file and no URL starts with its prefix.
function pageTrees(trees: RouteMount[]): RouteMount[] {
  return trees.filter(tree => tree.outer === undefined)
}

// The first of the trees holding `name` at a directory of the URL tree.
function treeHolding(trees: RouteMount[], at: string, name: string): RouteMount | undefined {
  return pageTrees(trees).find(({ dir, prefix }) => (at === prefix || at.startsWith(`${prefix}/`)) && existsSync(join(dir, at.slice(prefix.length), name)))
}

// Where a directory of one of the trees sits in the URL tree.
export function virtualDir(trees: RouteMount[], dir: string): string {
  const tree = pageTrees(trees).find(({ dir: root }) => dir === root || dir.startsWith(root + sep))!
  const rest = relative(tree.dir, dir).split(sep).filter(Boolean).join('/')

  return rest === '' ? tree.prefix : `${tree.prefix}/${rest}`
}

// From `at` up to the root of the URL tree, both included: `/a/b`, `/a`, `''`.
export function directoriesUp(at: string): string[] {
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

// A browser sends `/p/a@b` where `kay build` names the page `/p/a%40b`: each segment is decoded, then encoded the one way the build does.
export function canonicalPath(pathname: string): string {
  // Plain text, which `encodeURIComponent` leaves as it is, spells itself.
  if (UNRESERVED_PATH.test(pathname))
    return pathname

  return pathname.split('/').map(segment => encodeURIComponent(decodePath(segment) ?? segment)).join('/')
}

// The URL a guard reads, each segment decoded then spelled as `new URL` spells it, so `/%61dmin` and `//admin` read as `/admin`, as the params and the router do, while `/@admin` stays as a browser sends it.
// A segment holding a malformed escape stays as sent.
export function guardUrl(url: string | URL): URL {
  const guarded = new URL(url)

  // Nothing to decode and no leading slashes to collapse.
  if (!guarded.pathname.includes('%') && !guarded.pathname.startsWith('//'))
    return guarded

  guarded.pathname = guarded.pathname.replace(LEADING_SLASHES, '/').split('/').map(segment => decodePath(segment)?.replace(SEGMENT_ESCAPES, escaped => encodeURIComponent(escaped)) ?? segment).join('/')

  return guarded
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
