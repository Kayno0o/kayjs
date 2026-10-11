import type { ClientOptions } from './build/client'
import type { KayConfig } from './config'
import type { RenderOptions } from './server/render'
import type { SeoHead } from './server/seo'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { clientDir, outputDir, underKayDev } from './build/assets'
import { basePath } from './server/base'

// The content collections' config, when `content` names no other file.
export const CONTENT_CONFIG = 'src/content.config.ts'

// Where a project keeps each of its parts, as absolute paths: kay's defaults are written here alone.
export interface ProjectPaths {
  root: string
  routes: string
  public: string
  api: string
  // The server entry `kay dev`, `kay check` and `kay build --compile` start from.
  entry: string
  content: string
  // Under `.kay`: what compiling the project keeps between runs, the executable's generated entry, and the browser build with the directory it serves.
  cache: string
  compile: string
  output: string
  client: string
}

export function projectPaths(root: string, config: Pick<KayConfig, 'routes' | 'publicDir' | 'api' | 'content'> & { entry?: string | undefined } = {}): ProjectPaths {
  const absolute = resolve(root)

  return {
    root: absolute,
    routes: resolve(absolute, config.routes ?? 'src/routes'),
    public: resolve(absolute, config.publicDir ?? 'public'),
    api: resolve(absolute, config.api ?? 'src/api'),
    entry: resolve(absolute, config.entry ?? 'src/server.ts'),
    content: resolve(absolute, config.content ?? CONTENT_CONFIG),
    cache: join(absolute, '.kay', 'cache'),
    compile: join(absolute, '.kay', 'compile'),
    output: outputDir(absolute),
    client: clientDir(absolute),
  }
}

// A directory of the cache under `.kay`, by name.
export function cacheDir(root: string, ...names: string[]): string {
  return join(projectPaths(root).cache, ...names)
}

type ClientConfig = Pick<KayConfig, 'minify' | 'plugins' | 'routes' | 'extensions' | 'api' | 'navigation' | 'base' | 'settings' | 'publicEnv' | 'lints'>

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
  return config.offline !== undefined && !mode.dev
}

type RenderConfig = Pick<KayConfig, 'lang' | 'serverTiming' | 'prefetch' | 'onError' | 'base' | 'images' | 'offline'>

// How every page renders, served or prerendered alike.
export function renderOptionsOf(config: RenderConfig, mode: Pick<Mode, 'dev'>, built: { head: SeoHead | undefined, maxDensity: number }): RenderOptions {
  return { lang: config.lang, dev: mode.dev, serverTiming: config.serverTiming ?? mode.dev, prefetch: config.prefetch, onError: config.onError, head: built.head, base: basePath(config.base), maxDensity: built.maxDensity, resolvedImages: config.images?.resolve !== undefined, offline: offlineOf(config, mode) }
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
    base: basePath(config.base),
    settings: config.settings,
    publicEnv: config.publicEnv !== undefined,
    lints: config.lints,
    sourcemap: mode.dev,
    hot: mode.dev,
    inspect: mode.underKayDev,
    ...build,
  }
}
