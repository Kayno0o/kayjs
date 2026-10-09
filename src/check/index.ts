import type { KayLibrary, SettingsReplacement } from '../build/libraries'
import type { Diagnostic, Fix } from '../compiler/ast'
import type { Paint } from '../compiler/frame'
import type { LintLevel, LintLevels, TypeLint } from '../compiler/lints'
import type { I18nConfig } from '../config'
import type { ComponentUse } from '../content/server'
import type { ContentProblem } from '../content/validate'
import type { Duration } from '../runtime/duration'
import type { LocaleSettings } from '../runtime/i18n'
import type { ApiModule } from '../server/api'
import type { Redirects } from '../server/redirects'
import type { Route } from '../server/routes'
import type { ShadowFile } from './shadow'
import { existsSync, statSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ASSET_EXTENSIONS } from '../build/assets'
import { readCacheEntry, writeCacheEntry } from '../build/cache'
import { findKayFiles, writeIfChanged } from '../build/files'
import { iconTypes } from '../build/icons'
import { findKayLibraries, libraryOf, reachableLibraryFiles, settingsReplacements, throughNodeModules } from '../build/libraries'
import { cacheEntry } from '../build/transform'
import { componentName, rendersAsIsland, SourceMap } from '../compiler'
import { formatReport } from '../compiler/frame'
import { isLint, LEVELS, lintLevels, typeLint } from '../compiler/lints'
import { offsetAt, positionAt } from '../compiler/mapping'
import { CONFIG_FILE } from '../config'
import { CONTENT_CONFIG, PROBLEMS_MARKER, USES_MARKER } from '../content/server'
import { scanApi } from '../server/api'
import { FAVICON_PATHS } from '../server/favicon'
import { localePrefixes, localeSettings, messagesFile } from '../server/i18n'
import { HEALTH_PATH } from '../server/lifecycle'
import { publicFiles } from '../server/public'
import { redirectProblems } from '../server/redirects'
import { patternShapes, routeOf, scanRoutes } from '../server/routes'
import { ROBOTS, SITEMAP } from '../server/sitemap'
import { bootProblems } from './boot'
import { islandOnlyComponents } from './island-only'
import { compileShadow, matcherSource, serializeShadowSettings, SHADOW_DIR, SHADOW_SETTINGS, shadowPath } from './shadow'

const KAY_FILE = /\.kay$/
const SERVER_ENTRY = 'src/server.ts'
const SETTINGS_CHECK = 'kay-settings.ts'
const EXPORTS_CHECK = 'kay-exports.ts'
const CONTENT_CHECK = 'kay-content.ts'
const TSX_EXTENSION = /\.tsx$/
const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/
const CONTENT_PROBLEMS = fileURLToPath(new URL('../content/problems.ts', import.meta.url))
const MESSAGE_PROBLEMS = fileURLToPath(new URL('./messages.ts', import.meta.url))

export interface CheckOptions {
  tsconfig?: string | undefined
  // The server entry relative to the root, `src/server.ts` by default: the `app` it exports types `ctx.locals` and the app routes links may point at.
  entry?: string | undefined
  // Page directory relative to the root, so `ctx.params` is typed per route.
  routes?: string | undefined
  // Public file directory relative to the root, whose files links may point at.
  publicDir?: string | undefined
  // API directory relative to the root, whose modules' GET routes links may point at.
  api?: string | undefined
  // The app's own modules for its libraries' settings, checked against the defaults they replace.
  settings?: Record<string, string> | undefined
  // The content config relative to the root, whose collections' entries are read against their schemas.
  content?: string | undefined
  // The config's redirects, whose targets on the site must be a page or a public file.
  redirects?: Redirects | undefined
  // Where the site is mounted, the origin it is public at and how long a stopping server waits, which the server refuses at boot when it cannot read them.
  base?: string | undefined
  site?: string | undefined
  shutdownTimeout?: Duration | undefined
  // The config's locales: links may carry their prefixes, `t()` reads the default locale's messages, and every other locale's must match them.
  i18n?: I18nConfig | undefined
  // The level of each lint, over its default.
  lints?: LintLevels | undefined
}

export interface CheckDiagnostic extends Pick<Diagnostic, 'label' | 'related' | 'note' | 'help' | 'severity' | 'fixes'> {
  file: string
  line: number
  column: number
  // Where the span ends in the file's source, when it is longer than one character.
  end?: number | undefined
  message: string
  code?: string | undefined
  // Found by type checking only, so the file's type errors are still reported.
  checkOnly?: boolean | undefined
}

