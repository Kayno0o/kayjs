// The shadow tree `kay check` and the editor type the project through: each component compiled to TSX, and the modules declaring what types cannot find on their own.
import type { CheckDiagnostic, CheckOptions } from '.'
import type { KayLibrary } from '../build/libraries'
import type { Diagnostic } from '../compiler/ast'
import type { I18nConfig, KayExtension } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { ApiModule } from '../server/api'
import type { PublicFile } from '../server/public'
import type { Endpoint, Route, RouteMount } from '../server/routes'
import type { ShadowFile, ShadowOptions } from './shadow'
import { existsSync, realpathSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { readCacheEntry, writeCacheEntry } from '../build/cache'
import { findKayFiles, writeIfChanged } from '../build/files'
import { iconTypes } from '../build/icons'
import { findKayLibraries, libraryOf, reachableLibraryFiles, throughNodeModules } from '../build/libraries'
import { importedSignals } from '../build/signals'
import { cacheEntry } from '../build/transform'
import { rendersAsIsland, SourceMap } from '../compiler'
import { positionAt } from '../compiler/mapping'
import { CONFIG_FILE } from '../config'
import { projectPaths } from '../project'
import { projectApi } from '../server/api'
import { localePrefixes, localeSettings } from '../server/i18n'
import { htmlFallbacks, publicFiles } from '../server/public'
import { redirectProblems } from '../server/redirects'
import { extensionEditor, patternShapes, routeMounts, scanEndpoints, scanRoutes, servedPaths } from '../server/routes'
import { ownFile } from './diagnose'
import { ASSET_TYPES, environmentTypes, KAY_PATHS, packageTypes } from './env-types'
import { CONTENT_CHECK, EXPORTS_CHECK, exportsCheck, SETTINGS_CHECK, settingsCheck } from './generated'
import { unguardedRoutes } from './guards'
import { islandOnlyComponents } from './island-only'
import { compileShadow, matcherSource, pageRoute, serializeShadowSettings, SHADOW_SETTINGS, shadowPath } from './shadow'

// Imports each page of the extensions kay check reports as the app's own, so TypeScript checks them.
const EXTENSION_PAGES = 'kay-extension-pages.ts'

export interface ShadowTypes {
  files: Map<string, ShadowFile>
  // Each component's compile errors.
  diagnostics: CheckDiagnostic[]
  // What the config, the API modules and the redirects get wrong.
  problems: CheckDiagnostic[]
  // Library components the app never imports, whose errors are not its own.
  unreached: Set<string>
  // The kay libraries, and the packages of the linked extensions, whose own modules are theirs to check.
  libraries: KayLibrary[]
  // The app's settings module each line of the settings check stands for, with the library it sets.
  settings: Map<number, { file: string, library: string }>
  // The guard, API module or matcher each line of the exports check reads the default export of, with what it must be.
  exports: Map<number, { file: string, wanted: string }>
  // The static components only islands render, which compile as rendered inline with them.
  islandOnly: Set<string>
  // The routes the extensions mount, and the prefixes the locales serve them under too.
  mounts: RouteMount[]
  locales: string[]
}

// What the project serves, which links are checked against.
export interface ServedProject {
  routes: Route[]
  publicPaths: PublicFile[]
  apiModules: ApiModule[]
  endpoints: Endpoint[]
  settings: LocaleSettings | undefined
}

// The shadow tree as one run writes it: what it did not write is left from an earlier one.
interface ShadowTree {
  shadows: Map<string, ShadowFile>
  // At a path, or a name in the tree.
  write: (path: string, text: string) => Promise<void>
  shadow: (shadow: ShadowFile, path: string) => Promise<void>
  // Rewriting in place keeps every file present for editors reading the tree meanwhile; only stale ones go, but for the names another step writes.
  removeStale: (kept: string[]) => Promise<void>
}

// Compiles every .kay file of the project at `root`, nested projects left to their own, to `.kay/types/<path>.kay.tsx`, the tree tsconfig `rootDirs` merges with the sources.
export async function writeShadowTypes(projectRoot: string, options: CheckOptions = {}): Promise<ShadowTypes> {
  const root = resolve(projectRoot)
  const routesDir = projectPaths(root, options).routes
  const tree = shadowTree(projectPaths(root).types)
  const problems: CheckDiagnostic[] = []
  const mounts = routeMounts(root, options.extensions)
  const own = await ownShadows(root, options, tree, mounts)
  const served = await servedProject(root, options, problems, mounts)
  const libraries = await libraryShadows(root, options, own.files, tree, mounts)

  await tree.write('kay-env.d.ts', await environmentTypes(root, options, served))
  problems.push(...redirectChecks(root, options, served), ...await unguardedRoutes(options, served))
  // A script rather than a module, which is what lets it declare a wildcard module.
  await tree.write('kay-assets.d.ts', ASSET_TYPES)
  await tree.write('kay-icons.d.ts', iconTypes(root))
  await tree.write('kay-packages.d.ts', packageTypes(root, libraries.libraries))

  const replaced = settingsCheck(root, options.settings ?? {}, problems)
  const exported = exportsCheck(root, routesDir, served.routes, served.apiModules, served.endpoints)

  await tree.write(SETTINGS_CHECK, replaced.code)
  await tree.write(EXPORTS_CHECK, exported.code)

  // TypeScript skips the files an `include` reaches only through a `node_modules`, where a linked library's pages are shadowed, so they are imported.
  if (libraries.pages.length > 0)
    await tree.write(EXTENSION_PAGES, libraries.pages.map(file => `import ${JSON.stringify(`./${relative(projectPaths(root).types, shadowPath(root, file)).slice(0, -'.tsx'.length)}`)}\n`).join(''))

  await tree.write(SHADOW_SETTINGS, serializeShadowSettings(root, { routesDir, mounts: mounts.map(mount => mount.dir), islandOnly: own.islandOnly, lints: options.lints }))
  // `contentChecks` writes the props check once it read the collections.
  await tree.removeStale([CONTENT_CHECK])

  return { files: tree.shadows, diagnostics: [...own.diagnostics, ...libraries.diagnostics], problems, unreached: libraries.unreached, libraries: libraries.followed, settings: replaced.lines, exports: exported.lines, islandOnly: own.islandOnly, mounts, locales: served.settings ? localePrefixes(served.settings) : [] }
}

function shadowTree(dir: string): ShadowTree {
  const shadows = new Map<string, ShadowFile>()
  const written = new Set<string>()
  const write = async (path: string, text: string) => {
    const file = resolve(dir, path)

    written.add(file)
    await writeIfChanged(file, text)
  }

  return {
    shadows,
    write,
    shadow: async (shadow, path) => {
      shadows.set(path, shadow)
      await write(path, shadow.tsx)
    },
    removeStale: async (kept) => {
      const stale = (await readdir(dir, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name))
        .filter(path => !written.has(path) && !kept.some(name => path === join(dir, name)))

      await Promise.all(stale.map(async path => rm(path)))
    },
  }
}

// The project's own components, each compiled with the lints its source sets.
async function ownShadows(root: string, options: CheckOptions, tree: ShadowTree, mounts: RouteMount[]): Promise<{ files: string[], diagnostics: CheckDiagnostic[], islandOnly: Set<string> }> {
  const { routes: routesDir, cache: cacheDir } = projectPaths(root, options)
  const files = await findKayFiles(root, { project: true, ownOnly: true, ownKayOnly: true })
  const sources = new Map(await Promise.all(files.map(async file => [file, await Bun.file(file).text()] as const)))
  const islands = new Set((await Promise.all(files.map(async file => await rendersAsIslandCached(cacheDir, file, sources.get(file)!) ? [file] : []))).flat())
  const islandOnly = await islandOnlyComponents(root, routesDir, files, sources, file => islands.has(file))
  const diagnostics: CheckDiagnostic[] = []

  for (const file of files) {
    const source = sources.get(file)!
    const { shadow, diagnostics: compileDiagnostics } = await compileShadowCached(cacheDir, root, file, source, { routesDir, mounts: mounts.map(mount => mount.dir), insideIsland: islandOnly.has(file), lints: options.lints })

    await tree.shadow(shadow, shadowPath(root, file))
    for (const diagnostic of compileDiagnostics)
      diagnostics.push(fromCompile(file, source, diagnostic))
  }

  return { files, diagnostics, islandOnly }
}

// A library's components compile against the app's types, and the ones it reaches are reported as its own: `kay build` compiles those.
// So are the pages and the editor of an extension not installed from the registry, as a library's own example or fixture app lists it, and what they reach of its package: its own modules stay its own to check, as a library's do.
async function libraryShadows(root: string, options: CheckOptions, own: string[], tree: ShadowTree, mounts: RouteMount[]): Promise<{ libraries: KayLibrary[], followed: KayLibrary[], pages: string[], diagnostics: CheckDiagnostic[], unreached: Set<string> }> {
  const { routes: routesDir, cache: cacheDir } = projectPaths(root, options)
  const libraries = await findKayLibraries(root)
  // The app's own directories are checked already; a linked library has its real path outside any `node_modules`, an installed one inside.
  const linked = (path: string) => !ownFile(root, path) && existsSync(path) && !realpathSync(path).split(sep).includes('node_modules')
  const local = mounts.filter(mount => linked(mount.dir))
  const diagnostics: CheckDiagnostic[] = []
  const editor = editorOf(root, options.extensions, diagnostics)
  const localEditor = editor !== undefined && linked(editor) ? editor : undefined
  const followed = [...libraries, ...await extensionPackages(root, libraries, [...local.map(mount => mount.dir), ...localEditor === undefined ? [] : [dirname(localEditor)]])]
  const files = [...new Set(followed.flatMap(library => library.files))]
  const pages = files.filter(file => file === localEditor || local.some(mount => file.startsWith(mount.dir + sep)))
  const reached = new Set([...pages, ...(await reachableLibraryFiles(root, followed, [...own, ...pages])).components.map((file) => {
    const library = libraryOf(followed, file)

    return library ? throughNodeModules(library, file) : file
  })])
  const unreached = new Set<string>()

  await Promise.all(files.map(async (file) => {
    const source = await Bun.file(file).text()
    const { shadow, diagnostics: compileDiagnostics } = await compileShadowCached(cacheDir, root, file, source, { routesDir, mounts: mounts.map(mount => mount.dir), lints: options.lints })

    await tree.shadow(shadow, shadowPath(root, file))

    if (!reached.has(file)) {
      unreached.add(file)

      return
    }

    for (const diagnostic of compileDiagnostics)
      diagnostics.push(fromCompile(file, source, diagnostic))
  }))

  return { libraries, followed, pages, diagnostics, unreached }
}

// The package holding each of `extensionDirs`, an extension's routes or its editor's directory, that no kay library holds, the nearest directory above them with a package.json, as a library: its components are shadowed and reached as one's are.
async function extensionPackages(root: string, libraries: KayLibrary[], extensionDirs: string[]): Promise<KayLibrary[]> {
  const dirs = new Set(extensionDirs.filter(dir => libraryOf(libraries, join(dir, 'page.kay')) === undefined).map(packageRoot))

  return Promise.all([...dirs].map(async (dir) => {
    // Left out: the app itself, when the package holds it as a fixture; the other projects inside it, to their own checks; a kay library's files, to the library.
    const files = (await findKayFiles(dir, { project: true, ownOnly: true, ownKayOnly: true })).filter(file => !file.startsWith(root + sep) && libraryOf(libraries, file) === undefined)

    return { name: basename(dir), dir, realDir: dir, files, specifiers: new Map<string, string>() }
  }))
}

function packageRoot(dir: string): string {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, 'package.json')))
      return at

    if (at === dirname(at))
      return dir
  }
}

