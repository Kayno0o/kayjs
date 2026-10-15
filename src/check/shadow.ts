import type { Diagnostic, SourceMap } from '../compiler'
import type { Span } from '../compiler/ast'
import type { LintLevels } from '../compiler/lints'
import type { ImportedSignals } from '../compiler/module-signals'
import type { Route } from '../server/routes'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { importedSignals } from '../build/signals'
import { compileKay } from '../compiler'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { projectPaths } from '../project'
import * as builtInMatchers from '../runtime/params'
import { matcherFile } from '../server/params'
import { falseKeys, routeOf } from '../server/routes'

// What the shadow tree was last compiled with, for tools that compile one file at a time without reading kay.config.ts, such as the ESLint processor.
export const SHADOW_SETTINGS = 'kay-shadow.json'
const TS_EXTENSION = /\.ts$/
const KAY_EXTENSION = /\.kay$/
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
  mounts: string[]
  islandOnly: Set<string>
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
  return `${JSON.stringify({ routes: relative(root, settings.routesDir), mounts: settings.mounts.map(dir => relative(root, dir)), islandOnly: [...settings.islandOnly].map(file => relative(root, file)).sort(), ...settings.lints && { lints: settings.lints } }, null, 2)}\n`
}

// The settings the shadow tree was written with, or the defaults when no `kay check`, `kay dev` or LSP has written it yet.
export function readShadowSettings(root: string): ShadowSettings {
  try {
    const saved = JSON.parse(readFileSync(join(projectPaths(root).types, SHADOW_SETTINGS), 'utf8')) as { routes: string, mounts?: string[], islandOnly: string[], lints?: LintLevels }

    return { routesDir: resolve(root, saved.routes), mounts: (saved.mounts ?? []).map(dir => resolve(root, dir)), islandOnly: new Set(saved.islandOnly.map(file => resolve(root, file))), lints: saved.lints }
  }
  catch {
    return { routesDir: projectPaths(root).routes, mounts: [], islandOnly: new Set() }
  }
}

export interface ShadowOptions {
  routesDir: string
  mounts: string[]
  // For a static component only islands render.
  insideIsland?: boolean
  lints?: LintLevels | undefined
  signals?: ImportedSignals
}

// Compiles one .kay file for type checking, its route params typed when it is a page of the routes directory or of an extension's, by the matchers beside `routesDir`.
export function compileShadow(root: string, file: string, source: string, { routesDir, mounts, insideIsland = false, lints, signals = importedSignals(file, source) }: ShadowOptions): { shadow: ShadowFile, diagnostics: Diagnostic[] } {
  const route = pageRoute(file, routesDir, mounts)
  const shadowDir = dirname(shadowPath(root, file))
  // rootDirs only merges paths inside the project, so an import reaching outside it is pointed there from the shadow file.
  const relocateImport = (specifier: string) => {
    if (!specifier.startsWith('.'))
      return undefined

    const target = resolve(dirname(file), specifier)

    // A component beside a file outside the project has its shadow beside this one.
    if (target.startsWith(root + sep) || (KAY_EXTENSION.test(target) && !file.startsWith(root + sep)))
      return undefined

    return relative(shadowDir, target)
  }
  const { tsx, map, diagnostics } = compileKay(source, file, { root, params: route?.params, paramTypes: route && paramTypesOf(routesDir, shadowDir, route), outerQueries: route || basename(file) === LAYOUT ? outerQueries(file, source, mounts.find(dir => file.startsWith(dir + sep)) ?? routesDir) : undefined, check: true, insideIsland, relocateImport, lints, importedSignals: signals })
  // Reported as the server reports it, rather than as a type error in the shadow file.
  const unknown = Object.values(route?.matchers ?? {}).filter(matcher => matcherSource(routesDir, matcher) === undefined)

  return { shadow: { source, file, tsx, map }, diagnostics: [...diagnostics, ...unknown.map(matcher => ({ start: 0, end: 0, message: `names the matcher ${matcher}, which is neither ${relative(root, matcherFile(routesDir, matcher))} nor one kay ships: ${Object.keys(builtInMatchers).join(', ')}` }))] }
}

// The type of each `query` schema declared by the layouts above `file` in its routes directory, outermost first: a layout or page reads them through `ctx.query` as the server merges them.
export function outerQueries(file: string, source: string, pagesDir: string): string[] {
  if (!file.startsWith(pagesDir + sep) || falseKeys(source).has('layouts'))
    return []

  const above: { layout: string, text: string }[] = []

  for (let dir = dirname(file); dir.startsWith(pagesDir); dir = dirname(dir)) {
    const layout = join(dir, LAYOUT)

    if (layout !== file && existsSync(layout))
      above.push({ layout, text: readFileSync(layout, 'utf8') })

    if (dir === pagesDir)
      break
  }

  // The innermost layout that leaves its parents out starts the chain.
  const reset = above.findIndex(({ text }) => falseKeys(text).has('layouts'))

  return (reset === -1 ? above : above.slice(0, reset + 1)).reverse().filter(({ text }) => analyzeServer(text, parseKay(text).server)?.page?.settings.has('query')).map(({ layout }) => {
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
export function pageRoute(file: string, routesDir: string, mounts: string[]): ReturnType<typeof routeOf> {
  const pagesDir = mounts.find(dir => file.startsWith(dir + sep)) ?? routesDir

  return file.startsWith(pagesDir + sep) ? routeOf(pagesDir, file) : undefined
}

// A matcher's param is what it returns, the project's own or kay's; an optional one may be missing.
function paramTypesOf(routesDir: string, shadowDir: string, route: Pick<Route, 'params' | 'optional' | 'matchers'>): Record<string, string> {
  return Object.fromEntries(route.params.map((name) => {
    const matcher = route.matchers?.[name]
    const source = matcher === undefined ? undefined : matcherSource(routesDir, matcher)
    const module = source === 'kay' ? `'kay/params').${matcher}` : `${JSON.stringify(relative(shadowDir, source ?? '').replace(TS_EXTENSION, ''))}).default`
    const type = matcher === undefined ? 'string' : source === undefined ? 'unknown' : `Exclude<ReturnType<typeof import(${module}>, undefined>`

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
