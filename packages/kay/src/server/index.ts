// Kay v2 native Bun.serve server:
// - Static + dynamic ([param], [...catchall]) Router
// - Composable directory-scoped _middleware.ts chains + ctx.cookies + ctx.locals
// - Unified Standard-Schema action() endpoint handling with CSRF verification
// - <Head> collection + cancel-safe streaming <Suspense> (0-overhead fast path when unused)
// - Hybrid prerendered HTML serving + embedded single-executable mode

import type { RouteManifestEntry } from '../build/index'
import type { Html, HydrateStrategy } from '../jsx-runtime'
import type { DocumentOptions } from '../ssr/index'
import type { ActionErrorFlash } from './action'
import type { CookieStore } from './cookies'
import type { EmbeddedServerConfig, KayApp, Middleware, RequestContext } from './http'
import type { LoadedLayoutModule, LoadedMiddlewareModule, LoadedPageModule } from './page'
import { join } from 'node:path'
import { createAppContext, getAppContext, resolvePlugins, runWithAppContext } from '../plugins/index'
import { createRenderContext, runWithRenderContext } from '../ssr/context'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { ACTION_ERROR_COOKIE, executeAction, isServerAction } from './action'
import { createActionRegistry } from './action-registry'
import { createAssets } from './assets'
import { CompressionCache, compressedHtmlResponse, maybeCompressResponse } from './compress'
import { createDocumentHooks, createHtmlHeaders, resolveRenderedIslands, withPluginHtmlCsp } from './document'
import { createErrorNotifier, createFallbackPages, devErrorResponse } from './errors'
import { applyHstsHeader, DEFAULT_MAX_REQUEST_BODY_SIZE, enforceRequestBodyLimit, finalizeResponse, isNotFound, makeRequestContext, runChain, wantsJson } from './http'
import { allowedMethodsHeader, isPlainObject, mergedHeadTags, pickPageIslandProps, stripHeadBody } from './page'
import { allowedPluginMethodsHeader, createServerPluginHost } from './plugin-host'
import { requestedRegion, respondRegion } from './region'
import { Router } from './router'
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

type FastHandler = (req: Request, remoteIp?: string, url?: URL) => Response | Promise<Response>

interface CompiledRoute {
  entry: RouteManifestEntry
  mod: LoadedPageModule
  layouts: LoadedLayoutModule[]
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
    dev: isDev,
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
  const { router: pluginRouter, middlewaresFor } = pluginHost
  const hasPluginRewrites = pluginHost.rewrites.length > 0

  // Server actions and their live URLs
  for (const entry of manifest.actions) {
    const mod = modules[entry.file] as Record<string, unknown> | undefined
    const act = mod?.[entry.exportName]
    if (isServerAction(act))
      actions.register(act, entry.exportName, entry.url, entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default), middlewaresFor(entry.url))
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

  async function renderNotFound(cookieStore: CookieStore, url: URL, request: Request, ctx: RequestContext): Promise<Response> {
    const res = await runChain(ctx, middlewaresFor(url.pathname), () => buildNotFoundResponse(url, request, ctx))
    return finish(res, request, cookieStore)
  }

  function refuseCrossSite(request: Request, reason: string, cookieStore?: CookieStore): Response {
    return finish(Response.json({ ok: false, status: 403, error: reason }, { status: 403 }), request, cookieStore)
  }

  for (const entry of manifest.routes) {
    const mod = modules[entry.file] as LoadedPageModule
    const layouts = entry.layouts.map(l => modules[l] as LoadedLayoutModule)
    const dirMiddlewares = entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default)
    const routePluginMiddlewares = middlewaresFor(entry.path)
    const fastPluginMiddlewares = middlewaresFor(entry.path, true)
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
      const shell = renderDocument({ ...doc, body: '\0', preloadChunks: entry.eagerIslandChunks ?? entry.islandChunks, hasIslands })
      const splitAt = shell.indexOf('\0')
      const docPrefix = shell.slice(0, splitAt)
      const docSuffix = shell.slice(splitAt + 1)
      const singleLayout = layouts.length === 1 ? layouts[0]! : undefined


