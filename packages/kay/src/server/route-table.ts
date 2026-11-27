// The page routes of a build, compiled once at startup: each route's modules, middlewares and document options, and the handler of a page nothing can intercept.

import type { BuildManifest, RouteManifestEntry } from '../build/index'
import type { DocumentOptions } from '../ssr/index'
import type { Middleware } from './http'
import type { LoadedLayoutModule, LoadedMiddlewareModule, LoadedPageModule } from './page'
import type { FastHandler, FastStaticPageOptions } from './routing'
import { headTagStyleHashes } from './document'
import { mergedHeadTags } from './page'
import { Router } from './router'
import { createFastStaticPageHandler } from './routing'

export interface CompiledRoute {
  entry: RouteManifestEntry
  mod: LoadedPageModule
  layouts: LoadedLayoutModule[]
  dirMiddlewares: Middleware[]
  /** Precomputed plugin + directory middlewares for non-rewritten static paths. */
  middlewares: Middleware[]
  /** Dynamic segments (`:param` / `*rest`), so the path names no single URL. */
  dynamic: boolean
  /** Options every document of this route shares; a request adds its body, head and islands. */
  doc: DocumentOptions
  headStyleHashes: string[]
}

function routeDocument(manifest: BuildManifest, entry: RouteManifestEntry, lang: string, alwaysLoadRuntime: boolean, navigation: DocumentOptions['navigation']): DocumentOptions {
  return {
    body: '',
    headTags: mergedHeadTags(manifest, entry),
    lang,
    runtimeScript: manifest.runtimeScript,
    chunkImports: manifest.chunkImports,
    alwaysLoadRuntime,
    navigation,
    regionScript: entry.usesRegion === true ? manifest.regionScript : undefined,
    styles: entry.styles ?? manifest.styles,
  }
}

type SharedFastOptions = Omit<FastStaticPageOptions, 'entry' | 'mod' | 'layouts' | 'doc' | 'reviveScript' | 'hasIslands' | 'hasLoad'>

export interface RouteTableOptions {
  manifest: BuildManifest
  modules: Record<string, unknown>
  lang: string
  alwaysLoadRuntime: boolean
  navigation: DocumentOptions['navigation']
  middlewaresFor: (path: string, staticOnly?: boolean) => readonly Middleware[]
  /** Whether a plugin rewrite, head hook, HTML transform or route may change what `path` answers. */
  pluginIntercepts: (path: string) => boolean
  fast: SharedFastOptions
}

export function compileRouteTable(options: RouteTableOptions): { router: Router<CompiledRoute>, fastStaticPages: Map<string, FastHandler> } {
  const { manifest, modules, lang, alwaysLoadRuntime, navigation, middlewaresFor, pluginIntercepts, fast } = options
  const router = new Router<CompiledRoute>()
  const fastStaticPages = new Map<string, FastHandler>()
  for (const entry of manifest.routes) {
    const mod = modules[entry.file] as LoadedPageModule
    const layouts = entry.layouts.map(l => modules[l] as LoadedLayoutModule)
    const dirMiddlewares = entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default)
    const hasLoad = Boolean(entry.hasLoad && typeof mod.load === 'function')
    const dynamic = entry.path.includes(':') || entry.path.includes('*')
    const doc = routeDocument(manifest, entry, lang, alwaysLoadRuntime, navigation)

    // Zero-overhead path for a static route with no middleware, no <Head>/<Suspense>, and no intercepting plugin hook
    const canFastPath = middlewaresFor(entry.path, !hasLoad).length === 0
      && !pluginIntercepts(entry.path) && !dynamic
      && dirMiddlewares.length === 0 && !entry.usesRenderContext
      && typeof mod.default === 'function' && mod.GET === undefined
    if (canFastPath)
      fastStaticPages.set(entry.path, createFastStaticPageHandler({ ...fast, entry, mod, layouts, doc, reviveScript: manifest.reviveScript, hasIslands: entry.islandChunks.length > 0, hasLoad }))

    router.add(entry.path, { entry, mod, layouts, dirMiddlewares, middlewares: [...middlewaresFor(entry.path), ...dirMiddlewares], dynamic, doc, headStyleHashes: headTagStyleHashes(doc.headTags) })
  }
  return { router, fastStaticPages }
}
