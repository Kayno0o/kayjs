// Request pathname decoding, manifest prefix/ancestor middleware lookup, 405 helper, and fast static page handler.

import type { ActionManifestEntry, BuildManifest, RouteManifestEntry } from '../build/index'
import type { Html, HydrateStrategy } from '../jsx-runtime'
import type { DocumentOptions } from '../ssr/index'
import type { RenderContext } from '../ssr/context'
import type { ActionRegistry } from './action-registry'
import type { CompressionCache } from './compress'
import type { CookieStore } from './cookies'
import type { HtmlHeaders } from './document'
import type { NotifyError } from './errors'
import type { Middleware, RequestContext } from './http'
import type { KayLocals } from './index'
import type { LoadedLayoutModule, LoadedMiddlewareModule, LoadedPageModule } from './page'
import type { TrustProxy } from './security'
import { createRenderContext, runWithRenderContext } from '../ssr/context'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { keepScrollTag } from '../ssr/navigation'
import { compressedHtmlResponse, maybeCompressResponse } from './compress'
import { headTagStyleHashes, mergeStyleHashes } from './document'
import { isNotFound, makeRequestContext } from './http'
import { pickPageIslandProps } from './page'
import { withRegionVary } from './region'
import { Router } from './router'
import { styleHashesOf } from './security'

const UNSAFE_ENCODED_SEGMENT_RE = /%(?:2f|5c|00)/i
const MIDDLEWARE_BASENAME_RE = /(?:^|\/)_middleware\.js$/
const CATCH_ALL_BRACKET_RE = /\[\.\.\.([^\]]+)\]/g
const PARAM_BRACKET_RE = /\[([^\]]+)\]/g

export type FastHandler = (req: Request, remoteIp?: string, url?: URL) => Response | Promise<Response>

export type DecodedPathname =
  | { ok: true, staticPath: string | undefined, scopedPath: string }
  | { ok: false }

/**
 * Safely percent-decodes a request pathname segment-by-segment.
 * - Malformed `%` escapes return `{ ok: false }` (caller responds 400).
 * - Encoded slashes (`%2F`), backslashes (`%5C`), and NUL (`%00`) are never turned into separators:
 *   `staticPath` becomes `undefined` (rejecting static/public/prerendered lookups) while `scopedPath`
 *   decodes all other segments so path-scoped middleware cannot be bypassed via `/%61dmin/...`.
 */
export function decodeRequestPathname(rawPathname: string): DecodedPathname {
  if (!rawPathname.includes('%'))
    return { ok: true, staticPath: rawPathname, scopedPath: rawPathname }
  const parts = rawPathname.split('/')
  let hasUnsafe = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (!part.includes('%'))
      continue
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    }
    catch {
      return { ok: false }
    }
    if (UNSAFE_ENCODED_SEGMENT_RE.test(part))
      hasUnsafe = true
    else
      parts[i] = decoded
  }
  const scopedPath = parts.join('/')
  return { ok: true, staticPath: hasUnsafe ? undefined : scopedPath, scopedPath }
}

export function methodNotAllowed(allow: string): Response {
  return new Response('Method Not Allowed', allow ? { status: 405, headers: { allow } } : { status: 405 })
}

/** Encodes a static route/asset path for Bun.serve's `routes` table (which requires ASCII keys and treats `*` as a wildcard). */
export function toBunRouteKey(path: string): string | undefined {
  if (path.includes('*'))
    return undefined
  return path.split('/').map(encodeURIComponent).join('/')
}

function dirnamePrefix(file: string): string {
  const slash = file.lastIndexOf('/')
  return slash === -1 ? '' : file.slice(0, slash + 1)
}

function dirToRoutePattern(relDir: string): string {
  if (relDir === '')
    return '/'
  return `/${relDir.replace(CATCH_ALL_BRACKET_RE, '*$1').replace(PARAM_BRACKET_RE, ':$1')}`
}