      const fail = (error: unknown, request: Request, url: URL, cookieStore?: CookieStore, ctx?: RequestContext): Promise<Response> => {
        notifyError(error, request, 'route')
        return renderError(error, cookieStore, url, request, ctx)
      }
      const respondHtml = (body: string, request: Request, cookieStore?: CookieStore): Response => {
        const html = docPrefix + body + docSuffix
        const res = compressedHtmlResponse(html, 200, htmlHeaders(hasIslands, false, true, inlineStyleHashes(html)), request, compressCache, !entry.hasLoad)
        return cookieStore?.hasChanges ? finish(res, request, cookieStore) : withHsts(res, request)
      }
      const layoutProps = (inner: string, url: URL, locals: KayLocals) => ({ children: raw(inner), url, params: {}, locals })

      const finishSingleLayout = async (wrapped: Promise<Html | string>, request: Request, url: URL, cookieStore?: CookieStore, ctx?: RequestContext): Promise<Response> => {
        try {
          return respondHtml(ssrChild(await wrapped as Html), request, cookieStore)
        }
        catch (error) {
          return fail(error, request, url, cookieStore, ctx)
        }
      }

      const wrapLayouts = (inner: string, request: Request, url: URL, locals: KayLocals, cookieStore?: CookieStore, ctx?: RequestContext): Response | Promise<Response> => {
        if (layouts.length === 0)
          return respondHtml(inner, request, cookieStore)
        if (singleLayout !== undefined) {
          const wrapped = singleLayout.default(layoutProps(inner, url, locals))
          if (wrapped instanceof Promise)
            return finishSingleLayout(wrapped, request, url, cookieStore, ctx)
          return respondHtml(ssrChild(wrapped as Html), request, cookieStore)
        }
        return (async () => {
          try {
            let cur = inner
            for (let i = layouts.length - 1; i >= 0; i--)
              cur = ssrChild(await layouts[i]!.default(layoutProps(cur, url, locals)) as Html)
            return respondHtml(cur, request, cookieStore)
          }
          catch (error) {
            return fail(error, request, url, cookieStore, ctx)
          }
        })()
      }

      const finishAsyncPage = async (rendered: Promise<Html | string>, request: Request, url: URL, locals: KayLocals, cookieStore?: CookieStore, ctx?: RequestContext): Promise<Response> => {
        try {
          return await wrapLayouts(ssrChild(await rendered as Html), request, url, locals, cookieStore, ctx)
        }
        catch (error) {
          return fail(error, request, url, cookieStore, ctx)
        }
      }

      const renderPage = (data: unknown, request: Request, url: URL, locals: KayLocals, cookieStore?: CookieStore, ctx?: RequestContext): Response | Promise<Response> => {
        const pageProps: Record<string, unknown> = { params: {}, locals, url, ...(data !== undefined ? { data } : {}) }
        if (entry.isIsland && entry.islandChunk !== undefined) {
          return wrapLayouts(ssrIsland(
            entry.islandChunk,
            () => ssrChild(mod.default!(pageProps) as Html),
            pickPageIslandProps(data, entry, mod),
            entry.islandHydrate as HydrateStrategy | undefined,
            true, mod.default!.name,
          ), request, url, locals, cookieStore, ctx)
        }
        const rendered = mod.default!(pageProps)
        if (rendered instanceof Promise)
          return finishAsyncPage(rendered, request, url, locals, cookieStore, ctx)
        return wrapLayouts(ssrChild(rendered as Html), request, url, locals, cookieStore, ctx)
      }

