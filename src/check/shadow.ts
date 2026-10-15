import type { Diagnostic, SourceMap } from '../compiler'
import type { Span } from '../compiler/ast'
import type { LintLevels } from '../compiler/lints'
import type { ImportedSignals } from '../compiler/module-signals'
import type { Route, RouteMount } from '../server/routes'
import type { ServerFacts } from './layout-facts'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { KAY_FILE, TS_FILE } from '../build/files'
import { importedSignals } from '../build/signals'
import { compileKay } from '../compiler'
import { parseKay } from '../compiler/parser'
import { projectPaths, SHADOW_SETTINGS } from '../project'
import * as builtInMatchers from '../runtime/params'
import { matcherFile } from '../server/params'
import { directoriesUp, falseKeys, fileAt, routeOf, routeTrees, virtualDir } from '../server/routes'
import { serverFacts } from './layout-facts'

export { SHADOW_SETTINGS }
const LAYOUT = '_layout.kay'
const PARENT = '..'
const OUTSIDE = '__'
const WORD_CHARACTER = /[\w$]/

// How a generated span maps back to the .kay source: `exact` when both its ends were copied from it, `loose` letting glue stand for the construct it was generated for, `fences` only where the script and server fences' own code was copied character for character.
export type SpanMode = 'exact' | 'loose' | 'fences'

// The fences of a shadow file's source, parsed once for the many spans ESLint maps in it.
const fencesOf = new WeakMap<ShadowFile, Span[]>()

export interface ShadowFile {
  source: string
  file: string
  tsx: string
  map: SourceMap
}

export interface ShadowSettings {
  routesDir: string
  // The routes directories the app's extensions mount, whose pages' params are read from their own paths.
  mounts: RouteMount[]
  islandOnly: Set<string>
  // The directory the public files are served from, which `kay dev` reads to tell an edit of a file there from one elsewhere.
  publicDir?: string | undefined
  // The levels kay.config.ts gives the lints, which the compiler reports by.
  lints?: LintLevels | undefined
}

// A file outside the project, such as a library a workspace installs in a `node_modules` above it, goes under one `__` folder per level climbed, so it stays inside the tree and its sibling components still resolve beside it. A project folder named `__` would share that path.
export function shadowPath(root: string, file: string): string {
  return join(projectPaths(root).types, `${relative(root, file).split(sep).map(part => part === PARENT ? OUTSIDE : part).join(sep)}.tsx`)
}

// The source file `shadow`, a path `shadowPath` gave, was compiled from.
export function shadowSource(root: string, shadow: string): string {
  return resolve(root, relative(projectPaths(root).types, shadow).slice(0, -'.tsx'.length).split(sep).map(part => part === OUTSIDE ? PARENT : part).join(sep))
}

export function serializeShadowSettings(root: string, settings: ShadowSettings): string {
  return `${JSON.stringify({ routes: relative(root, settings.routesDir), mounts: settings.mounts.map(({ dir, prefix }) => ({ dir: relative(root, dir), prefix })), islandOnly: [...settings.islandOnly].map(file => relative(root, file)).sort(), ...settings.publicDir !== undefined && { public: relative(root, settings.publicDir) }, ...settings.lints && { lints: settings.lints } }, null, 2)}\n`
}

// The settings the shadow tree was written with, or the defaults when no `kay check`, `kay dev` or LSP has written it yet.
export function readShadowSettings(root: string): ShadowSettings {
  try {
    const saved = JSON.parse(readFileSync(join(projectPaths(root).types, SHADOW_SETTINGS), 'utf8')) as { routes: string, mounts?: (string | RouteMount)[], islandOnly: string[], public?: string, lints?: LintLevels }

    return { routesDir: resolve(root, saved.routes), mounts: (saved.mounts ?? []).map(mount => typeof mount === 'string' ? { dir: resolve(root, mount), prefix: '' } : { ...mount, dir: resolve(root, mount.dir) }), islandOnly: new Set(saved.islandOnly.map(file => resolve(root, file))), publicDir: resolve(root, saved.public ?? projectPaths(root).public), lints: saved.lints }
  }
  catch {
    return { routesDir: projectPaths(root).routes, mounts: [], islandOnly: new Set() }
  }
}