// What `noUnusedLocals` reports: `kay check` turns it on for .kay files, and leaves other files to the project's tsconfig.
export const UNUSED_CODES = new Set([6133, 6192, 6196, 6198, 6199, 6205])
// What `noUnusedParameters` alone reports: a parameter, a destructured one or a type parameter, under the codes locals share.
const UNUSED_PARAMETER_CODES = new Set([6133, 6198, 6205])
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/
// An error about the whole run, such as a tsconfig that does not exist.
const TSC_GLOBAL_LINE = /^error (TS\d+): (.*)$/
const UNWRITABLE = /[%?#]/
const TS_EXTENSION = /\.ts$/
const PARAM_SEGMENT = /:([^/]+)/g
// A prop name TypeScript reads unquoted, so its errors name it as written.
const IDENTIFIER = /^[a-z_$][\w$]*$/i
// A condition that is always true, a function standing in for its value.
const ALWAYS_DEFINED = 'TS2774'
const MISSING_PROPERTY = 'TS2339'
const LEADING_NAME = /^[a-z_$][\w$]*/i
const MEMBER_OF = /([a-z_$][\w$]*)\??\.$/i
// What kay serves itself, whether or not the project turns it on.
const KAY_PATHS = [SITEMAP, ROBOTS, ...FAVICON_PATHS, HEALTH_PATH]
// What a browser percent-encodes in a path it is given: spaces, controls and anything outside ASCII.
const NOT_IN_URL = /[^\x21-\x7E]+/g
// Stylesheets import for their effect, other assets for their URL. TypeScript matches a wildcard module case-sensitively, so both `.png` and `.PNG` are declared; a mixed case such as `.Png` is not.
const ASSET_TYPES = ['declare module \'*.css\' {}\n', ...ASSET_EXTENSIONS.flatMap(extension => [extension, extension.toUpperCase()]).map(extension => `declare module '*.${extension}' {\n  const url: string\n  export default url\n}\n`)].join('\n')

const TSGO_PACKAGE = fileURLToPath(import.meta.resolve('@typescript/native-preview/package.json'))

export const TSGO = join(dirname(TSGO_PACKAGE), 'bin', 'tsgo')
// Where `kay check` keeps tsgo's build info and what its last clean run read.
const CHECK_STATE = join('.kay', 'cache', 'check')
// A filesystem stamps writes off a coarse clock, milliseconds behind on Linux and up to a second on some, so a file written that close before a run counts as written after it.
const CLOCK_SLACK = 1000

// Compiles every .kay file of the project at `root`, nested projects left to their own, to `.kay/types/<path>.kay.tsx`, the tree tsconfig `rootDirs` merges with the sources.
export async function writeShadowTypes(projectRoot: string, options: CheckOptions = {}): Promise<ShadowTypes> {
  const root = resolve(projectRoot)
  const files = new Map<string, ShadowFile>()
  const diagnostics: CheckDiagnostic[] = []
  const routesDir = resolve(root, options.routes ?? 'src/routes')

  const environmentPath = join(root, SHADOW_DIR, 'kay-env.d.ts')
  const assetsPath = join(root, SHADOW_DIR, 'kay-assets.d.ts')
  const iconsPath = join(root, SHADOW_DIR, 'kay-icons.d.ts')
  const packagesPath = join(root, SHADOW_DIR, 'kay-packages.d.ts')
  const settingsPath = join(root, SHADOW_DIR, SETTINGS_CHECK)
  const exportsPath = join(root, SHADOW_DIR, EXPORTS_CHECK)
  const settingsFile = join(root, SHADOW_DIR, SHADOW_SETTINGS)
  const own = await findKayFiles(root, { project: true, ownOnly: true, ownKayOnly: true })
  const sources = new Map(await Promise.all(own.map(async file => [file, await Bun.file(file).text()] as const)))
  const cacheDir = join(root, '.kay', 'cache')
  const islands = new Set((await Promise.all(own.map(async file => await rendersAsIslandCached(cacheDir, file, sources.get(file)!) ? [file] : []))).flat())
  const islandOnly = await islandOnlyComponents(root, routesDir, own, sources, file => islands.has(file))

  for (const file of own) {
    const source = sources.get(file)!
    const { shadow, diagnostics: compileDiagnostics } = await compileShadowCached(cacheDir, root, routesDir, file, source, islandOnly.has(file), options.lints)
    const path = shadowPath(root, file)

    await writeIfChanged(path, shadow.tsx)
    files.set(path, shadow)
    for (const diagnostic of compileDiagnostics)
      diagnostics.push(fromCompile(file, source, diagnostic))
  }

  const [routes, publicPaths, apiModules] = await Promise.all([scanRoutes(routesDir), publicFiles(resolve(root, options.publicDir ?? 'public')), apiModulesOf(resolve(root, options.api ?? 'src/api'), diagnostics)])

  // A param a matcher kay ships checks is named after it, `:integer`, so a link filling it with a literal is checked as the matcher would; any other is `:`.
  const shapes = routes.flatMap(route => patternShapes(route.pattern).map(shape => shape.replace(PARAM_SEGMENT, (_, name: string) => {
    const matcher = route.matchers?.[name]

    return matcher !== undefined && matcherSource(routesDir, matcher) === 'kay' ? `:${matcher}` : ':'
  })))
  const settings = options.i18n && i18nSettings(root, options.i18n, diagnostics)
  // A page is reached in every locale, under its prefix where it has one; an unprefixed path still answers, sending the visitor on to theirs when every locale is prefixed.
  const prefixes = settings ? localePrefixes(settings) : []
  const localized = [...shapes, ...prefixes.flatMap(locale => shapes.map(shape => `/${locale}${shape === '/' ? '' : shape}`))]

  const apiMounts = apiModules.map(module => ({ mount: module.mount, module: relative(dirname(environmentPath), module.file).replace(TS_EXTENSION, '') }))

  const config = existsSync(join(root, CONFIG_FILE)) ? relative(dirname(environmentPath), join(root, CONFIG_FILE)).replace(TS_EXTENSION, '') : undefined
  const entry = resolve(root, options.entry ?? SERVER_ENTRY)
  const app = await exportsApp(entry) ? relative(dirname(environmentPath), entry).replace(TS_EXTENSION, '') : undefined
  const contentConfig = resolve(root, options.content ?? CONTENT_CONFIG)
  const content = existsSync(contentConfig) ? relative(dirname(environmentPath), contentConfig).replace(TS_EXTENSION, '') : undefined

  await writeIfChanged(environmentPath, environment(localized, [...publicPaths.map(file => file.url), ...KAY_PATHS], apiMounts, settings && options.i18n && { locales: options.i18n.locales, messages: relative(dirname(environmentPath), messagesFile(root, options.i18n, options.i18n.defaultLocale)).replace(TS_EXTENSION, '') }, config, app, content))

  // What kay serves itself counts as served, whether or not the project turns it on.
  const served = [...routes.flatMap(route => patternShapes(route.pattern)), ...publicPaths.map(file => file.url), ...KAY_PATHS]

  for (const message of redirectProblems(options.redirects ?? {}, served))
    diagnostics.push({ file: join(root, CONFIG_FILE), line: 1, column: 1, message })
  // A script rather than a module, which is what lets it declare a wildcard module.
  await writeIfChanged(assetsPath, ASSET_TYPES)
  await writeIfChanged(iconsPath, iconTypes(root))

  // A library's components compile against the app's types, and the ones it reaches are reported as its own: `kay build` compiles those.
  const libraries = await findKayLibraries(root)
  const reached = new Set((await reachableLibraryFiles(root, libraries, own)).components.map((file) => {
    const library = libraryOf(libraries, file)

    return library ? throughNodeModules(library, file) : file
  }))
  const unreached = new Set<string>()

  await Promise.all(libraries.flatMap(library => library.files).map(async (file) => {
    const source = await Bun.file(file).text()
    const { shadow, diagnostics: compileDiagnostics } = await compileShadowCached(cacheDir, root, routesDir, file, source, false, options.lints)
    const path = shadowPath(root, file)

    await writeIfChanged(path, shadow.tsx)
    files.set(path, shadow)

    if (!reached.has(file)) {
      unreached.add(file)

      return
    }

    for (const diagnostic of compileDiagnostics)
      diagnostics.push(fromCompile(file, source, diagnostic))
  }))

  await writeIfChanged(packagesPath, packageTypes(root, libraries))

  const replaced = settingsCheck(root, options.settings ?? {}, diagnostics)
  const exported = exportsCheck(root, routesDir, routes, apiModules)

  await writeIfChanged(settingsPath, replaced.code)
  await writeIfChanged(exportsPath, exported.code)
  await writeIfChanged(settingsFile, serializeShadowSettings(root, { routesDir, islandOnly }))

  // Rewriting in place keeps every shadow file present for editors reading the tree meanwhile; only stale ones go.
  const stale = (await readdir(join(root, SHADOW_DIR), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => path !== environmentPath && path !== assetsPath && path !== iconsPath && path !== packagesPath && path !== settingsPath && path !== exportsPath && path !== settingsFile && path !== join(root, SHADOW_DIR, CONTENT_CHECK) && !files.has(path))

  await Promise.all(stale.map(async path => rm(path)))

  return { files, diagnostics, unreached, libraries, settings: replaced.lines, exports: exported.lines, islandOnly }
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

// `compileShadow` through the build's cache of compiles. A page's params are typed by the matchers they name, so where each one is found, if anywhere, is part of the key.
async function compileShadowCached(cacheDir: string, root: string, routesDir: string, file: string, source: string, insideIsland: boolean, lints?: LintLevels): Promise<ReturnType<typeof compileShadow>> {
  const route = file.startsWith(routesDir + sep) ? routeOf(routesDir, file) : undefined
  const matchers = Object.values(route?.matchers ?? {}).map(matcher => matcherSource(routesDir, matcher) ?? '')
  const slot = cacheEntry(cacheDir, file, 'shadow', JSON.stringify([root, routesDir, insideIsland, lints ?? {}, matchers, source]))
  const cached = await readCacheEntry<{ tsx: string, map: ReturnType<SourceMap['toJSON']>, diagnostics: Diagnostic[] }>(slot)

  if (cached !== undefined)
    return { shadow: { source, file, tsx: cached.tsx, map: SourceMap.fromJSON(cached.map) }, diagnostics: cached.diagnostics }

  const compiled = compileShadow(root, routesDir, file, source, insideIsland, lints)

  await writeCacheEntry(slot, { tsx: compiled.shadow.tsx, map: compiled.shadow.map, diagnostics: compiled.diagnostics })

  return compiled
}

export interface ShadowTypes {
  files: Map<string, ShadowFile>
  diagnostics: CheckDiagnostic[]
  // Library components the app never imports, whose errors are not its own.
  unreached: Set<string>
  libraries: KayLibrary[]
  // The app's settings module each line of the settings check stands for, with the library it sets.
  settings: Map<number, { file: string, library: string }>
  // The guard, API module or matcher each line of the exports check reads the default export of, with what it must be.
  exports: Map<number, { file: string, wanted: string }>
  // The static components only islands render, which compile as rendered inline with them.
  islandOnly: Set<string>
}

// A file of the project itself: under its root and outside every `node_modules`.
function ownFile(root: string, file: string): boolean {
  const path = relative(resolve(root), file)

  return !path.startsWith('..') && !path.split(sep).includes('node_modules')
}

// Each component a library exports, typed as the module its specifier names: rootDirs merges relative imports only, so a package's `.kay` files reach the app through these.
function packageTypes(root: string, libraries: KayLibrary[]): string {
  const shadowDir = join(root, SHADOW_DIR)

  return libraries.flatMap(library => [...library.specifiers].map(([specifier, file]) => {
    const shadow = relative(shadowDir, shadowPath(root, file)).replace(TSX_EXTENSION, '')

    const name = componentName(file)

    // Named after the component, which is what auto-import offers it as.
    return `declare module ${JSON.stringify(specifier)} {\n  const ${name}: typeof import(${JSON.stringify(`./${shadow}`)}).default\n  export default ${name}\n}\n`
  })).join('\n')
}

// One line per library whose settings the app replaces, assigning the app's module to the type of the defaults it stands in for.
function settingsCheck(root: string, settings: Record<string, string>, diagnostics: CheckDiagnostic[]): { code: string, lines: Map<number, { file: string, library: string }> } {
  const shadowDir = join(root, SHADOW_DIR)
  const imports: string[] = []
  const checks: string[] = []
  const lines = new Map<number, { file: string, library: string }>()
  let replacements: SettingsReplacement[]

  try {
    replacements = settingsReplacements(root, settings)
  }
  catch (error) {
    diagnostics.push({ file: join(root, CONFIG_FILE), line: 1, column: 1, message: error instanceof Error ? error.message : String(error) })

    return { code: '', lines }
  }

  if (replacements.length === 0)
    return { code: '', lines }

  const modulePath = (file: string) => JSON.stringify(relative(shadowDir, file).replace(SCRIPT_EXTENSION, ''))

  for (const [index, { library, defaults, replacement }] of replacements.entries()) {
    imports.push(`import type defaults${index} from ${modulePath(defaults)}`, `import settings${index} from ${modulePath(replacement)}`)
    checks.push(`export const kaySettings${index}: typeof defaults${index} = settings${index}`)
    // Lines count from 1, the checks after the imports and a blank line.
    lines.set(replacements.length * 2 + 2 + index, { file: replacement, library })
  }

  return { code: `${imports.join('\n')}\n\n${checks.join('\n')}\n`, lines }
}

// Each default export the server calls, a guard's, an API module's or a matcher's, assigned to the type it is called as, so a wrong one is a type error at its file rather than a refusal at boot.
function exportsCheck(root: string, routesDir: string, routes: Route[], api: ApiModule[]): { code: string, lines: Map<number, { file: string, wanted: string }> } {
  const guards = new Set([...routes.flatMap(route => route.guards.map(guard => guard.file)), ...api.flatMap(module => module.guards)])
  const matchers = new Set(routes.flatMap(route => Object.values(route.matchers ?? {})).map(matcher => matcherSource(routesDir, matcher)).filter((source): source is string => source !== undefined && source !== 'kay'))
  const entries = [
    ...[...guards].map(file => ({ file, type: 'Guard', wanted: 'a guard by default: export default guard(ctx => ...)' })),
    ...api.map(module => ({ file: module.file, type: 'AnyElysia', wanted: 'an Elysia instance by default: export default new Elysia().get(\'/\', () => ...)' })),
    ...[...matchers].map(file => ({ file, type: '(value: string) => unknown', wanted: 'a matcher by default: export default (value: string) => value or undefined' })),
  ]
  const lines = new Map<number, { file: string, wanted: string }>()

  if (entries.length === 0)
    return { code: '', lines }

  const shadowDir = join(root, SHADOW_DIR)
  const header = [...guards.size > 0 ? ['import type { Guard } from \'kay\''] : [], ...api.length > 0 ? ['import type { AnyElysia } from \'elysia\''] : []]
  const imports = entries.map(({ file }, index) => `import kayExport${index} from ${JSON.stringify(relative(shadowDir, file).replace(SCRIPT_EXTENSION, ''))}`)
  const checks = entries.map(({ type }, index) => `export const kayCheck${index}: ${type} = kayExport${index}`)

  // Lines count from 1: the type imports, the imports, a blank line, then the checks.
  for (const [index, { file, wanted }] of entries.entries()) {
    lines.set(header.length + 1 + index, { file, wanted })
    lines.set(header.length + entries.length + 2 + index, { file, wanted })
  }

  return { code: `${[...header, ...imports].join('\n')}\n\n${checks.join('\n')}\n`, lines }
}

// The API modules, or none with the reason the server would refuse them reported at the directory.
async function apiModulesOf(apiDir: string, diagnostics: CheckDiagnostic[]): Promise<ApiModule[]> {
  try {
    return await scanApi(apiDir)
  }
  catch (error) {
    diagnostics.push({ file: apiDir, line: 1, column: 1, message: error instanceof Error ? error.message : String(error) })

    return []
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

// Declares the check-only helpers generated code calls, and the routes and public files links are checked against.
function environment(patterns: string[], files: string[], api: { mount: string, module: string }[], i18n?: { locales: string[], messages: string }, config?: string, app?: string, content?: string): string {
  const routes = patterns.length > 0 ? patterns.map(routeTuple).join(' | ') : 'never'
  // The collections' feeds are served as files are.
  const feeds = content === undefined ? [] : [`FeedPathsOf<typeof import(${importSpecifier(content)})>`]
  const paths = [...files.flatMap(spellings).map(file => JSON.stringify(file)), ...feeds].join(' | ') || 'never'
  const locales = i18n ? `, locales: ${i18n.locales.map(locale => JSON.stringify(locale)).join(' | ')}, messages: typeof import(${importSpecifier(i18n.messages)}).default` : ''
  const modules = api.length > 0 ? `, api: ${apiTree(api)}` : ''
  const publicEnv = config === undefined ? '' : `, publicEnv: PublicEnvOf<typeof import(${importSpecifier(config)}).default>`

  return [
    'import type { Action, ApiRoutesOf, CheckedHref, CheckedHtml, ChildrenProp, FieldName, FunctionProp, IdentityKeyed, IslandProp, LocalsOf, PublicEnvOf } from \'kay\'',
    ...content === undefined ? [] : ['import type { FeedPathsOf } from \'kay/content\''],
    '',
    'declare module \'kay\' {',
    `  interface Register { routes: ${routes}, files: ${paths}${locales}${modules}${publicEnv} }`,
    ...app === undefined ? [] : [`  interface Inferred { app: typeof import(${importSpecifier(app)}).app, locals: LocalsOf<typeof import(${importSpecifier(app)}).app> }`],
    '}',
    '',
    'declare global {',
    '  function KayHref<const Href extends string>(href: Href & CheckedHref<Href>): string',
    '  function KayHtml<const Markup>(markup: Markup & CheckedHtml<Markup>): Markup',
    '  function KayField<Target extends string | Action<never, unknown>>(target: Target, name: FieldName<Target>): string',
    '  function KayProp<Component>(component: Component): <Value>(value: Value & IslandProp<Component, Value>) => Value',
    '  function KayFunctionProp<Component>(component: Component): (attribute: FunctionProp<Component>) => Record<never, never>',
    '  function KayChildren<Component>(component: Component): (children: ChildrenProp<Component>) => Record<never, never>',
    '  function KayIdentityKey<Each>(each: Each & IdentityKeyed<Each>): Each',
    '}',
    '',
  ].join('\n')
}

// Read off its source rather than imported: the entry starts the server as it loads.
async function exportsApp(entry: string): Promise<boolean> {
  if (!existsSync(entry))
    return false

  try {
    return new Bun.Transpiler({ loader: 'ts' }).scan(await Bun.file(entry).text()).exports.includes('app')
  }
  catch {
    return false
  }
}

function importSpecifier(path: string): string {
  return JSON.stringify(path.startsWith('.') ? path : `./${path}`)
}

interface ApiNode {
  modules: string[]
  children: Map<string, ApiNode>
}

// The route trees of the API modules, each under the segments of its mount, as Elysia nests an app's own: `{ api: { chat: ... } }`.
function apiTree(api: { mount: string, module: string }[]): string {
  const top: ApiNode = { modules: [], children: new Map() }

  for (const { mount, module } of api) {
    let node = top

    for (const segment of mount.split('/').filter(part => part !== '')) {
      let child = node.children.get(segment)

      if (!child)
        node.children.set(segment, child = { modules: [], children: new Map() })

      node = child
    }

    node.modules.push(`ApiRoutesOf<typeof import(${importSpecifier(module)})>`)
  }

  const render = (node: ApiNode): string => {
    const children = node.children.size > 0 ? [`{ ${[...node.children].map(([segment, child]) => `${JSON.stringify(segment)}: ${render(child)}`).join(', ')} }`] : []

    return [...node.modules, ...children].join(' & ') || '{}'
  }

  return render(top)
}

// `/todos/:` becomes `['todos', ':']`, `/todos/:integer` `['todos', ':integer']`, the shape `CheckedHref` matches paths against segment by segment.
function routeTuple(pattern: string): string {
  const segments = pattern.split('/').filter(segment => segment !== '').map(segment => segment.startsWith(':') ? [segment] : spellings(segment))

  return `[${segments.map(segment => segment.map(spelling => JSON.stringify(spelling)).join(' | ')).join(', ')}]`
}

// A link may spell a path as written or percent-encoded, `/café` or `/caf%C3%A9`, and the server answers both.
function spellings(path: string): string[] {
  let written = path

  try {
    written = decodeURI(path)
  }
  catch {}

  // A written `%`, `?` or `#` would read as an escape, a query or a hash.
  return [...new Set([path, written.replace(NOT_IN_URL, encodeURI), ...(UNWRITABLE.test(written) ? [] : [written])])]
}

// Type-checks a project, .kay components included, and reports every error at the line and column the user wrote.
export async function check(root: string, options: CheckOptions = {}): Promise<CheckDiagnostic[]> {
  const tsconfig = options.tsconfig ?? 'tsconfig.json'
  const { files, diagnostics, unreached, libraries, settings, exports } = await writeShadowTypes(root, options)

  diagnostics.push(...lintConfigProblems(root, options.lints))
  const settingsFile = join(resolve(root), SHADOW_DIR, SETTINGS_CHECK)
  const exportsFile = join(resolve(root), SHADOW_DIR, EXPORTS_CHECK)
  const contentFile = join(resolve(root), SHADOW_DIR, CONTENT_CHECK)
  // The props Markdown entries give their components are typed with the rest, so the collections are read first.
  const content = await checkContent(root, options.content, options.site !== undefined)
  const props = contentPropsCheck(resolve(root), resolve(root, options.content ?? CONTENT_CONFIG), content.uses)

  await writeIfChanged(contentFile, props.code)

  const shown = await resolvedConfig(root, tsconfig)
  const projectUnused = unusedCodesOf(shown)
  const [{ output, errors, code }, messages, boot] = await Promise.all([typecheck(root, tsconfig, shown), checkMessages(root, options.i18n), bootProblems(resolve(root), options)])
  const config = resolve(root, tsconfig)
  const reported = parseTscOutput(output, config, root)
  // A file that did not compile has its errors already; what TypeScript makes of the code compiled around them would only add noise.
  const broken = new Set(diagnostics.filter(diagnostic => !diagnostic.checkOnly).map(diagnostic => diagnostic.file))
  // A library's own modules are its to check, as `skipLibCheck` leaves a declaration file's, a missing optional peer included: only its components compile as the app's. An app inside a linked library's repository keeps its own files.
  const libraryModule = (file: string) => !KAY_FILE.test(file) && libraryOf(libraries, file) !== undefined && !ownFile(root, file)
  const levels = new Map<ShadowFile, ReturnType<typeof lintLevels>>()
  // Unread code in a .kay file is the `unread-name` lint, at its level there.
  const unreadLevel = (diagnostic: CheckDiagnostic): LintLevel | undefined => {
    const shadow = files.get(diagnostic.file)

    if (!shadow || diagnostic.code === undefined || !UNUSED_CODES.has(Number(diagnostic.code.slice(2))))
      return undefined

    const levelAt = levels.get(shadow) ?? lintLevels(shadow.source, options.lints)

    levels.set(shadow, levelAt)

    return levelAt('unread-name', shadow.map.toSource(offsetAt(shadow.tsx, diagnostic)) ?? 0)
  }

  // A lint the types find, as `identity-key`, at its level where the source has it.
  const typeLintLevel = (diagnostic: CheckDiagnostic): { lint: TypeLint, level: LintLevel } | undefined => {
    const lint = typeLint(diagnostic.message)
    const shadow = files.get(diagnostic.file)

    if (!lint || !shadow)
      return undefined

    const levelAt = levels.get(shadow) ?? lintLevels(shadow.source, options.lints)

    levels.set(shadow, levelAt)

    return { lint, level: levelAt(lint.code, shadow.map.toSource(offsetAt(shadow.tsx, diagnostic)) ?? 0) }
  }

  if (errors.trim() !== '')
    diagnostics.push({ file: config, line: 1, column: 1, message: errors.trim() })

  for (const diagnostic of reported) {
    if (diagnostic.code !== undefined && UNUSED_CODES.has(Number(diagnostic.code.slice(2))) && (files.has(diagnostic.file) ? generatedOnly(diagnostic, files) : !projectUnused.has(Number(diagnostic.code.slice(2)))))
      continue

    const unread = unreadLevel(diagnostic)
    const typed = typeLintLevel(diagnostic)

    if (unread === 'allow' || typed?.level === 'allow')
      continue

    const remapped = typed !== undefined
      ? { ...remap(diagnostic, files), ...typed.lint, severity: typed.level === 'warn' ? 'warning' as const : 'error' as const }
      : unread === undefined ? remap(diagnostic, files) : { ...remap(diagnostic, files), code: 'unread-name', severity: unread === 'warn' ? 'warning' as const : 'error' as const }
    const setting = remapped.file === settingsFile ? settings.get(remapped.line) : undefined
    const exported = remapped.file === exportsFile ? exports.get(remapped.line) : undefined
    const used = remapped.file === contentFile ? props.lines.get(remapped.line) : undefined

    if (setting)
      diagnostics.push({ file: setting.file, line: 1, column: 1, code: remapped.code, message: `The settings for ${setting.library} do not match what it takes: ${remapped.message}` })
    else if (exported)
      diagnostics.push({ file: exported.file, line: 1, column: 1, code: remapped.code, message: `It must export ${exported.wanted}: ${remapped.message}` })
    else if (used)
      diagnostics.push({ file: resolve(root, used.file), line: used.line, column: 1, code: remapped.code, message: `<${used.component}> takes other props: ${remapped.message}` })
    else if (!broken.has(remapped.file) && !unreached.has(remapped.file) && !libraryModule(remapped.file))
      diagnostics.push(remapped)
  }

  diagnostics.push(...content.problems, ...messages, ...boot)

  // A failing run that reported nothing must not pass for a clean one.
  if (code !== 0 && reported.length === 0 && errors.trim() === '')
    diagnostics.push({ file: config, line: 1, column: 1, message: `tsgo exited with code ${code} and no diagnostics` })

  return diagnostics
}

// Each locale's messages against the default locale's, read in a process of its own so an edited file is read afresh.
async function checkMessages(root: string, config: I18nConfig | undefined): Promise<CheckDiagnostic[]> {
  if (!config)
    return []

  const child = Bun.spawn([process.execPath, MESSAGE_PROBLEMS, resolve(root), JSON.stringify(config)], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    return [{ file: join(root, CONFIG_FILE), line: 1, column: 1, message: errors.trim() || `reading the messages exited with code ${code}` }]

  return problemsIn(root, output)
}

// The problems a checking process printed on its marked line, whatever else the project's code logged.
function problemsIn(root: string, output: string): CheckDiagnostic[] {
  const line = output.split('\n').find(text => text.startsWith(PROBLEMS_MARKER)) ?? `${PROBLEMS_MARKER}[]`

  return (JSON.parse(line.slice(PROBLEMS_MARKER.length)) as ContentProblem[]).map(problem => ({ file: resolve(root, problem.file), line: problem.line, column: 1, message: problem.message }))
}

// The collections' entries that fail to compile or to match their schema, read in a process of its own.
async function checkContent(root: string, config: string | undefined, site: boolean): Promise<{ problems: CheckDiagnostic[], uses: ComponentUse[] }> {
  if (config === undefined && !existsSync(resolve(root, CONTENT_CONFIG)))
    return { problems: [], uses: [] }

  const child = Bun.spawn([process.execPath, CONTENT_PROBLEMS, resolve(root), config ?? '', site ? 'site' : ''], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    return { problems: [{ file: resolve(root, config ?? CONTENT_CONFIG), line: 1, column: 1, message: errors.trim() || `reading the collections exited with code ${code}` }], uses: [] }

  const uses = output.split('\n').find(text => text.startsWith(USES_MARKER))?.slice(USES_MARKER.length)

  return { problems: problemsIn(root, output), uses: uses === undefined ? [] : JSON.parse(uses) as ComponentUse[] }
}

// One line per component a Markdown entry uses, its props assigned to the type the component takes, so one missing, misspelt or of the wrong type is a type error at the entry's line.
function contentPropsCheck(root: string, configFile: string, uses: ComponentUse[]): { code: string, lines: Map<number, ComponentUse> } {
  const lines = new Map<number, ComponentUse>()

  if (uses.length === 0)
    return { code: '', lines }

  const header = [
    `import type * as kayContent from ${JSON.stringify(relative(join(root, SHADOW_DIR), configFile).replace(SCRIPT_EXTENSION, ''))}`,
    '',
    'type KayPropsOf<Component> = Component extends (props: infer Props) => unknown ? Props : never',
    '',
  ]
  // What a component wraps reaches it as `children`, which one taking none is then reported for.
  const checks = uses.map((use, index) => {
    const props = [...Object.entries(use.props).map(([name, value]) => `${IDENTIFIER.test(name) ? name : JSON.stringify(name)}: ${JSON.stringify(value)}`), ...use.children ? ['children: undefined as never'] : []]

    lines.set(header.length + 1 + index, use)

    return `export const kayProps${index}: KayPropsOf<(typeof kayContent)[${JSON.stringify(use.collection)}]['components'][${JSON.stringify(use.component)}]> = { ${props.join(', ')} }`
  })

  return { code: `${[...header, ...checks].join('\n')}\n`, lines }
}

function parseTscOutput(output: string, config: string, root: string): CheckDiagnostic[] {
  const diagnostics: CheckDiagnostic[] = []

  for (const line of output.split('\n')) {
    const match = TSC_LINE.exec(line)

    if (match) {
      diagnostics.push({ file: resolve(root, match[1]!), line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5]! })

      continue
    }

    const global = TSC_GLOBAL_LINE.exec(line)

    if (global) {
      diagnostics.push({ file: config, line: 1, column: 1, code: global[1], message: global[2]! })

      continue
    }

    const last = diagnostics.at(-1)

    if (last && line.trim() !== '')
      last.message += `\n${line}`
  }

  return diagnostics
}

// The project's tsconfig as tsgo resolves it, its extends, options and root files, or undefined when tsgo cannot read it.
async function resolvedConfig(root: string, tsconfig: string): Promise<string | undefined> {
  const child = Bun.spawn([process.execPath, TSGO, '--showConfig', '-p', tsconfig], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return code === 0 ? output : undefined
}

// The unused code the project's own tsconfig asks to be reported, in its .ts files too.
function unusedCodesOf(shown: string | undefined): Set<number> {
  if (shown === undefined)
    return new Set()

  const { compilerOptions } = JSON.parse(shown) as { compilerOptions?: { noUnusedLocals?: boolean, noUnusedParameters?: boolean } }

  return compilerOptions?.noUnusedLocals === true ? UNUSED_CODES : compilerOptions?.noUnusedParameters === true ? UNUSED_PARAMETER_CODES : new Set()
}

// Runs tsgo incrementally, or not at all when its last run was clean and nothing it read has changed since: tsgo's own incremental mode still parses every file, most of a warm run's time.
async function typecheck(root: string, tsconfig: string, shown: string | undefined): Promise<{ output: string, errors: string, code: number }> {
  const state = join(resolve(root), CHECK_STATE)
  const shadowDir = join(resolve(root), SHADOW_DIR)
  const buildInfo = join(state, 'tsbuildinfo')
  const args = ['--noEmit', '--pretty', 'false', '--noUnusedLocals', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', buildInfo]
  // The resolved config lists the root files, so one added or removed changes it as an edited option does.
  const slot = shown === undefined ? undefined : { file: join(state, 'clean.json'), key: JSON.stringify([(await Bun.file(TSGO_PACKAGE).json() as { version: string }).version, args, shown]) }
  const last = slot && await readCacheEntry<CleanRun>(slot)

  if (last && await stillClean(last, shadowDir))
    return { output: '', errors: '', code: 0 }

  const generated = await contentHashes(shadowDir)
  const started = Date.now()
  const child = Bun.spawn([process.execPath, TSGO, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const read = slot && code === 0 && output === '' && errors === '' ? await filesRead(buildInfo) : undefined

  if (slot && read)
    await writeCacheEntry(slot, { started, ...read, files: read.files.filter(file => !Object.hasOwn(generated, file)), generated } satisfies CleanRun)

  return { output, errors, code }
}

interface CleanRun {
  started: number
  // Every file the run read, packages' own included, by its times, and the package.json files it looked for and did not find.
  files: string[]
  missing: string[]
  // What kay wrote to the shadow tree just before the run, by content: it rewrites a file there on every check that changes it, too close to the run for its times to tell.
  generated: Record<string, string>
}

// What a run read, off its build info: TypeScript's own libraries are named bare there, and change only with tsgo's version.
async function filesRead(buildInfo: string): Promise<Pick<CleanRun, 'files' | 'missing'> | undefined> {
  try {
    const info = await Bun.file(buildInfo).json() as { fileNames: string[], packageJsons?: string[], missingPackageJsons?: string[] }
    const dir = dirname(buildInfo)

    return { files: [...info.fileNames.filter(name => name.includes('/')), ...info.packageJsons ?? []].map(name => resolve(dir, name)), missing: (info.missingPackageJsons ?? []).map(name => resolve(dir, name)) }
  }
  catch {
    return undefined
  }
}

async function contentHashes(dir: string): Promise<Record<string, string>> {
  const files = existsSync(dir) ? (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)) : []

  return Object.fromEntries(await Promise.all(files.map(async file => [file, Bun.hash(await Bun.file(file).bytes()).toString(36)] as const)))
}

// A file's change time moves when it is written, replaced or linked anew, which a package manager hardlinking an older file into node_modules does while keeping its modification time.
async function stillClean(run: CleanRun, shadowDir: string): Promise<boolean> {
  const unchanged = run.files.every((file) => {
    const stats = statSync(file, { throwIfNoEntry: false })

    return stats !== undefined && Math.max(stats.mtimeMs, stats.ctimeMs) < run.started - CLOCK_SLACK
  })

  if (!unchanged || run.missing.some(file => existsSync(file)))
    return false

  const hashes = Object.entries(await contentHashes(shadowDir))

  return hashes.length === Object.keys(run.generated).length && hashes.every(([file, hash]) => run.generated[file] === hash)
}

// A name kay generated, which the template reads in a way it does not spell out, rather than one the .kay file wrote.
function generatedOnly(diagnostic: CheckDiagnostic, files: Map<string, ShadowFile>): boolean {
  const shadow = files.get(diagnostic.file)!

  return !shadow.map.isExact(offsetAt(shadow.tsx, diagnostic))
}

function remap(diagnostic: CheckDiagnostic, files: Map<string, ShadowFile>): CheckDiagnostic {
  const shadow = files.get(diagnostic.file)

  if (!shadow)
    return diagnostic

  const generated = offsetAt(shadow.tsx, diagnostic)
  const source = shadow.map.toSource(generated) ?? 0
  const remapped = { ...diagnostic, file: shadow.file, ...positionAt(shadow.source, source) }

  return remapped.help === undefined && unreadSignal(diagnostic) ? { ...remapped, help: signalHelp(diagnostic, signalName(diagnostic, shadow.source, source)) } : remapped
}

// A condition always true for a function, or a signal where its value goes: what reading an imported signal, or one a prop holds, by its name gives.
function unreadSignal(diagnostic: CheckDiagnostic): boolean {
  return diagnostic.code === ALWAYS_DEFINED || diagnostic.message.includes('\'Signal<')
}

// The signal the error is about where its position tells: the condition itself, or what a missing property was read on.
function signalName(diagnostic: CheckDiagnostic, source: string, offset: number): string | undefined {
  if (diagnostic.code === ALWAYS_DEFINED)
    return LEADING_NAME.exec(source.slice(offset))?.[0]

  return diagnostic.code === MISSING_PROPERTY ? MEMBER_OF.exec(source.slice(0, offset))?.[1] : undefined
}

// A condition on any function is always true, a signal's or another's, so its help says so before naming signals.
function signalHelp(diagnostic: CheckDiagnostic, name: string | undefined): string {
  const call = name === undefined ? 'calling it' : `calling it, \`${name}()\``

  return diagnostic.code === ALWAYS_DEFINED ? `a function is always true here, so its value is read by ${call}: only a signal or memo the script declares reads by its name` : `only a signal or memo the script declares reads by its name; one imported or held by a prop is read by ${call}`
}

// With a code frame when the file's source is given.
export function formatCheckDiagnostic(diagnostic: CheckDiagnostic, source?: string, paint?: Paint): string {
  const start = source === undefined ? 0 : offsetAt(source, diagnostic)
  const frame = source === undefined ? undefined : { source, start, end: diagnostic.end ?? start + 1 }

  return formatReport({ ...diagnostic, file: relative(process.cwd(), diagnostic.file), frame }, paint)
}

// A lint or a level `lints` names that kay does not have, which would otherwise pass unnoticed.
function lintConfigProblems(root: string, lints: Record<string, string> = {}): CheckDiagnostic[] {
  const at = { file: join(root, CONFIG_FILE), line: 1, column: 1 }

  return Object.entries(lints).flatMap(([name, level]) => {
    if (!isLint(name))
      return [{ ...at, message: `\`lints\` names \`${name}\`, which is no lint`, help: '`kay explain` lists them' }]

    return LEVELS.has(level) ? [] : [{ ...at, message: `The lint \`${name}\` is set to \`${level}\`, which is no level`, help: 'set it to `allow`, `warn` or `deny`' }]
  })
}

function fromCompile(file: string, source: string, { start, end, message, label, related, note, help, code, severity, fixes, checkOnly }: Diagnostic): CheckDiagnostic {
  return { file, ...positionAt(source, start), end, message, label, related, note, help, code, severity, fixes, checkOnly }
}

// Applies the first safe fix of each problem in the project's own files to its file, leaving out one whose edits overlap another's, and answers how many problems that fixed. A library's files are its own to fix.
export async function applySafeFixes(root: string, diagnostics: CheckDiagnostic[]): Promise<number> {
  const byFile = Map.groupBy(diagnostics.flatMap((diagnostic) => {
    const fix = diagnostic.fixes?.find(candidate => candidate.safe)

    return fix && ownFile(root, diagnostic.file) ? [{ file: diagnostic.file, fix }] : []
  }), found => found.file)
  let fixed = 0

  for (const [file, found] of byFile) {
    const taken: Fix['edits'] = []

    for (const { fix } of found) {
      if (fix.edits.some(edit => taken.some(other => edit.start < other.end && other.start < edit.end)))
        continue

      taken.push(...fix.edits)
      fixed++
    }

    const source = await Bun.file(file).text()

    await Bun.write(file, taken.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source))
  }

  return fixed
}
