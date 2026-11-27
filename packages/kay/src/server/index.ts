// Kay v2 native Bun.serve server:
// - Static + dynamic ([param], [...catchall]) Router
// - Composable directory-scoped _middleware.ts chains + ctx.cookies + ctx.locals
// - Unified Standard-Schema action() endpoint handling with CSRF verification
// - <Head> collection + cancel-safe streaming <Suspense> (0-overhead fast path when unused)
// - Hybrid prerendered HTML serving + embedded single-executable mode

import type { Html, HydrateStrategy } from '../jsx-runtime'
import type { ActionRegistry, RegisteredAction } from './action-registry'
import type { NormalizedConsentConfig } from './consent'
import type { CookieStore } from './cookies'
import type { NotifyError } from './errors'
import type { EmbeddedServerConfig, KayApp, KayServer, Middleware, RequestContext } from './http'
import type { LoadedMiddlewareModule } from './page'
import type { RequestPath } from './request-path'
import type { CompiledRoute } from './route-table'
import type { FastHandler } from './routing'
import type { TrustProxy } from './security'
import { join } from 'node:path'
import { createAppContext, getAppContext, resolvePlugins, runWithAppContext } from '../plugins/index'
import { createRenderContext, runWithRenderContext } from '../ssr/context'
import { createNavigation } from '../ssr/navigation'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { ACTION_ERROR_COOKIE, executeAction, finishActionRedirect, hydrateActionErrorFlash, isServerAction } from './action'
import { createActionRegistry } from './action-registry'
import { createAssets } from './assets'
import { CompressionCache, compressedHtmlResponse, markCompressionHandled, maybeCompressResponse } from './compress'
import { normalizeConsentConfig } from './consent'
import { addedInlineStyleHashes, createDocumentHooks, createHtmlHeaders, mergeStyleHashes, resolveRenderedIslands, revivePreload, withPluginHtmlCsp } from './document'
import { createErrorNotifier, createFallbackPages, devErrorResponse } from './errors'
import { applyHstsHeader, DEFAULT_MAX_REQUEST_BODY_SIZE, enforceRequestBodyLimit, finalizeResponse, isNotFound, makeRequestContext, runChain, wantsJson } from './http'
import { allowedMethodsHeader, pickPageIslandProps, stripHeadBody } from './page'
import { allowedPluginMethodsHeader, createServerPluginHost } from './plugin-host'
import { hasRegionHeader, invalidRegionResponse, requestedRegion, respondRegion, withRegionVary } from './region'
import { decodeRequestPath, literalPath } from './request-path'
import { nativePrerenderedCheck } from './prerendered'
import { compileRouteTable } from './route-table'
import { actionRoutePrefix, createAncestorMiddlewareLookup, inferRoutesServerPrefix, methodNotAllowed } from './routing'
import { hasActionErrorCookie, isPlainRead, isRead, serveHandlers } from './serve-handlers'
import { buildSecurityHeaderEntries, resolveHstsValue, styleHashesOf, verifyOrigin } from './security'
import { createStreamTracker, STREAM_TAIL_MARK, streamDocument } from './stream'

/**
 * Request-scoped locals bag shared across middlewares, plugins, actions, layouts, and pages.
 * Augment via `declare module '@kayjs/kay/server' { interface KayLocals { ... } }`.
 */
export interface KayLocals {}

export { CONTENT_IMAGE_RESOLVER_SERVICE, createAppContext, defineConfig, definePlugin, getAppContext, I18N_CONFIG_SERVICE, loadConfig, pickRuntimeConfig, resolvePlugins, resolveServerConfig, runWithAppContext } from '../plugins/index'
export type { ActiveI18nConfig, AppRuntimeContext, BuildPluginContext, BuildPluginTarget, CheckPluginContext, ComplianceConfig, ComplianceRule, ConsentConfig, ContentImageResolver, ContentImageResult, CreateAppContextOptions, DocumentHeadContext, FinalizeBuildContext, KayConfig, KayPlugin, MiddlewareOptions, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI, ServerRuntimeConfig } from '../plugins/index'
export { action, getActionError } from './action'
export type { ActionContext, ActionErrorFlash, ActionOptions, ActionResult, ServerAction } from './action'
export { CompressionCache, isCompressibleType, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
export type { CompressionEncoding, PrecompressedEncoding } from './compress'
export type { RequestConsent } from './consent'
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


const isEventStream = (res: Response): boolean => (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
const makeServerError = (securityRecord: Record<string, string>) => (): Response => new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', ...securityRecord } })
// A file body Bun could not open: a build swapped in since this app loaded, or a file deleted by hand. Never cached.
const badRequest = (): Response => new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })
const makeFileGone = (securityRecord: Record<string, string>) => (): Response => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...securityRecord } })

