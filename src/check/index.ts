import type { KayLibrary, SettingsReplacement } from '../build/libraries'
import type { Diagnostic, SourceMap } from '../compiler'
import type { I18nConfig } from '../config'
import type { ContentProblem } from '../content/validate'
import type { LocaleSettings } from '../runtime/i18n'
import type { ApiModule } from '../server/api'
import type { Redirects } from '../server/redirects'
import type { Route } from '../server/routes'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ASSET_EXTENSIONS } from '../build/assets'
import { findKayFiles, writeIfChanged } from '../build/files'
import { iconTypes } from '../build/icons'
import { findKayLibraries, libraryOf, reachableLibraryFiles, settingsReplacements, throughNodeModules } from '../build/libraries'
import { compileKay, componentName } from '../compiler'
import { codeFrame } from '../compiler/frame'
import { offsetAt, positionAt } from '../compiler/mapping'
import { CONFIG_FILE } from '../config'
import { CONTENT_CONFIG, PROBLEMS_MARKER } from '../content/server'
import * as builtInMatchers from '../runtime/params'
import { scanApi } from '../server/api'
import { FAVICON_PATHS } from '../server/favicon'
import { localeSettings, messagesFile } from '../server/i18n'
import { HEALTH_PATH } from '../server/lifecycle'
import { matcherFile } from '../server/params'
import { publicFiles } from '../server/public'
import { redirectProblems } from '../server/redirects'
import { patternShapes, routeOf, scanRoutes } from '../server/routes'
import { ROBOTS, SITEMAP } from '../server/sitemap'
import { bootProblems } from './boot'
import { islandOnlyComponents } from './island-only'

export const SHADOW_DIR = join('.kay', 'types')
const KAY_FILE = /\.kay$/
const SETTINGS_CHECK = 'kay-settings.ts'
const EXPORTS_CHECK = 'kay-exports.ts'
const TSX_EXTENSION = /\.tsx$/
const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/
const CONTENT_PROBLEMS = fileURLToPath(new URL('../content/problems.ts', import.meta.url))
const MESSAGE_PROBLEMS = fileURLToPath(new URL('./messages.ts', import.meta.url))

export interface CheckOptions {
  tsconfig?: string
  // Page directory relative to the root, so `ctx.params` is typed per route.
  routes?: string
  // Public file directory relative to the root, whose files links may point at.
  publicDir?: string
  // API directory relative to the root, whose modules' GET routes links may point at.
  api?: string
  // The app's own modules for its libraries' settings, checked against the defaults they replace.
  settings?: Record<string, string>
  // The content config relative to the root, whose collections' entries are read against their schemas.
  content?: string
  // The config's redirects, whose targets on the site must be a page or a public file.
  redirects?: Redirects
  // Where the site is mounted, the origin it is public at and how long a stopping server waits, which the server refuses at boot when it cannot read them.
  base?: string
  site?: string
  shutdownTimeout?: number
  // The config's locales: links may carry their prefixes, `t()` reads the default locale's messages, and every other locale's must match them.
  i18n?: I18nConfig
}

export interface CheckDiagnostic {
  file: string
  line: number
  column: number
  message: string
  code?: string
  // Found by type checking only, so the file's type errors are still reported.
  checkOnly?: boolean
}