      fastStaticPages.set(entry.path, (request, remoteIp, url = new URL(request.url)) => {
        try {
          if (!entry.hasLoad || typeof mod.load !== 'function')
            return renderPage(undefined, request, url, {})

          const { ctx, cookieStore } = makeRequestContext(request, {}, { trustProxy, remoteIp, url })
          return (async () => {
            try {
              const loaded = await actions.run(ctx, () => mod.load!(ctx))
              if (isNotFound(loaded))
                return finish(await buildNotFoundResponse(url, request, ctx), request, cookieStore)
              if (loaded instanceof Response)
                return finish(loaded, request, cookieStore)
              return await renderPage(loaded, request, url, ctx.locals, cookieStore, ctx)
            }
            catch (error) {
              if (isNotFound(error))
                return finish(await buildNotFoundResponse(url, request, ctx), request, cookieStore)
              return fail(error, request, url, cookieStore, ctx)
            }
          })()
        }
        catch (error) {
          return fail(error, request, url)
        }
      })
    }

    router.add(entry.path, { entry, mod, layouts, middlewares: [...routePluginMiddlewares, ...dirMiddlewares], dynamic, doc })
  }

  async function renderCompiledRoute(
    route: CompiledRoute,
    ctx: RequestContext,
    disableTimeout?: () => void,
  ): Promise<Response> {
    const { entry, mod, layouts, doc } = route

    // Serve prerendered HTML after middlewares have passed (when route had middlewares)
    if (isRead(ctx.request)) {
      const rawPath = ctx.url.pathname
      const normPath = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
      const pre = prerenderedMap.get(rawPath) ?? prerenderedMap.get(normPath)
      if (pre !== undefined)
        return serveFile(ctx.request, pre)
      // Prerendered dynamic route: unlisted param returns 404 (never falls back to SSR)
      if (entry.prerender === true && entry.prerendered !== undefined && route.dynamic)
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
    if (typeof mod.default !== 'function' || !isRead(ctx.request)) {
      const allow = allowedMethodsHeader(mod)
      return new Response('Method Not Allowed', allow ? { status: 405, headers: { allow } } : { status: 405 })
    }

    // Hydrate & clear one-shot progressive form validation flash cookie only on page GETs (never API/plugin GETs)
    if (ctx.request.method === 'GET' && hasActionErrorCookie(ctx.request)) {
      const rawFlash = ctx.cookies.get(ACTION_ERROR_COOKIE)
      if (rawFlash !== undefined) {
        try {
          const parsed: unknown = JSON.parse(rawFlash)
          if (isPlainObject(parsed))
            ctx.locals.actionError = parsed as unknown as ActionErrorFlash
        }
        catch {}
        ctx.cookies.delete(ACTION_ERROR_COOKIE)
      }
    }

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

    if (requestedRegion(ctx.request) !== undefined)
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
      const pathname = url.pathname
      const read = isRead(request)

      // 1. Static client assets, then public/ files (explicit plugin routes take precedence over public/ files)
      if (read) {
        const asset = assetMap.get(pathname)
        if (asset !== undefined)
          return serveAsset(request, asset)
        const pub = publicMap.get(pathname)
        if (pub !== undefined) {
          const matchedPlugin = pluginRouter.match(pathname)
          const reqMethod = request.method.toUpperCase()
          const shadowedByPlugin = matchedPlugin !== undefined
            && (matchedPlugin.data.has(reqMethod) || (reqMethod === 'HEAD' && matchedPlugin.data.has('GET')) || matchedPlugin.data.has('ALL'))
          if (!shadowedByPlugin)
            return servePublic(request, pub)
        }
      }

      // Actions only accept POST; other methods get 405 before any middleware runs.
      const registeredAction = actions.byUrl(pathname)
      if (registeredAction !== undefined && request.method !== 'POST')
        return finish(new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } }), request)

      // Actions are origin-checked before their body is read and before any middleware runs.
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

      // 2. Server actions (POST /_kay/action/<id>): plugin middlewares, then the _middleware.ts chain of the action's folder
      if (actionHandler !== undefined) {
        const { act, middlewares } = actionHandler
        const { ctx, cookieStore } = makeRequestContext(req, {}, { trustProxy, remoteIp, url })
        try {
          return finish(await actions.run(ctx, () => runChain(ctx, middlewares, () => executeAction(act, req, ctx, trustedOrigins, trustProxy))), req, cookieStore)
        }
        catch (error) {
          notifyError(error, req, 'action')
          return renderError(error, cookieStore, ctx.url, req, ctx)
        }
      }

      // 3. Prerendered static HTML, then 4. the zero-overhead static route path
      const plainRead = isPlainRead(req)
      if (plainRead) {
        const pre = fastPrerenderedMap.get(pathname)
        if (pre !== undefined)
          return serveFile(req, pre)
        const fast = fastStaticPages.get(pathname)
        if (fast !== undefined)
          return fast(req, remoteIp, url)
      }

      // 5. Full Router + Plugin Rewrites + Plugin Routes + Middleware + Streaming/Head/Error pipeline
      const { ctx, cookieStore } = makeRequestContext(req, {}, { trustProxy, remoteIp, url })

      // Apply plugin URL rewrites (e.g. @kayjs/i18n stripping /fr prefix and setting ctx.locals.locale)
      let effectivePath = pathname
      for (const rewrite of pluginHost.rewrites) {
        const nextPath = rewrite(effectivePath, ctx)
        if (nextPath !== undefined)
          effectivePath = nextPath
      }

      // Custom plugin routes run behind plugin middlewares so ctx.locals (e.g. auth user/session) is available.
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
        try {
          let res = await actions.run(ctx, () => runChain(ctx, pluginHost.allMiddlewares, () => routeDef.handler(ctx)))
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
          const allow = allowedPluginMethodsHeader(pluginMatch.data)
          return finish(new Response('Method Not Allowed', allow ? { status: 405, headers: { allow } } : { status: 405 }), req)
        }
        return renderNotFound(cookieStore, ctx.url, req, ctx)
      }

      ctx.params = matched.params
      const route = matched.data

      // Reject unsupported HTTP methods with 405 + Allow BEFORE any middleware or CSRF check runs.
      const supportsMethod = typeof route.mod[method] === 'function'
        || (method === 'HEAD' && typeof route.mod.GET === 'function')
        || (typeof route.mod.default === 'function' && (method === 'GET' || method === 'HEAD'))
      if (!supportsMethod) {
        const allow = allowedMethodsHeader(route.mod)
        return finish(new Response('Method Not Allowed', allow ? { status: 405, headers: { allow } } : { status: 405 }), req)
      }

      // CSRF verification for file-based API routes on unsafe methods (opt out via `export const csrf = false`)
      if (typeof route.mod[method] === 'function' && route.mod.csrf !== false) {
        const originCheck = verifyOrigin(req, trustedOrigins, trustProxy, url)
        if (!originCheck.ok)
          return refuseCrossSite(req, originCheck.reason, cookieStore)
      }

      try {
        const res = await actions.run(ctx, () => runChain(ctx, route.middlewares, () => renderCompiledRoute(route, ctx, disableTimeout)))
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

    for (const [path, asset] of assetMap)
      routes[path] = req => isRead(req) ? serveAsset(req, asset) : fetchReq(req)

    for (const [path, pub] of publicMap) {
      if (!(path in routes) && pluginRouter.match(path) === undefined)
        routes[path] = req => isRead(req) ? servePublic(req, pub) : fetchReq(req)
    }

    for (const [path, pre] of fastPrerenderedMap) {
      if (!(path in routes))
        routes[path] = req => isPlainRead(req) ? serveFile(req, pre) : fetchReq(req)
    }

    for (const [path, handler] of fastStaticPages) {
      if (!(path in routes))
        routes[path] = req => isPlainRead(req) ? runWithAppContext(serverAppCtx, () => handler(req, ipOf(req))) : fetchReq(req)
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
        return serverError()
      },
    })
    return srvRef
  }

  return { handle, serve, dispose: pluginHost.dispose }
}
