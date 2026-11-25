// Route files: their URL patterns, conflicts, and the `_layout`/`_middleware` chain that wraps them.

import type { ModuleAnalysis } from '../compiler/index'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { relPosix } from './files'

export const SPECIAL_ROUTE_FILES = new Set(['_layout.tsx', '_middleware.ts', '_middleware.tsx', '_error.tsx', '_404.tsx'])
export const MIDDLEWARE_NAMES = ['_middleware.ts', '_middleware.tsx']
const ROUTE_EXPORTS = new Set(['default', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const TS_EXT_RE = /\.(?:tsx|ts)$/
const CATCH_ALL_RE = /\[\.\.\.([^\]]+)\]/g
const PARAM_RE = /\[([^\]]+)\]/g
const PATH_SEPARATOR_RE = /[/\\]/

interface ExportSpecifierNode {
  type: string
  exportKind?: string
  specifiers?: { exportKind?: string, exported?: { name?: string, value?: string } }[]
}

/** A file in routes/ is a route when it exports a default component or an HTTP method handler, directly or through `export { ... }`. */
export function hasRouteHandlerExport(analysis: ModuleAnalysis): boolean {
  for (const name of analysis.exportedNames) {
    if (ROUTE_EXPORTS.has(name))
      return true
  }
  for (const stmt of analysis.program.body as ExportSpecifierNode[]) {
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.exportKind === 'type' || stmt.specifiers === undefined)
      continue
    for (const spec of stmt.specifiers) {
      const exported = spec.exportKind === 'type' ? undefined : spec.exported?.name ?? spec.exported?.value
      if (exported !== undefined && ROUTE_EXPORTS.has(exported))
        return true
    }
  }
  return false
}

const LOAD_FIX = 'kay never calls it; export async function load() and read its data with the page\'s load prop'
const PATHS_FIX = 'kay never calls it; export function paths() returning URL strings such as "/posts/a"'
const HEAD_FIX = 'kay never reads it; render <Head> in the page'
// Exports other frameworks read from a route file, and what kay wants instead.
const FOREIGN_ROUTE_EXPORTS = new Map([
  ['getStaticProps', LOAD_FIX],
  ['getServerSideProps', LOAD_FIX],
  ['getInitialProps', LOAD_FIX],
  ['loader', LOAD_FIX],
  ['clientLoader', LOAD_FIX],
  ['getStaticPaths', PATHS_FIX],
  ['generateStaticParams', PATHS_FIX],
  ['metadata', HEAD_FIX],
  ['generateMetadata', HEAD_FIX],
  ['meta', HEAD_FIX],
  ...['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'].map(m => [m, `kay never calls it; export function ${m === 'all' ? 'GET(), POST() or another method' : `${m.toUpperCase()}()`}`] as const),
])

function findExportOffset(analysis: ModuleAnalysis, exportName: string): number {
  for (const stmt of analysis.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration')
      continue
    if (stmt.declaration?.type === 'FunctionDeclaration' && stmt.declaration.id?.name === exportName)
      return stmt.start
    if (stmt.declaration?.type === 'ClassDeclaration' && stmt.declaration.id?.name === exportName)
      return stmt.start
    if (stmt.declaration?.type === 'VariableDeclaration') {
      for (const d of stmt.declaration.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === exportName)
          return d.start
      }
    }
    for (const spec of stmt.specifiers) {
      const exp = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value
      if (exp === exportName)
        return spec.start
    }
  }
  return 0
}

/** Returns the first route export problem together with its byte offset in the module source. */
export function routeExportProblemLocation(analysis: ModuleAnalysis, file: string): { message: string, offset: number } | undefined {
  for (const name of analysis.exportedNames) {
    const fix = FOREIGN_ROUTE_EXPORTS.get(name)
    if (fix !== undefined)
      return { message: `export ${name} in ${file}: ${fix}.`, offset: findExportOffset(analysis, name) }
  }
  for (const stmt of analysis.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.declaration?.type !== 'VariableDeclaration')
      continue
    for (const d of stmt.declaration.declarations) {
      const name = d.id.type === 'Identifier' ? d.id.name : undefined
      const init = d.init
      if (name === 'paths' && init !== null && init.type !== 'ArrowFunctionExpression' && init.type !== 'FunctionExpression')
        return { message: `export const paths in ${file}: export function paths() returning the URLs, such as () => ['/posts/a'].`, offset: d.start }
      if (name === 'prerender' && !(init?.type === 'Literal' && typeof init.value === 'boolean'))
        return { message: `${init?.type === 'Literal' ? `prerender = ${init.raw ?? String(init.value)}` : 'prerender set at runtime'} in ${file}: write prerender = true or prerender = false.`, offset: d.start }
    }
  }
  return undefined
}

/** The first route export kay never reads (Next, Remix and Astro names), `paths` that is not a function, or `prerender` that is not literally `true` or `false`, worded for `kay build` and `kay check` to prefix. */
export function routeExportProblem(analysis: ModuleAnalysis, file: string): string | undefined {
  return routeExportProblemLocation(analysis, file)?.message
}

/** Throws unless a route's `paths()` gave an array of URL paths starting with `/`. */
export function assertPathUrls(urls: unknown, file: string): asserts urls is string[] {
  if (!Array.isArray(urls))
    throw new Error(`kay build: paths() in ${file} returned ${JSON.stringify(urls)}: return an array of URL paths such as ["/posts/a"].`)
  for (const url of urls) {
    if (typeof url !== 'string' || !url.startsWith('/'))
      throw new Error(`kay build: paths() in ${file} returned ${JSON.stringify(url)}: return URL paths such as "/posts/a".`)
  }
}

export function fileToRoutePath(routesDir: string, file: string): string {
  const rel = relPosix(routesDir, file).replace(TS_EXT_RE, '')
  if (rel === 'index')
    return '/'
  const clean = rel.endsWith('/index') ? rel.slice(0, -'/index'.length) : rel
  return `/${clean.replace(CATCH_ALL_RE, '*$1').replace(PARAM_RE, ':$1')}`
}

/** The shape two route paths conflict on: parameter names do not matter. */
export function normalizeRoutePattern(routePath: string): string {
  return routePath
    .split('/')
    .map(seg => (seg.startsWith(':') ? ':' : seg.startsWith('*') ? '*' : seg))
    .join('/')
}

/** Throws on two route files that serve one pattern (about.tsx vs about/index.tsx, [id].tsx vs [slug].tsx). */
export function assertNoRouteConflicts(root: string, routesDir: string, pageFiles: string[]): void {
  const seen = new Map<string, { file: string, path: string }>()
  for (const file of pageFiles) {
    const routePath = fileToRoutePath(routesDir, file)
    const normalized = normalizeRoutePattern(routePath)
    const existing = seen.get(normalized)
    if (existing !== undefined)
      throw new Error(`kay build: conflicting routes for pattern "${routePath}": "${relPosix(root, existing.file)}" (${existing.path}) and "${relPosix(root, file)}" (${routePath})`)
    seen.set(normalized, { file, path: routePath })
  }
}

/** Finds all ancestor files named one of `names` from routesDir down to dirname(routeFile), outermost first. */
export function ancestorFiles(routesDir: string, routeFile: string, names: string[]): string[] {
  const result: string[] = []
  const relDir = relative(routesDir, dirname(routeFile))
  const parts = relDir === '' ? [] : relDir.split(PATH_SEPARATOR_RE)
  let cur = routesDir
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0)
      cur = join(cur, parts[i - 1]!)
    for (const name of names) {
      const candidate = join(cur, name)
      if (existsSync(candidate))
        result.push(candidate)
    }
  }
  return result
}
