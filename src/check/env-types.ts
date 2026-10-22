// The declarations kay writes to the shadow tree for what types cannot find on their own: the routes and files links point at, the app's messages, API and locals, the assets imports name and each library's components.
import type { CheckOptions } from '.'
import type { KayLibrary } from '../build/libraries'
import type { Route } from '../server/routes'
import type { ServedProject } from './shadow-types'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { ASSET_EXTENSIONS } from '../build/assets'
import { TS_FILE, TSX_FILE } from '../build/files'
import { componentName } from '../compiler'
import { CONFIG_FILE, serverExtensions } from '../config'
import { projectPaths } from '../project'
import { apiPathOf, OPENAPI_PATH, openApiPaths, REFERENCE_PATH } from '../server/api-modules'
import { publicEnvFiles } from '../server/env-state'
import { FAVICON_PATHS } from '../server/favicon'
import { DEFAULT_LANG, extensionMessageFiles, localePattern, localePrefixes, messagesFile } from '../server/i18n'
import { HEALTH_PATH } from '../server/lifecycle'
import { NOT_FOUND_FILE } from '../server/not-found'
import { patternShapes } from '../server/routes'
import { readRuntimeRedirects } from '../server/runtime-redirects'
import { ROBOTS, SITEMAP } from '../server/site-paths'
import { matcherSource, shadowPath } from './shadow'

const PARAM_SEGMENT = /:([^/]+)/g
const CATCH_ALL = /\/\*$/
// A redirect's `:name` segment, whole.
const REDIRECT_PARAM = /(?<=\/):[^/]+(?=\/|$)/g

// The manifests of the locales reading a name or description of their own, served beside the default one.
const LOCALE_MANIFESTS = `\`/manifest.\${string}.webmanifest\``

// What kay serves itself, whether or not the project turns it on.
const KAY_PATHS = [SITEMAP, ROBOTS, ...FAVICON_PATHS, HEALTH_PATH]

// The paths of the OpenAPI document and its reference page, where `openapi` moved them; an invalid path is the boot's to refuse, so the defaults stand for it here.
function openApiServed(openapi: CheckOptions['openapi'], apiPath: string | undefined): string[] {
  try {
    const { document, reference } = openApiPaths(typeof openapi === 'object' ? openapi : undefined, apiPathOf(apiPath))

    return [document, reference]
  }
  catch {
    return [OPENAPI_PATH, REFERENCE_PATH]
  }
}

