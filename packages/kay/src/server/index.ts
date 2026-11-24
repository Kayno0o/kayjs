// Kay v2 native Bun.serve server:
// - Static + dynamic ([param], [...catchall]) Router
// - Composable directory-scoped _middleware.ts chains + ctx.cookies + ctx.locals
// - Unified Standard-Schema action() endpoint handling with CSRF verification
// - <Head> collection + streaming <Suspense> (0-overhead fast path when unused)
// - Hybrid prerendered HTML serving + embedded single-executable mode

import type { BuildManifest, RouteManifestEntry } from '../build/index'
import type { Html, HydrateStrategy } from '../jsx-runtime'
import type { KayPlugin, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI } from '../plugins/index'
import type { ActionContext, ActionErrorFlash, ServerAction } from './action'
import type { CookieStore } from './cookies'
import type { EmbeddedBody, EmbeddedServerConfig, KayApp, Middleware, RequestContext, ServerOptions } from './http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { loadConfig } from '../plugins/index'
import { createRenderContext, renderCollectedHead, runWithRenderContext, streamChunkScript } from '../ssr/context'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { ACTION_ERROR_COOKIE, executeAction, isServerAction } from './action'
import { CompressionCache, compressedHtmlResponse, isCompressibleType, maybeCompressResponse, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
import { applyHstsHeader, DEFAULT_MAX_REQUEST_BODY_SIZE, enforceRequestBodyLimit, extractRenderedIslands, finalizeResponse, makeRequestContext, MIME } from './http'
import { Router } from './router'
import { buildSecurityHeaderEntries, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, resolveCspPolicy, resolveHstsValue, verifyOrigin, withCspHashes } from './security'

export { defineConfig, definePlugin, loadConfig } from '../plugins/index'
export type { BuildPluginContext, CheckPluginContext, KayConfig, KayPlugin, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI } from '../plugins/index'
export { action, getActionError } from './action'
export type { ActionContext, ActionErrorFlash, ActionOptions, ActionResult, ServerAction } from './action'
export { CompressionCache, isCompressibleType, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
export type { CompressionEncoding, PrecompressedEncoding } from './compress'
export type { CookieOptions, Cookies } from './cookies'
export { defineEnv } from './env'
export { DEFAULT_MAX_REQUEST_BODY_SIZE } from './http'
export type { EmbeddedServerConfig, KayApp, Middleware, RequestContext, ServerOptions } from './http'
export { DEFAULT_CSP, DEFAULT_HSTS, getClientIp, isHttpsRequest, isTrustedOrigin, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, verifyOrigin, withCspHashes } from './security'
export type { SecurityHeadersOptions } from './security'
export type { InferInput, InferOutput, StandardSchemaIssue, StandardSchemaV1 } from './standard-schema'

interface LoadedPageModule {
  default?: (props: Record<string, unknown>) => Html | string | Promise<Html | string>
  load?: (ctx: RequestContext) => unknown | Promise<unknown>
  csrf?: boolean | undefined
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
  const trustProxy = config.trustProxy === true
  const maxRequestBodySize = config.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE
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
  const nosniffEnabled = security !== false && (security?.contentTypeOptions ?? true)
  const hstsValue = resolveHstsValue(security)
  const withHsts = (res: Response, request: Request): Response => applyHstsHeader(res, request, hstsValue, trustProxy)

  const htmlBaseHeaders: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', ...securityRecord }
  const baseCsp = resolveCspPolicy(security)
  const makeHtmlHeaders = (hasIslands: boolean, hasSuspense: boolean, isDynamic: boolean): Record<string, string> => {
    const base = isDynamic
      ? { ...htmlBaseHeaders, 'cache-control': 'private' }
      : htmlBaseHeaders
    if (baseCsp === undefined || (!hasIslands && !hasSuspense))
      return base
    const styleHashes: string[] = []
    const scriptHashes: string[] = []
    if (hasIslands)
      styleHashes.push(KAY_ISLAND_STYLE_HASH)
    if (hasSuspense) {
      styleHashes.push(KAY_SUSPENSE_STYLE_HASH)
      scriptHashes.push(KAY_STREAM_SCRIPT_HASH)
    }
    return { ...base, 'content-security-policy': withCspHashes(baseCsp, { styleHashes, scriptHashes }) }
  }
  const htmlHeadersPlain = makeHtmlHeaders(false, false, false)
  const htmlHeadersIslands = makeHtmlHeaders(true, false, false)
  const htmlHeadersSuspense = makeHtmlHeaders(false, true, false)
  const htmlHeadersBoth = makeHtmlHeaders(true, true, false)
  const selectHtmlHeaders = (hasIslands: boolean, hasSuspense: boolean): Record<string, string> =>
    hasIslands
      ? (hasSuspense ? htmlHeadersBoth : htmlHeadersIslands)
      : (hasSuspense ? htmlHeadersSuspense : htmlHeadersPlain)

  const dynHeadersPlain = makeHtmlHeaders(false, false, true)
  const dynHeadersIslands = makeHtmlHeaders(true, false, true)
  const dynHeadersSuspense = makeHtmlHeaders(false, true, true)
  const dynHeadersBoth = makeHtmlHeaders(true, true, true)
  const selectDynamicHtmlHeaders = (hasIslands: boolean, hasSuspense: boolean): Record<string, string> =>
    hasIslands
      ? (hasSuspense ? dynHeadersBoth : dynHeadersIslands)
      : (hasSuspense ? dynHeadersSuspense : dynHeadersPlain)

  const compressEnabled = config.compress ?? (process.env.KAY_DEV !== '1')
  const compressCache = compressEnabled ? new CompressionCache() : undefined

  // Collect plugin server hooks (supports both sync and async plugin setup)
  interface PluginRouteDef {
    handler: (ctx: RequestContext) => Response | Promise<Response>
    csrf: boolean
  }
  const globalMiddlewares: Middleware[] = []
  const pluginRewrites: ((pathname: string, ctx: RequestContext) => string | undefined)[] = []
  const pluginRouter = new Router<Map<string, PluginRouteDef>>()
  const pluginRouteEntries = new Map<string, Map<string, PluginRouteDef>>()

  const pluginApi: ServerPluginAPI = {
    use(mw) {
      globalMiddlewares.push(mw)
    },
    route(method, path, handler, options?: PluginRouteOptions) {
      let byMethod = pluginRouteEntries.get(path)
      if (byMethod === undefined) {
        byMethod = new Map()
        pluginRouteEntries.set(path, byMethod)
        pluginRouter.add(path, byMethod)
      }
      byMethod.set(method.toUpperCase(), { handler, csrf: options?.csrf ?? true })
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

  // Hashed build asset table (immutable cache + precompressed .br/.gz sidecars + optional lazy compression)
  interface AssetEntry {
    body: EmbeddedBody
    br?: EmbeddedBody | undefined
    gz?: EmbeddedBody | undefined
    type: string
    compressible: boolean
    headers: Record<string, string>
    varyHeaders: Record<string, string>
  }
  const assetMap = new Map<string, AssetEntry>()
  for (const [rel, body] of Object.entries(assets)) {
    const brSidecar = assets[`${rel}.br`] ?? (typeof body === 'string' && existsSync(`${body}.br`) ? `${body}.br` : undefined)
    const gzSidecar = assets[`${rel}.gz`] ?? (typeof body === 'string' && existsSync(`${body}.gz`) ? `${body}.gz` : undefined)
    const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    const compressible = isCompressibleType(type)
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      ...(nosniffEnabled ? { 'x-content-type-options': 'nosniff' } : {}),
    }
    const canVary = (compressible && compressCache !== undefined) || brSidecar !== undefined || gzSidecar !== undefined
    const varyHeaders: Record<string, string> = canVary
      ? { ...headers, vary: 'Accept-Encoding' }
      : headers
    assetMap.set(`${assetPrefix}/${rel}`, { body, br: brSidecar, gz: gzSidecar, type, compressible, headers, varyHeaders })
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
  const errorHooks: ((info: ServerErrorInfo) => void)[] = []
  if (config.onError !== undefined)
    errorHooks.push(config.onError)
  for (const p of plugins) {
    if (p.onError !== undefined)
      errorHooks.push(p.onError)
  }
  const notifyError = (error: unknown, request: Request, source: ServerErrorInfo['source']) => {
    for (let i = 0; i < errorHooks.length; i++) {
      try {
        errorHooks[i]!({ error, request, source })
      }
      catch {}
    }
  }

  async function serveAsset(request: Request, pathname: string, asset: AssetEntry): Promise<Response> {
    if (request.method === 'HEAD')
      return withHsts(new Response(null, { status: 200, headers: asset.varyHeaders }), request)

    // Serve precompressed .br / .gz sidecars directly without on-the-fly recompression
    if (compressEnabled && (asset.br !== undefined || asset.gz !== undefined)) {
      const preEnc = pickPrecompressedEncoding(request.headers.get('accept-encoding'), {
        br: asset.br !== undefined,
        gz: asset.gz !== undefined,
      })
      if (preEnc !== undefined) {
        const sidecar = preEnc === 'br' ? asset.br! : asset.gz!
        const headers: Record<string, string> = { ...asset.headers, 'content-encoding': preEnc, 'vary': 'Accept-Encoding' }
        if (headers.etag !== undefined)
          headers.etag = toWeakEtag(headers.etag)
        return withHsts(new Response(toResponseBody(sidecar), { status: 200, headers }), request)
      }
    }

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
            return withHsts(new Response(rawBytes, { status: 200, headers: asset.varyHeaders }), request)
        }
        return withHsts(new Response(compressed, {
          status: 200,
          headers: { ...asset.headers, 'content-encoding': enc, vary: 'Accept-Encoding' },
        }), request)
      }
    }

    return withHsts(new Response(toResponseBody(asset.body), { status: 200, headers: asset.varyHeaders }), request)
  }

  async function servePublic(request: Request, pathname: string, pub: PublicEntry): Promise<Response> {
    const cacheControl = process.env.KAY_DEV === '1' ? 'no-cache' : 'public, max-age=3600'
    const hasVary = pub.compressible && compressCache !== undefined
    const nosniffHeader: Record<string, string> = nosniffEnabled ? { 'x-content-type-options': 'nosniff' } : {}
    if (request.headers.get('if-none-match') === pub.etag) {
      const h: Record<string, string> = hasVary
        ? { 'etag': pub.etag, 'cache-control': cacheControl, 'vary': 'Accept-Encoding', ...nosniffHeader }
        : { 'etag': pub.etag, 'cache-control': cacheControl, ...nosniffHeader }
      return withHsts(new Response(null, { status: 304, headers: h }), request)
    }

    const baseHeaders: Record<string, string> = hasVary
      ? { 'content-type': pub.type, 'etag': pub.etag, 'cache-control': cacheControl, 'vary': 'Accept-Encoding', ...nosniffHeader }
      : { 'content-type': pub.type, 'etag': pub.etag, 'cache-control': cacheControl, ...nosniffHeader }

    if (request.method === 'HEAD')
      return withHsts(new Response(null, { status: 200, headers: baseHeaders }), request)

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
            return withHsts(new Response(rawBytes, { status: 200, headers: baseHeaders }), request)
        }
        return withHsts(new Response(compressed, {
          status: 200,
          headers: { ...baseHeaders, 'etag': toWeakEtag(pub.etag), 'content-encoding': enc },
        }), request)
      }
    }

    return withHsts(new Response(toResponseBody(pub.body), { status: 200, headers: baseHeaders }), request)
  }

  async function servePrerendered(request: Request, pathname: string, pre: PrerenderEntry): Promise<Response> {
    const base = selectHtmlHeaders(pre.hasIslands, false)
    const headers = compressCache !== undefined
      ? { ...base, vary: 'Accept-Encoding' }
      : base

    if (request.method === 'HEAD')
      return withHsts(new Response(null, { status: 200, headers }), request)

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
            return withHsts(new Response(rawBytes, { status: 200, headers }), request)
        }
        return withHsts(new Response(compressed, {
          status: 200,
          headers: { ...headers, 'content-encoding': enc },
        }), request)
      }
    }

    const body = pre.kind === 'file' ? Bun.file(pre.path) : pre.html
    return withHsts(new Response(body, { status: 200, headers }), request)
  }

  // Register server actions and assign their live URLs
  const actionHandlers = new Map<string, { act: ServerAction<unknown, unknown>, middlewares: Middleware[] }>()
  for (const entry of manifest.actions) {
    const mod = modules[entry.file] as Record<string, unknown> | undefined
    const act = mod?.[entry.exportName]
    if (isServerAction(act)) {
      ;(act as { url: string }).url = entry.url
      const middlewares = entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default)
      actionHandlers.set(entry.url, { act, middlewares: [...globalMiddlewares, ...middlewares] })
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
    fastHandler: ((req: Request, remoteIp?: string) => Response | Promise<Response>) | undefined
    docPrefix: string
    docSuffix: string
  }

  const router = new Router<CompiledRoute>()
  const fastStaticPages = new Map<string, (req: Request, remoteIp?: string) => Response | Promise<Response>>()

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

    let fastHandler: ((req: Request, remoteIp?: string) => Response | Promise<Response>) | undefined
    if (canFastPath) {
      const singleLayout = layouts.length === 1 ? layouts[0]! : undefined
      const fastHeaders = selectDynamicHtmlHeaders(hasIslands, false)

      fastHandler = (request: Request, remoteIp?: string): Response | Promise<Response> => {
        const handleErr = (error: unknown): Promise<Response> => {
          notifyError(error, request, 'route')
          return renderError(error, makeRequestContext(request, {}, { trustProxy, remoteIp }).cookieStore, new URL(request.url), request)
        }
        try {
          const reqUrl = new URL(request.url)
          const respondHtml = (body: string): Response =>
            withHsts(compressedHtmlResponse(docPrefix + body + docSuffix, 200, fastHeaders, request, compressCache), request)

          const wrapLayouts = (inner: string): Response | Promise<Response> => {
            if (layouts.length === 0)
              return respondHtml(inner)
            if (singleLayout !== undefined) {
              const w = singleLayout.default({ children: raw(inner), url: reqUrl, params: {}, locals: {} })
              if (w instanceof Promise)
                return w.then(x => respondHtml(ssrChild(x as Html)), handleErr)
              return respondHtml(ssrChild(w as Html))
            }
            return (async () => {
              let cur = inner
              for (let i = layouts.length - 1; i >= 0; i--)
                cur = ssrChild(await layouts[i]!.default({ children: raw(cur), url: reqUrl, params: {}, locals: {} }) as Html)
              return respondHtml(cur)
            })().catch(handleErr)
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
              return rendered.then(r => wrapLayouts(ssrChild(r as Html)), handleErr)
            return wrapLayouts(ssrChild(rendered as Html))
          }

          if (entry.hasLoad && typeof mod.load === 'function') {
            const { ctx, cookieStore } = makeRequestContext(request, {}, { trustProxy, remoteIp })
            const finish = (res: Response | Promise<Response>): Response | Promise<Response> => {
              if (!cookieStore.hasChanges)
                return res instanceof Promise ? res.then(r => withHsts(r, request), handleErr) : withHsts(res, request)
              if (res instanceof Promise)
                return res.then(r => withHsts(finalizeResponse(r, cookieStore, securityEntries), request), handleErr)
              return withHsts(finalizeResponse(res, cookieStore, securityEntries), request)
            }
            const loaded = mod.load(ctx)
            if (loaded instanceof Promise) {
              return loaded.then(
                data => finish(data instanceof Response ? data : renderPage(data)),
                handleErr,
              )
            }
            if (loaded instanceof Response)
              return finish(loaded)
            return finish(renderPage(loaded))
          }
          return renderPage(undefined)
        }
        catch (error) {
          return handleErr(error)
        }
      }
      fastStaticPages.set(entry.path, fastHandler)
    }

    router.add(entry.path, { entry, mod, layouts, middlewares, fastHandler, docPrefix, docSuffix })
  }

  async function renderCompiledRoute(
    route: CompiledRoute,
    ctx: RequestContext,
    disableTimeout?: () => void,
  ): Promise<Response> {
    const { entry, mod, layouts } = route

    // Serve prerendered HTML after middlewares have passed (when route had middlewares)
    if (ctx.request.method === 'GET' || ctx.request.method === 'HEAD') {
      const rawPath = ctx.url.pathname
      const normPath = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
      const pre = prerenderedMap.get(rawPath) ?? prerenderedMap.get(normPath)
      if (pre !== undefined)
        return servePrerendered(ctx.request, rawPath, pre)
      // Prerendered dynamic route: unlisted param returns 404 (never falls back to SSR)
      if (entry.prerender === true && entry.prerendered !== undefined && (entry.path.includes(':') || entry.path.includes('*')))
        return buildNotFoundResponse(ctx.url)
    }

    // API route (.ts exporting GET/POST/etc.)
    const methodHandler = mod[ctx.request.method]
    if (typeof methodHandler === 'function') {
      const res = await (methodHandler as (c: RequestContext) => Response | Promise<Response>)(ctx)
      if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream'))
        disableTimeout?.()
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
      disableTimeout?.()
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

      return new Response(stream, { status: 200, headers: { ...selectDynamicHtmlHeaders(hasIslands, true) } })
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

    return compressedHtmlResponse(html, 200, selectDynamicHtmlHeaders(hasIslands, false), ctx.request, compressCache)
  }

  const rootLayoutFile = manifest.routes.find(r => r.layouts.length > 0)?.layouts[0]
  const rootLayoutMod = rootLayoutFile !== undefined ? modules[rootLayoutFile] as LoadedLayoutModule | undefined : undefined
  const fallbackStyles = manifest.globalStyles ?? manifest.styles

  async function buildErrorResponse(error: unknown, url?: URL): Promise<Response> {
    if (errorMod !== undefined) {
      try {
        const rctx = createRenderContext()
        const body = await runWithRenderContext(rctx, async () => {
          let inner = ssrChild(await errorMod.default({ error }) as Html)
          if (rootLayoutMod !== undefined)
            inner = ssrChild(await rootLayoutMod.default({ children: raw(inner), url: url ?? new URL('http://localhost/500'), params: {}, locals: {} }) as Html)
          return inner
        })
        const html = renderDocument({ body, head: renderCollectedHead(rctx), headTags: manifest.headTags, styles: fallbackStyles, runtimeScript: manifest.runtimeScript, alwaysLoadRuntime, lang })
        return new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private' } })
      }
      catch {}
    }
    return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  async function renderError(error: unknown, cookieStore: CookieStore, url?: URL, request?: Request): Promise<Response> {
    const base = finalizeResponse(await buildErrorResponse(error, url), cookieStore, securityEntries)
    return request !== undefined ? withHsts(base, request) : base
  }

  async function buildNotFoundResponse(url?: URL): Promise<Response> {
    const notFoundFn = notFoundMod?.default
    if (notFoundFn !== undefined) {
      try {
        const rctx = createRenderContext()
        const body = await runWithRenderContext(rctx, async () => {
          let inner = ssrChild(await notFoundFn({}) as Html)
          if (rootLayoutMod !== undefined)
            inner = ssrChild(await rootLayoutMod.default({ children: raw(inner), url: url ?? new URL('http://localhost/404'), params: {}, locals: {} }) as Html)
          return inner
        })
        const html = renderDocument({ body, head: renderCollectedHead(rctx), headTags: manifest.headTags, styles: fallbackStyles, runtimeScript: manifest.runtimeScript, alwaysLoadRuntime, lang })
        return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private' } })
      }
      catch {}
    }
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  async function renderNotFound(cookieStore: CookieStore, url?: URL, request?: Request): Promise<Response> {
    const base = finalizeResponse(await buildNotFoundResponse(url), cookieStore, securityEntries)
    return request !== undefined ? withHsts(base, request) : base
  }

  function requestWantsJson(request: Request): boolean {
    return (request.headers.get('accept') ?? '').includes('application/json')
      || (request.headers.get('content-type') ?? '').includes('application/json')
  }

  async function handleInternal(request: Request, remoteIp?: string, disableTimeout?: () => void): Promise<Response> {
    try {
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

      // Enforce request body size cap before actions, plugin routes, and API routes
      const bounded = await enforceRequestBodyLimit(request, maxRequestBodySize)
      if (!bounded.ok) {
        const res413 = requestWantsJson(request)
          ? Response.json({ ok: false, status: 413, error: 'Payload Too Large' }, { status: 413 })
          : new Response('Payload Too Large', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } })
        return withHsts(finalizeResponse(res413, makeRequestContext(request, {}, { trustProxy, remoteIp }).cookieStore, securityEntries), request)
      }
      const req = bounded.request

      // 2. Server actions (POST /_kay/action/<id>): global plugin middlewares, then the _middleware.ts chain of the action's folder
      if (req.method === 'POST') {
        const handler = actionHandlers.get(pathname)
        if (handler !== undefined) {
          const { act, middlewares } = handler
          const { ctx, cookieStore } = makeRequestContext(req, {}, { trustProxy, remoteIp })
          const runAction = async (): Promise<Response> => {
            const actionCtx: ActionContext = {
              request: ctx.request,
              url: ctx.url,
              params: ctx.params,
              cookies: ctx.cookies,
              locals: ctx.locals,
              ip: ctx.ip,
              redirect: ctx.redirect,
              deny: ctx.deny,
            }
            return executeAction(act, req, actionCtx, trustedOrigins, trustProxy, maxRequestBodySize)
          }
          let index = -1
          const dispatch = async (i: number): Promise<Response> => {
            if (i <= index)
              throw new Error('kay: middleware called next() multiple times')
            index = i
            if (i < middlewares.length)
              return middlewares[i]!(ctx, () => dispatch(i + 1))
            return runAction()
          }
          try {
            const res = await dispatch(0)
            return withHsts(finalizeResponse(res, cookieStore, securityEntries), req)
          }
          catch (error) {
            notifyError(error, req, 'action')
            if (requestWantsJson(req)) {
              return withHsts(
                finalizeResponse(
                  Response.json({ ok: false, status: 500, error: 'Internal Server Error' }, { status: 500 }),
                  cookieStore,
                  securityEntries,
                ),
                req,
              )
            }
            return renderError(error, cookieStore, ctx.url, req)
          }
        }
      }

      const hasActionErrorFlash = (req.headers.get('cookie') ?? '').includes(`${ACTION_ERROR_COOKIE}=`)

      // 3. Prerendered static HTML (safe even when plugins add routes or build-time transformHtml!)
      if (!hasActionErrorFlash && (req.method === 'GET' || req.method === 'HEAD')) {
        const pre = fastPrerenderedMap.get(pathname)
        if (pre !== undefined)
          return servePrerendered(req, pathname, pre)
      }

      // 4. Ultra-fast static route path
      if (!hasActionErrorFlash && (req.method === 'GET' || req.method === 'HEAD')) {
        const fast = fastStaticPages.get(pathname)
        if (fast !== undefined)
          return fast(req, remoteIp)
      }

      // 5. Full Router + Plugin Rewrites + Plugin Routes + Middleware + Streaming/Head/Error pipeline
      const { ctx, cookieStore } = makeRequestContext(req, {}, { trustProxy, remoteIp })

      // Hydrate & clear one-shot progressive form validation flash cookie
      if (hasActionErrorFlash && req.method === 'GET') {
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
        const routeDef = pluginMatch.data.get(req.method.toUpperCase()) ?? pluginMatch.data.get('ALL')
        if (routeDef !== undefined) {
          if (routeDef.csrf) {
            const originCheck = verifyOrigin(req, trustedOrigins, trustProxy)
            if (!originCheck.ok) {
              return withHsts(
                finalizeResponse(
                  Response.json({ ok: false, status: 403, error: originCheck.reason }, { status: 403 }),
                  cookieStore,
                  securityEntries,
                ),
                req,
              )
            }
          }
          ctx.params = pluginMatch.params
          let res: Response
          try {
            if (globalMiddlewares.length === 0) {
              res = await routeDef.handler(ctx)
            }
            else {
              let index = -1
              const dispatch = async (i: number): Promise<Response> => {
                if (i <= index)
                  throw new Error('kay: middleware called next() multiple times')
                index = i
                if (i < globalMiddlewares.length)
                  return globalMiddlewares[i]!(ctx, () => dispatch(i + 1))
                return routeDef.handler(ctx)
              }
              res = await dispatch(0)
            }
            if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream'))
              disableTimeout?.()
            return withHsts(finalizeResponse(await maybeCompressResponse(res, req, compressCache), cookieStore, securityEntries), req)
          }
          catch (error) {
            notifyError(error, req, 'plugin')
            return renderError(error, cookieStore, ctx.url, req)
          }
        }
      }

      const matched = router.match(effectivePath)
      if (matched === undefined)
        return renderNotFound(cookieStore, ctx.url, req)

      ctx.params = matched.params
      const route = matched.data

      // CSRF verification for file-based API routes on unsafe methods (opt out via `export const csrf = false`)
      if (typeof route.mod[req.method] === 'function' && route.mod.csrf !== false) {
        const originCheck = verifyOrigin(req, trustedOrigins, trustProxy)
        if (!originCheck.ok) {
          return withHsts(
            finalizeResponse(
              Response.json({ ok: false, status: 403, error: originCheck.reason }, { status: 403 }),
              cookieStore,
              securityEntries,
            ),
            req,
          )
        }
      }

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
          return renderCompiledRoute(route, ctx, disableTimeout)
        }
        const res = await dispatch(0)
        if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream'))
          disableTimeout?.()
        return withHsts(finalizeResponse(res, cookieStore, securityEntries), req)
      }
      catch (error) {
        notifyError(error, req, 'route')
        return renderError(error, cookieStore, ctx.url, req)
      }
    }
    catch (error) {
      notifyError(error, request, 'route')
      return withHsts(
        new Response('Internal Server Error', {
          status: 500,
          headers: { 'content-type': 'text/plain; charset=utf-8', ...securityRecord },
        }),
        request,
      )
    }
  }

  function handle(request: Request, remoteIp?: string): Promise<Response> {
    return handleInternal(request, remoteIp)
  }

  function serve(port = 3000, hostname = '127.0.0.1') {
    let srvRef: ReturnType<typeof Bun.serve> | undefined
    const fetchReq = (req: Request) => handleInternal(
      req,
      srvRef?.requestIP(req)?.address,
      srvRef ? () => srvRef!.timeout(req, 0) : undefined,
    )

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
          : fetchReq(req)
      }
    }

    for (const [path, handler] of fastStaticPages) {
      if (!(path in routes)) {
        routes[path] = req => (req.method === 'GET' || req.method === 'HEAD') && !(req.headers.get('cookie') ?? '').includes(`${ACTION_ERROR_COOKIE}=`)
          ? handler(req, srvRef?.requestIP(req)?.address)
          : fetchReq(req)
      }
    }

    srvRef = Bun.serve({
      port,
      hostname,
      idleTimeout: 30,
      maxRequestBodySize,
      development: false,
      routes,
      fetch: fetchReq,
      error(err) {
        notifyError(err, new Request('http://localhost/'), 'route')
        return new Response('Internal Server Error', {
          status: 500,
          headers: { 'content-type': 'text/plain; charset=utf-8', ...securityRecord },
        })
      },
    })
    return srvRef
  }

  return { handle, serve }
}