/** Infers the compiled module prefix for files under `routesDir` (e.g. `'server/'` or `'server/src/routes/'`). */
export function inferRoutesServerPrefix(manifest: BuildManifest): string {
  const rootSpecial = manifest.rootLayoutFile ?? manifest.errorFile ?? manifest.notFoundFile
  if (rootSpecial !== undefined)
    return dirnamePrefix(rootSpecial)

  for (const route of manifest.routes) {
    const fileParts = route.file.split('/')
    const pathSegs = route.path === '/' ? [] : route.path.replace(/^\/|\/$/g, '').split('/')
    const isIndex = fileParts[fileParts.length - 1] === 'index.js'
    const routePartCount = pathSegs.length + (isIndex ? 1 : 0)
    if (routePartCount <= fileParts.length) {
      const prefixParts = fileParts.slice(0, fileParts.length - routePartCount)
      return prefixParts.length === 0 ? '' : `${prefixParts.join('/')}/`
    }
  }

  for (const entry of manifest.actions) {
    if (entry.file.startsWith('server/src/routes/'))
      return 'server/src/routes/'
  }
  return 'server/'
}

/** Derives an action's route directory prefix (e.g. `'/admin'`) when declared under `routesDir`. */
export function actionRoutePrefix(
  entry: ActionManifestEntry,
  routesPrefix: string,
  routePathByFile: ReadonlyMap<string, string>,
): string | undefined {
  const exactRoutePath = routePathByFile.get(entry.file)
  if (exactRoutePath !== undefined)
    return exactRoutePath
  if (!entry.file.startsWith(routesPrefix))
    return undefined
  const rel = entry.file.slice(routesPrefix.length)
  const slash = rel.lastIndexOf('/')
  const relDir = slash === -1 ? '' : rel.slice(0, slash)
  return dirToRoutePattern(relDir)
}

export interface AncestorMiddlewareMatch {
  middlewares: Middleware[]
  params: Record<string, string>
}

/** Builds a lookup returning the outermost-to-innermost `_middleware.ts` chain for any unmatched pathname. */
export function createAncestorMiddlewareLookup(
  manifest: BuildManifest,
  modules: Record<string, unknown>,
  routesPrefix: string,
): (pathname: string) => AncestorMiddlewareMatch | undefined {
  const byPattern = new Map<string, Middleware[]>()
  const seenModules = new Set<string>()

  const addMiddlewareModule = (modKey: string): void => {
    if (seenModules.has(modKey))
      return
    seenModules.add(modKey)
    if (!modKey.startsWith(routesPrefix) || !MIDDLEWARE_BASENAME_RE.test(modKey))
      return
    const mod = modules[modKey] as LoadedMiddlewareModule | undefined
    if (typeof mod?.default !== 'function')
      return
    const rel = modKey.slice(routesPrefix.length)
    const relDir = rel.replace(MIDDLEWARE_BASENAME_RE, '')
    const pattern = dirToRoutePattern(relDir)
    let list = byPattern.get(pattern)
    if (list === undefined) {
      list = []
      byPattern.set(pattern, list)
    }
    list.push(mod.default)
  }

  for (const route of manifest.routes) {
    for (const mwKey of route.middlewares)
      addMiddlewareModule(mwKey)
  }
  for (const act of manifest.actions) {
    for (const mwKey of act.middlewares)
      addMiddlewareModule(mwKey)
  }
  for (const modKey of Object.keys(modules)) {
    if (modKey.startsWith(routesPrefix) && MIDDLEWARE_BASENAME_RE.test(modKey))
      addMiddlewareModule(modKey)
  }

  if (byPattern.size === 0)
    return () => undefined

  const dirRouter = new Router<Middleware[]>()
  for (const [pattern, list] of byPattern)
    dirRouter.add(pattern, list)

  return (pathname: string): AncestorMiddlewareMatch | undefined => {
    const norm = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
    const segments = norm === '/' ? [] : norm.slice(1).split('/')
    const middlewares: Middleware[] = []
    const params: Record<string, string> = {}

    let prefix = ''
    for (let i = 0; i <= segments.length; i++) {
      const candidate = i === 0 ? '/' : `${prefix}/${segments[i - 1]!}`
      if (i > 0)
        prefix = candidate
      const matched = dirRouter.match(candidate)
      if (matched !== undefined) {
        for (const mw of matched.data)
          middlewares.push(mw)
        Object.assign(params, matched.params)
      }
    }

    return middlewares.length > 0 ? { middlewares, params } : undefined
  }
}