export interface ShadowOptions {
  routesDir: string
  mounts: RouteMount[]
  // For a static component only islands render.
  insideIsland?: boolean
  lints?: LintLevels | undefined
  signals?: ImportedSignals
}

// Compiles one .kay file for type checking, its route params typed when it is a page of the routes directory or of an extension's, by the matchers beside `routesDir`.
export function compileShadow(root: string, file: string, source: string, { routesDir, mounts, insideIsland = false, lints, signals = importedSignals(file, source) }: ShadowOptions): { shadow: ShadowFile, diagnostics: Diagnostic[], queries: string[] | undefined } {
  const route = pageRoute(file, routesDir, mounts)
  const shadowDir = dirname(shadowPath(root, file))
  // rootDirs only merges paths inside the project, so an import reaching outside it is pointed there from the shadow file.
  const relocateImport = (specifier: string) => {
    if (!specifier.startsWith('.'))
      return undefined

    const target = resolve(dirname(file), specifier)

    // A component beside a file outside the project has its shadow beside this one.
    if (target.startsWith(root + sep) || (KAY_FILE.test(target) && !file.startsWith(root + sep)))
      return undefined

    return relative(shadowDir, target)
  }
  const queries = layoutQueries(file, source, routesDir, mounts)
  const { tsx, map, diagnostics } = compileKay(source, file, { root, params: route?.params, paramTypes: route && paramTypesOf(routesDir, shadowDir, route), outerQueries: queries, check: true, insideIsland, relocateImport, lints, importedSignals: signals })
  // Reported as the server reports it, rather than as a type error in the shadow file.
  const unknown = Object.values(route?.matchers ?? {}).filter(matcher => matcherSource(routesDir, matcher) === undefined)

  return { shadow: { source, file, tsx, map }, queries, diagnostics: [...diagnostics, ...unknown.map(matcher => ({ start: 0, end: 0, message: `names the matcher ${matcher}, which is neither ${relative(root, matcherFile(routesDir, matcher))} nor one kay ships: ${Object.keys(builtInMatchers).join(', ')}` }))] }
}

// The `query` types of the layouts above a page or a layout, which its shadow depends on besides its own source.
export function layoutQueries(file: string, source: string, routesDir: string, mounts: RouteMount[]): string[] | undefined {
  return pageRoute(file, routesDir, mounts) || basename(file) === LAYOUT ? outerQueries(file, source, routeTrees(routesDir, mounts)) : undefined
}

// The type of each `query` schema declared by the layouts above `file` in the URL tree of the app's routes and its extensions', outermost first: a layout or page reads them through `ctx.query` as the server merges them.
export function outerQueries(file: string, source: string, trees: RouteMount[]): string[] {
  if (!trees.some(({ dir }) => file.startsWith(dir + sep)) || falseKeys(source).has('layouts'))
    return []

  const above: { layout: string, facts: ServerFacts }[] = []

  for (const dir of directoriesUp(virtualDir(trees, dirname(file)))) {
    const layout = fileAt(trees, dir, LAYOUT)

    if (layout !== undefined && layout !== file)
      above.push({ layout, facts: serverFacts(layout, readFileSync(layout, 'utf8')) })
  }

  // The innermost layout that leaves its parents out starts the chain.
  const reset = above.findIndex(({ facts }) => facts.leavesLayoutsOut)

  return (reset === -1 ? above : above.slice(0, reset + 1)).reverse().filter(({ facts }) => facts.server?.page?.settings.has('query')).map(({ layout }) => {
    const path = relative(dirname(file), layout).split(sep).join('/')

    return `(typeof import(${JSON.stringify(path.startsWith('.') ? path : `./${path}`)}))["page"]["query"]`
  })
}