function createStaticDirServer(
  outDir: string,
  assetPrefix: string,
  securityEntries: readonly [string, string][],
  compressEnabled: boolean,
  hstsValue: string | undefined,
  trustProxy: boolean,
): KayApp {
  const cleanPrefix = `${assetPrefix.replace(/\/$/, '')}/`
  const absRoot = resolve(outDir)
  const compressCache = compressEnabled ? new CompressionCache() : undefined
  const securityRecord: Record<string, string> = {}
  for (let i = 0; i < securityEntries.length; i++)
    securityRecord[securityEntries[i]![0]] = securityEntries[i]![1]
  const withHsts = (res: Response, req: Request) => applyHstsHeader(res, req, hstsValue, trustProxy)

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
      return withHsts(new Response('Method Not Allowed', { status: 405, headers: initHeaders() }), req)

    const url = new URL(req.url)
    const filePath = resolveStaticFile(url.pathname)
    if (filePath === undefined) {
      const notFoundPath = join(absRoot, '404.html')
      if (existsSync(notFoundPath) && statSync(notFoundPath).isFile()) {
        const headers = initHeaders()
        headers.set('content-type', 'text/html; charset=utf-8')
        return withHsts(new Response(req.method === 'HEAD' ? null : Bun.file(notFoundPath), { status: 404, headers }), req)
      }
      return withHsts(new Response('Not Found', { status: 404, headers: initHeaders() }), req)
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
      return withHsts(new Response(null, { status: 304, headers }), req)

    if (compressEnabled && req.method !== 'HEAD') {
      const hasBr = existsSync(`${filePath}.br`)
      const hasGz = existsSync(`${filePath}.gz`)
      if (hasBr || hasGz) {
        const preEnc = pickPrecompressedEncoding(req.headers.get('accept-encoding'), { br: hasBr, gz: hasGz })
        if (preEnc !== undefined) {
          headers.set('content-encoding', preEnc)
          headers.set('vary', 'Accept-Encoding')
          headers.set('etag', toWeakEtag(etag))
          return withHsts(new Response(Bun.file(`${filePath}.${preEnc === 'br' ? 'br' : 'gz'}`), { status: 200, headers }), req)
        }
      }
    }

    headers.set('content-length', String(st.size))
    const res = new Response(req.method === 'HEAD' ? null : Bun.file(filePath), { status: 200, headers })
    if (!compressEnabled || req.method === 'HEAD')
      return withHsts(res, req)
    return withHsts(await maybeCompressResponse(res, req, compressCache), req)
  }

  return {
    handle,
    serve(port = 3000, hostname = '127.0.0.1') {
      return Bun.serve({
        port,
        hostname,
        idleTimeout: 30,
        development: false,
        fetch: handle,
        error() {
          return new Response('Internal Server Error', {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=utf-8', ...securityRecord },
          })
        },
      })
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
  const securityOpt = options.security ?? fileConfig.security
  const trustProxy = (options.trustProxy ?? fileConfig.trustProxy) === true
  const maxRequestBodySize = options.maxRequestBodySize ?? fileConfig.maxRequestBodySize

  if (!existsSync(manifestPath)) {
    if (existsSync(outDir) && readdirSync(outDir).length > 0) {
      const securityEntries = securityOpt === false ? [] : buildSecurityHeaderEntries(securityOpt ?? {})
      return createStaticDirServer(
        outDir,
        options.assetPrefix ?? fileConfig.assetPrefix ?? '/_kay',
        securityEntries,
        (options.compress ?? fileConfig.compress) !== false,
        resolveHstsValue(securityOpt),
        trustProxy,
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
    if (existsSync(abs)) {
      assets[rel] = abs
      if (existsSync(`${abs}.br`))
        assets[`${rel}.br`] = `${abs}.br`
      if (existsSync(`${abs}.gz`))
        assets[`${rel}.gz`] = `${abs}.gz`
    }
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
  for (const a of manifest.actions) {
    await loadMod(a.file)
    for (const m of a.middlewares) await loadMod(m)
  }

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
    security: securityOpt,
    trustedOrigins: options.trustedOrigins ?? fileConfig.trustedOrigins,
    trustProxy,
    maxRequestBodySize,
    compress: options.compress ?? fileConfig.compress,
    onError: options.onError ?? fileConfig.onError,
    plugins,
  })
}
