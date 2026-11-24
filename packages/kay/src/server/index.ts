// Kay v2 native Bun.serve server:
// - Static + dynamic ([param], [...catchall]) Router
// - Composable directory-scoped _middleware.ts chains + ctx.cookies + ctx.locals
// - Unified Standard-Schema action() endpoint handling with CSRF verification
// - <Head> collection + streaming <Suspense> (0-overhead fast path when unused)
// - Hybrid prerendered HTML serving + embedded single-executable mode

import type { BuildManifest, RouteManifestEntry } from '../build/index'
import type { Html, HydrateStrategy } from '../jsx-runtime'
import type { KayPlugin, ServerPluginAPI } from '../plugins/index'
import type { ActionContext, ServerAction } from './action'
import type { CookieStore } from './cookies'
import type { EmbeddedBody, EmbeddedServerConfig, KayApp, Middleware, RequestContext, ServerOptions } from './http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { loadConfig } from '../plugins/index'
import { createRenderContext, renderCollectedHead, runWithRenderContext, streamChunkScript } from '../ssr/context'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { ACTION_ERROR_COOKIE, executeAction, isServerAction } from './action'
import type { ActionErrorFlash } from './action'
import { CompressionCache, compressedHtmlResponse, isCompressibleType, maybeCompressResponse, pickEncoding } from './compress'
import { extractRenderedIslands, finalizeResponse, makeRequestContext, MIME } from './http'
import { Router } from './router'
import { buildSecurityHeaderEntries, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, withCspHashes } from './security'

export { defineConfig, definePlugin, loadConfig } from '../plugins/index'
export type { BuildPluginContext, CheckPluginContext, KayConfig, KayPlugin, ServerPluginAPI } from '../plugins/index'
export { action, getActionError } from './action'
export type { ActionContext, ActionErrorFlash, ActionResult, ServerAction } from './action'
export { CompressionCache, isCompressibleType, pickEncoding } from './compress'
export type { CompressionEncoding } from './compress'
export type { CookieOptions, Cookies } from './cookies'
export { defineEnv } from './env'
export type { EmbeddedServerConfig, KayApp, Middleware, RequestContext, ServerOptions } from './http'
export { KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, verifyOrigin, withCspHashes } from './security'
export type { SecurityHeadersOptions } from './security'
export type { InferInput, InferOutput, StandardSchemaIssue, StandardSchemaV1 } from './standard-schema'

interface LoadedPageModule {
  default?: (props: Record<string, unknown>) => Html | string | Promise<Html | string>
  load?: (ctx: RequestContext) => unknown | Promise<unknown>
  GET?: (ctx: RequestContext) => Response | Promise<Response>
  POST?: (ctx: RequestContext) => Response | Promise<Response>
  PUT?: (ctx: RequestContext) => Response | Promise<Response>
  PATCH?: (ctx: RequestContext) => Response | Promise<Response>
  DELETE?: (ctx: RequestContext) => Response | Promise<Response>
  [key: string]: unknown
}

interface LoadedLayoutModule {
  default: (props: { children: Html, url?: URL, params?: Record<string, string>, locals?: Record<string, unknown> }) => Html | string | Promise<Html | string>
}

interface LoadedMiddlewareModule {
  default: Middleware
}

interface LoadedErrorModule {
  default: (props: { error: unknown }) => Html | string | Promise<Html | string>
}

const textEncoder = new TextEncoder()

type PrerenderEntry = { kind: 'file', path: string, hasIslands: boolean } | { kind: 'html', html: string, hasIslands: boolean }

