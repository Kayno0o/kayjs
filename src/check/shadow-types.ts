// The shadow tree `kay check` and the editor type the project through: each component compiled to TSX, and the modules declaring what types cannot find on their own.
import type { CheckDiagnostic, CheckOptions } from '.'
import type { KayLibrary } from '../build/libraries'
import type { Diagnostic } from '../compiler/ast'
import type { I18nConfig, KayExtension } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { ApiModule } from '../server/api-modules'
import type { PublicFile } from '../server/public'
import type { Endpoint, Route, RouteMount } from '../server/routes'
import type { ShadowFile, ShadowOptions } from './shadow'
import { existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, readlink, rm, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { readCacheEntry, writeCacheEntry } from '../build/cache'
import { findKayFiles, treeEntries, writeIfChanged } from '../build/files'
import { iconTypes } from '../build/icons'
import { findKayLibraries, libraryOf, packageRoot, reachableLibraryFiles, throughNodeModules } from '../build/libraries'
import { importedSignals } from '../build/signals'
import { cacheEntry } from '../build/transform'
import { rendersAsIsland, SourceMap } from '../compiler'
import { positionAt } from '../compiler/mapping'
import { CONFIG_FILE } from '../config'
import { projectPaths } from '../project'
import { projectApi } from '../server/api-modules'
import { localePrefixes, localeSettings } from '../server/i18n'
import { htmlFallbacks, publicFiles } from '../server/public'
import { redirectProblems } from '../server/redirects'
import { extensionEditor, patternShapes, routeMounts, scanEndpoints, scanRoutes, servedPaths } from '../server/routes'
import { ownFile } from './diagnose'
import { ASSET_TYPES, environmentTypes, KAY_PATHS, packageTypes } from './env-types'
import { CONTENT_CHECK, EXPORTS_CHECK, exportsCheck, SETTINGS_CHECK, settingsCheck } from './generated'
import { unguardedRoutes, unguardedTools } from './guards'
import { islandOnlyComponents } from './island-only'
import { compileShadow, layoutQueries, matcherSource, pageRoute, serializeShadowSettings, SHADOW_SETTINGS, shadowPath } from './shadow'
import { typingOptions } from './tsgo'

// Imports each page of the extensions kay check reports as the app's own, so TypeScript checks them.
const EXTENSION_PAGES = 'kay-extension-pages.ts'
const PACKAGE_TSCONFIG = 'tsconfig.json'
// What the app's declarations are in the shadow tree: the routes, files, messages and locals its libraries' pages are typed against.
const APP_TYPES = ['kay-env.d.ts', 'kay-assets.d.ts', 'kay-icons.d.ts', 'kay-packages.d.ts']

// A linked extension's package checked as a program of its own, as its tsconfig sets the options its pages are written for: the shadow tree holds a tsconfig for it, which the editor finds as tsgo does the nearest one.
export interface ExtensionProgram {
  // The package's shadow folder, beside the shadows of its real path whatever `node_modules` link the app reaches it by, and the tsconfig kay writes there.
  dir: string
  tsconfig: string
  library: KayLibrary
}

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
  // The linked extensions whose own options differ from the app's, checked apart.
  programs: ExtensionProgram[]
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
  // A symlink at a path in the tree to `target`.
  link: (path: string, target: string) => Promise<void>
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
  problems.push(...redirectChecks(root, options, served), ...await unguardedRoutes(options, served), ...await unguardedTools(options, served))
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

  await tree.write(SHADOW_SETTINGS, serializeShadowSettings(root, { routesDir, mounts, islandOnly: own.islandOnly, publicDir: projectPaths(root, options).public, lints: options.lints }))
  // `contentChecks` writes the props check once it read the collections.
  await tree.removeStale([CONTENT_CHECK])

  return { files: tree.shadows, diagnostics: [...own.diagnostics, ...libraries.diagnostics], problems, unreached: libraries.unreached, libraries: libraries.followed, programs: libraries.programs, settings: replaced.lines, exports: exported.lines, islandOnly: own.islandOnly, mounts, locales: served.settings ? localePrefixes(served.settings) : [] }
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
    link: async (path, target) => {
      const file = resolve(dir, path)

      written.add(file)

      try {
        if (await readlink(file) === target)
          return
      }
      catch {}

      await rm(file, { recursive: true, force: true })
      await mkdir(dirname(file), { recursive: true })
      await symlink(target, file, 'dir')
    },
    removeStale: async (kept) => {
      const { files, links } = await treeEntries(dir)
      const stale = [...files, ...links].filter(path => !written.has(path) && !kept.some(name => path === join(dir, name)))

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
    const { shadow, diagnostics: compileDiagnostics } = await compileShadowCached(cacheDir, root, file, source, { routesDir, mounts, insideIsland: islandOnly.has(file), lints: options.lints })

    await tree.shadow(shadow, shadowPath(root, file))
    for (const diagnostic of compileDiagnostics)
      diagnostics.push(fromCompile(file, source, diagnostic))
  }

  return { files, diagnostics, islandOnly }
}