// A generated span back in the source, where the mode allows it; an end that maps nowhere, or before the start, runs to the end of the word at the start.
export function sourceSpan(shadow: ShadowFile, start: number, end: number, mode: SpanMode): Span | undefined {
  const { map } = shadow

  if ((mode !== 'loose' && !map.isExact(start)) || (mode === 'exact' && !map.isExact(end)))
    return undefined

  const from = map.toSource(start)

  // A copied run maps its end too, which is where generated code follows it, such as the `;` after a fence's last statement.
  if (from === undefined || (mode === 'fences' && (shadow.tsx[start] !== shadow.source[from] || !inFences(shadow, from, from))))
    return undefined

  const to = map.isExact(end) ? map.toSource(end) : undefined

  return { start: from, end: to !== undefined && to >= from ? to : wordEnd(shadow.source, from) }
}

// The source a generated edit replaces, when one run copied from the fences holds all of it, so the edit can be made to the source instead.
export function fenceEdit(shadow: ShadowFile, start: number, end: number): Span | undefined {
  const span = shadow.map.toSourceSpan(start, end)

  return span && inFences(shadow, span.start, span.end) ? span : undefined
}

// A source span in the generated code, when both its ends were copied there.
export function generatedSpan(shadow: ShadowFile, start: number, end: number): Span | undefined {
  const from = shadow.map.toGenerated(start)
  const to = shadow.map.toGenerated(end)

  return from === undefined || to === undefined ? undefined : { start: from, end: to }
}

function inFences(shadow: ShadowFile, start: number, end: number): boolean {
  let fences = fencesOf.get(shadow)

  if (!fences) {
    const { script, server } = parseKay(shadow.source)

    fencesOf.set(shadow, fences = [script, server].filter(span => span !== undefined))
  }

  return fences.some(fence => start >= fence.start && end <= fence.end)
}

function wordEnd(source: string, offset: number): number {
  let end = offset

  while (end < source.length && WORD_CHARACTER.test(source[end]!))
    end++

  return end === offset ? Math.min(offset + 1, source.length) : end
}

// The route of `file` when it is a page, its path read from the routes directory holding it: the app's, or an extension's. Its matchers are the app's either way.
export function pageRoute(file: string, routesDir: string, mounts: RouteMount[]): ReturnType<typeof routeOf> {
  const pagesDir = mounts.find(({ dir }) => file.startsWith(dir + sep))?.dir ?? routesDir

  return file.startsWith(pagesDir + sep) ? routeOf(pagesDir, file) : undefined
}

// A matcher's param is what it returns, the project's own or kay's; an optional one may be missing.
function paramTypesOf(routesDir: string, shadowDir: string, route: Pick<Route, 'params' | 'optional' | 'matchers'>): Record<string, string> {
  return Object.fromEntries(route.params.map((name) => {
    const matcher = route.matchers?.[name]
    const source = matcher === undefined ? undefined : matcherSource(routesDir, matcher)
    const module = source === 'kay' ? `'kay/params').${matcher}` : `${JSON.stringify(relative(shadowDir, source ?? '').replace(TS_FILE, ''))}).default`
    const checked = source === undefined ? 'unknown' : `Exclude<ReturnType<typeof import(${module}>, undefined>`
    const type = matcher === undefined ? 'string' : checked

    return [name, route.optional?.includes(name) ? `${type} | undefined` : type]
  }))
}

// Where a matcher comes from, as the server looks it up: the project's file, `kay` for one kay ships, or undefined for neither.
export function matcherSource(routesDir: string, matcher: string): string | undefined {
  const file = matcherFile(routesDir, matcher)

  if (existsSync(file))
    return file

  return Object.hasOwn(builtInMatchers, matcher) ? 'kay' : undefined
}