export async function createServerFromEmbedded(config: EmbeddedServerConfig): Promise<KayApp> {
  const { manifest, modules, assets, publicAssets = {}, publicEtags = {}, prerendered, prerenderedFiles = {}, lang = 'en', security, plugins = [] } = config
  const assetPrefix = (config.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const trustedOrigins = config.trustedOrigins ? new Set(config.trustedOrigins) : undefined
  const alwaysLoadRuntime = plugins.some(p => Boolean(p.clientEntry))
  const htmlTransformers = plugins
    .map(p => p.transformHtml)
    .filter((fn): fn is NonNullable<KayPlugin['transformHtml']> => typeof fn === 'function')

  const securityEntries = buildSecurityHeaderEntries(security)
  const securityRecord: Record<string, string> = {}
  for (let i = 0; i < securityEntries.length; i++) {
    const [k, v] = securityEntries[i]!
    securityRecord[k] = v
  }
  const htmlBaseHeaders: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', ...securityRecord }
  const baseCsp = security !== false ? security?.csp : undefined
  const makeHtmlHeaders = (hasIslands: boolean, hasSuspense: boolean): Record<string, string> => {
    if (baseCsp === undefined || (!hasIslands && !hasSuspense))
      return htmlBaseHeaders
    const styleHashes: string[] = []
    const scriptHashes: string[] = []
    if (hasIslands)
      styleHashes.push(KAY_ISLAND_STYLE_HASH)
    if (hasSuspense) {
      styleHashes.push(KAY_SUSPENSE_STYLE_HASH)
      scriptHashes.push(KAY_STREAM_SCRIPT_HASH)
    }
    return { ...htmlBaseHeaders, 'content-security-policy': withCspHashes(baseCsp, { styleHashes, scriptHashes }) }
  }
  const htmlHeadersPlain = makeHtmlHeaders(false, false)
  const htmlHeadersIslands = makeHtmlHeaders(true, false)
  const htmlHeadersSuspense = makeHtmlHeaders(false, true)
  const htmlHeadersBoth = makeHtmlHeaders(true, true)
  const selectHtmlHeaders = (hasIslands: boolean, hasSuspense: boolean): Record<string, string> =>
    hasIslands
      ? (hasSuspense ? htmlHeadersBoth : htmlHeadersIslands)
      : (hasSuspense ? htmlHeadersSuspense : htmlHeadersPlain)
  const compressEnabled = config.compress ?? (process.env.KAY_DEV !== '1')
  const compressCache = compressEnabled ? new CompressionCache() : undefined

  // Collect plugin server hooks (supports both sync and async plugin setup)
  const globalMiddlewares: Middleware[] = []
  const pluginRewrites: ((pathname: string, ctx: RequestContext) => string | undefined)[] = []
  const pluginRouter = new Router<Map<string, (ctx: RequestContext) => Response | Promise<Response>>>()
  const pluginRouteEntries = new Map<string, Map<string, (ctx: RequestContext) => Response | Promise<Response>>>()

  const pluginApi: ServerPluginAPI = {
    use(mw) {
      globalMiddlewares.push(mw)
    },
    route(method, path, handler) {
      let byMethod = pluginRouteEntries.get(path)
      if (byMethod === undefined) {
        byMethod = new Map()
        pluginRouteEntries.set(path, byMethod)
        pluginRouter.add(path, byMethod)
      }
      byMethod.set(method.toUpperCase(), handler)
    },
    rewrite(fn) {
      pluginRewrites.push(fn)
    },
  }

  for (const plugin of plugins) {
    if (plugin.server !== undefined)
      await plugin.server(pluginApi)
  }

  const hasGlobalMiddleware = globalMiddlewares.length > 0
  const hasPluginRewrites = pluginRewrites.length > 0
  const hasHtmlTransformers = htmlTransformers.length > 0

  // Hashed build asset table (immutable cache + optional lazy compression)
  interface AssetEntry {
    body: EmbeddedBody
    type: string
    compressible: boolean
    headers: Record<string, string>
    varyHeaders: Record<string, string>
  }
  const assetMap = new Map<string, AssetEntry>()
  for (const [rel, body] of Object.entries(assets)) {
    const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    const compressible = isCompressibleType(type)
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
    }
    const varyHeaders: Record<string, string> = compressible && compressCache !== undefined
      ? { ...headers, vary: 'Accept-Encoding' }
      : headers
    assetMap.set(`${assetPrefix}/${rel}`, { body, type, compressible, headers, varyHeaders })
  }

  // Static public/ file table (ETag + 304 + zero-copy Bun.file + optional lazy compression)
  interface PublicEntry {
    body: EmbeddedBody
    type: string
    etag: string
    compressible: boolean
  }
  const publicMap = new Map<string, PublicEntry>()
  for (const [rel, body] of Object.entries(publicAssets)) {
    const etag = publicEtags[rel] ?? (typeof body === 'string' ? `W/"${Bun.hash(rel).toString(36)}"` : `W/"${Bun.hash(body).toString(36)}"`)
    const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    publicMap.set(`/${rel}`, { body, type, etag, compressible: isCompressibleType(type) })
  }

  const toResponseBody = (body: EmbeddedBody) => typeof body === 'string' ? Bun.file(body) : body

  async function serveAsset(request: Request, pathname: string, asset: AssetEntry): Promise<Response> {
    if (request.method === 'HEAD')
      return new Response(null, { status: 200, headers: asset.varyHeaders })

    if (compressCache !== undefined && asset.compressible) {
      const enc = pickEncoding(request.headers.get('accept-encoding'))
      if (enc !== undefined) {
        const key = `${enc}:a:${pathname}`
        let compressed = compressCache.get(key)
        if (compressed === undefined) {
          const rawBytes = typeof asset.body === 'string'
            ? new Uint8Array(await Bun.file(asset.body).arrayBuffer())
            : asset.body
          compressed = compressCache.compress(rawBytes, enc, `a:${pathname}`)
          if (compressed === undefined)
            return new Response(rawBytes, { status: 200, headers: asset.varyHeaders })
        }
        return new Response(compressed, {
          status: 200,
          headers: { ...asset.headers, 'content-encoding': enc, vary: 'Accept-Encoding' },
        })
      }
    }

    return new Response(toResponseBody(asset.body), { status: 200, headers: asset.varyHeaders })
  }

  async function servePublic(request: Request, pathname: string, pub: PublicEntry): Promise<Response> {
    const cacheControl = process.env.KAY_DEV === '1' ? 'no-cache' : 'public, max-age=3600'
    const hasVary = pub.compressible && compressCache !== undefined
    if (request.headers.get('if-none-match') === pub.etag) {
      const h: Record<string, string> = hasVary
        ? { 'etag': pub.etag, 'cache-control': cacheControl, 'vary': 'Accept-Encoding' }
        : { 'etag': pub.etag, 'cache-control': cacheControl }
      return new Response(null, { status: 304, headers: h })
    }

    const baseHeaders: Record<string, string> = hasVary
      ? { 'content-type': pub.type, 'etag': pub.etag, 'cache-control': cacheControl, 'vary': 'Accept-Encoding' }
      : { 'content-type': pub.type, 'etag': pub.etag, 'cache-control': cacheControl }

    if (request.method === 'HEAD')
      return new Response(null, { status: 200, headers: baseHeaders })

    if (hasVary) {
      const enc = pickEncoding(request.headers.get('accept-encoding'))
      if (enc !== undefined) {
        const staticKey = `p:${pathname}:${pub.etag}`
        let compressed = compressCache.get(`${enc}:${staticKey}`)
        if (compressed === undefined) {
          const rawBytes = typeof pub.body === 'string'
            ? new Uint8Array(await Bun.file(pub.body).arrayBuffer())
            : pub.body
          compressed = compressCache.compress(rawBytes, enc, staticKey)
          if (compressed === undefined)
            return new Response(rawBytes, { status: 200, headers: baseHeaders })
        }
        return new Response(compressed, {
          status: 200,
          headers: { ...baseHeaders, 'content-encoding': enc },
        })
      }
    }

    return new Response(toResponseBody(pub.body), { status: 200, headers: baseHeaders })
  }

  async function servePrerendered(request: Request, pathname: string, pre: PrerenderEntry): Promise<Response> {
    const base = selectHtmlHeaders(pre.hasIslands, false)
    const headers = compressCache !== undefined
      ? { ...base, vary: 'Accept-Encoding' }
      : base

    if (request.method === 'HEAD')
      return new Response(null, { status: 200, headers })

    if (compressCache !== undefined) {
      const enc = pickEncoding(request.headers.get('accept-encoding'))
      if (enc !== undefined) {
        const staticKey = `pre:${pathname}`
        let compressed = compressCache.get(`${enc}:${staticKey}`)
        if (compressed === undefined) {
          const rawBytes = pre.kind === 'file'
            ? new Uint8Array(await Bun.file(pre.path).arrayBuffer())
            : textEncoder.encode(pre.html)
          compressed = compressCache.compress(rawBytes, enc, staticKey)
          if (compressed === undefined)
            return new Response(rawBytes, { status: 200, headers })
        }
        return new Response(compressed, {
          status: 200,
          headers: { ...headers, 'content-encoding': enc },
        })
      }
    }

    const body = pre.kind === 'file' ? Bun.file(pre.path) : pre.html
    return new Response(body, { status: 200, headers })
  }

  // Register server actions and assign their live URLs
  const actionHandlers = new Map<string, ServerAction<unknown, unknown>>()
  for (const entry of manifest.actions) {
    const mod = modules[entry.file] as Record<string, unknown> | undefined
    const act = mod?.[entry.exportName]
    if (isServerAction(act)) {
      ;(act as { url: string }).url = entry.url
      actionHandlers.set(entry.url, act)
    }
  }

  const errorMod = manifest.errorFile ? modules[manifest.errorFile] as LoadedErrorModule : undefined
  const notFoundMod = manifest.notFoundFile ? modules[manifest.notFoundFile] as LoadedPageModule : undefined

  // Static prerendered pages table (zero-copy file paths preferred; raw HTML strings supported)
  const prerenderedMap = new Map<string, PrerenderEntry>()
  const fastPrerenderedMap = new Map<string, PrerenderEntry>()
  for (const route of manifest.routes) {
    if (route.prerendered) {
      const routeHasIslands = route.islandChunks.length > 0
      for (const [urlPath, relHtml] of Object.entries(route.prerendered)) {
        const filePath = prerenderedFiles[relHtml]
        const html = prerendered[relHtml]
        const entry: PrerenderEntry | undefined = filePath !== undefined
          ? { kind: 'file', path: filePath, hasIslands: routeHasIslands }
          : html !== undefined
            ? { kind: 'html', html, hasIslands: routeHasIslands }
            : undefined
        if (entry !== undefined) {
          prerenderedMap.set(urlPath, entry)
          if (route.middlewares.length === 0 && !hasGlobalMiddleware && pluginRouter.match(urlPath) === undefined)
            fastPrerenderedMap.set(urlPath, entry)
        }
      }
    }
  }

  interface CompiledRoute {
    entry: RouteManifestEntry
    mod: LoadedPageModule
    layouts: LoadedLayoutModule[]
    middlewares: Middleware[]
    fastHandler: ((req: Request) => Response | Promise<Response>) | undefined
    docPrefix: string
    docSuffix: string
  }

  const router = new Router<CompiledRoute>()
  const fastStaticPages = new Map<string, (req: Request) => Response | Promise<Response>>()

  for (const entry of manifest.routes) {
    const mod = modules[entry.file] as LoadedPageModule
    const layouts = entry.layouts.map(l => modules[l] as LoadedLayoutModule)
    const middlewares = entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default)

    const hasIslands = entry.islandChunks.length > 0
    const routeStyles = entry.styles ?? manifest.styles
    const routeHeadTags = entry.headTags !== undefined && entry.headTags.length > 0
      ? [...(manifest.headTags ?? []), ...entry.headTags]
      : manifest.headTags
    const shell = renderDocument({
      body: '\0',
      headTags: routeHeadTags,
      lang,
      runtimeScript: manifest.runtimeScript,
      alwaysLoadRuntime,
      preloadChunks: entry.eagerIslandChunks ?? entry.islandChunks,
      styles: routeStyles,
      hasIslands,
    })
    const splitAt = shell.indexOf('\0')
    const docPrefix = shell.slice(0, splitAt)
    const docSuffix = shell.slice(splitAt + 1)

    // Ultra-fast zero-overhead path when route is static, has no middleware, no <Head>/<Suspense>, and no intercepting plugin hooks
    const canFastPath = !hasGlobalMiddleware
      && !hasPluginRewrites
      && !hasHtmlTransformers
      && pluginRouter.match(entry.path) === undefined
      && !entry.path.includes(':')
      && !entry.path.includes('*')
      && middlewares.length === 0
      && !entry.usesRenderContext
      && typeof mod.default === 'function'
      && mod.GET === undefined

    let fastHandler: ((req: Request) => Response | Promise<Response>) | undefined
    if (canFastPath) {
      const singleLayout = layouts.length === 1 ? layouts[0]! : undefined
      const fastHeaders = selectHtmlHeaders(hasIslands, false)

      fastHandler = (request: Request): Response | Promise<Response> => {
        const reqUrl = new URL(request.url)
        const respondHtml = (body: string): Response =>
          compressedHtmlResponse(docPrefix + body + docSuffix, 200, fastHeaders, request, compressCache)

        const wrapLayouts = (inner: string): Response | Promise<Response> => {
          if (layouts.length === 0)
            return respondHtml(inner)
          if (singleLayout !== undefined) {
            const w = singleLayout.default({ children: raw(inner), url: reqUrl, params: {}, locals: {} })
            if (w instanceof Promise)
              return w.then(x => respondHtml(ssrChild(x as Html)))
            return respondHtml(ssrChild(w as Html))
          }
          return (async () => {
            let cur = inner
            for (let i = layouts.length - 1; i >= 0; i--)
              cur = ssrChild(await layouts[i]!.default({ children: raw(cur), url: reqUrl, params: {}, locals: {} }) as Html)
            return respondHtml(cur)
          })()
        }

        const renderPage = (data: unknown): Response | Promise<Response> => {
          const pageProps: Record<string, unknown> = {
            params: {},
            locals: {},
            url: reqUrl,
            ...(data !== undefined ? { data } : {}),
          }
          if (entry.isIsland && entry.islandChunk !== undefined) {
            const inner = ssrIsland(
              entry.path,
              entry.islandChunk,
              () => ssrChild(mod.default!(pageProps) as Html),
              data !== undefined ? { data } : {},
              entry.islandHydrate as HydrateStrategy | undefined,
            )
            return wrapLayouts(inner)
          }
          const rendered = mod.default!(pageProps)
          if (rendered instanceof Promise)
            return rendered.then(r => wrapLayouts(ssrChild(r as Html)))
          return wrapLayouts(ssrChild(rendered as Html))
        }

        if (entry.hasLoad && typeof mod.load === 'function') {
          const { ctx, cookieStore } = makeRequestContext(request, {})
          const finish = (res: Response | Promise<Response>): Response | Promise<Response> => {
            if (!cookieStore.hasChanges)
              return res
            if (res instanceof Promise)
              return res.then(r => finalizeResponse(r, cookieStore, securityEntries))
            return finalizeResponse(res, cookieStore, securityEntries)
          }
          const loaded = mod.load(ctx)
          if (loaded instanceof Promise) {
            return loaded.then(data =>
              finish(data instanceof Response ? data : renderPage(data)),
            )
          }
          if (loaded instanceof Response)
            return finish(loaded)
          return finish(renderPage(loaded))
        }
        return renderPage(undefined)
      }
      fastStaticPages.set(entry.path, fastHandler)
    }

    router.add(entry.path, { entry, mod, layouts, middlewares, fastHandler, docPrefix, docSuffix })
  }

  async function renderCompiledRoute(route: CompiledRoute, ctx: RequestContext): Promise<Response> {
    const { entry, mod, layouts } = route

    // Serve prerendered HTML after middlewares have passed (when route had middlewares)
    if (ctx.request.method === 'GET' || ctx.request.method === 'HEAD') {
      const pre = prerenderedMap.get(ctx.url.pathname)
      if (pre !== undefined)
        return servePrerendered(ctx.request, ctx.url.pathname, pre)
    }

    // API route (.ts exporting GET/POST/etc.)
    const methodHandler = mod[ctx.request.method]
    if (typeof methodHandler === 'function') {
      const res = await (methodHandler as (c: RequestContext) => Response | Promise<Response>)(ctx)
      return maybeCompressResponse(res, ctx.request, compressCache)
    }

    if (typeof mod.default !== 'function')
      return new Response('Method Not Allowed', { status: 405 })

    const data = entry.hasLoad && typeof mod.load === 'function' ? await mod.load(ctx) : undefined
    if (data instanceof Response)
      return data
    const pageProps: Record<string, unknown> = {
      params: ctx.params,
      locals: ctx.locals,
      url: ctx.url,
      ...(data !== undefined ? { data } : {}),
    }

    const rctx = createRenderContext()
    const renderBody = async (): Promise<string> => {
      let inner: string
      if (entry.isIsland && entry.islandChunk !== undefined) {
        inner = ssrIsland(
          entry.path,
          entry.islandChunk,
          () => ssrChild(mod.default!(pageProps) as Html),
          data !== undefined ? { data } : {},
          entry.islandHydrate as HydrateStrategy | undefined,
        )
      }
      else {
        inner = ssrChild(await mod.default!(pageProps) as Html)
      }
      for (let i = layouts.length - 1; i >= 0; i--)
        inner = ssrChild(await layouts[i]!.default({ children: raw(inner), url: ctx.url, params: ctx.params, locals: ctx.locals }) as Html)
      return inner
    }

    const body = await runWithRenderContext(rctx, renderBody)
    const collectedHead = renderCollectedHead(rctx)
    const renderedIslands = extractRenderedIslands(body)
    const hasIslands = renderedIslands.hasIslands || rctx.pending.length > 0 && entry.islandChunks.length > 0
    const preloadChunks = rctx.pending.length > 0 ? entry.islandChunks : renderedIslands.eagerChunks

    const routeStyles = entry.styles ?? manifest.styles
    const routeHeadTags = entry.headTags !== undefined && entry.headTags.length > 0
      ? [...(manifest.headTags ?? []), ...entry.headTags]
      : manifest.headTags

    // Streaming SSR path when <Suspense> boundaries are pending (never buffered for compression)!
    if (rctx.pending.length > 0) {
      const shell = renderDocument({
        body: '\0',
        head: collectedHead,
        headTags: routeHeadTags,
        lang,
        runtimeScript: manifest.runtimeScript,
        alwaysLoadRuntime,
        preloadChunks,
        styles: routeStyles,
        hasIslands,
        hasSuspense: true,
      })
      const splitAt = shell.indexOf('\0')
      const headHtml = shell.slice(0, splitAt)
      const tailHtml = shell.slice(splitAt + 1)

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(textEncoder.encode(headHtml + body))
          await Promise.all(
            rctx.pending.map(async (chunk) => {
              const resolved = await chunk.promise
              controller.enqueue(textEncoder.encode(streamChunkScript(chunk.id, resolved)))
            }),
          )
          controller.enqueue(textEncoder.encode(tailHtml))
          controller.close()
        },
      })

      return new Response(stream, { status: 200, headers: { ...selectHtmlHeaders(hasIslands, true) } })
    }

    let html = renderDocument({
      body,
      head: collectedHead,
      headTags: routeHeadTags,
      lang,
      runtimeScript: manifest.runtimeScript,
      alwaysLoadRuntime,
      preloadChunks,
      styles: routeStyles,
      hasIslands,
    })

    for (let i = 0; i < htmlTransformers.length; i++)
      html = await htmlTransformers[i]!(html, ctx)

    return compressedHtmlResponse(html, 200, selectHtmlHeaders(hasIslands, false), ctx.request, compressCache)
  }

  const rootLayoutFile = manifest.routes.find(r => r.layouts.length > 0)?.layouts[0]
  const rootLayoutMod = rootLayoutFile !== undefined ? modules[rootLayoutFile] as LoadedLayoutModule | undefined : undefined
  const fallbackStyles = manifest.globalStyles ?? manifest.styles

  async function renderError(error: unknown, cookieStore: CookieStore, url?: URL): Promise<Response> {
    if (errorMod !== undefined) {
      const rctx = createRenderContext()
      const body = await runWithRenderContext(rctx, async () => {
        let inner = ssrChild(await errorMod.default({ error }) as Html)
        if (rootLayoutMod !== undefined)
          inner = ssrChild(await rootLayoutMod.default({ children: raw(inner), url: url ?? new URL('http://localhost/500'), params: {}, locals: {} }) as Html)
        return inner
      })
      const html = renderDocument({ body, head: renderCollectedHead(rctx), headTags: manifest.headTags, styles: fallbackStyles, runtimeScript: manifest.runtimeScript, alwaysLoadRuntime, lang })
      return finalizeResponse(new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }), cookieStore, securityEntries)
    }
    return finalizeResponse(new Response('Internal Server Error', { status: 500 }), cookieStore, securityEntries)
  }

  async function renderNotFound(cookieStore: CookieStore, url?: URL): Promise<Response> {
    const notFoundFn = notFoundMod?.default
    if (notFoundFn !== undefined) {
      const rctx = createRenderContext()
      const body = await runWithRenderContext(rctx, async () => {
        let inner = ssrChild(await notFoundFn({}) as Html)
        if (rootLayoutMod !== undefined)
          inner = ssrChild(await rootLayoutMod.default({ children: raw(inner), url: url ?? new URL('http://localhost/404'), params: {}, locals: {} }) as Html)
        return inner
      })
      const html = renderDocument({ body, head: renderCollectedHead(rctx), headTags: manifest.headTags, styles: fallbackStyles, runtimeScript: manifest.runtimeScript, alwaysLoadRuntime, lang })
      return finalizeResponse(new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }), cookieStore, securityEntries)
    }
    return finalizeResponse(new Response('Not Found', { status: 404 }), cookieStore, securityEntries)
  }

  async function handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname

    // 1. Static client assets
    if (request.method === 'GET' || request.method === 'HEAD') {
      const asset = assetMap.get(pathname)
      if (asset !== undefined)
        return serveAsset(request, pathname, asset)
    }

    // 1b. Static public/ files (no-cache in dev so edits/plugins never get stuck in browser cache)
    if (request.method === 'GET' || request.method === 'HEAD') {
      const pub = publicMap.get(pathname)
      if (pub !== undefined)
        return servePublic(request, pathname, pub)
    }

    // 2. Server actions (POST /_kay/action/<id>) — run global plugin middlewares first so ctx.locals (e.g. auth user) is populated
    if (request.method === 'POST') {
      const act = actionHandlers.get(pathname)
      if (act !== undefined) {
        const { ctx, cookieStore } = makeRequestContext(request, {})
        const runAction = async (): Promise<Response> => {
          const actionCtx: ActionContext = {
            request: ctx.request,
            url: ctx.url,
            params: ctx.params,
            cookies: ctx.cookies,
            locals: ctx.locals,
            redirect: ctx.redirect,
            deny: ctx.deny,
          }
          return executeAction(act, request, actionCtx, trustedOrigins)
        }
        if (globalMiddlewares.length === 0) {
          const res = await runAction()
          return finalizeResponse(res, cookieStore, securityEntries)
        }
        let index = -1
        const dispatch = async (i: number): Promise<Response> => {
          if (i <= index)
            throw new Error('kay: middleware called next() multiple times')
          index = i
          if (i < globalMiddlewares.length)
            return globalMiddlewares[i]!(ctx, () => dispatch(i + 1))
          return runAction()
        }
        const res = await dispatch(0)
        return finalizeResponse(res, cookieStore, securityEntries)
      }
    }

    const hasActionErrorFlash = (request.headers.get('cookie') ?? '').includes(`${ACTION_ERROR_COOKIE}=`)

    // 3. Prerendered static HTML (safe even when plugins add routes or build-time transformHtml!)
    if (!hasActionErrorFlash && (request.method === 'GET' || request.method === 'HEAD')) {
      const pre = fastPrerenderedMap.get(pathname)
      if (pre !== undefined)
        return servePrerendered(request, pathname, pre)
    }

    // 4. Ultra-fast static route path
    if (!hasActionErrorFlash && (request.method === 'GET' || request.method === 'HEAD')) {
      const fast = fastStaticPages.get(pathname)
      if (fast !== undefined)
        return fast(request)
    }

    // 5. Full Router + Plugin Rewrites + Plugin Routes + Middleware + Streaming/Head/Error pipeline
    const { ctx, cookieStore } = makeRequestContext(request, {})

    // Hydrate & clear one-shot progressive form validation flash cookie
    if (hasActionErrorFlash && request.method === 'GET') {
      const rawFlash = ctx.cookies.get(ACTION_ERROR_COOKIE)
      if (rawFlash !== undefined) {
        try {
          ctx.locals.actionError = JSON.parse(rawFlash) as ActionErrorFlash
        }
        catch {}
        ctx.cookies.delete(ACTION_ERROR_COOKIE)
      }
    }

    // Apply plugin URL rewrites (e.g. @kayjs/i18n stripping /fr prefix and setting ctx.locals.locale)
    let effectivePath = pathname
    for (let i = 0; i < pluginRewrites.length; i++) {
      const nextPath = pluginRewrites[i]!(effectivePath, ctx)
      if (nextPath !== undefined)
        effectivePath = nextPath
    }

    // Check custom plugin routes first (e.g. GET /sitemap.xml, POST /auth/callback, GET /api/board)
    // Run global plugin middlewares so ctx.locals (e.g. auth user/session) is available in plugin routes too.
    const pluginMatch = pluginRouter.match(effectivePath)
    if (pluginMatch !== undefined) {
      const methodHandler = pluginMatch.data.get(request.method.toUpperCase()) ?? pluginMatch.data.get('ALL')
      if (methodHandler !== undefined) {
        ctx.params = pluginMatch.params
        let res: Response
        if (globalMiddlewares.length === 0) {
          res = await methodHandler(ctx)
        }
        else {
          let index = -1
          const dispatch = async (i: number): Promise<Response> => {
            if (i <= index)
              throw new Error('kay: middleware called next() multiple times')
            index = i
            if (i < globalMiddlewares.length)
              return globalMiddlewares[i]!(ctx, () => dispatch(i + 1))
            return methodHandler(ctx)
          }
          res = await dispatch(0)
        }
        return finalizeResponse(await maybeCompressResponse(res, request, compressCache), cookieStore, securityEntries)
      }
    }

    const matched = router.match(effectivePath)
    if (matched === undefined)
      return renderNotFound(cookieStore, ctx.url)

    ctx.params = matched.params
    const route = matched.data
    const allMiddlewares = globalMiddlewares.length > 0
      ? [...globalMiddlewares, ...route.middlewares]
      : route.middlewares

    try {
      let index = -1
      const dispatch = async (i: number): Promise<Response> => {
        if (i <= index)
          throw new Error('kay: middleware called next() multiple times')
        index = i
        if (i < allMiddlewares.length)
          return allMiddlewares[i]!(ctx, () => dispatch(i + 1))
        return renderCompiledRoute(route, ctx)
      }
      const res = await dispatch(0)
      return finalizeResponse(res, cookieStore, securityEntries)
    }
    catch (error) {
      return renderError(error, cookieStore, ctx.url)
    }
  }

  function serve(port = 3000) {
    const routes: Record<string, (req: Request) => Response | Promise<Response>> = {}

    for (const [path, asset] of assetMap)
      routes[path] = req => serveAsset(req, path, asset)

    for (const [path, pub] of publicMap) {
      if (!(path in routes))
        routes[path] = req => servePublic(req, path, pub)
    }

    for (const [path, pre] of fastPrerenderedMap) {
      if (!(path in routes)) {
        routes[path] = req => (req.method === 'GET' || req.method === 'HEAD') && !(req.headers.get('cookie') ?? '').includes(`${ACTION_ERROR_COOKIE}=`)
          ? servePrerendered(req, path, pre)
          : handle(req)
      }
    }

    for (const [path, handler] of fastStaticPages) {
      if (!(path in routes)) {
        routes[path] = req => (req.method === 'GET' || req.method === 'HEAD') && !(req.headers.get('cookie') ?? '').includes(`${ACTION_ERROR_COOKIE}=`)
          ? handler(req)
          : handle(req)
      }
    }

    return Bun.serve({
      port,
      idleTimeout: 0,
      routes,
      fetch: handle,
    })
  }

  return { handle, serve }
}