// A library's components compile against the app's types, and the ones it reaches are reported as its own: `kay build` compiles those.
// So are the pages and the editor of an extension not installed from the registry, as a library's own example or fixture app lists it, and what they reach of its package: its own modules stay its own to check, as a library's do.
async function libraryShadows(root: string, options: CheckOptions, own: string[], tree: ShadowTree, mounts: RouteMount[]): Promise<{ libraries: KayLibrary[], followed: KayLibrary[], programs: ExtensionProgram[], pages: string[], diagnostics: CheckDiagnostic[], unreached: Set<string> }> {
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
  const programs = await extensionPrograms(root, options, followed.filter(library => library.extension), tree, diagnostics)
  // The editor finds a package's tsconfig for the files beside the app but not under a `node_modules`, where tsgo takes them as the app's imports: a package of a program is shadowed beside its real path, and the shadows under `node_modules` are a link to them.
  const apart = (file: string) => programs.some(({ library }) => libraryOf([library], file) !== undefined)
  const shadowOf = programShadows(root, programs)
  const pages = files.filter(file => file === localEditor || local.some(mount => [file, realFile(followed, file)].some(path => path.startsWith(mount.dir + sep))))
  const reached = new Set([...pages, ...(await reachableLibraryFiles(root, followed, [...own, ...pages])).components.map((file) => {
    const library = libraryOf(followed, file)

    return library ? throughNodeModules(library, file) : file
  })])
  const unreached = new Set<string>()

  await Promise.all(followed.filter(library => library.extension).map(async (library) => {
    const own = programs.some(program => program.library === library)

    // A link left from a run in which the package was a program of its own would take what is written under `node_modules` to that program's folder.
    if (!own)
      await dropLink(dirname(shadowPath(root, join(library.dir, 'x'))))

    await linkDependencies(root, library, own, tree)
  }))

  await Promise.all(files.map(async (file) => {
    const source = await Bun.file(file).text()
    const { shadow, diagnostics: compileDiagnostics } = await compileShadowCached(cacheDir, root, file, source, { routesDir, mounts, lints: options.lints, shadowOf })

    await tree.shadow(shadow, shadowOf(file))

    if (!reached.has(file)) {
      unreached.add(file)

      return
    }

    for (const diagnostic of compileDiagnostics)
      diagnostics.push(fromCompile(file, source, diagnostic))
  }))

  return { libraries, followed, programs, pages: pages.filter(file => !apart(file)), diagnostics, unreached }
}

// The programs of the linked extensions whose tsconfig types a file other than the app's does, each with the tsconfig kay writes in its shadow folder: it extends the package's and lays the app's declarations over it, so the app's catalogs, locals and matchers stay in scope.
async function extensionPrograms(root: string, options: CheckOptions, extensions: KayLibrary[], tree: ShadowTree, diagnostics: CheckDiagnostic[]): Promise<ExtensionProgram[]> {
  const own = extensions.map(library => ({ library, tsconfig: join(library.realDir, PACKAGE_TSCONFIG) })).filter(({ tsconfig }) => existsSync(tsconfig))

  if (own.length === 0)
    return []

  const types = projectPaths(root).types
  const appOptions = typingOptions(root, options.tsconfig ?? 'tsconfig.json')
  const programs = await Promise.all(own.map(async ({ library, tsconfig }) => {
    const packageOptions = await typingOptions(root, tsconfig)

    if (packageOptions === undefined) {
      diagnostics.push({ file: tsconfig, line: 1, column: 1, message: `tsgo cannot read the tsconfig of the extension ${library.name}, so its pages are checked under the app's options.` })

      return undefined
    }

    if (packageOptions === await appOptions)
      return undefined

    // Where the package really is, as tsgo ignores a tsconfig under a `node_modules` path: the shadows the app reaches through its link are the ones here.
    const dir = dirname(shadowPath(root, join(library.realDir, 'x')))
    const from = (path: string) => {
      const relation = relative(dir, path).split(sep).join('/')

      return relation.startsWith('.') ? relation : `./${relation}`
    }
    const config = {
      extends: from(tsconfig),
      // What the shadow files are compiled for, whatever the package's own config says.
      compilerOptions: { jsx: 'preserve', jsxImportSource: 'kay', module: 'Preserve', moduleResolution: 'bundler', rootDirs: [from(root), from(types)], noEmit: true },
      // The package's own `include` is not inherited, as it names its sources.
      include: [],
      files: [...library.files.map(file => from(shadowPath(root, realFile(extensions, file)))), ...APP_TYPES.map(name => from(join(types, name)))],
    }

    await tree.write(join(relative(types, dir), PACKAGE_TSCONFIG), `${JSON.stringify(config, null, 2)}\n`)

    if (library.dir !== library.realDir)
      await tree.link(relative(types, dirname(shadowPath(root, join(library.dir, 'x')))), dir)

    return { dir, tsconfig: join(dir, PACKAGE_TSCONFIG), library }
  }))

  return programs.filter(program => program !== undefined)
}

