// Kay v2 native Bun.serve server + in-process request handler.

import type { BuildManifest, RouteManifestEntry } from '../build/index'
import type { Html, HydrateStrategy } from '../jsx-runtime'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'

export interface ServerOptions {
  root: string
  outDir?: string | undefined
  assetPrefix?: string | undefined
  port?: number | undefined
  lang?: string | undefined
}

export interface RequestContext {
  request: Request
  url: URL
  params: Record<string, string>
}

export interface KayApp {
  handle: (request: Request) => Promise<Response>
  serve: (port?: number) => ReturnType<typeof Bun.serve>
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
}

interface LoadedPageModule {
  default: (props: Record<string, unknown>) => Html | string | Promise<Html | string>
  load?: (ctx: RequestContext) => unknown | Promise<unknown>
  GET?: (ctx: RequestContext) => Response | Promise<Response>
  POST?: (ctx: RequestContext) => Response | Promise<Response>
}

interface LoadedLayoutModule {
  default: (props: { children: Html }) => Html | string | Promise<Html | string>
}

export async function createServer(options: ServerOptions): Promise<KayApp> {
  const root = resolve(options.root)
  const outDir = resolve(root, options.outDir ?? 'dist')
  const clientDir = join(outDir, 'client')
  const assetPrefix = (options.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const lang = options.lang ?? 'en'

  const manifestPath = join(outDir, 'manifest.json')
  if (!existsSync(manifestPath))
    throw new Error(`kay server: missing ${manifestPath}. Run build() first.`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest

  // Preload static client assets into memory for zero-disk-I/O serving
  const assetBytes = new Map<string, { body: Uint8Array<ArrayBuffer>, type: string }>()
  for (const rel of manifest.assets) {
    const abs = join(clientDir, rel)
    if (existsSync(abs)) {
      const body = new Uint8Array(readFileSync(abs))
      const type = MIME[extname(rel)] ?? 'application/octet-stream'
      assetBytes.set(`${assetPrefix}/${rel}`, { body, type })
    }
  }

  // Pre-import layouts and route modules at boot
  const layouts = new Map<string, LoadedLayoutModule>()
  const pageHandlers = new Map<string, (req: Request) => Response | Promise<Response>>()

  async function loadLayout(rel: string): Promise<LoadedLayoutModule> {
    const existing = layouts.get(rel)
    if (existing !== undefined)
      return existing
    const mod = await import(join(outDir, rel)) as LoadedLayoutModule
    layouts.set(rel, mod)
    return mod
  }

  for (const entry of manifest.routes) {
    const mod = await import(join(outDir, entry.file)) as LoadedPageModule
    const layout = entry.layout !== undefined ? await loadLayout(entry.layout) : undefined
    pageHandlers.set(entry.path, makeRouteHandler(entry, mod, layout, manifest, lang))
  }

  function makeRouteHandler(
    entry: RouteManifestEntry,
    mod: LoadedPageModule,
    layout: LoadedLayoutModule | undefined,
    manifestData: BuildManifest,
    docLang: string,
  ): (req: Request) => Response | Promise<Response> {
    // Precompute static document prefix & suffix per route! Zero per-request head/script string building!
    const hasIslands = entry.islandChunks.length > 0
    const shell = renderDocument({
      body: '\0',
      lang: docLang,
      runtimeScript: manifestData.runtimeScript,
      preloadChunks: entry.islandChunks,
      hasIslands,
    })
    const splitAt = shell.indexOf('\0')
    const docPrefix = shell.slice(0, splitAt)
    const docSuffix = shell.slice(splitAt + 1)
    const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' }

    return (request: Request): Promise<Response> | Response => {
      // Endpoint handler (.ts route exporting GET/POST)
      const methodHandler = (mod as unknown as Record<string, ((c: RequestContext) => Response | Promise<Response>) | undefined>)[request.method]
      if (typeof methodHandler === 'function')
        return methodHandler({ request, url: new URL(request.url), params: {} })

      const finish = (inner: string): Response | Promise<Response> => {
        if (layout === undefined)
          return new Response(docPrefix + inner + docSuffix, { status: 200, headers: htmlHeaders })
        const wrapped = layout.default({ children: raw(inner) })
        if (wrapped instanceof Promise)
          return wrapped.then(w => new Response(docPrefix + ssrChild(w as Html) + docSuffix, { status: 200, headers: htmlHeaders }))
        return new Response(docPrefix + ssrChild(wrapped as Html) + docSuffix, { status: 200, headers: htmlHeaders })
      }

      const renderPage = (pageProps: Record<string, unknown>): Response | Promise<Response> => {
        if (entry.isIsland && entry.islandChunk !== undefined) {
          const inner = ssrIsland(
            entry.path,
            entry.islandChunk,
            () => ssrChild(mod.default(pageProps) as Html),
            pageProps,
            entry.islandHydrate as HydrateStrategy | undefined,
          )
          return finish(inner)
        }
        const rendered = mod.default(pageProps)
        if (rendered instanceof Promise)
          return rendered.then(r => finish(ssrChild(r as Html)))
        return finish(ssrChild(rendered as Html))
      }

      if (entry.hasLoad && typeof mod.load === 'function') {
        const loaded = mod.load({ request, url: new URL(request.url), params: {} })
        if (loaded instanceof Promise)
          return loaded.then(data => renderPage(data !== undefined ? { data } : {}))
        return renderPage(loaded !== undefined ? { data: loaded } : {})
      }

      return renderPage({})
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

    const asset = assetBytes.get(pathname)
    if (asset !== undefined) {
      return new Response(asset.body, {
        status: 200,
        headers: {
          'content-type': asset.type,
          'cache-control': 'public, max-age=31536000, immutable',
        },
      })
    }

    const routeHandler = pageHandlers.get(pathname)
    if (routeHandler !== undefined)
      return routeHandler(request)

    return new Response('Not Found', { status: 404 })
  }

  function serve(port = options.port ?? 3000) {
    const routes: Record<string, Response | ((req: Request) => Response | Promise<Response>)> = {}

    for (const [path, asset] of assetBytes) {
      routes[path] = new Response(asset.body, {
        status: 200,
        headers: {
          'content-type': asset.type,
          'cache-control': 'public, max-age=31536000, immutable',
        },
      })
    }

    for (const [path, handler] of pageHandlers)
      routes[path] = handler

    return Bun.serve({
      port,
      routes,
      fetch: handle,
    })
  }

  return { handle, serve }
}
