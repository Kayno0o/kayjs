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
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { loadConfig } from '../plugins/index'
import { createRenderContext, renderCollectedHead, runWithRenderContext, streamChunkScript } from '../ssr/context'
import { raw, renderDocument, ssrChild, ssrIsland } from '../ssr/index'
import { executeAction, isServerAction } from './action'
import { extractRenderedIslands, finalizeResponse, makeRequestContext, MIME } from './http'
import { Router } from './router'
import { applySecurityHeaders } from './security'

export { defineConfig, definePlugin, loadConfig } from '../plugins/index'
export type { BuildPluginContext, KayConfig, KayPlugin, ServerPluginAPI } from '../plugins/index'
export { action } from './action'
export type { ActionContext, ActionResult, ServerAction } from './action'
export type { CookieOptions, Cookies } from './cookies'
export { defineEnv } from './env'
export type { EmbeddedServerConfig, KayApp, Middleware, RequestContext, ServerOptions } from './http'
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

export async function createServerFromEmbedded(config: EmbeddedServerConfig): Promise<KayApp> {
  const { manifest, modules, assets, publicAssets = {}, publicEtags = {}, prerendered, lang = 'en', security, plugins = [] } = config
  const assetPrefix = (config.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const trustedOrigins = config.trustedOrigins ? new Set(config.trustedOrigins) : undefined
  const alwaysLoadRuntime = plugins.some(p => Boolean(p.clientEntry))
  const htmlTransformers = plugins
    .map(p => p.transformHtml)
    .filter((fn): fn is NonNullable<KayPlugin['transformHtml']> => typeof fn === 'function')

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

  const hasPluginRequestHooks = globalMiddlewares.length > 0 || pluginRewrites.length > 0 || htmlTransformers.length > 0 || pluginRouteEntries.size > 0

  // Hashed build asset table (immutable cache)
  const assetMap = new Map<string, { body: EmbeddedBody, type: string }>()
  for (const [rel, body] of Object.entries(assets)) {
    assetMap.set(`${assetPrefix}/${rel}`, { body, type: MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream' })
  }

  // Static public/ file table (ETag + 304 support)
  const publicMap = new Map<string, { body: EmbeddedBody, type: string, etag: string }>()
  for (const [rel, body] of Object.entries(publicAssets)) {
    const etag = publicEtags[rel] ?? (typeof body === 'string' ? `W/"${Bun.hash(rel).toString(36)}"` : `W/"${Bun.hash(body).toString(36)}"`)
    publicMap.set(`/${rel}`, { body, type: MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream', etag })
  }

  const toResponseBody = (body: EmbeddedBody) => typeof body === 'string' ? Bun.file(body) : body

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

  // Static prerendered pages table
  const prerenderedMap = new Map<string, string>()
  for (const route of manifest.routes) {
    if (route.prerendered) {
      for (const [urlPath, relHtml] of Object.entries(route.prerendered)) {
        const html = prerendered[relHtml]
        if (html !== undefined)
          prerenderedMap.set(urlPath, html)
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
    const shell = renderDocument({
      body: '\0',
      headTags: manifest.headTags,
      lang,
      runtimeScript: manifest.runtimeScript,
      alwaysLoadRuntime,
      preloadChunks: entry.eagerIslandChunks ?? entry.islandChunks,
      styles: manifest.styles,
      hasIslands,
    })
    const splitAt = shell.indexOf('\0')
    const docPrefix = shell.slice(0, splitAt)
    const docSuffix = shell.slice(splitAt + 1)

    // Ultra-fast zero-overhead path when route is static, has no middleware, no <Head>/<Suspense>, no plugins
    const canFastPath = !hasPluginRequestHooks
      && !entry.path.includes(':')
      && !entry.path.includes('*')
      && middlewares.length === 0
      && !entry.usesRenderContext
      && typeof mod.default === 'function'
      && mod.GET === undefined

    let fastHandler: ((req: Request) => Response | Promise<Response>) | undefined
    if (canFastPath) {
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
      if (security !== false) {
        const h = new Headers(headers)
        applySecurityHeaders(h, security)
        h.forEach((v, k) => { headers[k] = v })
      }
      const singleLayout = layouts.length === 1 ? layouts[0]! : undefined

      fastHandler = (request: Request): Response | Promise<Response> => {
        const reqUrl = new URL(request.url)
        const wrapLayouts = (inner: string): Response | Promise<Response> => {
          if (layouts.length === 0)
            return new Response(docPrefix + inner + docSuffix, { status: 200, headers })
          if (singleLayout !== undefined) {
            const w = singleLayout.default({ children: raw(inner), url: reqUrl, params: {}, locals: {} })
            if (w instanceof Promise)
              return w.then(x => new Response(docPrefix + ssrChild(x as Html) + docSuffix, { status: 200, headers }))
            return new Response(docPrefix + ssrChild(w as Html) + docSuffix, { status: 200, headers })
          }
          return (async () => {
            let cur = inner
            for (let i = layouts.length - 1; i >= 0; i--)
              cur = ssrChild(await layouts[i]!.default({ children: raw(cur), url: reqUrl, params: {}, locals: {} }) as Html)
            return new Response(docPrefix + cur + docSuffix, { status: 200, headers })
          })()
        }

        const renderPage = (pageProps: Record<string, unknown>): Response | Promise<Response> => {
          if (entry.isIsland && entry.islandChunk !== undefined) {
            const inner = ssrIsland(
              entry.path,
              entry.islandChunk,
              () => ssrChild(mod.default!(pageProps) as Html),
              pageProps,
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
          const { ctx } = makeRequestContext(request, {})
          const loaded = mod.load(ctx)
          if (loaded instanceof Promise)
            return loaded.then(data => renderPage(data !== undefined ? { data } : {}))
          return renderPage(loaded !== undefined ? { data: loaded } : {})
        }
        return renderPage({})
      }
      fastStaticPages.set(entry.path, fastHandler)
    }

    router.add(entry.path, { entry, mod, layouts, middlewares, fastHandler, docPrefix, docSuffix })
  }

  async function renderCompiledRoute(route: CompiledRoute, ctx: RequestContext, cookieStore: CookieStore): Promise<Response> {
    const { entry, mod, layouts } = route

    // API route (.ts exporting GET/POST/etc.)
    const methodHandler = mod[ctx.request.method]
    if (typeof methodHandler === 'function') {
      const res = await (methodHandler as (c: RequestContext) => Response | Promise<Response>)(ctx)
      return finalizeResponse(res, cookieStore, security)
    }

    if (typeof mod.default !== 'function')
      return finalizeResponse(new Response('Method Not Allowed', { status: 405 }), cookieStore, security)

    const data = entry.hasLoad && typeof mod.load === 'function' ? await mod.load(ctx) : undefined
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

    // Streaming SSR path when <Suspense> boundaries are pending!
    if (rctx.pending.length > 0) {
      const shell = renderDocument({
        body: '\0',
        head: collectedHead,
        headTags: manifest.headTags,
        lang,
        runtimeScript: manifest.runtimeScript,
        alwaysLoadRuntime,
        preloadChunks,
        styles: manifest.styles,
        hasIslands,
      })
      const splitAt = shell.indexOf('\0')
      const headHtml = shell.slice(0, splitAt)
      const tailHtml = shell.slice(splitAt + 1)
      const encoder = new TextEncoder()

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(headHtml + body))
          await Promise.all(
            rctx.pending.map(async (chunk) => {
              const resolved = await chunk.promise
              controller.enqueue(encoder.encode(streamChunkScript(chunk.id, resolved)))
            }),
          )
          controller.enqueue(encoder.encode(tailHtml))
          controller.close()
        },
      })

      const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
      cookieStore.applyTo(headers)
      if (security !== false)
        applySecurityHeaders(headers, security)
      return new Response(stream, { status: 200, headers })
    }

    let html = renderDocument({
      body,
      head: collectedHead,
      headTags: manifest.headTags,
      lang,
      runtimeScript: manifest.runtimeScript,
      alwaysLoadRuntime,
      preloadChunks,
      styles: manifest.styles,
      hasIslands,
    })

    for (let i = 0; i < htmlTransformers.length; i++)
      html = await htmlTransformers[i]!(html, ctx)

    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
    cookieStore.applyTo(headers)
    if (security !== false)
      applySecurityHeaders(headers, security)
    return new Response(html, { status: 200, headers })
  }

  const rootLayoutFile = manifest.routes.find(r => r.layouts.length > 0)?.layouts[0]
  const rootLayoutMod = rootLayoutFile !== undefined ? modules[rootLayoutFile] as LoadedLayoutModule | undefined : undefined

  async function renderError(error: unknown, cookieStore: CookieStore, url?: URL): Promise<Response> {
    if (errorMod !== undefined) {
      const rctx = createRenderContext()
      const body = await runWithRenderContext(rctx, async () => {
        let inner = ssrChild(await errorMod.default({ error }) as Html)
        if (rootLayoutMod !== undefined)
          inner = ssrChild(await rootLayoutMod.default({ children: raw(inner), url: url ?? new URL('http://localhost/500'), params: {}, locals: {} }) as Html)
        return inner
      })
      const html = renderDocument({ body, head: renderCollectedHead(rctx), headTags: manifest.headTags, styles: manifest.styles, runtimeScript: manifest.runtimeScript, alwaysLoadRuntime, lang })
      return finalizeResponse(new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }), cookieStore, security)
    }
    return finalizeResponse(new Response('Internal Server Error', { status: 500 }), cookieStore, security)
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
      const html = renderDocument({ body, head: renderCollectedHead(rctx), headTags: manifest.headTags, styles: manifest.styles, runtimeScript: manifest.runtimeScript, alwaysLoadRuntime, lang })
      return finalizeResponse(new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }), cookieStore, security)
    }
    return finalizeResponse(new Response('Not Found', { status: 404 }), cookieStore, security)
  }

  async function handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname

    // 1. Static client assets
    const asset = assetMap.get(pathname)
    if (asset !== undefined) {
      return new Response(toResponseBody(asset.body), {
        status: 200,
        headers: {
          'content-type': asset.type,
          'cache-control': 'public, max-age=31536000, immutable',
        },
      })
    }

    // 1b. Static public/ files
    if (request.method === 'GET' || request.method === 'HEAD') {
      const pub = publicMap.get(pathname)
      if (pub !== undefined) {
        if (request.headers.get('if-none-match') === pub.etag)
          return new Response(null, { status: 304, headers: { 'etag': pub.etag, 'cache-control': 'public, max-age=3600' } })
        return new Response(request.method === 'HEAD' ? null : toResponseBody(pub.body), {
          status: 200,
          headers: {
            'content-type': pub.type,
            'etag': pub.etag,
            'cache-control': 'public, max-age=3600',
          },
        })
      }
    }

    // 2. Server actions (POST /_kay/action/<id>)
    if (request.method === 'POST') {
      const act = actionHandlers.get(pathname)
      if (act !== undefined) {
        const { ctx, cookieStore } = makeRequestContext(request, {})
        const actionCtx: ActionContext = {
          request: ctx.request,
          url: ctx.url,
          params: ctx.params,
          cookies: ctx.cookies,
          locals: ctx.locals,
          redirect: ctx.redirect,
          deny: ctx.deny,
        }
        const res = await executeAction(act, request, actionCtx, trustedOrigins)
        return finalizeResponse(res, cookieStore, security)
      }
    }

    // 3. Prerendered static HTML (when no plugin request hooks intercept)
    if (!hasPluginRequestHooks && (request.method === 'GET' || request.method === 'HEAD')) {
      const pre = prerenderedMap.get(pathname)
      if (pre !== undefined) {
        const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
        if (security !== false)
          applySecurityHeaders(headers, security)
        return new Response(pre, { status: 200, headers })
      }
    }

    // 4. Ultra-fast static route path
    if (request.method === 'GET') {
      const fast = fastStaticPages.get(pathname)
      if (fast !== undefined)
        return fast(request)
    }

    // 5. Full Router + Plugin Rewrites + Plugin Routes + Middleware + Streaming/Head/Error pipeline
    const { ctx, cookieStore } = makeRequestContext(request, {})

    // Apply plugin URL rewrites (e.g. @kayjs/i18n stripping /fr prefix and setting ctx.locals.locale)
    let effectivePath = pathname
    for (let i = 0; i < pluginRewrites.length; i++) {
      const nextPath = pluginRewrites[i]!(effectivePath, ctx)
      if (nextPath !== undefined)
        effectivePath = nextPath
    }

    // Check custom plugin routes first (e.g. GET /sitemap.xml, POST /auth/callback)
    const pluginMatch = pluginRouter.match(effectivePath)
    if (pluginMatch !== undefined) {
      const methodHandler = pluginMatch.data.get(request.method.toUpperCase()) ?? pluginMatch.data.get('ALL')
      if (methodHandler !== undefined) {
        ctx.params = pluginMatch.params
        const res = await methodHandler(ctx)
        return finalizeResponse(res, cookieStore, security)
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
        return renderCompiledRoute(route, ctx, cookieStore)
      }
      const res = await dispatch(0)
      return finalizeResponse(res, cookieStore, security)
    }
    catch (error) {
      return renderError(error, cookieStore, ctx.url)
    }
  }

  function serve(port = 3000) {
    const routes: Record<string, Response | ((req: Request) => Response | Promise<Response>)> = {}

    for (const [path, asset] of assetMap) {
      const headers = {
        'content-type': asset.type,
        'cache-control': 'public, max-age=31536000, immutable',
      }
      routes[path] = typeof asset.body === 'string'
        ? () => new Response(Bun.file(asset.body as string), { status: 200, headers })
        : new Response(asset.body, { status: 200, headers })
    }

    for (const [path, pub] of publicMap) {
      if (!(path in routes)) {
        const headers = {
          'content-type': pub.type,
          'etag': pub.etag,
          'cache-control': 'public, max-age=3600',
        }
        routes[path] = typeof pub.body === 'string'
          ? () => new Response(Bun.file(pub.body as string), { status: 200, headers })
          : new Response(pub.body, { status: 200, headers })
      }
    }

    for (const [path, pre] of prerenderedMap) {
      const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
      if (security !== false)
        applySecurityHeaders(headers, security)
      routes[path] = new Response(pre, { status: 200, headers })
    }

    for (const [path, handler] of fastStaticPages) {
      if (!(path in routes))
        routes[path] = handler
    }

    return Bun.serve({
      port,
      routes,
      fetch: handle,
    })
  }

  return { handle, serve }
}