// The pages, public files, API modules and endpoints, with the locale settings, each with the reason the server would refuse it reported.
async function servedProject(root: string, options: CheckOptions, problems: CheckDiagnostic[], mounts: RouteMount[]): Promise<ServedProject> {
  const paths = projectPaths(root, options)
  const [routes, found, apiModules, endpoints] = await Promise.all([scanRoutes(paths.routes, mounts), publicFiles(paths.public), apiModulesOf(root, options, problems), endpointsOf(paths.routes, mounts)])
  const settings = options.i18n && i18nSettings(root, options.i18n, problems)

  return { routes, publicPaths: [...found, ...htmlFallbacks(found, servedPaths(routes))], apiModules, endpoints, settings }
}

// Each redirect whose target on the site nothing serves; what kay serves itself counts, whether or not the project turns it on.
function redirectChecks(root: string, options: CheckOptions, { routes, publicPaths, endpoints }: ServedProject): CheckDiagnostic[] {
  const served = [...routes.flatMap(route => patternShapes(route.pattern)), ...publicPaths.map(file => file.url), ...KAY_PATHS, ...endpoints.filter(endpoint => endpoint.params.length === 0).map(endpoint => endpoint.pattern)]

  return redirectProblems(options.redirects ?? {}, served).map(message => ({ file: join(root, CONFIG_FILE), line: 1, column: 1, message }))
}

