import type { ClientOptions } from './build/client'
import type { KayConfig, LoadedConfig } from './config'
import type { RenderOptions } from './server/render'
import type { SeoHead } from './server/seo'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { clientDir, KAY_DIR, outputDir, testWorker, underKayDev } from './build/assets'
import { TSCONFIG } from './build/files'
import { pickConfig } from './config'
import { renamedKeys } from './config-shape'
import { isFrench } from './runtime/french'
import { IMAGE_WIDTHS, parseWidths } from './runtime/image'
import { basePath } from './server/base'
import { linkSchemes } from './server/link-schemes'

// The content collections' config, when `content` names no other file.
export const CONTENT_CONFIG = 'src/content.config.ts'

// The shadow tree `kay check`, `kay dev`, the LSP and eslint type the `.kay` files through, under the root.
export const SHADOW_DIR = join(KAY_DIR, 'types')

// What the shadow tree was last compiled with, for tools that compile one file at a time without reading kay.config.ts.
export const SHADOW_SETTINGS = 'kay-shadow.json'

// The directory the public files are served from, as the shadow tree was last written with it, read without loading the checker.
export function savedPublicDir(root: string): string {
  try {
    const { public: saved } = JSON.parse(readFileSync(join(projectPaths(root).types, SHADOW_SETTINGS), 'utf8')) as { public?: string }

    return resolve(root, saved ?? projectPaths(root).public)
  }
  catch {
    return projectPaths(root).public
  }
}

// Where a project keeps each of its parts, as absolute paths: kay's defaults are written here alone.
export interface ProjectPaths {
  root: string
  routes: string
  public: string
  api: string
  // The server entry `kay dev`, `kay check` and `kay build --compile` start from.
  entry: string
  content: string
  // Under `.kay`: what compiling the project keeps between runs, the executable's generated entry, the browser build with the directory it serves, the shadow tree, the class names kay collects for Tailwind (at the path an app's own `@source` line may name, but for each test worker's), the components tests mount and the last build's report.
  cache: string
  compile: string
  output: string
  client: string
  types: string
  classes: string
  tests: string
  // The sizes the last successful `kay build` printed, for the next one to show its change against.
  report: string
}

export function projectPaths(root: string, config: Pick<KayConfig, 'routesDir' | 'publicDir' | 'apiDir' | 'contentConfig' | 'entry'> = {}): ProjectPaths {
  const absolute = resolve(root)

  return {
    root: absolute,
    routes: resolve(absolute, config.routesDir ?? 'src/routes'),
    public: resolve(absolute, config.publicDir ?? 'public'),
    api: resolve(absolute, config.apiDir ?? 'src/api'),
    entry: resolve(absolute, config.entry ?? 'src/server.ts'),
    content: resolve(absolute, config.contentConfig ?? CONTENT_CONFIG),
    cache: join(absolute, KAY_DIR, 'cache'),
    compile: join(absolute, KAY_DIR, 'compile'),
    output: outputDir(absolute),
    client: clientDir(absolute),
    types: join(absolute, SHADOW_DIR),
    classes: join(absolute, KAY_DIR, `classes${testWorker()}.txt`),
    tests: join(absolute, KAY_DIR, 'test'),
    report: join(absolute, KAY_DIR, `report${testWorker()}.json`),
  }
}

// The project a file belongs to: the nearest directory holding a tsconfig.json, which is where `kay check` runs, looked for up to `within` (an editor's workspace), else the file's own directory.
export function projectRootOf(file: string, within?: string): string {
  const inside = (dir: string) => within === undefined || dir === within || dir.startsWith(within + sep)

  for (let dir = dirname(file); inside(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, TSCONFIG)))
      return dir

    if (dir === dirname(dir))
      break
  }

  return within ?? dirname(file)
}

// A directory of the cache under `.kay`, by name.
export function cacheDir(root: string, ...names: string[]): string {
  return join(projectPaths(root).cache, ...names)
}

// The keys of the config the browser build takes as written, which `clientOptionsOf` passes on; `ClientOptions` declares the rest.
export const CLIENT_CONFIG = [
  'plugins',
  // Page directory relative to the root: its pages and layouts are where stylesheets are gathered from.
  'routesDir',
  // The libraries whose routes the app mounts, built as its own pages are.
  'extensions',
  // API directory relative to the root: an island importing a module there, or under an extension's, gets where its routes are served, not its code.
  'apiDir',
  // Where the API is mounted, `/api` by default: the stubs an island imports hold it.
  'apiPath',
  // The app's own modules for its libraries' settings, as `kay.config.ts` gives them.
  'librarySettings',
  // Swaps pages in place: the entry is built whether or not any component is interactive, for the pages posting forms to actions.
  'navigation',
  // How far ahead of the viewport an island marked `hydrate="visible"` starts to hydrate, and a deferred server island starts to load, as CSS root margins; `200px` and `100% 0px` by default.
  'hydration',
  // Every page loads the whole stylesheet, so the build has no class to warn of.
  'lateStyles',
  // A page opened from a search hit marks the words searched for.
  'search',
  // The self-hosted fonts: each family is followed by a metric-matched fallback in the stylesheets' font stacks.
  'fonts',
  // The level of each lint the dev tool shows in development.
  'lints',
] as const satisfies readonly (keyof KayConfig)[]

export type ClientConfigKey = (typeof CLIENT_CONFIG)[number]