export async function createServer(options: ServerOptions): Promise<KayApp> {
  const root = resolve(options.root)
  const fileConfig = await loadConfig(root)
  const plugins = options.plugins ?? fileConfig.plugins ?? []
  const outDir = resolve(root, options.outDir ?? fileConfig.outDir ?? 'dist')
  const clientDir = join(outDir, 'client')
  const manifestPath = join(outDir, 'manifest.json')

  if (!existsSync(manifestPath))
    throw new Error(`kay server: missing ${manifestPath}. Run build() first.`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest
  const modules: Record<string, unknown> = {}
  const assets: Record<string, Uint8Array<ArrayBuffer>> = {}
  const publicAssets: Record<string, Uint8Array<ArrayBuffer>> = {}
  const prerendered: Record<string, string> = {}

  for (const rel of manifest.assets) {
    const abs = join(clientDir, rel)
    if (existsSync(abs))
      assets[rel] = new Uint8Array(readFileSync(abs))
  }

  for (const rel of manifest.publicFiles ?? []) {
    const abs = join(outDir, 'public', rel)
    if (existsSync(abs))
      publicAssets[rel] = new Uint8Array(readFileSync(abs))
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
          prerendered[relHtml] = readFileSync(abs, 'utf8')
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
    prerendered,
    assetPrefix: options.assetPrefix ?? fileConfig.assetPrefix,
    lang: options.lang ?? fileConfig.lang,
    security: options.security ?? fileConfig.security,
    trustedOrigins: options.trustedOrigins ?? fileConfig.trustedOrigins,
    plugins,
  })
}