function lookupPrerendered<T>(map: ReadonlyMap<string, T>, staticPath: string | undefined): T | undefined {
  if (staticPath === undefined)
    return undefined
  const normPath = staticPath.length > 1 && staticPath.endsWith('/') ? staticPath.slice(0, -1) : staticPath
  return map.get(staticPath) ?? map.get(normPath)
}

async function renderRouteBody(route: CompiledRoute, data: unknown, pageProps: Record<string, unknown>, ctx: RequestContext): Promise<string> {
  const { entry, mod, layouts } = route
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


interface ActionDispatcherDeps {
  actions: ActionRegistry
  rewrites: readonly ((pathname: string, ctx: RequestContext) => string | undefined)[]
  trustedOrigins: Set<string> | undefined
  trustProxy: TrustProxy
  consent: NormalizedConsentConfig | undefined
  refuseCrossSite: (request: Request, reason: string, cookieStore?: CookieStore) => Response
  checkBodyLimit: (request: Request, bodyLimited: boolean, cookieStore?: CookieStore) => Promise<Request | Response>
  finish: (res: Response, request: Request, cookieStore?: CookieStore) => Response
  notifyError: NotifyError
  renderError: (error: unknown, cookieStore: CookieStore | undefined, url: URL, request: Request, ctx?: RequestContext) => Promise<Response>
}

function createActionDispatcher(deps: ActionDispatcherDeps) {
  const { actions, rewrites, trustedOrigins, trustProxy, consent, refuseCrossSite, checkBodyLimit, finish, notifyError, renderError } = deps
  return async (
    registeredAction: RegisteredAction,
    request: Request,
    url: URL,
    rawPathname: string,
    remoteIp: string | undefined,
    bodyLimited: boolean,
    existing?: { ctx: RequestContext, cookieStore: CookieStore },
  ): Promise<Response> => {
    const actionHandler = request.method === 'POST' ? registeredAction : undefined
    let req = request
    if (actionHandler !== undefined) {
      const originCheck = verifyOrigin(request, trustedOrigins, trustProxy, url)
      if (!originCheck.ok)
        return refuseCrossSite(request, originCheck.reason, existing?.cookieStore)
      const checked = await checkBodyLimit(request, bodyLimited, existing?.cookieStore)
      if (checked instanceof Response)
        return checked
      req = checked
    }
    const { act, middlewares } = registeredAction
    const { ctx, cookieStore } = existing ?? makeRequestContext(req, {}, { trustProxy, remoteIp, url, consent })
    ctx.request = req
    if (existing === undefined && rewrites.length > 0) {
      for (const rewrite of rewrites)
        rewrite(rawPathname, ctx)
    }
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
}

interface ManifestActions {
  manifest: EmbeddedServerConfig['manifest']
  modules: EmbeddedServerConfig['modules']
  actions: ReturnType<typeof createActionRegistry>
  routesPrefix: ReturnType<typeof inferRoutesServerPrefix>
  routePathByFile: Map<string, string>
  middlewaresFor: (path: string) => readonly Middleware[]
  middlewaresForPaths: (paths: string[]) => readonly Middleware[]
}

// Server actions and their live URLs.
function registerManifestActions({ manifest, modules, actions, routesPrefix, routePathByFile, middlewaresFor, middlewaresForPaths }: ManifestActions): void {
  for (const entry of manifest.actions) {
    const mod = modules[entry.file] as Record<string, unknown> | undefined
    const act = mod?.[entry.exportName]
    if (isServerAction(act)) {
      const routePrefix = actionRoutePrefix(entry, routesPrefix, routePathByFile)
      const pluginMws = routePrefix !== undefined ? middlewaresForPaths([entry.url, routePrefix]) : middlewaresFor(entry.url)
      actions.register(act, entry.exportName, entry.url, entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default), pluginMws)
    }
  }
}

export async function createServerFromEmbedded(config: EmbeddedServerConfig): Promise<KayApp> {
  const { manifest, modules, assets, publicAssets = {}, publicEtags = {}, prerendered = {}, prerenderedFiles = {}, prerenderedEtags = {}, lang = 'en', security } = config
  const plugins = resolvePlugins(config.plugins)
  const assetPrefix = (config.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const site = config.site?.replace(/\/$/, '') || undefined
  const trustedOriginsList = config.trustedOrigins ?? []
  const trustedOrigins = trustedOriginsList.length > 0 ? new Set(trustedOriginsList) : undefined
  const trustProxy = config.trustProxy ?? false
  const consent = normalizeConsentConfig(config.consent)
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
  const { hasHeadHooks, hasHtmlTransformers, resolveDocumentHead, applyHtmlTransforms } = document

  const securityEntries = buildSecurityHeaderEntries(security)
  const securityRecord: Record<string, string> = Object.fromEntries(securityEntries)
  const nosniffHeader: Record<string, string> = security !== false && (security?.contentTypeOptions ?? true) ? { 'x-content-type-options': 'nosniff' } : {}
  const hstsValue = resolveHstsValue(security)
  const withHsts = (res: Response, request: Request): Response => applyHstsHeader(res, request, hstsValue, trustProxy, isDev)
  // The one way out of every response not built with the security headers already in place.
  const finish = (res: Response, request: Request, cookieStore?: CookieStore): Response => withHsts(finalizeResponse(res, cookieStore, securityEntries), request)
  const serverError = makeServerError(securityRecord)
  const fileGone = makeFileGone(securityRecord)
  const navigation = createNavigation(config.navigation)
  const htmlHeaders = createHtmlHeaders(security, securityRecord, navigation)
  const streams = createStreamTracker()

  const compressEnabled = config.compress ?? !isDev
  const compressCache = compressEnabled ? new CompressionCache() : undefined

  const files = createAssets({ assets, assetPrefix, isDev, compressEnabled, compressCache, nosniffHeader, securityRecord, withHsts })
  const { assetMap, publicMap, serveFile } = files
  files.registerPublicFiles(publicAssets, publicEtags)

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

  registerManifestActions({ manifest, modules, actions, routesPrefix, routePathByFile, middlewaresFor, middlewaresForPaths })


  const { buildNotFoundResponse, renderError } = createFallbackPages({ manifest, modules, lang, alwaysLoadRuntime, navigation: navigation.html, dev: isDev, document, htmlHeaders, notifyError, finish })

  async function renderNotFound(
    cookieStore: CookieStore,
    url: URL,
    request: Request,
    ctx: RequestContext,
    effective: RequestPath,
    rawScopedPath: string,
  ): Promise<Response> {
    const pluginMws = pluginMiddlewaresFor(effective.scopedPath, rawScopedPath)
    const ancestor = ancestorMiddlewaresFor(effective)
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

  async function checkBodyLimit(request: Request, bodyLimited: boolean, cookieStore?: CookieStore): Promise<Request | Response> {
    if (bodyLimited)
      return request
    const bounded = await enforceRequestBodyLimit(request, maxRequestBodySize)
    if (bounded.ok)
      return bounded.request
    return finish(wantsJson(request)
      ? Response.json({ ok: false, status: 413, error: 'Payload Too Large' }, { status: 413 })
      : new Response('Payload Too Large', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } }), request, cookieStore)
  }

  const { router, fastStaticPages } = compileRouteTable({
    manifest, modules, lang, alwaysLoadRuntime, navigation: navigation.html, middlewaresFor,
    pluginIntercepts: path => hasPluginRewrites || hasHeadHooks || hasHtmlTransformers || pluginRouter.match(literalPath(path)) !== undefined,
    fast: { trustProxy, consent, htmlHeaders, compressCache, actions, buildNotFoundResponse, renderError, notifyError, finish, withHsts },
  })
  const { all: prerenderedMap, fast: fastPrerenderedMap } = files.collectPrerendered(manifest.routes, {
    prerendered,
    prerenderedFiles,
    prerenderedEtags,
    // The route's region script is what sends `x-kay-region`, so a page without one never varies on it.
    htmlHeaders: (route, urlPath) => withRegionVary(htmlHeaders(route.islandChunks.length > 0, false, false, route.prerenderedStyleHashes?.[urlPath]), route.usesRegion === true),
    isFast: nativePrerenderedCheck({ site, rewrites: pluginHost.rewrites, pluginRouter, router, actions, middlewaresForPaths, trustProxy, consent }),
  })

  async function renderCompiledRoute(
    route: CompiledRoute,
    ctx: RequestContext,
    disableTimeout?: () => void,
    staticPath?: string,
  ): Promise<Response> {
    const { entry, mod, doc } = route

    const isRegion = hasRegionHeader(ctx.request)
    // Serve prerendered HTML after middlewares have passed (skip on full-page GETs with a flash cookie so it hydrates & clears, and on region requests)
    if (isRead(ctx.request)) {
      const pre = lookupPrerendered(prerenderedMap, staticPath)
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
    if (isRegion && requestedRegion(ctx.request) === undefined)
      return invalidRegionResponse(ctx.request)

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

    if (isRegion) {
      return respondRegion(
        ctx.request, mod, pageProps, entry.path, htmlHeaders,
        rctx => resolveDocumentHead(rctx, doc.headTags as readonly string[] | undefined, ctx.url, ctx.request, ctx),
        streamTimeout, error => notifyError(error, ctx.request, 'route'),
        hasHtmlTransformers ? html => applyHtmlTransforms(html, ctx.url, ctx.request, ctx) : undefined,
      )
    }

    const rctx = createRenderContext(undefined, undefined, ctx.consent, error => notifyError(error, ctx.request, 'route'))
    const body = await runWithRenderContext(rctx, () => renderRouteBody(route, data, pageProps, ctx))
    if (hasFlash)
      ctx.cookies.delete(ACTION_ERROR_COOKIE)
    const docHead = await resolveDocumentHead(rctx, doc.headTags as readonly string[] | undefined, ctx.url, ctx.request, ctx)
    const renderedIslands = resolveRenderedIslands(rctx, body)
    const isStreamed = rctx.pending.length > 0
    const hasIslands = renderedIslands.hasIslands || (isStreamed && entry.islandChunks.length > 0)
    // A streamed page preloads before its boundaries render, so it takes the route's eager islands: a lazy one loads when its strategy fires.
    const preloadChunks = [...isStreamed ? entry.eagerIslandChunks ?? entry.islandChunks : renderedIslands.eagerChunks, ...revivePreload(rctx, manifest.reviveScript)]
    const hasRegions = rctx.regionNames.size > 0

    const trustedStyleHashes = mergeStyleHashes(route.headStyleHashes, docHead.styleHashes, styleHashesOf(rctx.inlineStyles))

    // Streaming SSR when <Suspense> boundaries are pending (never buffered for compression)
    if (isStreamed) {
      if (ctx.request.method === 'HEAD')
        return markCompressionHandled(new Response(null, { status: 200, headers: withRegionVary(htmlHeaders(hasIslands, true, true, trustedStyleHashes), hasRegions) }))
      disableTimeout?.()
      const docShell = renderDocument({ ...doc, body: body + STREAM_TAIL_MARK, head: docHead.head, lang: docHead.lang, htmlAttrs: docHead.htmlAttrs, preloadChunks, hasIslands, hasSuspense: true })
      // Transforms see the document with its initial body; boundaries resolved later stream as they render.
      const shell = hasHtmlTransformers ? await applyHtmlTransforms(docShell, ctx.url, ctx.request, ctx) : docShell
      const streamStyleHashes = mergeStyleHashes(trustedStyleHashes, addedInlineStyleHashes(docShell, shell))
      return markCompressionHandled(new Response(streamDocument(shell, rctx, streamTimeout, error => notifyError(error, ctx.request, 'route')), { status: 200, headers: withRegionVary(htmlHeaders(hasIslands, true, true, streamStyleHashes), hasRegions) }))
    }

    const docHtml = renderDocument({ ...doc, body, head: docHead.head, lang: docHead.lang, htmlAttrs: docHead.htmlAttrs, preloadChunks, hasIslands })
    const html = hasHtmlTransformers ? await applyHtmlTransforms(docHtml, ctx.url, ctx.request, ctx) : docHtml
    const finalStyleHashes = mergeStyleHashes(trustedStyleHashes, addedInlineStyleHashes(docHtml, html))

    return compressedHtmlResponse(html, 200, withRegionVary(htmlHeaders(hasIslands, false, true, finalStyleHashes), hasRegions), ctx.request, compressCache)
  }

  const dispatchAction = createActionDispatcher({
    actions, rewrites: pluginHost.rewrites, trustedOrigins, trustProxy, consent, refuseCrossSite, checkBodyLimit, finish, notifyError, renderError,
  })

  // `bodyLimited` is set under `serve()`, where Bun.serve already enforces maxRequestBodySize on every body, chunked ones included.
  async function handleInternal(request: Request, remoteIp?: string, disableTimeout?: () => void, bodyLimited = false): Promise<Response> {
    try {
      const url = new URL(request.url)
      const rawPathname = url.pathname
      const requestPath = decodeRequestPath(rawPathname)
      if (requestPath === undefined)
        return finish(badRequest(), request)
      const { staticPath, scopedPath } = requestPath
      const read = isRead(request)

      // 1. Static client assets, then public/ files (explicit plugin routes take precedence over public/ files)
      if (read && staticPath !== undefined) {
        const asset = assetMap.get(staticPath)
        if (asset !== undefined)
          return serveFile(request, asset)
        const pub = publicMap.get(staticPath)
        if (pub !== undefined) {
          const matchedPlugin = pluginRouter.match(requestPath)
          const reqMethod = request.method.toUpperCase()
          const shadowedByPlugin = matchedPlugin !== undefined
            && (matchedPlugin.data.has(reqMethod) || (reqMethod === 'HEAD' && matchedPlugin.data.has('GET')) || matchedPlugin.data.has('ALL'))
          if (!shadowedByPlugin)
            return serveFile(request, pub)
        }
      }

      // 2. Server actions (POST /_kay/action/<id>; non-POST runs applicable middlewares before 405)
      const registeredAction = staticPath !== undefined ? actions.byUrl(staticPath) : undefined
      if (registeredAction !== undefined)
        return dispatchAction(registeredAction, request, url, rawPathname, remoteIp, bodyLimited)

      // 3. Prerendered static HTML, then 4. the zero-overhead static route path
      const plainRead = isPlainRead(request)
      if (plainRead && staticPath !== undefined) {
        const pre = fastPrerenderedMap.get(staticPath)
        if (pre !== undefined)
          return serveFile(request, pre)
        const fast = fastStaticPages.get(staticPath)
        if (fast !== undefined)
          return fast(request, remoteIp, url)
      }

      // 5. Full Router + Plugin Rewrites + Plugin Routes + Middleware + Streaming/Head/Error pipeline
      const { ctx, cookieStore } = makeRequestContext(request, {}, { trustProxy, remoteIp, url, consent })

      // Apply plugin URL rewrites (e.g. @kayjs/i18n stripping /fr prefix and setting ctx.locals.locale)
      let effectivePath = rawPathname
      for (const rewrite of pluginHost.rewrites) {
        const nextPath = rewrite(effectivePath, ctx)
        if (nextPath !== undefined)
          effectivePath = nextPath
      }
      let effective = requestPath
      if (effectivePath !== rawPathname) {
        const rewritten = decodeRequestPath(effectivePath)
        if (rewritten === undefined)
          return finish(badRequest(), request, cookieStore)
        effective = rewritten
        const rewrittenAction = rewritten.staticPath !== undefined ? actions.byUrl(rewritten.staticPath) : undefined
        if (rewrittenAction !== undefined)
          return dispatchAction(rewrittenAction, request, url, effectivePath, remoteIp, bodyLimited, { ctx, cookieStore })
      }
      const { scopedPath: effectiveScopedPath, staticPath: effectiveStaticPath } = effective

      // Custom plugin routes run behind path-matched plugin middlewares so ctx.locals is available without cross-scope leaks.
      const method = request.method.toUpperCase()
      const pluginMatch = pluginRouter.match(effective)
      const directPluginDef = pluginMatch?.data.get(method) ?? pluginMatch?.data.get('ALL')
      const headFallbackPluginDef = directPluginDef === undefined && method === 'HEAD' ? pluginMatch?.data.get('GET') : undefined
      const routeDef = directPluginDef ?? headFallbackPluginDef
      if (pluginMatch !== undefined && routeDef !== undefined) {
        if (routeDef.csrf) {
          const originCheck = verifyOrigin(request, routeDef.trustedOrigins, routeDef.trustProxy, url)
          if (!originCheck.ok)
            return refuseCrossSite(request, originCheck.reason, cookieStore)
        }
        const checked = await checkBodyLimit(request, bodyLimited, cookieStore)
        if (checked instanceof Response)
          return checked
        ctx.request = checked
        ctx.params = pluginMatch.params
        const pluginMws = pluginMiddlewaresFor(effectiveScopedPath, scopedPath)
        try {
          let res = await actions.run(ctx, () => runChain(ctx, pluginMws, () => routeDef.handler(ctx)))
          if (headFallbackPluginDef !== undefined)
            res = stripHeadBody(res)
          else if (isEventStream(res))
            res = streams.track(res, disableTimeout)
          return finish(await maybeCompressResponse(await withPluginHtmlCsp(res, htmlHeaders), ctx.request, compressCache), ctx.request, cookieStore)
        }
        catch (error) {
          notifyError(error, ctx.request, 'plugin')
          return renderError(error, cookieStore, ctx.url, ctx.request, ctx)
        }
      }

      // Localized/rewritten public/ links (e.g. /fr/logo.png -> /logo.png)
      if (read && effectivePath !== rawPathname && effectiveStaticPath !== undefined) {
        const pub = publicMap.get(effectiveStaticPath)
        if (pub !== undefined)
          return serveFile(request, pub)
      }

      const matched = router.match(effective)
      if (matched === undefined) {
        if (pluginMatch !== undefined) {
          ctx.params = pluginMatch.params
          const allow = allowedPluginMethodsHeader(pluginMatch.data)
          const pluginMws = pluginMiddlewaresFor(effectiveScopedPath, scopedPath)
          try {
            const res = await actions.run(ctx, () => runChain(ctx, pluginMws, () => methodNotAllowed(allow)))
            return finish(res, request, cookieStore)
          }
          catch (error) {
            notifyError(error, request, 'plugin')
            return renderError(error, cookieStore, ctx.url, request, ctx)
          }
        }
        return renderNotFound(cookieStore, ctx.url, request, ctx, effective, scopedPath)
      }

      ctx.params = matched.params
      const route = matched.data

      // CSRF verification & body limit for file-based API routes (opt out of CSRF via `export const csrf = false`)
      if (typeof route.mod[method] === 'function') {
        if (route.mod.csrf !== false) {
          const originCheck = verifyOrigin(request, trustedOrigins, trustProxy, url)
          if (!originCheck.ok)
            return refuseCrossSite(request, originCheck.reason, cookieStore)
        }
        const checked = await checkBodyLimit(request, bodyLimited, cookieStore)
        if (checked instanceof Response)
          return checked
        ctx.request = checked
      }

      const routeMiddlewares = pluginHost.hasPathScopedMiddlewares && (route.dynamic || effectiveScopedPath !== scopedPath)
        ? [...pluginMiddlewaresFor(effectiveScopedPath, scopedPath), ...route.dirMiddlewares]
        : route.middlewares

      try {
        const rawRes = await actions.run(ctx, () => runChain(ctx, routeMiddlewares, () => renderCompiledRoute(route, ctx, disableTimeout, staticPath)))
        const res = isEventStream(rawRes) ? streams.track(rawRes, disableTimeout) : rawRes
        // Compress uncompressed API/middleware responses after the middleware chain unwinds.
        const finalRes = res.headers.has('content-encoding') ? res : await maybeCompressResponse(res, ctx.request, compressCache)
        return finish(finalRes, ctx.request, cookieStore)
      }
      catch (error) {
        notifyError(error, ctx.request, 'route')
        return renderError(error, cookieStore, ctx.url, ctx.request, ctx)
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

  const runRequest = (req: Request, remoteIp: string | undefined, disableTimeout: () => void): Promise<Response> => runWithAppContext(serverAppCtx, () => handleInternal(req, remoteIp, disableTimeout, true))
  const runFast = (handler: FastHandler, req: Request, remoteIp: string | undefined): Response | Promise<Response> => runWithAppContext(serverAppCtx, () => handler(req, remoteIp))
  const handlers = (server: () => KayServer | undefined) => serveHandlers(server, { files, fastPrerenderedMap, fastStaticPages, pluginRouter, runRequest, runFast, notifyError, serverError, fileGone })

  function serve(port = 3000, hostname = '127.0.0.1') {
    const server: KayServer = Bun.serve({ port, hostname, idleTimeout: 30, maxRequestBodySize, development: false, ...handlers(() => server) })
    return server
  }

  const reloadInto = (server: KayServer): void => {
    server.reload(handlers(() => server))
  }
  return { handle, serve, reloadInto, closeStreams: streams.closeAll, dispose: async () => { await streams.closeAll(); await pluginHost.dispose() } }
}