// How a server runs. In development it shows errors with their stack and maps and swaps islands; prebuilt, it serves the browser build `kay build` wrote rather than bundling one; under `kay dev`, each element carries its source for the inspector.
export interface Mode {
  dev: boolean
  prebuilt: boolean
  underKayDev: boolean
  // Whether the dev tool's data, UI, jobs and other routes answer: under `kay dev`, or when the code passed `dev: true` itself, never because `NODE_ENV` says development.
  devRoutes: boolean
}

// What `kay build` and the executable it compiles run as.
export const PRODUCTION: Mode = { dev: false, prebuilt: true, underKayDev: false, devRoutes: false }

// The mode a server takes from its options, or else from `NODE_ENV` and `kay dev`.
export function modeOf(options: { dev?: boolean | undefined, prebuilt?: boolean | undefined } = {}): Mode {
  const dev = options.dev ?? process.env.NODE_ENV === 'development'

  return { dev, prebuilt: options.prebuilt ?? process.env.NODE_ENV === 'production', underKayDev: underKayDev(), devRoutes: dev && (underKayDev() || options.dev === true) }
}

// Whether pages register the service worker: never in development, which serves one unregistering itself instead.
export function offlineOf(config: Pick<KayConfig, 'offline'>, mode: Pick<Mode, 'dev'>): boolean {
  return config.offline !== undefined && config.offline !== false && !mode.dev
}

// Whether the config lists `push()`, whose worker handles pushes and is registered in every mode.
export function pushListed(config: Pick<KayConfig, 'extensions'>): boolean {
  return config.extensions?.some(extension => extension.name === 'kay/push') === true
}

// Whether pages register kay's service worker: `offlineOf`, or a site with `push()`.
export function registersWorker(config: Pick<KayConfig, 'offline' | 'extensions'>, mode: Pick<Mode, 'dev'>): boolean {
  return offlineOf(config, mode) || pushListed(config)
}

// The keys of the config every page renders with as written, which `renderOptionsOf` passes on; `RenderOptions` declares the rest.
export const RENDER_CONFIG = [
  'lang',
  'prefetch',
  // Where the API is mounted, which pages are never prefetched under.
  'apiPath',
  'onError',
  // Whether pages load the whole stylesheet after paint, so no class lacks its rule.
  'lateStyles',
  // `false` leaves a French page's spaces as they were typed.
  'typography',
  // `false` serves every visitor the same page; else a visitor asking for less data gets one without font preloads and speculation rules.
  'saveData',
] as const satisfies readonly (keyof KayConfig)[]

export type RenderConfigKey = (typeof RENDER_CONFIG)[number]

// `images.widths` sorted, or undefined for the default ladder, which the islands need not be told.
function customWidths(widths: number[] | undefined): number[] | undefined {
  if (widths === undefined)
    return undefined

  const sorted = parseWidths(widths)

  return sorted.join() === IMAGE_WIDTHS.join() ? undefined : sorted
}

// How every page renders, served or prerendered alike.
export function renderOptionsOf(config: KayConfig, mode: Pick<Mode, 'dev' | 'devRoutes'>, built: { head: SeoHead | undefined, maxDensity: number, editor?: string | undefined, contexts?: string[] | undefined, fontCss?: string | undefined, islandPreloads?: RenderOptions['islandPreloads'] }): RenderOptions {
  return { ...pickConfig(config, RENDER_CONFIG), dev: mode.dev, devTools: mode.devRoutes, serverTiming: config.serverTiming ?? mode.dev, sameTabLinks: config.links?.outside === 'same-tab', linkSchemes: linkSchemes(config), fontCss: config.saveData === false ? undefined : built.fontCss, islandPreloads: config.saveData === false ? undefined : built.islandPreloads, head: built.head, base: basePath(config.base), maxDensity: built.maxDensity, imageWidths: customWidths(config.images?.widths), resolvedImages: config.images?.resolve !== undefined, offline: registersWorker(config, mode), installOffer: pushListed(config), editor: built.editor, contexts: built.contexts }
}

// A project as every entry point takes it: where it is, its config, where it keeps each part and how it runs.
export interface Project<Config extends KayConfig = KayConfig> {
  root: string
  config: Config
  paths: ProjectPaths
  mode: Mode
}

export function resolveProject<Config extends KayConfig>(root: string, config: Config, mode: Mode = PRODUCTION): Project<Config> {
  const named = renamedKeys(config)

  return { root: resolve(root), config: named, paths: projectPaths(root, named), mode }
}

// Whether the islands of an app write French spaces: a French `lang` or locale, and `typography` not off.
export function writesFrench(config: Pick<KayConfig, 'lang' | 'i18n' | 'typography'>): boolean {
  return config.typography !== false && (config.i18n ? config.i18n.locales.some(isFrench) : config.lang !== undefined && isFrench(config.lang))
}

// The browser build a config asks for. `kay build`'s (`build` given) minifies unless the config says not to; one a server or a test makes on demand does only when the config says so.
export function clientOptionsOf(config: LoadedConfig, mode: Pick<Mode, 'dev' | 'underKayDev'>, build?: Pick<ClientOptions, 'exported' | 'report'>): ClientOptions {
  return {
    ...pickConfig(config, CLIENT_CONFIG),
    minify: config.minify ?? build !== undefined,
    i18n: config.i18n !== undefined,
    french: writesFrench(config),
    base: basePath(config.base),
    publicEnv: config.publicEnv !== undefined,
    sourcemap: mode.dev || (build !== undefined && build.exported !== true ? 'external' : false),
    hot: mode.dev,
    inspect: mode.underKayDev,
    ...build,
  }
}