// Whether a component renders as an island, through the build's cache of compiles.
async function rendersAsIslandCached(cacheDir: string, file: string, source: string): Promise<boolean> {
  const slot = cacheEntry(cacheDir, file, 'renders-island', source)
  const cached = await readCacheEntry<boolean>(slot)

  if (cached !== undefined)
    return cached

  const island = rendersAsIsland(source)

  await writeCacheEntry(slot, island)

  return island
}

// `compileShadow` through the build's cache of compiles. A page's params are read from its path in the routes directory holding it, an extension's or the app's, and typed by the matchers they name, so the mounts and where each matcher is found, if anywhere, are part of the key, as are the signals of the modules it imports.
async function compileShadowCached(cacheDir: string, root: string, file: string, source: string, { routesDir, mounts, insideIsland = false, lints }: ShadowOptions): Promise<ReturnType<typeof compileShadow>> {
  const route = pageRoute(file, routesDir, mounts)
  const matchers = Object.values(route?.matchers ?? {}).map(matcher => matcherSource(routesDir, matcher) ?? '')
  const signals = importedSignals(file, source)
  const slot = cacheEntry(cacheDir, file, 'shadow', JSON.stringify([root, routesDir, mounts, insideIsland, lints ?? {}, matchers, signals, source]))
  const cached = await readCacheEntry<{ tsx: string, map: ReturnType<SourceMap['toJSON']>, diagnostics: Diagnostic[] }>(slot)

  if (cached !== undefined)
    return { shadow: { source, file, tsx: cached.tsx, map: SourceMap.fromJSON(cached.map) }, diagnostics: cached.diagnostics }

  const compiled = compileShadow(root, file, source, { routesDir, mounts, insideIsland, lints, signals })

  await writeCacheEntry(slot, { tsx: compiled.shadow.tsx, map: compiled.shadow.map, diagnostics: compiled.diagnostics })

  return compiled
}