function createStaticDirServer(
  outDir: string,
  assetPrefix: string,
  securityEntries: readonly [string, string][],
  compressEnabled: boolean,
): KayApp {
  const cleanPrefix = `${assetPrefix.replace(/\/$/, '')}/`
  const absRoot = resolve(outDir)
  const compressCache = compressEnabled ? new CompressionCache() : undefined

  function resolveStaticFile(pathname: string): string | undefined {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    }
    catch {
      return undefined
    }
    const rel = decoded.replace(/^\/+/, '').replace(/\/+$/, '')
    const candidates = rel === ''
      ? ['index.html']
      : [rel, `${rel}.html`, `${rel}/index.html`]
    for (const c of candidates) {
      const abs = resolve(absRoot, c)
      if (abs !== absRoot && !abs.startsWith(`${absRoot}/`) && !abs.startsWith(`${absRoot}\\`))
        continue
      if (existsSync(abs) && statSync(abs).isFile())
        return abs
    }
    return undefined
  }

  const initHeaders = (): Headers => {
    const headers = new Headers()
    for (let i = 0; i < securityEntries.length; i++)
      headers.set(securityEntries[i]![0], securityEntries[i]![1])
    return headers
  }

  const handle = async (req: Request): Promise<Response> => {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return new Response('Method Not Allowed', { status: 405 })

    const url = new URL(req.url)
    const filePath = resolveStaticFile(url.pathname)
    if (filePath === undefined) {
      const notFoundPath = join(absRoot, '404.html')
      if (existsSync(notFoundPath) && statSync(notFoundPath).isFile()) {
        const headers = initHeaders()
        headers.set('content-type', 'text/html; charset=utf-8')
        return new Response(req.method === 'HEAD' ? null : Bun.file(notFoundPath), { status: 404, headers })
      }
      return new Response('Not Found', { status: 404 })
    }

    const st = statSync(filePath)
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    const isImmutable = url.pathname.startsWith(cleanPrefix)
    const cacheControl = isImmutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate'
    const headers = initHeaders()
    headers.set('content-type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
    headers.set('cache-control', cacheControl)
    headers.set('etag', etag)

    if (req.headers.get('if-none-match') === etag)
      return new Response(null, { status: 304, headers })

    const res = new Response(req.method === 'HEAD' ? null : Bun.file(filePath), { status: 200, headers })
    if (!compressEnabled || req.method === 'HEAD')
      return res
    return maybeCompressResponse(res, req, compressCache)
  }

  return {
    handle,
    serve(port = 3000) {
      return Bun.serve({ port, fetch: handle })
    },
  }
}

