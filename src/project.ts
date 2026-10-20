import type { ClientOptions } from './build/client'
import type { KayConfig } from './config'
import type { RenderOptions } from './server/render'
import type { SeoHead } from './server/seo'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { clientDir, KAY_DIR, outputDir, testWorker, underKayDev } from './build/assets'
import { TSCONFIG } from './build/files'
import { isFrench } from './runtime/french'
import { IMAGE_WIDTHS, parseWidths } from './runtime/image'
import { basePath } from './server/base'

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

export function projectPaths(root: string, config: Pick<KayConfig, 'routes' | 'publicDir' | 'api' | 'content' | 'entry'> = {}): ProjectPaths {
  const absolute = resolve(root)

  return {
    root: absolute,
    routes: resolve(absolute, config.routes ?? 'src/routes'),
    public: resolve(absolute, config.publicDir ?? 'public'),
    api: resolve(absolute, config.api ?? 'src/api'),
    entry: resolve(absolute, config.entry ?? 'src/server.ts'),
    content: resolve(absolute, config.content ?? CONTENT_CONFIG),
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

type ClientConfig = Pick<KayConfig, 'minify' | 'plugins' | 'routes' | 'extensions' | 'api' | 'navigation' | 'i18n' | 'base' | 'settings' | 'publicEnv' | 'lints' | 'fonts' | 'search' | 'hydration' | 'lateStyles' | 'lang' | 'typography'>

// How a server runs. In development it shows errors with their stack and maps and swaps islands; prebuilt, it serves the browser build `kay build` wrote rather than bundling one; under `kay dev`, each element carries its source for the inspector.
export interface Mode {
  dev: boolean
  prebuilt: boolean
  underKayDev: boolean
}

// What `kay build` and the executable it compiles run as.
export const PRODUCTION: Mode = { dev: false, prebuilt: true, underKayDev: false }

// The mode a server takes from its options, or else from `NODE_ENV` and `kay dev`.
export function modeOf(options: { dev?: boolean | undefined, prebuilt?: boolean | undefined } = {}): Mode {
  return { dev: options.dev ?? process.env.NODE_ENV === 'development', prebuilt: options.prebuilt ?? process.env.NODE_ENV === 'production', underKayDev: underKayDev() }
}

// Whether pages register the service worker: never in development, which serves one unregistering itself instead.
export function offlineOf(config: Pick<KayConfig, 'offline'>, mode: Pick<Mode, 'dev'>): boolean {
  return config.offline !== undefined && config.offline !== false && !mode.dev
}

type RenderConfig = Pick<KayConfig, 'lang' | 'serverTiming' | 'prefetch' | 'onError' | 'base' | 'images' | 'offline' | 'lateStyles' | 'typography'>

// `images.widths` sorted, or undefined for the default ladder, which the islands need not be told.
function customWidths(widths: number[] | undefined): number[] | undefined {
  if (widths === undefined)
    return undefined

  const sorted = parseWidths(widths)

  return sorted.join() === IMAGE_WIDTHS.join() ? undefined : sorted
}

// How every page renders, served or prerendered alike.
export function renderOptionsOf(config: RenderConfig, mode: Pick<Mode, 'dev'>, built: { head: SeoHead | undefined, maxDensity: number, editor?: string | undefined }): RenderOptions {
  return { lang: config.lang, dev: mode.dev, serverTiming: config.serverTiming ?? mode.dev, prefetch: config.prefetch, onError: config.onError, head: built.head, base: basePath(config.base), maxDensity: built.maxDensity, imageWidths: customWidths(config.images?.widths), resolvedImages: config.images?.resolve !== undefined, offline: offlineOf(config, mode), lateStyles: config.lateStyles, typography: config.typography, editor: built.editor }
}

// A project as every entry point takes it: where it is, its config, where it keeps each part and how it runs.
export interface Project<Config extends KayConfig = KayConfig> {
  root: string
  config: Config
  paths: ProjectPaths
  mode: Mode
}

export function resolveProject<Config extends KayConfig>(root: string, config: Config, mode: Mode = PRODUCTION): Project<Config> {
  return { root: resolve(root), config, paths: projectPaths(root, config), mode }
}

// The browser build a config asks for. `kay build`'s (`build` given) minifies unless the config says not to; one a server or a test makes on demand does only when the config says so.
export function clientOptionsOf(config: ClientConfig, mode: Pick<Mode, 'dev' | 'underKayDev'>, build?: Pick<ClientOptions, 'exported' | 'report'>): ClientOptions {
  return {
    minify: config.minify ?? build !== undefined,
    plugins: config.plugins,
    routes: config.routes,
    extensions: config.extensions,
    api: config.api,
    navigation: config.navigation,
    i18n: config.i18n !== undefined,
    french: config.typography !== false && (config.i18n ? config.i18n.locales.some(isFrench) : config.lang !== undefined && isFrench(config.lang)),
    search: config.search,
    hydration: config.hydration,
    lateStyles: config.lateStyles,
    base: basePath(config.base),
    settings: config.settings,
    publicEnv: config.publicEnv !== undefined,
    lints: config.lints,
    fonts: config.fonts,
    sourcemap: mode.dev || (build !== undefined && build.exported !== true ? 'external' : false),
    hot: mode.dev,
    inspect: mode.underKayDev,
    ...build,
  }
}