// The endpoint files, or none while one is misnamed: the boot checks report it.
async function endpointsOf(routesDir: string, mounts: RouteMount[]): Promise<Endpoint[]> {
  try {
    return await scanEndpoints(routesDir, mounts)
  }
  catch {
    return []
  }
}

// The API modules, or none with the reason the server would refuse them reported at the directory.
async function apiModulesOf(root: string, options: CheckOptions, diagnostics: CheckDiagnostic[]): Promise<ApiModule[]> {
  try {
    return await projectApi(root, options)
  }
  catch (error) {
    diagnostics.push({ file: projectPaths(root, options).api, line: 1, column: 1, message: error instanceof Error ? error.message : String(error) })

    return []
  }
}

// The editor the extensions give, or undefined with the reason it cannot be told reported at the config, as when two give one.
function editorOf(root: string, extensions: KayExtension[] | undefined, diagnostics: CheckDiagnostic[]): string | undefined {
  try {
    return extensionEditor(root, extensions)
  }
  catch (error) {
    diagnostics.push({ file: join(root, CONFIG_FILE), line: 1, column: 1, message: error instanceof Error ? error.message : String(error) })

    return undefined
  }
}

// The locale settings, or undefined with the reason they cannot serve a page reported at the config, as the server would refuse them.
function i18nSettings(root: string, config: I18nConfig, diagnostics: CheckDiagnostic[]): LocaleSettings | undefined {
  try {
    return localeSettings(config)
  }
  catch (error) {
    diagnostics.push({ file: join(root, CONFIG_FILE), line: 1, column: 1, message: error instanceof Error ? error.message : String(error) })

    return undefined
  }
}

export function fromCompile(file: string, source: string, { start, end, message, label, related, note, help, code, severity, fixes, checkOnly }: Diagnostic): CheckDiagnostic {
  return { file, ...positionAt(source, start), end, message, label, related, note, help, code, severity, fixes, checkOnly }
}