export async function createServer(options: ServerOptions): Promise<KayApp> {
  const root = resolve(options.root)
  const fileConfig = await loadConfig(root)
  const plugins = options.plugins ?? fileConfig.plugins ?? []
  const outDir = resolve(root, options.outDir ?? fileConfig.outDir ?? 'dist')
  const clientDir = join(outDir, 'client')
  const manifestPath = join(outDir, 'manifest.json')

  if (!existsSync(manifestPath)) {
    if (existsSync(outDir) && readdirSync(outDir).length > 0) {
      const securityOpt = options.security ?? fileConfig.security
      const securityEntries = securityOpt === false ? [] : buildSecurityHeaderEntries(securityOpt ?? {})
      return createStaticDirServer(
        outDir,
        options.assetPrefix ?? fileConfig.assetPrefix ?? '/_kay',
        securityEntries,
        (options.compress ?? fileConfig.compress) !== false,
      )
    }
    throw new Error(`kay server: missing ${manifestPath}. Run build() first.`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest
  const modules: Record<string, unknown> = {}
  const assets: Record<string, EmbeddedBody> = {}
  const publicAssets: Record<string, EmbeddedBody> = {}
  const publicEtags: Record<string, string> = {}
  const prerenderedFiles: Record<string, string> = {}
  const srcPublicDir = resolve(root, fileConfig.publicDir ?? 'public')

  // Store file paths only (zero-copy Bun.file() serving, zero startup RAM bloat!)
  for (const rel of manifest.assets) {
    const abs = join(clientDir, rel)
    if (existsSync(abs))
      assets[rel] = abs
  }

  for (const rel of manifest.publicFiles ?? []) {
    const outAbs = join(outDir, 'public', rel)
    const abs = existsSync(outAbs) ? outAbs : join(srcPublicDir, rel)
    if (existsSync(abs)) {
      publicAssets[rel] = abs
      const st = statSync(abs)
      publicEtags[rel] = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    }
  }

  const loadStamp = Date.now()
  const loadMod = async (rel: string) => {
    if (!(rel in modules))
      modules[rel] = await import(`${join(outDir, rel)}?v=${loadStamp}`)
  }

  for (const r of manifest.routes) {
    await loadMod(r.file)
    for (const l of r.layouts) await loadMod(l)
    for (const m of r.middlewares) await loadMod(m)
    if (r.prerendered) {
      for (const [, relHtml] of Object.entries(r.prerendered)) {
        const abs = join(outDir, relHtml)
        if (existsSync(abs))
          prerenderedFiles[relHtml] = abs
      }
    }
  }
  if (manifest.errorFile) await loadMod(manifest.errorFile)
  if (manifest.notFoundFile) await loadMod(manifest.notFoundFile)
  for (const a of manifest.actions) await loadMod(a.file)

  return createServerFromEmbedded({
    manifest,
    modules,
    assets,
    publicAssets,
    publicEtags,
    prerendered: {},
    prerenderedFiles,
    assetPrefix: options.assetPrefix ?? fileConfig.assetPrefix,
    lang: options.lang ?? fileConfig.lang,
    security: options.security ?? fileConfig.security,
    trustedOrigins: options.trustedOrigins ?? fileConfig.trustedOrigins,
    compress: options.compress ?? fileConfig.compress,
    plugins,
  })
}