export interface ShadowFile {
  source: string
  file: string
  tsx: string
  map: SourceMap
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/
// An error about the whole run, such as a tsconfig that does not exist.
const TSC_GLOBAL_LINE = /^error (TS\d+): (.*)$/
const UNWRITABLE = /[%?#]/
const TS_EXTENSION = /\.ts$/
// What a browser percent-encodes in a path it is given: spaces, controls and anything outside ASCII.
const NOT_IN_URL = /[^\x21-\x7E]+/g
// Stylesheets import for their effect, other assets for their URL. TypeScript matches a wildcard module case-sensitively, so both `.png` and `.PNG` are declared; a mixed case such as `.Png` is not.
const ASSET_TYPES = ['declare module \'*.css\' {}\n', ...ASSET_EXTENSIONS.flatMap(extension => [extension, extension.toUpperCase()]).map(extension => `declare module '*.${extension}' {\n  const url: string\n  export default url\n}\n`)].join('\n')

export const TSGO = join(dirname(fileURLToPath(import.meta.resolve('@typescript/native-preview/package.json'))), 'bin', 'tsgo')

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
  const own = await findKayFiles(root, { project: true, ownOnly: true })
  const sources = new Map(await Promise.all(own.map(async file => [file, await Bun.file(file).text()] as const)))
  const islandOnly = await islandOnlyComponents(root, routesDir, own, sources)

  for (const file of own) {
    const source = sources.get(file)!
    const { shadow, diagnostics: compileDiagnostics } = compileShadow(root, routesDir, file, source, islandOnly.has(file))
    const path = shadowPath(root, file)

    await writeIfChanged(path, shadow.tsx)
    files.set(path, shadow)
    for (const diagnostic of compileDiagnostics)
      diagnostics.push({ file, ...positionAt(source, diagnostic.start), message: diagnostic.message, checkOnly: diagnostic.checkOnly })
  }

  const [routes, publicPaths, apiModules] = await Promise.all([scanRoutes(routesDir), publicFiles(resolve(root, options.publicDir ?? 'public')), apiModulesOf(resolve(root, options.api ?? 'src/api'), diagnostics)])

  const shapes = routes.flatMap(route => patternShapes(route.pattern))
  const settings = options.i18n && i18nSettings(root, options.i18n, diagnostics)
  // A page is reached in every locale, under its prefix where it has one; an unprefixed path still answers, sending the visitor on to theirs when every locale is prefixed.
  const prefixes = settings && !settings.hosts ? settings.locales.filter(locale => locale !== settings.defaultLocale || settings.prefixDefault) : []
  const localized = [...shapes, ...prefixes.flatMap(locale => shapes.map(shape => `/${locale}${shape === '/' ? '' : shape}`))]

  const apiMounts = apiModules.map(module => ({ mount: module.mount, module: relative(dirname(environmentPath), module.file).replace(TS_EXTENSION, '') }))

  await writeIfChanged(environmentPath, environment(localized, publicPaths.map(file => file.url), apiMounts, settings && options.i18n && { locales: options.i18n.locales, messages: relative(dirname(environmentPath), messagesFile(root, options.i18n, options.i18n.defaultLocale)).replace(TS_EXTENSION, '') }))

  // What kay serves itself counts as served, whether or not the project turns it on.
  const served = [...routes.flatMap(route => patternShapes(route.pattern)), ...publicPaths.map(file => file.url), SITEMAP, ROBOTS, ...FAVICON_PATHS, HEALTH_PATH]

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
    const { shadow, diagnostics: compileDiagnostics } = compileShadow(root, routesDir, file, source)
    const path = shadowPath(root, file)

    await writeIfChanged(path, shadow.tsx)
    files.set(path, shadow)

    if (!reached.has(file)) {
      unreached.add(file)

      return
    }

    for (const diagnostic of compileDiagnostics)
      diagnostics.push({ file, ...positionAt(source, diagnostic.start), message: diagnostic.message, checkOnly: diagnostic.checkOnly })
  }))

  await writeIfChanged(packagesPath, packageTypes(root, libraries))

  const replaced = settingsCheck(root, options.settings ?? {}, diagnostics)
  const exported = exportsCheck(root, routesDir, routes, apiModules)

  await writeIfChanged(settingsPath, replaced.code)
  await writeIfChanged(exportsPath, exported.code)

  // Rewriting in place keeps every shadow file present for editors reading the tree meanwhile; only stale ones go.
  const stale = (await readdir(join(root, SHADOW_DIR), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => path !== environmentPath && path !== assetsPath && path !== iconsPath && path !== packagesPath && path !== settingsPath && path !== exportsPath && !files.has(path))

  await Promise.all(stale.map(async path => rm(path)))

  return { files, diagnostics, unreached, libraries, settings: replaced.lines, exports: exported.lines, islandOnly }
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

export function shadowPath(root: string, file: string): string {
  return join(root, SHADOW_DIR, `${relative(root, file)}.tsx`)
}

// Compiles one .kay file for type checking, its route params typed when it is a page under `routesDir`; `insideIsland` for a static component only islands render.
export function compileShadow(root: string, routesDir: string, file: string, source: string, insideIsland = false): { shadow: ShadowFile, diagnostics: Diagnostic[] } {
  const route = file.startsWith(routesDir + sep) ? routeOf(routesDir, file) : undefined
  const shadowDir = dirname(shadowPath(root, file))
  // rootDirs only merges paths inside the project, so an import reaching outside it is pointed there from the shadow file.
  const relocateImport = (specifier: string) => {
    if (!specifier.startsWith('.'))
      return undefined

    const target = resolve(dirname(file), specifier)

    return target.startsWith(root + sep) ? undefined : relative(shadowDir, target)
  }
  const { tsx, map, diagnostics } = compileKay(source, file, { root, params: route?.params, paramTypes: route && paramTypesOf(routesDir, shadowDir, route), check: true, insideIsland, relocateImport })
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
function matcherSource(routesDir: string, matcher: string): string | undefined {
  const file = matcherFile(routesDir, matcher)

  if (existsSync(file))
    return file

  return Object.hasOwn(builtInMatchers, matcher) ? 'kay' : undefined
}

// Declares the check-only helpers generated code calls, and the routes and public files links are checked against.
function environment(patterns: string[], files: string[], api: { mount: string, module: string }[], i18n?: { locales: string[], messages: string }): string {
  const routes = patterns.length > 0 ? patterns.map(routeTuple).join(' | ') : 'never'
  const paths = files.length > 0 ? files.flatMap(spellings).map(file => JSON.stringify(file)).join(' | ') : 'never'
  const locales = i18n ? `, locales: ${i18n.locales.map(locale => JSON.stringify(locale)).join(' | ')}, messages: typeof import(${importSpecifier(i18n.messages)}).default` : ''
  const modules = api.length > 0 ? `, api: ${apiTree(api)}` : ''

  return [
    'import type { Action, ApiRoutesOf, CheckedHref, ChildrenProp, FieldName, FunctionProp, IslandProp } from \'kay\'',
    '',
    'declare module \'kay\' {',
    `  interface Register { routes: ${routes}, files: ${paths}${locales}${modules} }`,
    '}',
    '',
    'declare global {',
    '  function KayHref<const Href extends string>(href: Href & CheckedHref<Href>): string',
    '  function KayField<Target extends string | Action<never, unknown>>(target: Target, name: FieldName<Target>): string',
    '  function KayProp<Component>(component: Component): <Value>(value: Value & IslandProp<Component, Value>) => Value',
    '  function KayFunctionProp<Component>(component: Component): (attribute: FunctionProp<Component>) => Record<never, never>',
    '  function KayChildren<Component>(component: Component): (children: ChildrenProp<Component>) => Record<never, never>',
    '}',
    '',
  ].join('\n')
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

// `/todos/:id` becomes `['todos', ':']`, the shape `CheckedHref` matches paths against segment by segment.
function routeTuple(pattern: string): string {
  const segments = pattern.split('/').filter(segment => segment !== '').map(segment => segment.startsWith(':') ? [':'] : spellings(segment))

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
  const settingsFile = join(resolve(root), SHADOW_DIR, SETTINGS_CHECK)
  const exportsFile = join(resolve(root), SHADOW_DIR, EXPORTS_CHECK)
  const child = Bun.spawn([process.execPath, TSGO, '--noEmit', '--pretty', 'false', '-p', tsconfig], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code, content, messages, boot] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited, checkContent(root, options.content, options.site !== undefined), checkMessages(root, options.i18n), bootProblems(resolve(root), options)])
  const config = resolve(root, tsconfig)
  const reported = parseTscOutput(output, config, root)
  // A file that did not compile has its errors already; what TypeScript makes of the code compiled around them would only add noise.
  const broken = new Set(diagnostics.filter(diagnostic => !diagnostic.checkOnly).map(diagnostic => diagnostic.file))
  // A library's own modules are its to check, as `skipLibCheck` leaves a declaration file's, a missing optional peer included: only its components compile as the app's. An app inside a linked library's repository keeps its own files.
  const libraryModule = (file: string) => !KAY_FILE.test(file) && libraryOf(libraries, file) !== undefined && !ownFile(root, file)

  if (errors.trim() !== '')
    diagnostics.push({ file: config, line: 1, column: 1, message: errors.trim() })

  for (const diagnostic of reported) {
    const remapped = remap(diagnostic, files)
    const setting = remapped.file === settingsFile ? settings.get(remapped.line) : undefined
    const exported = remapped.file === exportsFile ? exports.get(remapped.line) : undefined

    if (setting)
      diagnostics.push({ file: setting.file, line: 1, column: 1, code: remapped.code, message: `The settings for ${setting.library} do not match what it takes: ${remapped.message}` })
    else if (exported)
      diagnostics.push({ file: exported.file, line: 1, column: 1, code: remapped.code, message: `It must export ${exported.wanted}: ${remapped.message}` })
    else if (!broken.has(remapped.file) && !unreached.has(remapped.file) && !libraryModule(remapped.file))
      diagnostics.push(remapped)
  }

  diagnostics.push(...content, ...messages, ...boot)

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
async function checkContent(root: string, config: string | undefined, site: boolean): Promise<CheckDiagnostic[]> {
  if (config === undefined && !existsSync(resolve(root, CONTENT_CONFIG)))
    return []

  const child = Bun.spawn([process.execPath, CONTENT_PROBLEMS, resolve(root), config ?? '', site ? 'site' : ''], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    return [{ file: resolve(root, config ?? CONTENT_CONFIG), line: 1, column: 1, message: errors.trim() || `reading the collections exited with code ${code}` }]

  return problemsIn(root, output)
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

function remap(diagnostic: CheckDiagnostic, files: Map<string, ShadowFile>): CheckDiagnostic {
  const shadow = files.get(diagnostic.file)

  if (!shadow)
    return diagnostic

  const generated = offsetAt(shadow.tsx, diagnostic)
  const source = shadow.map.toSource(generated) ?? 0

  return { ...diagnostic, file: shadow.file, ...positionAt(shadow.source, source) }
}

// Followed by a code frame when the file's source is given.
export function formatCheckDiagnostic(diagnostic: CheckDiagnostic, source?: string): string {
  const code = diagnostic.code ? ` ${diagnostic.code}` : ''
  const heading = `${relative(process.cwd(), diagnostic.file)}:${diagnostic.line}:${diagnostic.column} - error${code}: ${diagnostic.message}`

  return source === undefined ? heading : `${heading}\n${codeFrame(source, offsetAt(source, diagnostic))}`
}
