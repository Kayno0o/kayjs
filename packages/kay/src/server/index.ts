// Kay v2 native Bun.serve server:
// - Static + dynamic ([param], [...catchall]) Router
// - Composable directory-scoped _middleware.ts chains + ctx.cookies + ctx.locals
// - Unified Standard-Schema action() endpoint handling with CSRF verification
// - <Head> collection + cancel-safe streaming <Suspense> (0-overhead fast path when unused)
// - Hybrid prerendered HTML serving + embedded single-executable mode

import type { RouteManifestEntry } from '../build/index'
import type { Html, HydrateStrategy } from '../jsx-runtime'
import type { DocumentOptions } from '../ssr/index'
import type { CookieStore } from './cookies'
import type { EmbeddedServerConfig, KayApp, Middleware, RequestContext } from './http'
import type { LoadedLayoutModule, LoadedMiddlewareModule, LoadedPageModule } from './page'
import type { FastHandler } from './routing'
import { join } from 'node:path'
import { createAppContext, getAppContext, resolvePlugins, runWithAppContext } from '../plugins/index'
import { createRenderContext, runWithRenderContext } from '../ssr/context'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { ACTION_ERROR_COOKIE, executeAction, finishActionRedirect, hydrateActionErrorFlash, isServerAction } from './action'
import { createActionRegistry } from './action-registry'
import { createAssets } from './assets'
import { CompressionCache, compressedHtmlResponse, maybeCompressResponse } from './compress'
import { createDocumentHooks, createHtmlHeaders, resolveRenderedIslands, withPluginHtmlCsp } from './document'
import { createErrorNotifier, createFallbackPages, devErrorResponse } from './errors'
import { applyHstsHeader, DEFAULT_MAX_REQUEST_BODY_SIZE, enforceRequestBodyLimit, finalizeResponse, isNotFound, makeRequestContext, runChain, wantsJson } from './http'
import { allowedMethodsHeader, mergedHeadTags, pickPageIslandProps, stripHeadBody } from './page'
import { allowedPluginMethodsHeader, createServerPluginHost } from './plugin-host'
import { requestedRegion, respondRegion } from './region'
import { Router } from './router'
import { actionRoutePrefix, createAncestorMiddlewareLookup, createFastStaticPageHandler, decodeRequestPathname, inferRoutesServerPrefix, methodNotAllowed, toBunRouteKey } from './routing'
import { buildSecurityHeaderEntries, inlineStyleHashes, resolveHstsValue, verifyOrigin } from './security'
import { STREAM_TAIL_MARK, streamDocument } from './stream'

/**
 * Request-scoped locals bag shared across middlewares, plugins, actions, layouts, and pages.
 * Augment via `declare module '@kayjs/kay/server' { interface KayLocals { ... } }`.
 */
export interface KayLocals {}

