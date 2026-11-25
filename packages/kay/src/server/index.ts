// Kay v2 native Bun.serve server:
// - Static + dynamic ([param], [...catchall]) Router
// - Composable directory-scoped _middleware.ts chains + ctx.cookies + ctx.locals
// - Unified Standard-Schema action() endpoint handling with CSRF verification
// - <Head> collection + cancel-safe streaming <Suspense> (0-overhead fast path when unused)
// - Hybrid prerendered HTML serving + embedded single-executable mode

import type { BuildManifest, RouteManifestEntry } from '../build/index'
import type { Html, HydrateStrategy } from '../jsx-runtime'
import type { KayPlugin, MiddlewareOptions, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI } from '../plugins/index'
import type { PendingChunk, SettledChunk } from '../ssr/context'
import type { DocumentOptions } from '../ssr/index'
import type { ActionErrorFlash, ActionResult, ServerAction } from './action'
import type { CookieStore } from './cookies'
import type { EmbeddedBody, EmbeddedServerConfig, KayApp, Middleware, RequestContext } from './http'
import type { TrustProxy } from './security'
import { existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { createAppContext, getAppContext, runWithAppContext } from '../plugins/index'
import { createRenderContext, renderCollectedHead, runWithRenderContext, streamChunkScript } from '../ssr/context'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { ACTION_ERROR_COOKIE, executeAction, invokeActionCore, isServerAction } from './action'
import { CompressionCache, compressedHtmlResponse, isCompressibleType, maybeCompressResponse, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
import { applyHstsHeader, DEFAULT_MAX_REQUEST_BODY_SIZE, enforceRequestBodyLimit, etagMatches, extractRenderedIslands, finalizeResponse, makeRequestContext, MIME, wantsJson } from './http'
import { Router } from './router'
import { buildSecurityHeaderEntries, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, resolveCspPolicy, resolveHstsValue, verifyOrigin, withCspHashes } from './security'

export { createAppContext, defineConfig, definePlugin, getAppContext, loadConfig, runWithAppContext } from '../plugins/index'
export type { AppRuntimeContext, BuildPluginContext, BuildPluginTarget, CheckPluginContext, CreateAppContextOptions, FinalizeBuildContext, KayConfig, KayPlugin, MiddlewareOptions, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI } from '../plugins/index'
export { action, getActionError } from './action'
export type { ActionContext, ActionErrorFlash, ActionOptions, ActionResult, ServerAction } from './action'
export { CompressionCache, isCompressibleType, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
export type { CompressionEncoding, PrecompressedEncoding } from './compress'
export type { CookieOptions, Cookies } from './cookies'
export { defineEnv, nodeEnv } from './env'
export { DEFAULT_MAX_REQUEST_BODY_SIZE } from './http'
export type { EmbeddedServerConfig, KayApp, Middleware, RequestContext, ServerOptions } from './http'
export { createServer } from './loader'
export { DEFAULT_CSP, DEFAULT_HSTS, DEFAULT_PERMISSIONS_POLICY, getClientIp, isHttpsRequest, isTrustedOrigin, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, verifyOrigin, withCspHashes } from './security'
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
  HEAD?: (ctx: RequestContext) => Response | Promise<Response>
  OPTIONS?: (ctx: RequestContext) => Response | Promise<Response>
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

const HTTP_METHOD_EXPORTS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

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

interface ScopedMiddleware {
  mw: Middleware
  scope: 'all' | 'dynamic' | string
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

async function settleWithin(chunk: PendingChunk, deadlineMs: number, signal: AbortSignal): Promise<SettledChunk | undefined> {
  if (signal.aborted)
    return undefined
  const remaining = Math.max(0, deadlineMs - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  const abortedOrTimedOut = new Promise<SettledChunk | undefined>((resolve) => {
    const onAbort = () => resolve(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      const error = new Error(`<Suspense> boundary ${chunk.id} did not resolve within ${remaining} ms`)
      resolve({ html: chunk.renderError(error), error })
    }, remaining)
  })
  try {
    return await Promise.race([chunk.settled, abortedOrTimedOut])
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

function allowedMethodsHeader(mod: LoadedPageModule): string {
  const allowed = new Set<string>()
  if (typeof mod.default === 'function') {
    allowed.add('GET')
    allowed.add('HEAD')
  }
  for (const m of HTTP_METHOD_EXPORTS) {
    if (typeof mod[m] === 'function')
      allowed.add(m)
  }
  if (allowed.has('GET'))
    allowed.add('HEAD')
  return [...allowed].join(', ')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pickRootLayoutFile(manifest: BuildManifest): string | undefined {
  // Prefer a layout attached to a root route (`/`) or shared at the shallowest directory depth.
  const rootRoute = manifest.routes.find(r => r.path === '/' && r.layouts.length > 0)
  if (rootRoute !== undefined)
    return rootRoute.layouts[0]
  let best: string | undefined
  let bestDepth = Number.POSITIVE_INFINITY
  for (const r of manifest.routes) {
    const first = r.layouts[0]
    if (first === undefined)
      continue
    const depth = first.split('/').length
    if (depth < bestDepth) {
      bestDepth = depth
      best = first
    }
  }
  return best
}

function middlewareAppliesToPath(scope: ScopedMiddleware['scope'], path: string, isStaticFast: boolean): boolean {
  if (scope === 'all')
    return true
  if (scope === 'dynamic')
    return !isStaticFast
  return path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)
}

export async function createServerFromEmbedded(config: EmbeddedServerConfig): Promise<KayApp> {
  const { manifest, modules, assets, publicAssets = {}, publicEtags = {}, prerendered, prerenderedFiles = {}, lang = 'en', security, plugins = [] } = config
  const assetPrefix = (config.assetPrefix ?? '/_kay').replace(/\/$/, '')
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
  const htmlTransformers = plugins
    .map(p => p.transformHtml)
    .filter((fn): fn is NonNullable<KayPlugin['transformHtml']> => typeof fn === 'function')

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
  const varyEncoding: Record<string, string> = compressCache !== undefined ? { vary: 'Accept-Encoding' } : {}

  const toBody = (body: EmbeddedBody): BodyInit => typeof body === 'string' ? Bun.file(body) : body
  const readBody = async (body: EmbeddedBody): Promise<Uint8Array<ArrayBuffer>> => typeof body === 'string' ? new Uint8Array(await Bun.file(body).arrayBuffer()) : body
  const builtFile = (key: string, source: EmbeddedBody, headers: Record<string, string>, compressedHeaders: Record<string, string> | undefined): ServedFile =>
    ({ key, headers, compressedHeaders, body: toBody(source), read: () => readBody(source) })

  const publicMap = new Map<string, PublicEntry>()
  const publicCacheControl = isDev ? 'no-cache' : 'public, max-age=3600'

  const registerPublicEntry = (rel: string, body: EmbeddedBody, explicitEtag?: string): void => {
    const cleanRel = rel.replace(/^\/+/, '')
    const etag = explicitEtag ?? `W/"${Bun.hash(typeof body === 'string' ? cleanRel : body).toString(36)}"`
    const type = MIME[extname(cleanRel).toLowerCase()] ?? 'application/octet-stream'
    const hasVary = compressCache !== undefined && isCompressibleType(type)
    const validators = { etag, 'cache-control': publicCacheControl, ...(hasVary ? { vary: 'Accept-Encoding' } : {}), ...nosniffHeader }
    const headers = { 'content-type': type, ...validators }
    publicMap.set(`/${cleanRel}`, {
      etag,
      notModifiedHeaders: validators,
      file: builtFile(`p:/${cleanRel}:${etag}`, body, headers, hasVary ? { ...headers, etag: toWeakEtag(etag) } : undefined),
    })
  }

  for (const [rel, body] of Object.entries(publicAssets))
    registerPublicEntry(rel, body, publicEtags[rel])

  const serverAppCtx = createAppContext({
    root: serverRoot,
    outDir: serverOutDir,
    publicDir: serverPublicDir,
    assetPrefix,
    dev: isDev,
    onRegisterPublicFile: (rel) => {
      parentAppCtx?.registerPublicFile(rel)
      const cleanRel = rel.replace(/^\/+/, '')
      const abs = join(serverPublicDir, cleanRel)
      if (existsSync(abs)) {
        const st = statSync(abs)
        registerPublicEntry(cleanRel, abs, `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`)
      }
    },
  })

  // Plugin server hooks (plugin setup may be sync or async)
  const scopedMiddlewares: ScopedMiddleware[] = []
  const shutdownHooks: (() => void | Promise<void>)[] = []
  const pluginRewrites: ((pathname: string, ctx: RequestContext) => string | undefined)[] = []
  const pluginRouter = new Router<Map<string, PluginRouteDef>>()
  const pluginRouteEntries = new Map<string, Map<string, PluginRouteDef>>()

  const actionHandlers = new Map<string, { act: ServerAction<unknown, unknown>, middlewares: Middleware[] }>()
  const actionByRef = new WeakMap<ServerAction<unknown, unknown>, Middleware[]>()

  const registerPluginRoute = (
    method: string,
    path: string,
    handler: (ctx: RequestContext) => Response | Promise<Response>,
    options?: PluginRouteOptions,
  ): void => {
    const normPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
    let byMethod = pluginRouteEntries.get(normPath)
    if (byMethod === undefined) {
      byMethod = new Map()
      pluginRouteEntries.set(normPath, byMethod)
      pluginRouter.add(normPath, byMethod)
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

  async function invokeRegisteredAction<I, O>(act: ServerAction<I, O>, input: I, ctx: RequestContext): Promise<ActionResult<O>> {
    const dirMiddlewares = actionByRef.get(act as unknown as ServerAction<unknown, unknown>) ?? []
    if (dirMiddlewares.length === 0)
      return invokeActionCore(act, input, ctx)

    let actionResult: ActionResult<O> | undefined
    const res = await runChain(ctx, dirMiddlewares, async () => {
      actionResult = await invokeActionCore(act, input, ctx)
      return new Response(null, { status: actionResult.ok ? 200 : actionResult.status })
    })
    if (actionResult !== undefined)
      return actionResult
    // A directory `_middleware.ts` short-circuited the request (e.g. 401/403 auth guard).
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      try {
        const body = await res.clone().json() as Record<string, unknown>
        return {
          ok: false,
          status: res.status,
          error: typeof body.error === 'string' ? body.error : res.statusText || 'Forbidden',
        }
      }
      catch {}
    }
    return {
      ok: false,
      status: res.status,
      error: (await res.clone().text().catch(() => '')) || res.statusText || 'Forbidden',
    }
  }

  for (const plugin of plugins) {
    if (plugin.dispose !== undefined)
      shutdownHooks.push(() => plugin.dispose!())
    if (plugin.server !== undefined) {
      const pluginApi: ServerPluginAPI = {
        root: serverRoot,
        outDir: serverOutDir,
        assetPrefix,
        dev: isDev,
        trustProxy,
        trustedOrigins: trustedOriginsList,
        use(mw: Middleware, options?: MiddlewareOptions) {
          scopedMiddlewares.push({ mw, scope: options?.scope ?? 'all' })
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
        onShutdown(fn) {
          shutdownHooks.push(fn)
        },
        invokeAction: invokeRegisteredAction,
      }
      await runWithAppContext(serverAppCtx, () => plugin.server!(pluginApi))
    }
  }

  const middlewaresFor = (path: string, isStaticFast = false): Middleware[] =>
    scopedMiddlewares.filter(m => middlewareAppliesToPath(m.scope, path, isStaticFast)).map(m => m.mw)
  const allPluginMiddlewares = scopedMiddlewares.map(m => m.mw)
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

  // Hashed build assets: immutable cache, precompressed .br/.gz sidecars, optional lazy compression.
  // Skip `.br`/`.gz` sidecars as standalone HTTP routes when their base asset exists.
  const assetMap = new Map<string, AssetEntry>()
  for (const [rel, body] of Object.entries(assets)) {
    if ((rel.endsWith('.br') || rel.endsWith('.gz')) && rel.slice(0, -3) in assets)
      continue
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
    if (etagMatches(request.headers.get('if-none-match'), pub.etag))
      return withHsts(new Response(null, { status: 304, headers: pub.notModifiedHeaders }), request)
    return serveFile(request, pub.file)
  }

  // Server actions and their live URLs
  for (const entry of manifest.actions) {
    const mod = modules[entry.file] as Record<string, unknown> | undefined
    const act = mod?.[entry.exportName]
    if (isServerAction(act)) {
      ;(act as { url: string }).url = entry.url
      const dirMiddlewares = entry.middlewares.map(m => (modules[m] as LoadedMiddlewareModule).default)
      actionByRef.set(act, dirMiddlewares)
      actionHandlers.set(entry.url, { act, middlewares: [...middlewaresFor(entry.url), ...dirMiddlewares] })
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
    const headers: Record<string, string> = { ...htmlHeaders(route.islandChunks.length > 0, false, false), ...varyEncoding }
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
      if (route.middlewares.length === 0 && middlewaresFor(urlPath, true).length === 0 && !hasPluginRewrites && pluginRouter.match(urlPath) === undefined)
        fastPrerenderedMap.set(urlPath, entry)
    }
  }

  const router = new Router<CompiledRoute>()
  const fastStaticPages = new Map<string, FastHandler>()

  // Error and 404 pages sit outside any route, so they render with the global styles and the true root layout.
  const rootLayoutFile = pickRootLayoutFile(manifest)
  const rootLayoutMod = rootLayoutFile !== undefined ? modules[rootLayoutFile] as LoadedLayoutModule | undefined : undefined
  const fallbackDoc: DocumentOptions = {
    body: '',
    headTags: manifest.headTags,
    styles: manifest.globalStyles ?? manifest.styles,
    runtimeScript: manifest.runtimeScript,
    alwaysLoadRuntime,
    lang,
  }

  async function applyHtmlTransforms(html: string, url: URL, req?: Request, ctx?: RequestContext): Promise<string> {
    if (!hasHtmlTransformers)
      return html
    const transformCtx = ctx ?? makeRequestContext(req ?? new Request(url.toString()), {}, { trustProxy }).ctx
    let out = html
    for (const transform of htmlTransformers) {
      try {
        out = await transform(out, transformCtx)
      }
      catch (err) {
        notifyError(err, req ?? transformCtx.request, 'plugin')
      }
    }
    return out
  }

  function resolveRenderedIslands(rctx: ReturnType<typeof createRenderContext>, body: string): { hasIslands: boolean, eagerChunks: string[] } {
    if (rctx.hasIslands) {
      const eagerChunks: string[] = []
      for (const [chunk, eager] of rctx.renderedIslands) {
        if (eager)
          eagerChunks.push(chunk)
      }
      return { hasIslands: true, eagerChunks }
    }
    // Fallback only if raw HTML injected a <kay-island> without going through ssrIsland/ssrIslandStatic.
    if (body.includes('<kay-island'))
      return extractRenderedIslands(body)
    return { hasIslands: false, eagerChunks: [] }
  }

  async function renderFallbackPage(status: number, renderInner: (() => unknown) | undefined, text: string, url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> {
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
        const { hasIslands, eagerChunks } = resolveRenderedIslands(rctx, body)
        const docHtml = renderDocument({
          ...fallbackDoc,
          body,
          head: renderCollectedHead(rctx),
          htmlAttrs: rctx.htmlAttrs,
          preloadChunks: eagerChunks,
          hasIslands,
        })
        const html = await applyHtmlTransforms(docHtml, effUrl, req, ctx)
        return new Response(html, { status, headers: htmlHeaders(hasIslands, false, true) })
      }
      catch (err) {
        if (req !== undefined)
          notifyError(err, req, 'route')
      }
    }
    return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  const buildErrorResponse = (error: unknown, url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> =>
    renderFallbackPage(500, errorMod && (() => errorMod.default({ error })), 'Internal Server Error', url, req, ctx)

  const notFoundPage = notFoundMod?.default
  const buildNotFoundResponse = (url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> =>
    renderFallbackPage(404, notFoundPage && (() => notFoundPage({})), 'Not Found', url, req, ctx)

  async function renderError(error: unknown, cookieStore: CookieStore | undefined, url: URL, request: Request, ctx?: RequestContext): Promise<Response> {
    if (wantsJson(request))
      return finish(Response.json({ ok: false, status: 500, error: 'Internal Server Error' }, { status: 500 }), request, cookieStore)
    return finish(await buildErrorResponse(error, url, request, ctx), request, cookieStore)
  }

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
      const fastHeaders = htmlHeaders(hasIslands, false, true)

      const fail = (error: unknown, request: Request, cookieStore?: CookieStore, ctx?: RequestContext): Promise<Response> => {
        notifyError(error, request, 'route')
        return renderError(error, cookieStore, ctx?.url ?? new URL(request.url), request, ctx)
      }
      const respondHtml = (body: string, request: Request, cookieStore?: CookieStore): Response => {
        const res = compressedHtmlResponse(docPrefix + body + docSuffix, 200, fastHeaders, request, compressCache, !entry.hasLoad)
        return cookieStore?.hasChanges ? finish(res, request, cookieStore) : withHsts(res, request)
      }
      const layoutProps = (inner: string, url: URL, locals: Record<string, unknown>) => ({ children: raw(inner), url, params: {}, locals })

      const wrapLayouts = (inner: string, request: Request, url: URL, locals: Record<string, unknown>, cookieStore?: CookieStore, ctx?: RequestContext): Response | Promise<Response> => {
        if (layouts.length === 0)
          return respondHtml(inner, request, cookieStore)
        if (singleLayout !== undefined) {
          const wrapped = singleLayout.default(layoutProps(inner, url, locals))
          if (wrapped instanceof Promise)
            return wrapped.then(x => respondHtml(ssrChild(x as Html), request, cookieStore), error => fail(error, request, cookieStore, ctx))
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
            return fail(error, request, cookieStore, ctx)
          }
        })()
      }

      const renderPage = (data: unknown, request: Request, url: URL, locals: Record<string, unknown>, cookieStore?: CookieStore, ctx?: RequestContext): Response | Promise<Response> => {
        const pageProps: Record<string, unknown> = { params: {}, locals, url, ...(data !== undefined ? { data } : {}) }
        if (entry.isIsland && entry.islandChunk !== undefined) {
          return wrapLayouts(ssrIsland(
            entry.islandChunk,
            () => ssrChild(mod.default!(pageProps) as Html),
            data !== undefined ? { data } : {},
            entry.islandHydrate as HydrateStrategy | undefined,
          ), request, url, locals, cookieStore, ctx)
        }
        const rendered = mod.default!(pageProps)
        if (rendered instanceof Promise)
          return rendered.then(r => wrapLayouts(ssrChild(r as Html), request, url, locals, cookieStore, ctx), error => fail(error, request, cookieStore, ctx))
        return wrapLayouts(ssrChild(rendered as Html), request, url, locals, cookieStore, ctx)
      }

      fastStaticPages.set(entry.path, (request, remoteIp, url = new URL(request.url)) => {
        try {
          if (!entry.hasLoad || typeof mod.load !== 'function')
            return renderPage(undefined, request, url, {})

          const { ctx, cookieStore } = makeRequestContext(request, {}, { trustProxy, remoteIp, url })
          const afterLoad = async (pending: unknown): Promise<Response> => {
            try {
              const loaded = await pending
              if (loaded instanceof Response)
                return finish(loaded, request, cookieStore)
              return await renderPage(loaded, request, url, ctx.locals, cookieStore, ctx)
            }
            catch (error) {
              return fail(error, request, cookieStore, ctx)
            }
          }
          return afterLoad(mod.load(ctx))
        }
        catch (error) {
          return fail(error, request)
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

    // API route (.ts exporting GET/POST/etc.)
    const methodHandler = mod[ctx.request.method]
    if (typeof methodHandler === 'function')
      return await (methodHandler as (c: RequestContext) => Response | Promise<Response>)(ctx)

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
    const renderedIslands = resolveRenderedIslands(rctx, body)
    const isStreamed = rctx.pending.length > 0
    const hasIslands = renderedIslands.hasIslands || (isStreamed && entry.islandChunks.length > 0)
    const preloadChunks = isStreamed ? entry.islandChunks : renderedIslands.eagerChunks

    // Streaming SSR when <Suspense> boundaries are pending (never buffered for compression)
    if (isStreamed) {
      disableTimeout?.()
      let shell = renderDocument({ ...doc, body: body + STREAM_TAIL_MARK, head: collectedHead, htmlAttrs: rctx.htmlAttrs, preloadChunks, hasIslands, hasSuspense: true })
      // Transforms see the document with its initial body; boundaries resolved later stream as they render.
      for (const transform of htmlTransformers)
        shell = await transform(shell, ctx)
      let splitAt = shell.lastIndexOf(STREAM_TAIL_MARK)
      let tailOffset = STREAM_TAIL_MARK.length
      if (splitAt === -1) {
        splitAt = shell.lastIndexOf('</body>')
        tailOffset = 0
      }
      const openingHtml = splitAt === -1 ? shell : shell.slice(0, splitAt)
      const tailHtml = splitAt === -1 ? '' : shell.slice(splitAt + tailOffset)

      const abortCtrl = new AbortController()
      let closed = false
      const deadline = Date.now() + streamTimeout

      const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, data: Uint8Array): void => {
        if (closed || abortCtrl.signal.aborted)
          return
        try {
          controller.enqueue(data)
        }
        catch {
          closed = true
          abortCtrl.abort()
        }
      }

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          safeEnqueue(controller, textEncoder.encode(openingHtml))
          // A resolved boundary can render boundaries of its own, so each flush also drains the ones it added.
          let flushed = 0
          const flushPending = async (): Promise<void> => {
            if (closed || abortCtrl.signal.aborted)
              return
            const chunks = rctx.pending.slice(flushed)
            flushed = rctx.pending.length
            await Promise.all(chunks.map(async (chunk) => {
              const settled = await settleWithin(chunk, deadline, abortCtrl.signal)
              if (settled === undefined || closed || abortCtrl.signal.aborted)
                return
              if ('error' in settled)
                notifyError(settled.error, ctx.request, 'route')
              safeEnqueue(controller, textEncoder.encode(streamChunkScript(chunk.id, settled.html)))
              await flushPending()
            }))
          }
          await flushPending()
          if (!closed && !abortCtrl.signal.aborted) {
            safeEnqueue(controller, textEncoder.encode(tailHtml))
            closed = true
            try {
              controller.close()
            }
            catch {}
          }
        },
        cancel() {
          closed = true
          abortCtrl.abort()
        },
      })

      return new Response(stream, { status: 200, headers: htmlHeaders(hasIslands, true, true) })
    }

    let html = renderDocument({ ...doc, body, head: collectedHead, htmlAttrs: rctx.htmlAttrs, preloadChunks, hasIslands })
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

      // 2. Server actions (POST /_kay/action/<id>): plugin middlewares, then the _middleware.ts chain of the action's folder
      if (actionHandler !== undefined) {
        const { act, middlewares } = actionHandler
        const { ctx, cookieStore } = makeRequestContext(req, {}, { trustProxy, remoteIp, url })
        try {
          return finish(await runChain(ctx, middlewares, () => executeAction(act, req, ctx, trustedOrigins, trustProxy)), req, cookieStore)
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
      for (const rewrite of pluginRewrites) {
        const nextPath = rewrite(effectivePath, ctx)
        if (nextPath !== undefined)
          effectivePath = nextPath
      }

      // Custom plugin routes run behind plugin middlewares so ctx.locals (e.g. auth user/session) is available.
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
          const res = await runChain(ctx, allPluginMiddlewares, () => routeDef.handler(ctx))
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

  let disposed = false
  async function dispose(): Promise<void> {
    if (disposed)
      return
    disposed = true
    for (const hook of shutdownHooks) {
      try {
        await hook()
      }
      catch {}
    }
  }

  return { handle, serve, dispose }
}
