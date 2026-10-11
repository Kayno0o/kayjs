import type { ClientOptions } from './build/client'
import type { KayConfig } from './config'
import { join, resolve } from 'node:path'
import { clientDir, outputDir } from './build/assets'
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

// How the browser build is made: in development it maps its chunks to their sources and swaps an edited island in, and under `kay dev` marks every element with its source for the inspector.
export interface ClientMode {
  dev: boolean
  underKayDev: boolean
}

// The browser build a config asks for. `kay build`'s (`build` given) minifies unless the config says not to; one a server or a test makes on demand does only when the config says so.
export function clientOptionsOf(config: ClientConfig, mode: ClientMode, build?: Pick<ClientOptions, 'exported' | 'report'>): ClientOptions {
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
