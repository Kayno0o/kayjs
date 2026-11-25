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