export { CONTENT_IMAGE_RESOLVER_SERVICE, createAppContext, defineConfig, definePlugin, getAppContext, I18N_CONFIG_SERVICE, loadConfig, pickRuntimeConfig, resolvePlugins, resolveServerConfig, runWithAppContext } from '../plugins/index'
export type { ActiveI18nConfig, AppRuntimeContext, BuildPluginContext, BuildPluginTarget, CheckPluginContext, ContentImageResolver, ContentImageResult, CreateAppContextOptions, DocumentHeadContext, FinalizeBuildContext, KayConfig, KayPlugin, MiddlewareOptions, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI, ServerRuntimeConfig } from '../plugins/index'
export { action, getActionError } from './action'
export type { ActionContext, ActionErrorFlash, ActionOptions, ActionResult, ServerAction } from './action'
export { CompressionCache, isCompressibleType, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
export type { CompressionEncoding, PrecompressedEncoding } from './compress'
export type { CookieOptions, Cookies } from './cookies'
export { defineEnv, nodeEnv } from './env'
export { DEFAULT_MAX_REQUEST_BODY_SIZE, notFound } from './http'
export type { EmbeddedServerConfig, ExtractRouteParams, KayApp, LayoutProps, LoaderData, LoaderFn, Middleware, NotFoundResult, PageProps, RequestContext, RouteContext, ServerOptions } from './http'
export { createServer } from './loader'
export { DEFAULT_CSP, DEFAULT_HSTS, DEFAULT_PERMISSIONS_POLICY, getClientIp, isHttpsRequest, isTrustedOrigin, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, verifyOrigin, withCspHashes } from './security'
export type { SecurityHeadersOptions, TrustProxy } from './security'
export { formatIssuePath, formatSchemaIssues, validateSchema, validateSchemaSync } from './standard-schema'
export type { InferInput, InferOutput, StandardSchemaIssue, StandardSchemaV1, ValidationFailure, ValidationResult, ValidationSuccess } from './standard-schema'

// Matches Bun.serve's 30 s idle timeout, which a streamed page turns off.
const DEFAULT_STREAM_TIMEOUT = 30_000

interface CompiledRoute {
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
}

const isRead = (request: Request): boolean => request.method === 'GET' || request.method === 'HEAD'
const isEventStream = (res: Response): boolean => (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
const hasActionErrorCookie = (request: Request): boolean => (request.headers.get('cookie') ?? '').includes(`${ACTION_ERROR_COOKIE}=`)
// A read the pre-rendered and fast static paths may answer: nothing to flash back to the page.
const isPlainRead = (request: Request): boolean => isRead(request) && !hasActionErrorCookie(request)


export async function createServerFromEmbedded(config: EmbeddedServerConfig): Promise<KayApp> {
  const { manifest, modules, assets, publicAssets = {}, publicEtags = {}, prerendered = {}, prerenderedFiles = {}, lang = 'en', security } = config
  const plugins = resolvePlugins(config.plugins)
  const assetPrefix = (config.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const site = config.site?.replace(/\/$/, '') || undefined
  const trustedOriginsList = config.trustedOrigins ?? []
  const trustedOrigins = trustedOriginsList.length > 0 ? new Set(trustedOriginsList) : undefined
  const trustProxy = config.trustProxy ?? false
  const maxRequestBodySize = config.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE
  const streamTimeout = config.streamTimeout ?? DEFAULT_STREAM_TIMEOUT
  const isDev = config.dev ?? (process.env.KAY_DEV === '1')
  const serverRoot = config.root ?? process.cwd()
  const serverOutDir = config.outDir ?? join(serverRoot, 'dist')
  const serverPublicDir = config.publicDir ?? join(serverOutDir, 'public')
  const parentAppCtx = getAppContext()

  const alwaysLoadRuntime = plugins.some(p => Boolean(p.clientEntry))
  const notifyError = createErrorNotifier(config.onError, plugins, { dev: isDev, sink: config.errorSink })
  const document = createDocumentHooks({ plugins, lang, trustProxy, notifyError })
  const { hasHeadHooks, hasHtmlTransformers, htmlTransformers, resolveDocumentHead } = document

  const securityEntries = buildSecurityHeaderEntries(security)
  const securityRecord: Record<string, string> = Object.fromEntries(securityEntries)
  const nosniffHeader: Record<string, string> = security !== false && (security?.contentTypeOptions ?? true) ? { 'x-content-type-options': 'nosniff' } : {}
  const hstsValue = resolveHstsValue(security)
  const withHsts = (res: Response, request: Request): Response => applyHstsHeader(res, request, hstsValue, trustProxy, isDev)
  // The one way out of every response not built with the security headers already in place.
  const finish = (res: Response, request: Request, cookieStore?: CookieStore): Response => withHsts(finalizeResponse(res, cookieStore, securityEntries), request)
  const serverError = (): Response => new Response('Internal Server Error', {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...securityRecord },
  })
  const htmlHeaders = createHtmlHeaders(security, securityRecord)

  const compressEnabled = config.compress ?? !isDev
  const compressCache = compressEnabled ? new CompressionCache() : undefined

  const files = createAssets({ assets, assetPrefix, isDev, compressEnabled, compressCache, nosniffHeader, withHsts })
  const { assetMap, publicMap, serveFile, serveAsset, servePublic } = files
  for (const [rel, body] of Object.entries(publicAssets))
    files.registerPublic(rel, body, publicEtags[rel])

  const serverAppCtx = createAppContext({
    root: serverRoot,
    outDir: serverOutDir,
    publicDir: serverPublicDir,
    assetPrefix,
    site,
    dev: isDev, nodeEnv: config.nodeEnv ?? parentAppCtx?.nodeEnv,
    onRegisterPublicFile: (rel) => {
      parentAppCtx?.registerPublicFile(rel)
      files.registerPublicFromDisk(serverPublicDir, rel)
    },
  })

  const actions = createActionRegistry()
  const pluginHost = await createServerPluginHost({
    plugins,
    config,
    manifest,
    appCtx: serverAppCtx,
    root: serverRoot,
    outDir: serverOutDir,
    assetPrefix,
    site,
    dev: isDev,
    trustProxy,
    trustedOriginsList,
    trustedOrigins,
  })
  const { router: pluginRouter, middlewaresFor, middlewaresForPaths } = pluginHost
  const hasPluginRewrites = pluginHost.rewrites.length > 0
  const routesPrefix = inferRoutesServerPrefix(manifest)
  const routePathByFile = new Map(manifest.routes.map(r => [r.file, r.path]))
  const ancestorMiddlewaresFor = createAncestorMiddlewareLookup(manifest, modules, routesPrefix)
  const pluginMiddlewaresFor = (effectiveScopedPath: string, rawScopedPath: string): readonly Middleware[] =>
    effectiveScopedPath === rawScopedPath
      ? middlewaresFor(effectiveScopedPath)
      : middlewaresForPaths([effectiveScopedPath, rawScopedPath])

  // Server actions and their live URLs
  for (const entry of manifest.actions) {
    const mod = modules[entry.file] as Record<string, unknown> | undefined
    const act = mod?.[entry.exportName]
    if (isServerAction(act)) {
      const routePrefix = actionRoutePrefix(entry, routesPrefix, routePathByFile)
      const pluginMws = routePrefix !== undefined ? middlewaresForPaths([entry.url, routePrefix]) : middlewaresFor(entry.url)
      actions.register(act, entry.exportName, entry.url, entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default), pluginMws)
    }
  }

  const { all: prerenderedMap, fast: fastPrerenderedMap } = files.collectPrerendered(manifest.routes, {
    prerendered,
    prerenderedFiles,
    htmlHeaders: (route, urlPath) => htmlHeaders(route.islandChunks.length > 0, false, false, route.prerenderedStyleHashes?.[urlPath]),
    isFast: (urlPath, route) => route.middlewares.length === 0 && middlewaresFor(urlPath, true).length === 0 && !hasPluginRewrites && pluginRouter.match(urlPath) === undefined,
  })

  const router = new Router<CompiledRoute>()
  const fastStaticPages = new Map<string, FastHandler>()

  const { buildNotFoundResponse, renderError } = createFallbackPages({ manifest, modules, lang, alwaysLoadRuntime, dev: isDev, document, htmlHeaders, notifyError, finish })

  async function renderNotFound(
    cookieStore: CookieStore,
    url: URL,
    request: Request,
    ctx: RequestContext,
    effectiveScopedPath: string,
    rawScopedPath: string,
  ): Promise<Response> {
    const pluginMws = pluginMiddlewaresFor(effectiveScopedPath, rawScopedPath)
    const ancestor = ancestorMiddlewaresFor(effectiveScopedPath)
    if (ancestor !== undefined)
      ctx.params = ancestor.params
    const chain = ancestor === undefined ? pluginMws : [...pluginMws, ...ancestor.middlewares]
    try {
      const res = await actions.run(ctx, () => runChain(ctx, chain, () => buildNotFoundResponse(url, request, ctx)))
      return finish(res, request, cookieStore)
    }
    catch (error) {
      notifyError(error, request, 'route')
      return renderError(error, cookieStore, url, request, ctx)
    }
  }

  function refuseCrossSite(request: Request, reason: string, cookieStore?: CookieStore): Response {
    return finish(Response.json({ ok: false, status: 403, error: reason }, { status: 403 }), request, cookieStore)
  }

  for (const entry of manifest.routes) {
    const mod = modules[entry.file] as LoadedPageModule
    const layouts = entry.layouts.map(l => modules[l] as LoadedLayoutModule)
    const dirMiddlewares = entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default)
    const routePluginMiddlewares = middlewaresFor(entry.path)
    const hasLoad = Boolean(entry.hasLoad && typeof mod.load === 'function')
    const fastPluginMiddlewares = middlewaresFor(entry.path, !hasLoad)
    const dynamic = entry.path.includes(':') || entry.path.includes('*')
    const hasIslands = entry.islandChunks.length > 0
    const doc: DocumentOptions = {
      body: '',
      headTags: mergedHeadTags(manifest, entry),
      lang,
      runtimeScript: manifest.runtimeScript,
      alwaysLoadRuntime,
      styles: entry.styles ?? manifest.styles,
    }

    // Zero-overhead path for a static route with no middleware, no <Head>/<Suspense>, and no intercepting plugin hook
    const canFastPath = fastPluginMiddlewares.length === 0
      && !hasPluginRewrites
      && !hasHeadHooks
      && !hasHtmlTransformers
      && pluginRouter.match(entry.path) === undefined
      && !dynamic
      && dirMiddlewares.length === 0
      && !entry.usesRenderContext
      && typeof mod.default === 'function'
      && mod.GET === undefined

    if (canFastPath) {
      fastStaticPages.set(entry.path, createFastStaticPageHandler({
        entry,
        mod,
        layouts,
        doc,
        hasIslands,
        hasLoad,
        trustProxy,
        htmlHeaders,
        compressCache,
        actions,
        buildNotFoundResponse,
        renderError,
        notifyError,
        finish,
        withHsts,
      }))
    }

    router.add(entry.path, { entry, mod, layouts, dirMiddlewares, middlewares: [...routePluginMiddlewares, ...dirMiddlewares], dynamic, doc })
  }

  async function renderCompiledRoute(
    route: CompiledRoute,
    ctx: RequestContext,
    disableTimeout?: () => void,
    staticPath?: string,
  ): Promise<Response> {
    const { entry, mod, layouts, doc } = route

    const isRegion = requestedRegion(ctx.request) !== undefined
    // Serve prerendered HTML after middlewares have passed (skip on full-page GETs with a flash cookie so it hydrates & clears, and on region requests)
    if (isRead(ctx.request)) {
      const lookupPath = staticPath ?? ctx.url.pathname
      const normPath = lookupPath.length > 1 && lookupPath.endsWith('/') ? lookupPath.slice(0, -1) : lookupPath
      const pre = staticPath !== undefined ? (prerenderedMap.get(lookupPath) ?? prerenderedMap.get(normPath)) : undefined
      if (pre !== undefined && !isRegion && (ctx.request.method === 'HEAD' || !hasActionErrorCookie(ctx.request)))
        return serveFile(ctx.request, pre)
      // Prerendered dynamic route: unlisted param returns 404 (never falls back to SSR)
      if (pre === undefined && entry.prerender === true && entry.prerendered !== undefined && route.dynamic)
        return buildNotFoundResponse(ctx.url, ctx.request, ctx)
    }

    // API route (.ts exporting GET/POST/etc.) — HEAD falls back to GET without a body
    const method = ctx.request.method.toUpperCase()
    const methodHandler = mod[method]
    if (typeof methodHandler === 'function')
      return await (methodHandler as (c: RequestContext) => Response | Promise<Response>)(ctx)
    if (method === 'HEAD' && typeof mod.GET === 'function')
      return stripHeadBody(await mod.GET(ctx))

    // Page routes only handle GET/HEAD; unsafe methods (POST/PUT/PATCH/DELETE) without a method export get 405.
    if (typeof mod.default !== 'function' || !isRead(ctx.request))
      return methodNotAllowed(allowedMethodsHeader(mod))

    // Hydrate one-shot flash cookie on full page GETs only; defer deletion until a full page renders (not load() redirects or <Region> requests)
    const hasFlash = ctx.request.method === 'GET' && !isRegion && hasActionErrorCookie(ctx.request) && hydrateActionErrorFlash(ctx)

    let data: unknown
    if (entry.hasLoad && typeof mod.load === 'function') {
      try {
        data = await mod.load(ctx)
      }
      catch (error) {
        if (isNotFound(error))
          return buildNotFoundResponse(ctx.url, ctx.request, ctx)
        throw error
      }
    }
    if (isNotFound(data))
      return buildNotFoundResponse(ctx.url, ctx.request, ctx)
    if (data instanceof Response)
      return data
    const pageProps: Record<string, unknown> = {
      params: ctx.params,
      locals: ctx.locals,
      url: ctx.url,
      ...(data !== undefined ? { data } : {}),
    }

    if (isRegion)
      return respondRegion(ctx.request, mod, pageProps, entry.path, htmlHeaders, rctx => resolveDocumentHead(rctx, doc.headTags as readonly string[] | undefined, ctx.url, ctx.request, ctx))

    const rctx = createRenderContext()
    const renderBody = async (): Promise<string> => {
      let inner: string
      if (entry.isIsland && entry.islandChunk !== undefined) {
        inner = ssrIsland(
          entry.islandChunk,
          () => ssrChild(mod.default!(pageProps) as Html),
          pickPageIslandProps(data, entry, mod),
          entry.islandHydrate as HydrateStrategy | undefined,
          true, mod.default!.name,
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
    if (hasFlash)
      ctx.cookies.delete(ACTION_ERROR_COOKIE)
    const docHead = await resolveDocumentHead(rctx, doc.headTags as readonly string[] | undefined, ctx.url, ctx.request, ctx)
    const renderedIslands = resolveRenderedIslands(rctx, body)
    const isStreamed = rctx.pending.length > 0
    const hasIslands = renderedIslands.hasIslands || (isStreamed && entry.islandChunks.length > 0)
    const preloadChunks = isStreamed ? entry.islandChunks : renderedIslands.eagerChunks

    // Streaming SSR when <Suspense> boundaries are pending (never buffered for compression)
    if (isStreamed) {
      if (ctx.request.method === 'HEAD')
        return new Response(null, { status: 200, headers: htmlHeaders(hasIslands, true, true) })
      disableTimeout?.()
      let shell = renderDocument({ ...doc, body: body + STREAM_TAIL_MARK, head: docHead.head, lang: docHead.lang, htmlAttrs: docHead.htmlAttrs, preloadChunks, hasIslands, hasSuspense: true })
      // Transforms see the document with its initial body; boundaries resolved later stream as they render.
      for (const transform of htmlTransformers)
        shell = await transform(shell, ctx)
      return new Response(streamDocument(shell, rctx, streamTimeout, error => notifyError(error, ctx.request, 'route')), { status: 200, headers: htmlHeaders(hasIslands, true, true, inlineStyleHashes(shell)) })
    }

    let html = renderDocument({ ...doc, body, head: docHead.head, lang: docHead.lang, htmlAttrs: docHead.htmlAttrs, preloadChunks, hasIslands })
    for (const transform of htmlTransformers)
      html = await transform(html, ctx)

    return compressedHtmlResponse(html, 200, htmlHeaders(hasIslands, false, true, inlineStyleHashes(html)), ctx.request, compressCache)
  }

  // `bodyLimited` is set under `serve()`, where Bun.serve already enforces maxRequestBodySize on every body, chunked ones included.
  async function handleInternal(request: Request, remoteIp?: string, disableTimeout?: () => void, bodyLimited = false): Promise<Response> {
    try {
      const url = new URL(request.url)
      const rawPathname = url.pathname
      const decoded = decodeRequestPathname(rawPathname)
      if (!decoded.ok)
        return finish(new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } }), request)
      const { staticPath, scopedPath } = decoded
      const read = isRead(request)

      // 1. Static client assets, then public/ files (explicit plugin routes take precedence over public/ files)
      if (read && staticPath !== undefined) {
        const asset = assetMap.get(staticPath)
        if (asset !== undefined)
          return serveAsset(request, asset)
        const pub = publicMap.get(staticPath)
        if (pub !== undefined) {
          const matchedPlugin = pluginRouter.match(rawPathname)
          const reqMethod = request.method.toUpperCase()
          const shadowedByPlugin = matchedPlugin !== undefined
            && (matchedPlugin.data.has(reqMethod) || (reqMethod === 'HEAD' && matchedPlugin.data.has('GET')) || matchedPlugin.data.has('ALL'))
          if (!shadowedByPlugin)
            return servePublic(request, pub)
        }
      }

      // Actions are origin-checked on POST before their body is read and before any middleware runs.
      const registeredAction = staticPath !== undefined ? actions.byUrl(staticPath) : undefined
      const actionHandler = request.method === 'POST' ? registeredAction : undefined
      if (actionHandler !== undefined) {
        const originCheck = verifyOrigin(request, trustedOrigins, trustProxy, url)
        if (!originCheck.ok)
          return refuseCrossSite(request, originCheck.reason)
      }

      // Enforce request body size cap before actions, plugin routes, and API routes
      const bounded = bodyLimited ? { ok: true as const, request } : await enforceRequestBodyLimit(request, maxRequestBodySize)
      if (!bounded.ok) {
        const res413 = wantsJson(request)
          ? Response.json({ ok: false, status: 413, error: 'Payload Too Large' }, { status: 413 })
          : new Response('Payload Too Large', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } })
        return finish(res413, request)
      }
      const req = bounded.request

      // 2. Server actions (POST /_kay/action/<id>; non-POST runs applicable middlewares before 405)
      if (registeredAction !== undefined) {
        const { act, middlewares } = registeredAction
        const { ctx, cookieStore } = makeRequestContext(req, {}, { trustProxy, remoteIp, url })
        try {
          const res = await actions.run(ctx, () => runChain(ctx, middlewares, () =>
            actionHandler !== undefined
              ? executeAction(act, req, ctx, trustedOrigins, trustProxy)
              : methodNotAllowed('POST'),
          ))
          return finish(actionHandler !== undefined ? finishActionRedirect(res, req) : res, req, cookieStore)
        }
        catch (error) {
          notifyError(error, req, 'action')
          return renderError(error, cookieStore, ctx.url, req, ctx)
        }
      }

      // 3. Prerendered static HTML, then 4. the zero-overhead static route path
      const plainRead = isPlainRead(req)
      if (plainRead && staticPath !== undefined) {
        const pre = fastPrerenderedMap.get(staticPath)
        if (pre !== undefined)
          return serveFile(req, pre)
        const fast = fastStaticPages.get(staticPath)
        if (fast !== undefined)
          return fast(req, remoteIp, url)
      }

      // 5. Full Router + Plugin Rewrites + Plugin Routes + Middleware + Streaming/Head/Error pipeline
      const { ctx, cookieStore } = makeRequestContext(req, {}, { trustProxy, remoteIp, url })

      // Apply plugin URL rewrites (e.g. @kayjs/i18n stripping /fr prefix and setting ctx.locals.locale)
      let effectivePath = rawPathname
      for (const rewrite of pluginHost.rewrites) {
        const nextPath = rewrite(effectivePath, ctx)
        if (nextPath !== undefined)
          effectivePath = nextPath
      }
      let effectiveScopedPath = scopedPath
      if (effectivePath !== rawPathname) {
        const reDecoded = decodeRequestPathname(effectivePath)
        if (!reDecoded.ok)
          return finish(new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } }), req, cookieStore)
        effectiveScopedPath = reDecoded.scopedPath
      }

      // Custom plugin routes run behind path-matched plugin middlewares so ctx.locals is available without cross-scope leaks.
      const method = req.method.toUpperCase()
      const pluginMatch = pluginRouter.match(effectivePath)
      const directPluginDef = pluginMatch?.data.get(method) ?? pluginMatch?.data.get('ALL')
      const headFallbackPluginDef = directPluginDef === undefined && method === 'HEAD' ? pluginMatch?.data.get('GET') : undefined
      const routeDef = directPluginDef ?? headFallbackPluginDef
      if (pluginMatch !== undefined && routeDef !== undefined) {
        if (routeDef.csrf) {
          const originCheck = verifyOrigin(req, routeDef.trustedOrigins, routeDef.trustProxy, url)
          if (!originCheck.ok)
            return refuseCrossSite(req, originCheck.reason, cookieStore)
        }
        ctx.params = pluginMatch.params
        const pluginMws = pluginMiddlewaresFor(effectiveScopedPath, scopedPath)
        try {
          let res = await actions.run(ctx, () => runChain(ctx, pluginMws, () => routeDef.handler(ctx)))
          if (headFallbackPluginDef !== undefined)
            res = stripHeadBody(res)
          else if (isEventStream(res))
            disableTimeout?.()
          return finish(await maybeCompressResponse(await withPluginHtmlCsp(res, htmlHeaders), req, compressCache), req, cookieStore)
        }
        catch (error) {
          notifyError(error, req, 'plugin')
          return renderError(error, cookieStore, ctx.url, req, ctx)
        }
      }

      const matched = router.match(effectivePath)
      if (matched === undefined) {
        if (pluginMatch !== undefined) {
          ctx.params = pluginMatch.params
          const allow = allowedPluginMethodsHeader(pluginMatch.data)
          const pluginMws = pluginMiddlewaresFor(effectiveScopedPath, scopedPath)
          try {
            const res = await actions.run(ctx, () => runChain(ctx, pluginMws, () => methodNotAllowed(allow)))
            return finish(res, req, cookieStore)
          }
          catch (error) {
            notifyError(error, req, 'plugin')
            return renderError(error, cookieStore, ctx.url, req, ctx)
          }
        }
        return renderNotFound(cookieStore, ctx.url, req, ctx, effectiveScopedPath, scopedPath)
      }

      ctx.params = matched.params
      const route = matched.data

      // CSRF verification for file-based API routes on unsafe methods (opt out via `export const csrf = false`)
      if (typeof route.mod[method] === 'function' && route.mod.csrf !== false) {
        const originCheck = verifyOrigin(req, trustedOrigins, trustProxy, url)
        if (!originCheck.ok)
          return refuseCrossSite(req, originCheck.reason, cookieStore)
      }

      const routeMiddlewares = pluginHost.hasPathScopedMiddlewares && (route.dynamic || effectiveScopedPath !== scopedPath)
        ? [...pluginMiddlewaresFor(effectiveScopedPath, scopedPath), ...route.dirMiddlewares]
        : route.middlewares

      try {
        const res = await actions.run(ctx, () => runChain(ctx, routeMiddlewares, () => renderCompiledRoute(route, ctx, disableTimeout, staticPath)))
        if (isEventStream(res))
          disableTimeout?.()
        // Compress uncompressed API/middleware responses after the middleware chain unwinds.
        const finalRes = res.headers.has('content-encoding') ? res : await maybeCompressResponse(res, req, compressCache)
        return finish(finalRes, req, cookieStore)
      }
      catch (error) {
        notifyError(error, req, 'route')
        return renderError(error, cookieStore, ctx.url, req, ctx)
      }
    }
    catch (error) {
      notifyError(error, request, 'route')
      return withHsts(isDev ? devErrorResponse(error, request) : serverError(), request)
    }
  }

  function handle(request: Request, remoteIp?: string): Promise<Response> {
    return runWithAppContext(serverAppCtx, () => handleInternal(request, remoteIp))
  }

  function serve(port = 3000, hostname = '127.0.0.1') {
    let srvRef: ReturnType<typeof Bun.serve> | undefined
    const ipOf = (req: Request) => srvRef?.requestIP(req)?.address
    const fetchReq = (req: Request) => runWithAppContext(serverAppCtx, () => handleInternal(
      req,
      ipOf(req),
      srvRef ? () => srvRef!.timeout(req, 0) : undefined,
      true,
    ))

    const routes: Record<string, (req: Request) => Response | Promise<Response>> = {}
    const registerServeRoute = (path: string, handler: (req: Request) => Response | Promise<Response>): void => {
      const key = toBunRouteKey(path)
      if (key !== undefined && !(key in routes))
        routes[key] = handler
    }

    for (const [path, asset] of assetMap)
      registerServeRoute(path, req => isRead(req) ? serveAsset(req, asset) : fetchReq(req))

    for (const [path, pub] of publicMap) {
      if (pluginRouter.match(path) === undefined)
        registerServeRoute(path, req => isRead(req) ? servePublic(req, pub) : fetchReq(req))
    }

    for (const [path, pre] of fastPrerenderedMap)
      registerServeRoute(path, req => isPlainRead(req) ? serveFile(req, pre) : fetchReq(req))

    for (const [path, handler] of fastStaticPages)
      registerServeRoute(path, req => isPlainRead(req) ? runWithAppContext(serverAppCtx, () => handler(req, ipOf(req))) : fetchReq(req))

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
        return serverError()
      },
    })
    return srvRef
  }

  return { handle, serve, dispose: pluginHost.dispose }
}