export interface FastStaticPageOptions {
  entry: RouteManifestEntry
  mod: LoadedPageModule
  layouts: LoadedLayoutModule[]
  doc: DocumentOptions
  hasIslands: boolean
  hasLoad: boolean
  trustProxy: TrustProxy
  htmlHeaders: HtmlHeaders
  compressCache: CompressionCache | undefined
  actions: ActionRegistry
  buildNotFoundResponse: (url?: URL, req?: Request, ctx?: RequestContext) => Promise<Response>
  renderError: (error: unknown, cookieStore: CookieStore | undefined, url: URL, request: Request, ctx?: RequestContext) => Promise<Response>
  notifyError: NotifyError
  finish: (res: Response, request: Request, cookieStore?: CookieStore) => Response
  withHsts: (res: Response, request: Request) => Response
}

/** Builds the zero-overhead static-path page handler, keeping `actions.run()` active through load, render, and 404 fallback. */
export function createFastStaticPageHandler(options: FastStaticPageOptions): FastHandler {
  const {
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
  } = options

  const shell = renderDocument({ ...doc, body: '\0', preloadChunks: entry.eagerIslandChunks ?? entry.islandChunks, hasIslands })
  const splitAt = shell.indexOf('\0')
  const docPrefix = shell.slice(0, splitAt)
  const docSuffix = shell.slice(splitAt + 1)
  const headStyleHashes = headTagStyleHashes(doc.headTags)
  const singleLayout = layouts.length === 1 ? layouts[0]! : undefined

  const fail = (error: unknown, request: Request, url: URL, cookieStore?: CookieStore, ctx?: RequestContext): Promise<Response> => {
    notifyError(error, request, 'route')
    return renderError(error, cookieStore, url, request, ctx)
  }
  const respondHtml = (body: string, request: Request, rctx: RenderContext, cookieStore?: CookieStore): Response => {
    const html = docPrefix + body + keepScrollTag(body) + docSuffix
    const styleHashes = mergeStyleHashes(headStyleHashes, styleHashesOf(rctx.inlineStyles))
    const headers = withRegionVary(htmlHeaders(hasIslands, false, true, styleHashes), rctx.regionNames.size > 0)
    const res = compressedHtmlResponse(html, 200, headers, request, compressCache, !hasLoad)
    return cookieStore?.hasChanges ? finish(res, request, cookieStore) : withHsts(res, request)
  }
  const layoutProps = (inner: string, url: URL, locals: KayLocals) => ({ children: raw(inner), url, params: {}, locals })

  const finishSingleLayout = async (wrapped: Promise<Html | string>, request: Request, url: URL, rctx: RenderContext, cookieStore?: CookieStore, ctx?: RequestContext): Promise<Response> => {
    try {
      return respondHtml(ssrChild(await wrapped as Html), request, rctx, cookieStore)
    }
    catch (error) {
      return fail(error, request, url, cookieStore, ctx)
    }
  }

  const wrapLayouts = (inner: string, request: Request, url: URL, locals: KayLocals, rctx: RenderContext, cookieStore?: CookieStore, ctx?: RequestContext): Response | Promise<Response> => {
    if (layouts.length === 0)
      return respondHtml(inner, request, rctx, cookieStore)
    if (singleLayout !== undefined) {
      const wrapped = singleLayout.default(layoutProps(inner, url, locals))
      if (wrapped instanceof Promise)
        return finishSingleLayout(wrapped, request, url, rctx, cookieStore, ctx)
      return respondHtml(ssrChild(wrapped as Html), request, rctx, cookieStore)
    }
    return (async () => {
      try {
        let cur = inner
        for (let i = layouts.length - 1; i >= 0; i--)
          cur = ssrChild(await layouts[i]!.default(layoutProps(cur, url, locals)) as Html)
        return respondHtml(cur, request, rctx, cookieStore)
      }
      catch (error) {
        return fail(error, request, url, cookieStore, ctx)
      }
    })()
  }

  const finishAsyncPage = async (rendered: Promise<Html | string>, request: Request, url: URL, locals: KayLocals, rctx: RenderContext, cookieStore?: CookieStore, ctx?: RequestContext): Promise<Response> => {
    try {
      return await wrapLayouts(ssrChild(await rendered as Html), request, url, locals, rctx, cookieStore, ctx)
    }
    catch (error) {
      return fail(error, request, url, cookieStore, ctx)
    }
  }

  const renderPage = (data: unknown, request: Request, url: URL, locals: KayLocals, rctx: RenderContext, cookieStore?: CookieStore, ctx?: RequestContext): Response | Promise<Response> => {
    const pageProps: Record<string, unknown> = { params: {}, locals, url, ...(data !== undefined ? { data } : {}) }
    if (entry.isIsland && entry.islandChunk !== undefined) {
      return wrapLayouts(ssrIsland(
        entry.islandChunk,
        () => ssrChild(mod.default!(pageProps) as Html),
        pickPageIslandProps(data, entry, mod),
        entry.islandHydrate as HydrateStrategy | undefined,
        true,
        mod.default!.name,
      ), request, url, locals, rctx, cookieStore, ctx)
    }
    const rendered = mod.default!(pageProps)
    if (rendered instanceof Promise)
      return finishAsyncPage(rendered, request, url, locals, rctx, cookieStore, ctx)
    return wrapLayouts(ssrChild(rendered as Html), request, url, locals, rctx, cookieStore, ctx)
  }

  return (request, remoteIp, url = new URL(request.url)) => {
    const { ctx, cookieStore } = makeRequestContext(request, {}, { trustProxy, remoteIp, url })
    if (request.method === 'HEAD' && typeof mod.HEAD === 'function') {
      return actions.run(ctx, async () => {
        try {
          return finish(await mod.HEAD!(ctx), request, cookieStore)
        }
        catch (error) {
          return fail(error, request, url, cookieStore, ctx)
        }
      })
    }
    const rctx = createRenderContext()
    try {
      if (!hasLoad)
        return actions.run(ctx, () => runWithRenderContext(rctx, () => renderPage(undefined, request, url, ctx.locals, rctx, cookieStore, ctx)))

      return actions.run(ctx, async () => {
        let loaded: unknown
        try {
          loaded = await mod.load!(ctx)
        }
        catch (error) {
          if (isNotFound(error))
            return finish(await maybeCompressResponse(await buildNotFoundResponse(url, request, ctx), request, compressCache), request, cookieStore)
          return fail(error, request, url, cookieStore, ctx)
        }
        if (isNotFound(loaded))
          return finish(await maybeCompressResponse(await buildNotFoundResponse(url, request, ctx), request, compressCache), request, cookieStore)
        if (loaded instanceof Response)
          return finish(await maybeCompressResponse(loaded, request, compressCache), request, cookieStore)
        try {
          return await runWithRenderContext(rctx, () => renderPage(loaded, request, url, ctx.locals, rctx, cookieStore, ctx))
        }
        catch (error) {
          return fail(error, request, url, cookieStore, ctx)
        }
      })
    }
    catch (error) {
      return fail(error, request, url, cookieStore, ctx)
    }
  }
}
