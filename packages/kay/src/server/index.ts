// Kay v2 native Bun.serve server:
// - Static + dynamic ([param], [...catchall]) Router
// - Composable directory-scoped _middleware.ts chains + ctx.cookies + ctx.locals
// - Unified Standard-Schema action() endpoint handling with CSRF verification
// - <Head> collection + streaming <Suspense> (0-overhead fast path when unused)
// - Hybrid prerendered HTML serving + embedded single-executable mode

import type { BuildManifest, RouteManifestEntry } from '../build/index'
import type { Stats } from 'node:fs'
import type { Html, HydrateStrategy } from '../jsx-runtime'
import type { KayPlugin, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI } from '../plugins/index'
import type { DocumentOptions } from '../ssr/index'
import type { ActionErrorFlash, ServerAction } from './action'
import type { CookieStore } from './cookies'
import type { EmbeddedBody, EmbeddedServerConfig, KayApp, Middleware, RequestContext, ServerOptions } from './http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { createAppContext, getAppContext, loadConfig, runWithAppContext } from '../plugins/index'
import type { PendingChunk, SettledChunk } from '../ssr/context'
import { createRenderContext, renderCollectedHead, runWithRenderContext, streamChunkScript } from '../ssr/context'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { ACTION_ERROR_COOKIE, executeAction, isServerAction } from './action'
import { CompressionCache, compressedHtmlResponse, isCompressibleType, maybeCompressResponse, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
import { applyHstsHeader, DEFAULT_MAX_REQUEST_BODY_SIZE, enforceRequestBodyLimit, extractRenderedIslands, finalizeResponse, makeRequestContext, MIME, wantsJson } from './http'
import { Router } from './router'
import type { SecurityHeadersOptions, TrustProxy } from './security'
import { buildSecurityHeaderEntries, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, resolveCspPolicy, resolveHstsValue, verifyOrigin, withCspHashes } from './security'

export { createAppContext, defineConfig, definePlugin, getAppContext, loadConfig, runWithAppContext } from '../plugins/index'
export type { AppRuntimeContext, BuildPluginContext, BuildPluginTarget, CheckPluginContext, CreateAppContextOptions, FinalizeBuildContext, KayConfig, KayPlugin, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI } from '../plugins/index'
export { action, getActionError } from './action'
export type { ActionContext, ActionErrorFlash, ActionOptions, ActionResult, ServerAction } from './action'
export { CompressionCache, isCompressibleType, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
export type { CompressionEncoding, PrecompressedEncoding } from './compress'
export type { CookieOptions, Cookies } from './cookies'
export { defineEnv } from './env'
export { DEFAULT_MAX_REQUEST_BODY_SIZE } from './http'
export type { EmbeddedServerConfig, KayApp, Middleware, RequestContext, ServerOptions } from './http'
export { DEFAULT_CSP, DEFAULT_HSTS, getClientIp, isHttpsRequest, isTrustedOrigin, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, verifyOrigin, withCspHashes } from './security'
export type { SecurityHeadersOptions, TrustProxy } from './security'
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
// Where a streamed page's document splits: everything before it flushes first, resolved boundaries go in between.
const STREAM_TAIL_MARK = '<!--kay:stream-tail-->'
// Matches Bun.serve's 30 s idle timeout, which a streamed page turns off.
const DEFAULT_STREAM_TIMEOUT = 30_000

// A build file ready to serve: headers and compression key are fixed at startup, so a request only picks a variant.
interface ServedFile {
  key: string
  headers: Record<string, string>
  /** Headers of the on-the-fly compressed variant; undefined when the file is never compressed here. */
  compressedHeaders: Record<string, string> | undefined
  body: BodyInit
  read: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>
}

interface Sidecar {
  body: BodyInit
  headers: Record<string, string>
}

interface AssetEntry {
  file: ServedFile
  br: Sidecar | undefined
  gz: Sidecar | undefined
}

interface PublicEntry {
  file: ServedFile
  etag: string
  notModifiedHeaders: Record<string, string>
}

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

interface PluginRouteDef {
  handler: (ctx: RequestContext) => Response | Promise<Response>
  csrf: boolean
  trustedOrigins: Set<string> | undefined
  trustProxy: TrustProxy
}

const isRead = (request: Request): boolean => request.method === 'GET' || request.method === 'HEAD'
const isEventStream = (res: Response): boolean => (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
const hasActionErrorCookie = (request: Request): boolean => (request.headers.get('cookie') ?? '').includes(`${ACTION_ERROR_COOKIE}=`)
// A read the pre-rendered and fast static paths may answer: nothing to flash back to the page.
const isPlainRead = (request: Request): boolean => isRead(request) && !hasActionErrorCookie(request)

/** Runs `middlewares` in order around `last`; each calls `next` at most once. */
async function runChain(ctx: RequestContext, middlewares: readonly Middleware[], last: () => Response | Promise<Response>): Promise<Response> {
  if (middlewares.length === 0)
    return last()
  let index = -1
  const dispatch = async (i: number): Promise<Response> => {
    if (i <= index)
      throw new Error('kay: middleware called next() multiple times')
    index = i
    return i < middlewares.length ? middlewares[i]!(ctx, () => dispatch(i + 1)) : last()
  }
  return dispatch(0)
}

async function settleWithin(chunk: PendingChunk, timeoutMs: number): Promise<SettledChunk> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<SettledChunk>((resolve) => {
    timer = setTimeout(() => {
      const error = new Error(`<Suspense> boundary ${chunk.id} did not resolve within ${timeoutMs} ms`)
      resolve({ html: chunk.renderError(error), error })
    }, timeoutMs)
  })
  try {
    return await Promise.race([chunk.settled, timedOut])
  }
  finally {
    clearTimeout(timer)
  }
}

function mergedHeadTags(manifest: BuildManifest, entry: RouteManifestEntry): string[] | undefined {
  return entry.headTags !== undefined && entry.headTags.length > 0
    ? [...(manifest.headTags ?? []), ...entry.headTags]
    : manifest.headTags
}

export async function createServerFromEmbedded(config: EmbeddedServerConfig): Promise<KayApp> {
  const { manifest, modules, assets, publicAssets = {}, publicEtags = {}, prerendered, prerenderedFiles = {}, lang = 'en', security, plugins = [] } = config
  const assetPrefix = (config.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const trustedOrigins = config.trustedOrigins ? new Set(config.trustedOrigins) : undefined
  const trustProxy = config.trustProxy ?? false
  const maxRequestBodySize = config.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE
  const streamTimeout = config.streamTimeout ?? DEFAULT_STREAM_TIMEOUT
  const isDev = config.dev ?? (process.env.KAY_DEV === '1')
  const serverRoot = config.root ?? process.cwd()
  const serverOutDir = config.outDir ?? join(serverRoot, 'dist')
  const serverPublicDir = config.publicDir ?? join(serverOutDir, 'public')
  const parentAppCtx = getAppContext()
  const serverAppCtx = createAppContext({
    root: serverRoot,
    outDir: serverOutDir,
    publicDir: serverPublicDir,
    assetPrefix,
    dev: isDev,
    onRegisterPublicFile: rel => parentAppCtx?.registerPublicFile(rel),
  })
  const alwaysLoadRuntime = plugins.some(p => Boolean(p.clientEntry))
  const htmlTransformers = plugins
    .map(p => p.transformHtml)
    .filter((fn): fn is NonNullable<KayPlugin['transformHtml']> => typeof fn === 'function')

  const securityEntries = buildSecurityHeaderEntries(security)
  const securityRecord: Record<string, string> = Object.fromEntries(securityEntries)
  const nosniffHeader: Record<string, string> = security !== false && (security?.contentTypeOptions ?? true) ? { 'x-content-type-options': 'nosniff' } : {}
  const hstsValue = resolveHstsValue(security)
  const withHsts = (res: Response, request: Request): Response => applyHstsHeader(res, request, hstsValue, trustProxy)
  // The one way out of every response not built with the security headers already in place.
  const finish = (res: Response, request: Request, cookieStore?: CookieStore): Response => withHsts(finalizeResponse(res, cookieStore, securityEntries), request)
  const serverError = (): Response => new Response('Internal Server Error', {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...securityRecord },
  })

  // HTML headers, one set per (dynamic, islands, suspense) combination: the CSP only gains the hashes a page needs.
  const baseCsp = resolveCspPolicy(security)
  const htmlHeaderSets: Record<string, string>[] = []
  for (let i = 0; i < 8; i++) {
    const isDynamic = (i & 4) !== 0
    const hasIslands = (i & 2) !== 0
    const hasSuspense = (i & 1) !== 0
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', ...securityRecord }
    if (isDynamic)
      headers['cache-control'] = 'private'
    if (baseCsp !== undefined && (hasIslands || hasSuspense)) {
      headers['content-security-policy'] = withCspHashes(baseCsp, {
        styleHashes: [...(hasIslands ? [KAY_ISLAND_STYLE_HASH] : []), ...(hasSuspense ? [KAY_SUSPENSE_STYLE_HASH] : [])],
        scriptHashes: hasSuspense ? [KAY_STREAM_SCRIPT_HASH] : [],
      })
    }
    htmlHeaderSets.push(headers)
  }
  const htmlHeaders = (hasIslands: boolean, hasSuspense: boolean, isDynamic: boolean): Record<string, string> =>
    htmlHeaderSets[(isDynamic ? 4 : 0) | (hasIslands ? 2 : 0) | (hasSuspense ? 1 : 0)]!

  const compressEnabled = config.compress ?? !isDev
  const compressCache = compressEnabled ? new CompressionCache() : undefined
  const varyEncoding = compressCache !== undefined ? { vary: 'Accept-Encoding' } : {}

  const toBody = (body: EmbeddedBody): BodyInit => typeof body === 'string' ? Bun.file(body) : body
  const readBody = async (body: EmbeddedBody): Promise<Uint8Array<ArrayBuffer>> => typeof body === 'string' ? new Uint8Array(await Bun.file(body).arrayBuffer()) : body
  const builtFile = (key: string, source: EmbeddedBody, headers: Record<string, string>, compressedHeaders: Record<string, string> | undefined): ServedFile =>
    ({ key, headers, compressedHeaders, body: toBody(source), read: () => readBody(source) })

  // Plugin server hooks (plugin setup may be sync or async)
  const globalMiddlewares: Middleware[] = []
  const pluginRewrites: ((pathname: string, ctx: RequestContext) => string | undefined)[] = []
  const pluginRouter = new Router<Map<string, PluginRouteDef>>()
  const pluginRouteEntries = new Map<string, Map<string, PluginRouteDef>>()

  const registerPluginRoute = (
    method: string,
    path: string,
    handler: (ctx: RequestContext) => Response | Promise<Response>,
    options?: PluginRouteOptions,
  ): void => {
    let byMethod = pluginRouteEntries.get(path)
    if (byMethod === undefined) {
      byMethod = new Map()
      pluginRouteEntries.set(path, byMethod)
      pluginRouter.add(path, byMethod)
    }
    let routeTrustedOrigins = trustedOrigins
    if (options?.trustedOrigins !== undefined && options.trustedOrigins.length > 0) {
      routeTrustedOrigins = new Set([...(trustedOrigins ?? []), ...options.trustedOrigins])
    }
    byMethod.set(method.toUpperCase(), {
      handler,
      csrf: options?.csrf ?? true,
      trustedOrigins: routeTrustedOrigins,
      trustProxy: options?.trustProxy ?? trustProxy,
    })
  }

  for (const plugin of plugins) {
    if (plugin.server !== undefined) {
      const pluginApi: ServerPluginAPI = {
        root: serverRoot,
        outDir: serverOutDir,
        assetPrefix,
        dev: isDev,
        use(mw) {
          globalMiddlewares.push(mw)
        },
        route: registerPluginRoute,
        rewrite(fn) {
          pluginRewrites.push(fn)
        },
        provide: serverAppCtx.provide,
        inject: serverAppCtx.inject,
        getBuildData<T = Record<string, unknown>>(pluginName?: string): T | undefined {
          return manifest.pluginData?.[pluginName ?? plugin.name] as T | undefined
        },
      }
      await runWithAppContext(serverAppCtx, () => plugin.server!(pluginApi))
    }
  }

  const hasGlobalMiddleware = globalMiddlewares.length > 0
  const hasPluginRewrites = pluginRewrites.length > 0
  const hasHtmlTransformers = htmlTransformers.length > 0

  const errorHooks: ((info: ServerErrorInfo) => void)[] = []
  if (config.onError !== undefined)
    errorHooks.push(config.onError)
  for (const p of plugins) {
    if (p.onError !== undefined)
      errorHooks.push(p.onError)
  }
  const notifyError = (error: unknown, request: Request, source: ServerErrorInfo['source']) => {
    for (const hook of errorHooks) {
      try {
        hook({ error, request, source })
      }
      catch {}
    }
  }

  // Hashed build assets: immutable cache, precompressed .br/.gz sidecars, optional lazy compression
  const assetMap = new Map<string, AssetEntry>()
  for (const [rel, body] of Object.entries(assets)) {
    const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    const compressible = compressCache !== undefined && isCompressibleType(type)
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      ...nosniffHeader,
    }
    const sidecar = (ext: 'br' | 'gz', encoding: string): Sidecar | undefined => {
      const source = assets[`${rel}.${ext}`] ?? (typeof body === 'string' && existsSync(`${body}.${ext}`) ? `${body}.${ext}` : undefined)
      return source === undefined ? undefined : { body: toBody(source), headers: { ...headers, 'content-encoding': encoding, 'vary': 'Accept-Encoding' } }
    }
    const br = sidecar('br', 'br')
    const gz = sidecar('gz', 'gzip')
    const varyHeaders = compressible || br !== undefined || gz !== undefined ? { ...headers, vary: 'Accept-Encoding' } : headers
    assetMap.set(`${assetPrefix}/${rel}`, {
      file: builtFile(`a:${assetPrefix}/${rel}`, body, varyHeaders, compressible ? varyHeaders : undefined),
      br,
      gz,
    })
  }

  // Static public/ files: ETag + 304 + zero-copy Bun.file + optional lazy compression
  const publicMap = new Map<string, PublicEntry>()
  const publicCacheControl = isDev ? 'no-cache' : 'public, max-age=3600'
  for (const [rel, body] of Object.entries(publicAssets)) {
    const etag = publicEtags[rel] ?? `W/"${Bun.hash(typeof body === 'string' ? rel : body).toString(36)}"`
    const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    const hasVary = compressCache !== undefined && isCompressibleType(type)
    const validators = { etag, 'cache-control': publicCacheControl, ...(hasVary ? { vary: 'Accept-Encoding' } : {}), ...nosniffHeader }
    const headers = { 'content-type': type, ...validators }
    publicMap.set(`/${rel}`, {
      etag,
      notModifiedHeaders: validators,
      file: builtFile(`p:/${rel}:${etag}`, body, headers, hasVary ? { ...headers, etag: toWeakEtag(etag) } : undefined),
    })
  }

  async function serveFile(request: Request, file: ServedFile): Promise<Response> {
    if (request.method === 'HEAD')
      return withHsts(new Response(null, { status: 200, headers: file.headers }), request)
    if (file.compressedHeaders !== undefined && compressCache !== undefined) {
      const enc = pickEncoding(request.headers.get('accept-encoding'))
      if (enc !== undefined) {
        const compressed = await compressCache.file(file.key, enc, file.read)
        if (compressed !== undefined)
          return withHsts(new Response(compressed, { status: 200, headers: { ...file.compressedHeaders, 'content-encoding': enc } }), request)
      }
    }
    return withHsts(new Response(file.body, { status: 200, headers: file.headers }), request)
  }

  async function serveAsset(request: Request, asset: AssetEntry): Promise<Response> {
    if (compressEnabled && request.method !== 'HEAD' && (asset.br !== undefined || asset.gz !== undefined)) {
      const preEnc = pickPrecompressedEncoding(request.headers.get('accept-encoding'), { br: asset.br !== undefined, gz: asset.gz !== undefined })
      if (preEnc !== undefined) {
        const sidecar = preEnc === 'br' ? asset.br! : asset.gz!
        return withHsts(new Response(sidecar.body, { status: 200, headers: sidecar.headers }), request)
      }
    }
    return serveFile(request, asset.file)
  }

  async function servePublic(request: Request, pub: PublicEntry): Promise<Response> {
    if (request.headers.get('if-none-match') === pub.etag)
      return withHsts(new Response(null, { status: 304, headers: pub.notModifiedHeaders }), request)
    return serveFile(request, pub.file)
  }

  // Server actions and their live URLs
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

  // Prerendered pages (zero-copy file paths preferred; raw HTML strings supported). `fastPrerenderedMap` holds those nothing may intercept.
  const prerenderedMap = new Map<string, ServedFile>()
  const fastPrerenderedMap = new Map<string, ServedFile>()
  for (const route of manifest.routes) {
    if (route.prerendered === undefined)
      continue
    const headers = { ...htmlHeaders(route.islandChunks.length > 0, false, false), ...varyEncoding }
    const compressedHeaders = compressCache !== undefined ? headers : undefined
    for (const [urlPath, relHtml] of Object.entries(route.prerendered)) {
      const filePath = prerenderedFiles[relHtml]
      const html = prerendered[relHtml]
      const key = `pre:${urlPath}`
      const entry: ServedFile | undefined = filePath !== undefined
        ? builtFile(key, filePath, headers, compressedHeaders)
        : html !== undefined
          ? { key, headers, compressedHeaders, body: html, read: () => textEncoder.encode(html) }
          : undefined
      if (entry === undefined)
        continue
      prerenderedMap.set(urlPath, entry)
      if (route.middlewares.length === 0 && !hasGlobalMiddleware && !hasPluginRewrites && pluginRouter.match(urlPath) === undefined)
        fastPrerenderedMap.set(urlPath, entry)
    }
  }

  const router = new Router<CompiledRoute>()
  const fastStaticPages = new Map<string, FastHandler>()

  // Error and 404 pages sit outside any route, so they render with the global styles and the root layout.
  const rootLayoutFile = manifest.routes.find(r => r.layouts.length > 0)?.layouts[0]
  const rootLayoutMod = rootLayoutFile !== undefined ? modules[rootLayoutFile] as LoadedLayoutModule | undefined : undefined
  const fallbackDoc: DocumentOptions = {
    body: '',
    headTags: manifest.headTags,
    styles: manifest.globalStyles ?? manifest.styles,
    runtimeScript: manifest.runtimeScript,
    alwaysLoadRuntime,
    lang,
  }

  async function applyHtmlTransforms(html: string, url: URL, ctx?: RequestContext): Promise<string> {
    if (!hasHtmlTransformers)
      return html
    const transformCtx = ctx ?? makeRequestContext(new Request(url.toString()), {}, { trustProxy }).ctx
    let out = html
    for (const transform of htmlTransformers) {
      try {
        out = await transform(out, transformCtx)
      }
      catch {}
    }
    return out
  }

  async function renderFallbackPage(status: number, renderInner: (() => unknown) | undefined, text: string, url?: URL, ctx?: RequestContext): Promise<Response> {
    if (renderInner !== undefined) {
      try {
        const effUrl = url ?? new URL(`http://localhost/${status}`)
        const rctx = createRenderContext()
        const body = await runWithRenderContext(rctx, async () => {
          let inner = ssrChild(await renderInner() as Html)
          if (rootLayoutMod !== undefined)
            inner = ssrChild(await rootLayoutMod.default({ children: raw(inner), url: effUrl, params: {}, locals: ctx?.locals ?? {} }) as Html)
          return inner
        })
        const html = await applyHtmlTransforms(renderDocument({ ...fallbackDoc, body, head: renderCollectedHead(rctx) }), effUrl, ctx)
        return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private' } })
      }
      catch {}
    }
    return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  const buildErrorResponse = (error: unknown, url?: URL, ctx?: RequestContext): Promise<Response> =>
    renderFallbackPage(500, errorMod && (() => errorMod.default({ error })), 'Internal Server Error', url, ctx)

  const notFoundPage = notFoundMod?.default
  const buildNotFoundResponse = (url?: URL, ctx?: RequestContext): Promise<Response> =>
    renderFallbackPage(404, notFoundPage && (() => notFoundPage({})), 'Not Found', url, ctx)

  async function renderError(error: unknown, cookieStore: CookieStore | undefined, url: URL, request: Request, ctx?: RequestContext): Promise<Response> {
    return finish(await buildErrorResponse(error, url, ctx), request, cookieStore)
  }

  async function renderNotFound(cookieStore: CookieStore, url: URL, request: Request, ctx: RequestContext): Promise<Response> {
    return finish(await buildNotFoundResponse(url, ctx), request, cookieStore)
  }

  function refuseCrossSite(request: Request, reason: string, cookieStore?: CookieStore): Response {
    return finish(Response.json({ ok: false, status: 403, error: reason }, { status: 403 }), request, cookieStore)
  }

  for (const entry of manifest.routes) {
    const mod = modules[entry.file] as LoadedPageModule
    const layouts = entry.layouts.map(l => modules[l] as LoadedLayoutModule)
    const middlewares = entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default)
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
    const canFastPath = !hasGlobalMiddleware
      && !hasPluginRewrites
      && !hasHtmlTransformers
      && pluginRouter.match(entry.path) === undefined
      && !dynamic
      && middlewares.length === 0
      && !entry.usesRenderContext
      && typeof mod.default === 'function'
      && mod.GET === undefined

    if (canFastPath) {
      const shell = renderDocument({ ...doc, body: '\0', preloadChunks: entry.eagerIslandChunks ?? entry.islandChunks, hasIslands })
      const splitAt = shell.indexOf('\0')
      const docPrefix = shell.slice(0, splitAt)
      const docSuffix = shell.slice(splitAt + 1)
      const singleLayout = layouts.length === 1 ? layouts[0]! : undefined
      const fastHeaders = htmlHeaders(hasIslands, false, true)

      const fail = (error: unknown, request: Request): Promise<Response> => {
        notifyError(error, request, 'route')
        return renderError(error, undefined, new URL(request.url), request)
      }
      const respondHtml = (body: string, request: Request): Response =>
        withHsts(compressedHtmlResponse(docPrefix + body + docSuffix, 200, fastHeaders, request, compressCache, !entry.hasLoad), request)
      const layoutProps = (inner: string, url: URL) => ({ children: raw(inner), url, params: {}, locals: {} })

      const wrapLayouts = (inner: string, request: Request, url: URL): Response | Promise<Response> => {
        if (layouts.length === 0)
          return respondHtml(inner, request)
        if (singleLayout !== undefined) {
          const wrapped = singleLayout.default(layoutProps(inner, url))
          if (wrapped instanceof Promise)
            return wrapped.then(x => respondHtml(ssrChild(x as Html), request), error => fail(error, request))
          return respondHtml(ssrChild(wrapped as Html), request)
        }
        return (async () => {
          try {
            let cur = inner
            for (let i = layouts.length - 1; i >= 0; i--)
              cur = ssrChild(await layouts[i]!.default(layoutProps(cur, url)) as Html)
            return respondHtml(cur, request)
          }
          catch (error) {
            return fail(error, request)
          }
        })()
      }

      const renderPage = (data: unknown, request: Request, url: URL): Response | Promise<Response> => {
        const pageProps: Record<string, unknown> = { params: {}, locals: {}, url, ...(data !== undefined ? { data } : {}) }
        if (entry.isIsland && entry.islandChunk !== undefined) {
          return wrapLayouts(ssrIsland(
            entry.islandChunk,
            () => ssrChild(mod.default!(pageProps) as Html),
            data !== undefined ? { data } : {},
            entry.islandHydrate as HydrateStrategy | undefined,
          ), request, url)
        }
        const rendered = mod.default!(pageProps)
        if (rendered instanceof Promise)
          return rendered.then(r => wrapLayouts(ssrChild(r as Html), request, url), error => fail(error, request))
        return wrapLayouts(ssrChild(rendered as Html), request, url)
      }

      fastStaticPages.set(entry.path, (request, remoteIp, url = new URL(request.url)) => {
        try {
          if (!entry.hasLoad || typeof mod.load !== 'function')
            return renderPage(undefined, request, url)

          const { ctx, cookieStore } = makeRequestContext(request, {}, { trustProxy, remoteIp, url })
          const afterLoad = async (pending: unknown): Promise<Response> => {
            try {
              const loaded = await pending
              return finish(loaded instanceof Response ? loaded : await renderPage(loaded, request, url), request, cookieStore)
            }
            catch (error) {
              return fail(error, request)
            }
          }
          return afterLoad(mod.load(ctx))
        }
        catch (error) {
          return fail(error, request)
        }
      })
    }

    router.add(entry.path, { entry, mod, layouts, middlewares: [...globalMiddlewares, ...middlewares], dynamic, doc })
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
        return buildNotFoundResponse(ctx.url, ctx)
    }

    // API route (.ts exporting GET/POST/etc.)
    const methodHandler = mod[ctx.request.method]
    if (typeof methodHandler === 'function')
      return maybeCompressResponse(await (methodHandler as (c: RequestContext) => Response | Promise<Response>)(ctx), ctx.request, compressCache)

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
    const isStreamed = rctx.pending.length > 0
    const hasIslands = renderedIslands.hasIslands || isStreamed && entry.islandChunks.length > 0
    const preloadChunks = isStreamed ? entry.islandChunks : renderedIslands.eagerChunks

    // Streaming SSR when <Suspense> boundaries are pending (never buffered for compression)
    if (isStreamed) {
      disableTimeout?.()
      let shell = renderDocument({ ...doc, body: body + STREAM_TAIL_MARK, head: collectedHead, preloadChunks, hasIslands, hasSuspense: true })
      // Transforms see the document with its initial body; boundaries resolved later stream as they render.
      for (const transform of htmlTransformers)
        shell = await transform(shell, ctx)
      const splitAt = shell.lastIndexOf(STREAM_TAIL_MARK)
      const openingHtml = splitAt === -1 ? shell : shell.slice(0, splitAt)
      const tailHtml = splitAt === -1 ? '' : shell.slice(splitAt + STREAM_TAIL_MARK.length)

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(textEncoder.encode(openingHtml))
          // A resolved boundary can render boundaries of its own, so each flush also drains the ones it added.
          let flushed = 0
          const flushPending = async (): Promise<void> => {
            const chunks = rctx.pending.slice(flushed)
            flushed = rctx.pending.length
            await Promise.all(chunks.map(async (chunk) => {
              const settled = await settleWithin(chunk, streamTimeout)
              if ('error' in settled)
                notifyError(settled.error, ctx.request, 'route')
              controller.enqueue(textEncoder.encode(streamChunkScript(chunk.id, settled.html)))
              await flushPending()
            }))
          }
          await flushPending()
          controller.enqueue(textEncoder.encode(tailHtml))
          controller.close()
        },
      })

      return new Response(stream, { status: 200, headers: htmlHeaders(hasIslands, true, true) })
    }

    let html = renderDocument({ ...doc, body, head: collectedHead, preloadChunks, hasIslands })
    for (const transform of htmlTransformers)
      html = await transform(html, ctx)

    return compressedHtmlResponse(html, 200, htmlHeaders(hasIslands, false, true), ctx.request, compressCache)
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
          const shadowedByPlugin = matchedPlugin !== undefined
            && (matchedPlugin.data.has(request.method) || matchedPlugin.data.has('ALL'))
          if (!shadowedByPlugin)
            return servePublic(request, pub)
        }
      }

      // Actions are origin-checked before their body is read and before any middleware runs.
      const actionHandler = request.method === 'POST' ? actionHandlers.get(pathname) : undefined
      if (actionHandler !== undefined) {
        const originCheck = verifyOrigin(request, trustedOrigins, trustProxy)
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

      // 2. Server actions (POST /_kay/action/<id>): global plugin middlewares, then the _middleware.ts chain of the action's folder
      if (actionHandler !== undefined) {
        const { act, middlewares } = actionHandler
        const { ctx, cookieStore } = makeRequestContext(req, {}, { trustProxy, remoteIp, url })
        try {
          return finish(await runChain(ctx, middlewares, () => executeAction(act, req, ctx, trustedOrigins, trustProxy)), req, cookieStore)
        }
        catch (error) {
          notifyError(error, req, 'action')
          if (wantsJson(req))
            return finish(Response.json({ ok: false, status: 500, error: 'Internal Server Error' }, { status: 500 }), req, cookieStore)
          return renderError(error, cookieStore, ctx.url, req)
        }
      }

      // 3. Prerendered static HTML (safe even when plugins add routes or build-time transformHtml!), then 4. the zero-overhead static route path
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

      // Hydrate & clear one-shot progressive form validation flash cookie
      if (req.method === 'GET' && !plainRead) {
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
      for (const rewrite of pluginRewrites) {
        const nextPath = rewrite(effectivePath, ctx)
        if (nextPath !== undefined)
          effectivePath = nextPath
      }

      // Custom plugin routes (e.g. GET /sitemap.xml, POST /auth/callback, GET /api/board) run behind the global plugin middlewares, so ctx.locals (e.g. auth user/session) is there too.
      const pluginMatch = pluginRouter.match(effectivePath)
      const routeDef = pluginMatch?.data.get(req.method.toUpperCase()) ?? pluginMatch?.data.get('ALL')
      if (pluginMatch !== undefined && routeDef !== undefined) {
        if (routeDef.csrf) {
          const originCheck = verifyOrigin(req, routeDef.trustedOrigins, routeDef.trustProxy)
          if (!originCheck.ok)
            return refuseCrossSite(req, originCheck.reason, cookieStore)
        }
        ctx.params = pluginMatch.params
        try {
          const res = await runChain(ctx, globalMiddlewares, () => routeDef.handler(ctx))
          if (isEventStream(res))
            disableTimeout?.()
          return finish(await maybeCompressResponse(res, req, compressCache), req, cookieStore)
        }
        catch (error) {
          notifyError(error, req, 'plugin')
          return renderError(error, cookieStore, ctx.url, req, ctx)
        }
      }

      const matched = router.match(effectivePath)
      if (matched === undefined)
        return renderNotFound(cookieStore, ctx.url, req, ctx)

      ctx.params = matched.params
      const route = matched.data

      // CSRF verification for file-based API routes on unsafe methods (opt out via `export const csrf = false`)
      if (typeof route.mod[req.method] === 'function' && route.mod.csrf !== false) {
        const originCheck = verifyOrigin(req, trustedOrigins, trustProxy)
        if (!originCheck.ok)
          return refuseCrossSite(req, originCheck.reason, cookieStore)
      }

      try {
        const res = await runChain(ctx, route.middlewares, () => renderCompiledRoute(route, ctx, disableTimeout))
        if (isEventStream(res))
          disableTimeout?.()
        return finish(res, req, cookieStore)
      }
      catch (error) {
        notifyError(error, req, 'route')
        return renderError(error, cookieStore, ctx.url, req, ctx)
      }
    }
    catch (error) {
      notifyError(error, request, 'route')
      return withHsts(serverError(), request)
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
      routes[path] = req => serveAsset(req, asset)

    for (const [path, pub] of publicMap) {
      if (!(path in routes) && pluginRouter.match(path) === undefined)
        routes[path] = req => servePublic(req, pub)
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

  return { handle, serve }
}

function createStaticDirServer(
  outDir: string,
  assetPrefix: string,
  security: SecurityHeadersOptions | false | undefined,
  compressEnabled: boolean,
  trustProxy: TrustProxy,
): KayApp {
  const cleanPrefix = `${assetPrefix.replace(/\/$/, '')}/`
  const absRoot = resolve(outDir)
  const compressCache = compressEnabled ? new CompressionCache() : undefined
  const securityEntries = buildSecurityHeaderEntries(security)
  const hstsValue = resolveHstsValue(security)
  const withHsts = (res: Response, req: Request) => applyHstsHeader(res, req, hstsValue, trustProxy)

  function statFile(abs: string): Stats | undefined {
    const st = statSync(abs, { throwIfNoEntry: false })
    return st?.isFile() ? st : undefined
  }

  function resolveStaticFile(pathname: string): { path: string, st: Stats } | undefined {
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
      const st = statFile(abs)
      if (st !== undefined)
        return { path: abs, st }
    }
    return undefined
  }

  const initHeaders = (): Headers => new Headers(securityEntries as [string, string][])

  const handle = async (req: Request): Promise<Response> => {
    if (!isRead(req))
      return withHsts(new Response('Method Not Allowed', { status: 405, headers: initHeaders() }), req)

    const url = new URL(req.url)
    const found = resolveStaticFile(url.pathname)
    if (found === undefined) {
      const notFoundPath = join(absRoot, '404.html')
      if (statFile(notFoundPath) !== undefined) {
        const headers = initHeaders()
        headers.set('content-type', 'text/html; charset=utf-8')
        return withHsts(new Response(req.method === 'HEAD' ? null : Bun.file(notFoundPath), { status: 404, headers }), req)
      }
      return withHsts(new Response('Not Found', { status: 404, headers: initHeaders() }), req)
    }

    const { path: filePath, st } = found
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    const isImmutable = url.pathname.startsWith(cleanPrefix)
    const headers = initHeaders()
    headers.set('content-type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
    headers.set('cache-control', isImmutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate')
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
            headers: { 'content-type': 'text/plain; charset=utf-8', ...Object.fromEntries(securityEntries) },
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
  const trustProxy = options.trustProxy ?? fileConfig.trustProxy ?? false
  const maxRequestBodySize = options.maxRequestBodySize ?? fileConfig.maxRequestBodySize

  if (!existsSync(manifestPath)) {
    if (existsSync(outDir) && readdirSync(outDir).length > 0) {
      return createStaticDirServer(
        outDir,
        options.assetPrefix ?? fileConfig.assetPrefix ?? '/_kay',
        securityOpt,
        (options.compress ?? fileConfig.compress) !== false,
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
      for (const relHtml of Object.values(r.prerendered)) {
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
    root,
    outDir,
    publicDir: join(outDir, 'public'),
    assetPrefix: options.assetPrefix ?? fileConfig.assetPrefix,
    lang: options.lang ?? fileConfig.lang,
    security: securityOpt,
    trustedOrigins: options.trustedOrigins ?? fileConfig.trustedOrigins,
    trustProxy,
    maxRequestBodySize,
    streamTimeout: options.streamTimeout ?? fileConfig.streamTimeout,
    compress: options.compress ?? fileConfig.compress,
    dev: options.dev,
    onError: options.onError ?? fileConfig.onError,
    plugins,
  })
}