// Where the shadow of a file is written: the package of a program beside its real path, any other file where `shadowPath` puts it.
export function programShadows(root: string, programs: ExtensionProgram[]): (file: string) => string {
  const libraries = programs.map(({ library }) => library)

  return file => shadowPath(root, libraries.some(library => libraryOf([library], file) !== undefined) ? realFile(libraries, file) : file)
}

// A file of a package given by the `node_modules` link the app reaches it by, as its real path.
function realFile(libraries: KayLibrary[], file: string): string {
  const library = libraryOf(libraries, file)

  return library && file.startsWith(library.dir + sep) ? join(library.realDir, relative(library.dir, file)) : file
}

async function dropLink(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      await unlink(path)
  }
  catch {}
}

// A bare import climbs from the shadow, not from the package, so the dependencies the package installs are linked beside its shadows: its own `node_modules`, and the ones above it that the app's ancestors do not include.
async function linkDependencies(root: string, { dir, realDir }: KayLibrary, own: boolean, tree: ShadowTree) {
  const types = projectPaths(root).types
  // The package of a program is shadowed beside its real path.
  const folder = join(relative(types, dirname(shadowPath(root, join(own ? realDir : dir, 'x')))), 'node_modules')
  const above: string[] = []

  for (let level = realDir; level !== dirname(level) && !(root + sep).startsWith(level + sep); level = dirname(level)) {
    if (existsSync(join(level, 'node_modules')))
      above.push(join(level, 'node_modules'))
  }

  // One link to the folder while it is the only one, else a link per package, the nearest folder naming it winning.
  if (above.length <= 1) {
    if (above.length === 1)
      await tree.link(folder, above[0]!)

    return
  }

  // A link to a whole folder from an earlier run would take the links below it to the packages' own.
  await dropLink(join(types, folder))

  const taken = new Set<string>()

  for (const modules of above) {
    const names = (await readdir(modules, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.'))
    const named = (await Promise.all(names.map(async entry => entry.name.startsWith('@') ? (await readdir(join(modules, entry.name))).map(name => join(entry.name, name)) : [entry.name]))).flat()

    await Promise.all(named.filter(name => !taken.has(name)).map(async (name) => {
      taken.add(name)
      await tree.link(join(folder, name), join(modules, name))
    }))
  }
}

// The package holding each of `extensionDirs`, an extension's routes or its editor's directory, that no kay library holds, the nearest directory above them with a package.json, as a library: its components are shadowed and reached as one's are.
async function extensionPackages(root: string, libraries: KayLibrary[], extensionDirs: string[]): Promise<KayLibrary[]> {
  const dirs = new Set(extensionDirs.filter(dir => libraryOf(libraries, join(dir, 'page.kay')) === undefined).map(packageRoot))

  const realRoot = realpathSync(root)

  return Promise.all([...dirs].map(async (dir) => {
    // Left out: the app itself, when the package holds it as a fixture; the other projects inside it, to their own checks; a kay library's files, to the library. A package linked into `node_modules` goes by that path, as the app imports it.
    const files = (await findKayFiles(dir, { project: true, ownOnly: true, ownKayOnly: true })).filter(file => !realpathSync(file).startsWith(realRoot + sep) && libraryOf(libraries, file) === undefined)

    return { name: basename(dir), dir, realDir: realpathSync(dir), files, specifiers: new Map<string, string>(), exports: undefined, extension: true as const }
  }))
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

// `compileShadow` through the build's cache of compiles. A page's params are read from its path in the routes directory holding it, an extension's or the app's, and typed by the matchers they name, so the mounts and where each matcher is found, if anywhere, are part of the key, as are the `query` types of the layouts above it, as are the signals of the modules it imports.
async function compileShadowCached(cacheDir: string, root: string, file: string, source: string, { routesDir, mounts, insideIsland = false, lints, shadowOf }: ShadowOptions): Promise<ReturnType<typeof compileShadow>> {
  const route = pageRoute(file, routesDir, mounts)
  const matchers = Object.values(route?.matchers ?? {}).map(matcher => matcherSource(routesDir, matcher) ?? '')
  const signals = importedSignals(file, source)
  const queries = layoutQueries(file, source, routesDir, mounts)
  const slot = cacheEntry(cacheDir, file, 'shadow', JSON.stringify([root, routesDir, mounts, insideIsland, lints ?? {}, matchers, signals, queries, shadowOf?.(file), source]))
  const cached = await readCacheEntry<{ tsx: string, map: ReturnType<SourceMap['toJSON']>, diagnostics: Diagnostic[] }>(slot)

  if (cached !== undefined)
    return { shadow: { source, file, tsx: cached.tsx, map: SourceMap.fromJSON(cached.map) }, diagnostics: cached.diagnostics, queries }

  const compiled = compileShadow(root, file, source, { routesDir, mounts, insideIsland, lints, signals, shadowOf })

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
