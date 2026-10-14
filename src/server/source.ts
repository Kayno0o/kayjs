import type { KayConfig } from '../config'
import type { Mode, Project } from '../project'
import type { ApiModule } from './api'
import type { Bundle } from './bundle'
import type { ClientBuild } from './client'
import type { Endpoint, Route, RouteMount, SpecialPages } from './routes'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { outputDir, testWorker } from '../build/assets'
import { mergeConfig, withConfig } from '../config'
import { cacheDir, clientOptionsOf, modeOf, PRODUCTION } from '../project'
import { kayLog } from '../runtime/log'
import { bundled } from './bundle'
import { readClient } from './client'
import { extensionEditor, routeTrees, scanEndpoints, scanRoutes, specialPagesOf } from './routes'

// Where a project's config, routes, modules and built files come from: the files on disk, compiled as they load, or what `kay build --compile` embedded in the executable.
export interface ProjectSource {
  // An executable builds nothing as it runs: the fonts, the card key and the content are the ones embedded, and their absence is a build to make again.
  embedded: boolean
  mode: (options: { dev?: boolean | undefined, prebuilt?: boolean | undefined }) => Mode
  // An executable serves the project it was built from, wherever it runs.
  root: (fallback: string) => string
  config: <Options extends KayConfig>(root: string, options: Options) => Promise<KayConfig & Options>
  client: (project: Project) => Promise<ClientBuild>
  // Lets the `.kay` modules it imports compile as they load.
  prepare: (root: string, settings?: Record<string, string>) => Promise<void>
  has: (file: string) => boolean
  routes: (routesDir: string, mounts: RouteMount[]) => Promise<Route[]>
  fallback: (routesDir: string, mounts: RouteMount[]) => SpecialPages
  api: (root: string, config: Pick<KayConfig, 'api' | 'extensions'>) => Promise<ApiModule[]>
  endpoints: (routesDir: string, mounts: RouteMount[]) => Promise<Endpoint[]>
  // The catalogs the extensions give a locale, of `files`, those the extensions name where the server runs.
  extensionCatalogs: (locale: string, files: string[]) => string[]
  // The editor an extension gives, which a page in edit mode renders.
  editor: (root: string, config: Pick<KayConfig, 'extensions'>) => string | undefined
  // What paths the config names resolve against as the server runs.
  runtimeRoot: (root: string) => string
  imageCache: (root: string) => string
  // The client build the content manifests were written into, if any is read.
  contentBuild: (root: string, prebuilt: boolean, output?: string) => string | undefined
}

const DISK: ProjectSource = {
  embedded: false,
  mode: options => modeOf(options),
  root: fallback => resolve(fallback),
  config: async (root, options) => withConfig(root, options),
  client: async ({ root, config, mode, paths }) => {
    if (mode.prebuilt) {
      const built = await readClient(root, paths.output)

      if (built)
        return built

      kayLog('warn', 'no client build in .kay/client, bundling now; run `kay build` before starting in production')
    }

    const options = clientOptionsOf(config, mode)

    // `kay dev` builds it beside the server booting.
    if (mode.underKayDev) {
      const built = await (await import('./dev')).kayDevClient(root, options)

      if (built)
        return built
    }

    // Imported only to bundle, as it brings the compiler, which a server reading a build never needs.
    const { buildClient } = await import('../build/client')

    return buildClient(root, options)
  },
  // Imported as it is asked for, as it needs Bun, which eslint's bundle of the shadow types runs without.
  prepare: async (root, settings) => (await import('./loader')).registerLoader(root, settings),
  has: file => existsSync(file),
  routes: async (routesDir, mounts) => scanRoutes(routesDir, mounts),
  fallback: (routesDir, mounts) => specialPagesOf(routeTrees(routesDir, mounts), ''),
  // Imported as it is asked for, as the API modules' actions read the locales, which read this.
  api: async (root, config) => (await import('./api')).projectApi(root, config),
  endpoints: async (routesDir, mounts) => scanEndpoints(routesDir, mounts),
  extensionCatalogs: (_, files) => files.filter(file => existsSync(file)),
  editor: (root, config) => extensionEditor(root, config.extensions),
  runtimeRoot: root => root,
  imageCache: root => cacheDir(root, `images${testWorker()}`),
  contentBuild: (root, prebuilt, output) => prebuilt ? output ?? outputDir(root) : undefined,
}

function embeddedSource(bundle: Bundle): ProjectSource {
  return {
    embedded: true,
    mode: () => PRODUCTION,
    root: () => bundle.root,
    // The root, routes and public files it was built with win over the options.
    config: async (_, options) => ({ ...mergeConfig(bundle.config, options), root: bundle.root, publicDir: bundle.publicDir }),
    client: async () => {
      const client = await readClient(bundle.root, bundle.clientDir)

      if (!client)
        throw new Error(`kay: this executable holds no client build at ${bundle.clientDir}`)

      return client
    },
    prepare: async () => undefined,
    has: file => file in bundle.modules,
    routes: async () => bundle.routes,
    fallback: () => bundle.fallback,
    api: async () => bundle.api ?? [],
    endpoints: async () => bundle.endpoints ?? [],
    // An extension names its catalogs under the executable's own path, so the build's are kept.
    extensionCatalogs: locale => bundle.extensionMessages?.[locale] ?? [],
    // The build resolved it where the extension was, under the path the executable holds its module by.
    editor: () => bundle.editor,
    // An executable is copied away from the project it was built in, to run where its files are.
    runtimeRoot: () => process.cwd(),
    imageCache: () => join(tmpdir(), 'kay-images'),
    contentBuild: () => bundle.clientDir,
  }
}

let embedded: [Bundle, ProjectSource] | undefined

// The executable's embedded build once its entry registered one, else the files on disk.
export function projectSource(): ProjectSource {
  const bundle = bundled()

  if (!bundle)
    return DISK

  if (embedded?.[0] !== bundle)
    embedded = [bundle, embeddedSource(bundle)]

  return embedded[1]
}