export function kayPaths(options: CheckOptions): string[] {
  return [...KAY_PATHS, ...openApiServed(options.openapi, options.apiPath)]
}
const UNWRITABLE = /[%?#]/
// What a browser percent-encodes in a path it is given: spaces, controls and anything outside ASCII.
const NOT_IN_URL = /[^\x21-\x7E]+/g

// Stylesheets import for their effect, or for their text `with { type: 'text' }`, other assets for their URL. TypeScript matches a wildcard module case-sensitively, so both `.png` and `.PNG` are declared; a mixed case such as `.Png` is not.
export const ASSET_TYPES = ['declare module \'*.css\' {\n  const text: string\n  export default text\n}\n', ...ASSET_EXTENSIONS.flatMap(extension => [extension, extension.toUpperCase()]).map(extension => `declare module '*.${extension}' {\n  const url: string\n  export default url\n}\n`)].join('\n')

// Each component a library exports, typed as the module its specifier names, with the named exports (actions, `page`) the file declares: rootDirs merges relative imports only, so a package's `.kay` files reach the app through these.
export function packageTypes(root: string, libraries: KayLibrary[]): string {
  const shadowDir = projectPaths(root).types

  return libraries.flatMap(library => [...library.specifiers].map(([specifier, file]) => {
    const shadow = relative(shadowDir, shadowPath(root, file)).replace(TSX_FILE, '')

    const name = componentName(file)

    // Named after the component, which is what auto-import offers it as.
    return `declare module ${JSON.stringify(specifier)} {\n  const ${name}: typeof import(${JSON.stringify(`./${shadow}`)}).default\n  export default ${name}\n  export * from ${JSON.stringify(`./${shadow}`)}\n}\n`
  })).join('\n')
}

// The routes and files links point at, the app's messages, API modules, locals and public env, and the collections' feeds, declared from what the project serves.
export async function environmentTypes(root: string, options: CheckOptions, served: ServedProject): Promise<string> {
  const paths = projectPaths(root, options)
  const { routes, publicPaths, apiModules, endpoints, settings } = served
  const shadowDir = paths.types
  // A param a matcher kay ships checks is named after it, `:integer`, so a link filling it with a literal is checked as the matcher would; any other is `:`.
  const shapesOf = (route: Route, pattern: string) => patternShapes(pattern).map(shape => shape.replace(PARAM_SEGMENT, (_, name: string) => {
    const matcher = route.matchers?.[name]

    return matcher !== undefined && matcherSource(paths.routes, matcher) === 'kay' ? `:${matcher}` : ':'
  }))
  // A page is reached in every locale at the path the locale gives it, under its prefix where it has one; an unprefixed path still answers, sending the visitor on to theirs when every locale is prefixed.
  const prefixes = settings ? localePrefixes(settings) : []
  const localized = settings
    ? [...new Set([
      ...settings.prefixDefault ? routes.flatMap(route => shapesOf(route, route.pattern)) : [],
      ...settings.locales.flatMap(locale => routes.flatMap(route => shapesOf(route, localePattern(settings, route.pattern, locale)).map(shape => prefixes.includes(locale) ? `/${locale}${shape === '/' ? '' : shape}` : shape))),
    ])]
    : routes.flatMap(route => shapesOf(route, route.pattern))
  // A redirect's source is a path a visitor reaches as a page's is, at the path as written whatever the locale; its params match any segment, no matcher checks them.
  const sources = [...Object.keys(options.redirects ?? {}), ...readRuntimeRedirects(join(root, NOT_FOUND_FILE)).map(({ from }) => from)].map(source => source.replace(REDIRECT_PARAM, ':'))
  const reachable = localized.length > 0 ? [...new Set([...localized, ...sources])] : localized
  const modulePath = (file: string) => relative(shadowDir, file).replace(TS_FILE, '')
  const apiMounts = apiModules.map(module => ({ mount: module.mount, module: modulePath(module.file) }))
  const config = existsSync(join(root, CONFIG_FILE)) ? modulePath(join(root, CONFIG_FILE)) : undefined
  const app = await exportsApp(paths.entry) ? modulePath(paths.entry) : undefined
  const serverExts = serverExtensions(root, options.extensions)
  const servers = serverExts.some(extension => extension.server !== undefined || extension.serverModule !== undefined)
  // The modules extensions take their server plugin from, which the check types the locals off, skipping one that does not resolve (the build reports it).
  const serverModules = serverExts.flatMap(({ serverModule }) => {
    if (serverModule === undefined)
      return []

    try {
      return [{ module: modulePath(Bun.resolveSync(resolve(root, serverModule.path), root)), name: serverModule.export ?? 'default' }]
    }
    catch {
      return []
    }
  })
  const content = existsSync(paths.content) ? modulePath(paths.content) : undefined
  // `t()` reads the default locale's catalogs, or without `i18n` the site's one language's, when it has any.
  const textLocale = options.i18n?.defaultLocale ?? options.lang ?? DEFAULT_LANG
  const catalogs = [...extensionMessageFiles(root, options.extensions, textLocale), messagesFile(root, options.i18n ?? {}, textLocale)].filter(file => existsSync(file)).map(modulePath)
  const singleLanguage = catalogs.length > 0 ? { locales: [textLocale], prefixes: [], messages: catalogs } : undefined
  const texts = options.i18n ? settings && { locales: options.i18n.locales, prefixes, messages: catalogs } : singleLanguage
  // An endpoint with params is linked to as a template: `/feeds/${string}.json`.
  const endpointPaths = endpoints.map(endpoint => endpoint.params.length === 0 ? JSON.stringify(endpoint.pattern) : `\`${endpoint.pattern.replace(PARAM_SEGMENT, () => `\${string}`)}${endpoint.suffix ?? ''}\``)

  // What `route()` takes: each page as its file names it, a catch-all as `*name`.
  const named = [...new Set(routes.map(route => route.catchAll === undefined ? route.pattern : route.pattern.replace(CATCH_ALL, `/*${route.catchAll}`)))]

  // The modules declaring a `s.Public` field, whose `defineEnv` results carry the type of what an island reads.
  const publicModules = publicEnvFiles(root).filter(file => file.endsWith('.ts')).map(file => modulePath(join(root, file)))

  return environment(reachable, [...publicPaths.map(file => file.url), ...kayPaths(options)], apiMounts, texts, config, app, content, servers, serverModules, [...endpointPaths, LOCALE_MANIFESTS], named, publicModules)
}

// Declares the check-only helpers generated code calls, and the routes and public files links are checked against.
function environment(patterns: string[], files: string[], api: { mount: string, module: string }[], i18n?: { locales: string[], prefixes: string[], messages: string[] }, config?: string, app?: string, content?: string, servers = false, serverModules: { module: string, name: string }[] = [], endpoints: string[] = [], named: string[] = [], publicModules: string[] = []): string {
  const routes = patterns.length > 0 ? patterns.map(routeTuple).join(' | ') : 'never'
  // The collections' feeds are served as files are, a localized one's under each locale's prefix too.
  const feed = content === undefined ? undefined : `FeedPathsOf<typeof import(${importSpecifier(content)})>`
  const prefixes = i18n?.prefixes.map(locale => JSON.stringify(`/${locale}`)).join(' | ')
  const feeds = feed === undefined ? [] : [feed, ...prefixes === undefined || prefixes === '' ? [] : [`\`\${${prefixes}}\${${feed}}\``]]
  const paths = [...files.flatMap(spellings).map(file => JSON.stringify(file)), ...feeds, ...endpoints].join(' | ') || 'never'
  // The app's catalog laid over its extensions', key by key.
  const messages = i18n?.messages.length === 0 ? '{}' : i18n?.messages.map(file => `typeof import(${importSpecifier(file)}).default`).reduce((under, over) => `MergeMessages<${under}, ${over}>`)
  const locales = i18n ? `, locales: ${i18n.locales.map(locale => JSON.stringify(locale)).join(' | ')}, messages: ${messages}` : ''
  const pageNames = named.length > 0 ? `, patterns: ${named.map(pattern => JSON.stringify(pattern)).join(' | ')}` : ''
  const modules = api.length > 0 ? `, api: ${apiTree(api)}` : ''
  const publicTypes = [...config === undefined ? [] : [`PublicEnvOf<typeof import(${importSpecifier(config)}).default>`], ...publicModules.map(file => `PublicFieldsOfModule<typeof import(${importSpecifier(file)})>`)]
  const publicEnv = publicTypes.length === 0 ? '' : `, publicEnv: ${publicTypes.join(' & ')}`
  const inferred = [
    ...app === undefined ? [] : [`app: typeof import(${importSpecifier(app)}).app`, `locals: LocalsOf<typeof import(${importSpecifier(app)}).app>`],
    ...servers ? [`extensions: ${[...config === undefined ? [] : [`ExtensionServersOf<typeof import(${importSpecifier(config)}).default>`], ...serverModules.map(({ module, name }) => `ServerOfModule<typeof import(${importSpecifier(module)}), ${JSON.stringify(name)}>`)].join(' | ') || 'never'}`] : [],
  ]

  return [
    'import type { Action, ApiRoutesOf, BoundProp, BoundValue, CheckedHref, CheckedHtml, ExtensionServersOf, FieldName, FunctionProp, HandedSignal, IslandProp, PlainIslandProp, LocalsOf, PublicEnvOf, PublicFieldsOfModule, ServerOfModule, Signal, Truthy, Unmatched, UnresolvedParameter } from \'kay\'',
    ...content === undefined ? [] : ['import type { FeedPathsOf } from \'kay/content\''],
    ...(i18n?.messages.length ?? 0) > 1 ? ['import type { MergeMessages } from \'kay/i18n\''] : [],
    '',
    'declare module \'kay\' {',
    `  interface Register { routes: ${routes}, files: ${paths}${locales}${pageNames}${modules}${publicEnv} }`,
    ...inferred.length === 0 ? [] : [`  interface Inferred { ${inferred.join(', ')} }`],
    '}',
    '',
    'declare global {',
    '  function KayHref<const Href extends string>(href: Href & CheckedHref<Href>): string',
    '  function KayHtml<const Markup>(markup: Markup & CheckedHtml<Markup>): Markup',
    '  function KayField<Target extends string | Action<never, unknown>>(target: Target, name: FieldName<Target>): string',
    '  function KayFormError<Target extends string | Action<never, unknown>>(target: Target, field?: FieldName<Target>): null',
    '  function KayProp<Component>(component: Component): <Value>(value: Value & IslandProp<Component, Value>) => Value',
    '  function KayPlainProp<Component>(component: Component): <Value>(value: Value & PlainIslandProp<Component, Value>) => Value',
    '  function KayFunctionProp<Component>(component: Component): (attribute: FunctionProp<Component>) => Record<never, never>',
    '  function KayBound<Component>(component: Component): <Key extends string, Value>(key: Key & BoundProp<Component, Key>, value: Value, write: (value: BoundValue<Component, Key>) => unknown) => Value',
    '  function KayRow<Item>(each: readonly Item[] | null | undefined | false): Item',
    '  function KayTruthy<Value>(value: Value): Truthy<Value>',
    '  function KayUnmatched<Rest>(rest: Rest & Unmatched<Rest>): void',
    '  function KayHanded<Parameter = UnresolvedParameter, Handed = unknown>(signal: Handed & HandedSignal<Parameter>): [Parameter] extends [unknown] ? Handed : Parameter',
    '  function KayWritable<Written extends Signal<any>>(signal: Written): Written',
    '  function KayDefault<Value, Fallback>(value: Value, fallback: () => Fallback): Exclude<Value, undefined> | Fallback',
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
