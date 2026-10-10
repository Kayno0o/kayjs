import type { Diagnostic, SourceMap } from '../compiler'
import type { LintLevels } from '../compiler/lints'
import type { ImportedSignals } from '../compiler/module-signals'
import type { Route } from '../server/routes'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { importedSignals } from '../build/signals'
import { compileKay } from '../compiler'
import * as builtInMatchers from '../runtime/params'
import { matcherFile } from '../server/params'
import { routeOf } from '../server/routes'

export const SHADOW_DIR = join('.kay', 'types')
// What the shadow tree was last compiled with, for tools that compile one file at a time without reading kay.config.ts, such as the ESLint processor.
export const SHADOW_SETTINGS = 'kay-shadow.json'
const TS_EXTENSION = /\.ts$/
const KAY_EXTENSION = /\.kay$/
const PARENT = '..'
const OUTSIDE = '__'

export interface ShadowFile {
  source: string
  file: string
  tsx: string
  map: SourceMap
}

export interface ShadowSettings {
  routesDir: string
  islandOnly: Set<string>
}

// A file outside the project, such as a library a workspace installs in a `node_modules` above it, goes under one `__` folder per level climbed, so it stays inside the tree and its sibling components still resolve beside it. A project folder named `__` would share that path.
export function shadowPath(root: string, file: string): string {
  return join(root, SHADOW_DIR, `${relative(root, file).split(sep).map(part => part === PARENT ? OUTSIDE : part).join(sep)}.tsx`)
}

export function serializeShadowSettings(root: string, settings: ShadowSettings): string {
  return `${JSON.stringify({ routes: relative(root, settings.routesDir), islandOnly: [...settings.islandOnly].map(file => relative(root, file)).sort() }, null, 2)}\n`
}

// The settings the shadow tree was written with, or the defaults when no `kay check`, `kay dev` or LSP has written it yet.
export function readShadowSettings(root: string): ShadowSettings {
  try {
    const saved = JSON.parse(readFileSync(join(root, SHADOW_DIR, SHADOW_SETTINGS), 'utf8')) as { routes: string, islandOnly: string[] }

    return { routesDir: resolve(root, saved.routes), islandOnly: new Set(saved.islandOnly.map(file => resolve(root, file))) }
  }
  catch {
    return { routesDir: resolve(root, 'src/routes'), islandOnly: new Set() }
  }
}

// Compiles one .kay file for type checking, its route params typed when it is a page under `routesDir`; `insideIsland` for a static component only islands render.
export function compileShadow(root: string, routesDir: string, file: string, source: string, insideIsland = false, lints?: LintLevels, signals: ImportedSignals = importedSignals(file, source)): { shadow: ShadowFile, diagnostics: Diagnostic[] } {
  const route = file.startsWith(routesDir + sep) ? routeOf(routesDir, file) : undefined
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
  const { tsx, map, diagnostics } = compileKay(source, file, { root, params: route?.params, paramTypes: route && paramTypesOf(routesDir, shadowDir, route), check: true, insideIsland, relocateImport, lints, importedSignals: signals })
  // Reported as the server reports it, rather than as a type error in the shadow file.
  const unknown = Object.values(route?.matchers ?? {}).filter(matcher => matcherSource(routesDir, matcher) === undefined)

  return { shadow: { source, file, tsx, map }, diagnostics: [...diagnostics, ...unknown.map(matcher => ({ start: 0, end: 0, message: `names the matcher ${matcher}, which is neither ${relative(root, matcherFile(routesDir, matcher))} nor one kay ships: ${Object.keys(builtInMatchers).join(', ')}` }))] }
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
