// What plugins see of a running server: each `server(api)` hook, and the middleware, routes, rewrites and shutdown hooks those hooks register.

import type { BuildManifest } from '../build/index'
import type { AppRuntimeContext } from '../plugins/context'
import type { KayPlugin, MiddlewareOptions, PluginRouteOptions, ServerPluginAPI } from '../plugins/index'
import type { EmbeddedServerConfig, Middleware, RequestContext } from './http'
import type { TrustProxy } from './security'
import { runWithAppContext } from '../plugins/context'
import { Router } from './router'

export interface PluginRouteDef {
  handler: (ctx: RequestContext) => Response | Promise<Response>
  csrf: boolean
  trustedOrigins: Set<string> | undefined
  trustProxy: TrustProxy
}

interface ScopedMiddleware {
  mw: Middleware
  scope: 'all' | 'dynamic' | string
}

export interface ServerPluginHostOptions {
  plugins: readonly KayPlugin[]
  config: EmbeddedServerConfig
  manifest: BuildManifest
  appCtx: AppRuntimeContext
  root: string
  outDir: string
  assetPrefix: string
  site: string | undefined
  dev: boolean
  trustProxy: TrustProxy
  trustedOriginsList: readonly string[]
  trustedOrigins: Set<string> | undefined
  invokeAction: ServerPluginAPI['invokeAction']
}

function middlewareAppliesToPath(scope: ScopedMiddleware['scope'], path: string, isStaticFast: boolean): boolean {
  if (scope === 'all')
    return true
  if (scope === 'dynamic')
    return !isStaticFast
  return path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)
}

export function allowedPluginMethodsHeader(methods: ReadonlyMap<string, PluginRouteDef>): string {
  const allowed = new Set<string>()
  for (const m of methods.keys()) {
    if (m === 'ALL')
      continue
    allowed.add(m)
  }
  if (allowed.has('GET'))
    allowed.add('HEAD')
  return [...allowed].join(', ')
}

export async function createServerPluginHost(options: ServerPluginHostOptions) {
  const { plugins, config, manifest, appCtx, trustedOrigins, trustProxy } = options
  const scopedMiddlewares: ScopedMiddleware[] = []
  const shutdownHooks: (() => void | Promise<void>)[] = []
  const rewrites: ((pathname: string, ctx: RequestContext) => string | undefined)[] = []
  const router = new Router<Map<string, PluginRouteDef>>()
  const routeEntries = new Map<string, Map<string, PluginRouteDef>>()

  const registerRoute = (
    method: string,
    path: string,
    handler: (ctx: RequestContext) => Response | Promise<Response>,
    routeOptions?: PluginRouteOptions,
  ): void => {
    const normPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
    let byMethod = routeEntries.get(normPath)
    if (byMethod === undefined) {
      byMethod = new Map()
      routeEntries.set(normPath, byMethod)
      router.add(normPath, byMethod)
    }
    let routeTrustedOrigins = trustedOrigins
    if (routeOptions?.trustedOrigins !== undefined && routeOptions.trustedOrigins.length > 0) {
      routeTrustedOrigins = new Set([...(trustedOrigins ?? []), ...routeOptions.trustedOrigins])
    }
    byMethod.set(method.toUpperCase(), {
      handler,
      csrf: routeOptions?.csrf ?? true,
      trustedOrigins: routeTrustedOrigins,
      trustProxy: routeOptions?.trustProxy ?? trustProxy,
    })
  }

  const {
    manifest: _m,
    modules: _mods,
    assets: _a,
    publicAssets: _pa,
    publicEtags: _pe,
    prerendered: _pr,
    prerenderedFiles: _pf,
    ...forwardedConfig
  } = config as EmbeddedServerConfig & Record<string, unknown>
  const readonlyRuntimeConfig: Readonly<Record<string, unknown>> = Object.freeze({ ...forwardedConfig })

  for (const plugin of plugins) {
    if (plugin.dispose !== undefined)
      shutdownHooks.push(() => plugin.dispose!())
    if (plugin.server !== undefined) {
      const pluginApi: ServerPluginAPI = {
        root: options.root,
        outDir: options.outDir,
        assetPrefix: options.assetPrefix,
        site: options.site,
        dev: options.dev,
        trustProxy,
        trustedOrigins: options.trustedOriginsList,
        config: readonlyRuntimeConfig,
        use(mw: Middleware, middlewareOptions?: MiddlewareOptions) {
          scopedMiddlewares.push({ mw, scope: middlewareOptions?.scope ?? 'all' })
        },
        route: registerRoute,
        rewrite(fn) {
          rewrites.push(fn)
        },
        provide: appCtx.provide,
        inject: appCtx.inject,
        getBuildData<T = Record<string, unknown>>(pluginName?: string): T | undefined {
          return manifest.pluginData?.[pluginName ?? plugin.name] as T | undefined
        },
        onShutdown(fn) {
          shutdownHooks.push(fn)
        },
        invokeAction: options.invokeAction,
      }
      await runWithAppContext(appCtx, () => plugin.server!(pluginApi))
    }
  }

  const allMiddlewares: readonly Middleware[] = scopedMiddlewares.map(m => m.mw)
  const staticFastMiddlewares: readonly Middleware[] = scopedMiddlewares
    .filter(m => m.scope === 'all')
    .map(m => m.mw)
  const hasPathScopedMiddlewares = scopedMiddlewares.some(m => m.scope !== 'all' && m.scope !== 'dynamic')
  const middlewaresFor = (path: string, isStaticFast = false): readonly Middleware[] => {
    if (scopedMiddlewares.length === 0)
      return allMiddlewares
    if (!hasPathScopedMiddlewares)
      return isStaticFast ? staticFastMiddlewares : allMiddlewares
    return scopedMiddlewares.filter(m => middlewareAppliesToPath(m.scope, path, isStaticFast)).map(m => m.mw)
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

  return { router, rewrites, allMiddlewares, middlewaresFor, dispose }
}

export type ServerPluginHost = Awaited<ReturnType<typeof createServerPluginHost>>
