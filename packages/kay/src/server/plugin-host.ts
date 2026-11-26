// What plugins see of a running server: each `server(api)` hook, and the middleware, routes, rewrites and shutdown hooks those hooks register.

import type { BuildManifest } from '../build/index'
import type { AppRuntimeContext } from '../plugins/context'
import type { KayPlugin, MiddlewareOptions, PluginRouteOptions, ServerPluginAPI } from '../plugins/index'
import type { EmbeddedServerConfig, Middleware, RequestContext } from './http'
import type { TrustProxy } from './security'
import { runWithAppContext } from '../plugins/context'
import { normalizeConsentConfig, registerConsentRoute } from './consent'
import { Router } from './router'

export interface PluginRouteDef {
  plugin: string
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
}

function middlewareAppliesToPath(scope: ScopedMiddleware['scope'], path: string, isStaticFast: boolean): boolean {
  if (scope === 'all')
    return true
  if (scope === 'dynamic')
    return !isStaticFast
  const normScope = scope.length > 1 && scope.endsWith('/') ? scope.slice(0, -1) : scope
  const normPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  if (normScope === '/')
    return normPath.startsWith('/')
  return normPath === normScope || normPath.startsWith(`${normScope}/`)
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
  const shutdownHooks: { plugin: string, hook: () => void | Promise<void> }[] = []
  const rewrites: ((pathname: string, ctx: RequestContext) => string | undefined)[] = []
  const router = new Router<Map<string, PluginRouteDef>>()
  const routeEntries = new Map<string, Map<string, PluginRouteDef>>()

  const registerRouteFor = (pluginName: string) => (
    method: string,
    path: string,
    handler: (ctx: RequestContext) => Response | Promise<Response>,
    routeOptions?: PluginRouteOptions,
  ): void => {
    const upperMethod = method.toUpperCase()
    const normPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
    let byMethod = routeEntries.get(normPath)
    if (byMethod === undefined) {
      byMethod = new Map()
      routeEntries.set(normPath, byMethod)
      router.add(normPath, byMethod)
    }
    else {
      const directConflict = byMethod.get(upperMethod)
      if (directConflict !== undefined) {
        throw new Error(`kay: plugin "${pluginName}" registered ${upperMethod} ${normPath}, which collides with "${directConflict.plugin}". Mount one of the plugins on a different path.`)
      }
      if (upperMethod === 'ALL' && byMethod.size > 0) {
        const [existingMethod, existingDef] = byMethod.entries().next().value!
        throw new Error(`kay: plugin "${pluginName}" registered ALL ${normPath}, which collides with ${existingMethod} ${normPath} from "${existingDef.plugin}". Mount one of the plugins on a different path.`)
      }
      const allConflict = byMethod.get('ALL')
      if (allConflict !== undefined) {
        throw new Error(`kay: plugin "${pluginName}" registered ${upperMethod} ${normPath}, which collides with ALL ${normPath} from "${allConflict.plugin}". Mount one of the plugins on a different path.`)
      }
    }
    let routeTrustedOrigins = trustedOrigins
    if (routeOptions?.trustedOrigins !== undefined && routeOptions.trustedOrigins.length > 0) {
      routeTrustedOrigins = new Set([...(trustedOrigins ?? []), ...routeOptions.trustedOrigins])
    }
    byMethod.set(upperMethod, {
      plugin: pluginName,
      handler,
      csrf: routeOptions?.csrf ?? true,
      trustedOrigins: routeTrustedOrigins,
      trustProxy: routeOptions?.trustProxy ?? trustProxy,
    })
  }

  const consentConfig = normalizeConsentConfig(config.consent)
  if (consentConfig !== undefined)
    registerConsentRoute(registerRouteFor('kay:consent'), consentConfig, trustedOrigins, trustProxy)

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
        route: registerRouteFor(plugin.name),
        rewrite(fn) {
          rewrites.push(fn)
        },
        provide: appCtx.provide,
        inject: appCtx.inject,
        getBuildData<T = Record<string, unknown>>(pluginName?: string): T | undefined {
          return manifest.pluginData?.[pluginName ?? plugin.name] as T | undefined
        },
        onShutdown(fn) {
          shutdownHooks.push({ plugin: plugin.name, hook: fn })
        },
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
  const middlewaresForPaths = (paths: readonly string[], isStaticFast = false): readonly Middleware[] => {
    if (scopedMiddlewares.length === 0)
      return allMiddlewares
    if (!hasPathScopedMiddlewares)
      return isStaticFast ? staticFastMiddlewares : allMiddlewares
    return scopedMiddlewares
      .filter(m => paths.some(path => middlewareAppliesToPath(m.scope, path, isStaticFast)))
      .map(m => m.mw)
  }

  let disposed = false
  async function dispose(): Promise<void> {
    if (disposed)
      return
    disposed = true
    for (const { plugin, hook } of shutdownHooks) {
      try {
        await hook()
      }
      catch (error) {
        console.error(`kay: the onShutdown hook of ${plugin} threw; the other hooks still run.`, error)
      }
    }
  }

  return { router, rewrites, allMiddlewares, hasPathScopedMiddlewares, middlewaresFor, middlewaresForPaths, dispose }
}

export type ServerPluginHost = Awaited<ReturnType<typeof createServerPluginHost>>
