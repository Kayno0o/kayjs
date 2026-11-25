// The plugin contract: what a `KayPlugin` declares and what the build, check and server hosts hand its hooks.

import type { BunPlugin } from 'bun'
import type { RouteManifestEntry } from '../build/index'
import type { ActionResult, ServerAction } from '../server/action'
import type { Middleware, RequestContext } from '../server/index'
import type { SecurityHeadersOptions, TrustProxy } from '../server/security'

export type BuildPluginTarget = 'client' | 'server' | 'compile'

export interface BuildPluginContext {
  readonly root: string
  readonly outDir: string
  readonly assetPrefix: string
  readonly site?: string | undefined
  readonly minify: boolean
  readonly isStatic: boolean
  readonly dev: boolean
  readonly routes: readonly RouteManifestEntry[]
  /** Emit an immutable build asset into dist/client/<relPath>; returns its public URL (`/_kay/<relPath>`). */
  emitAsset(relPath: string, content: string | Uint8Array): string
  /** Emit a static file into dist/public/<relPath> served at `/<relPath>`. */
  emitPublic(relPath: string, content: string | Uint8Array): string
  /** Add a stylesheet URL to <head> on every page. */
  addStyle(href: string): void
  /** Add a stylesheet URL to <head> on a specific route path only. */
  addRouteStyle(routePath: string, href: string): void
  /** Add raw HTML to <head> on every page (e.g. font preloads, default meta/OG, JSON-LD). */
  addHead(html: string): void
  /** Add raw HTML to <head> on a specific route path only. */
  addRouteHead(routePath: string, html: string): void
  /** Register an explicit build-scoped service for other plugins or render-time helpers. */
  provide<T>(key: string, value: T): void
  /** Look up a build-scoped service registered by another plugin. */
  inject<T>(key: string): T | undefined
  /** Persist JSON-serializable build data into `manifest.pluginData[plugin.name]` for cold-start servers and `--compile`. */
  setData(data: Record<string, unknown>): void
}

export interface FinalizeBuildContext {
  readonly root: string
  readonly outDir: string
  readonly assetPrefix: string
  readonly site?: string | undefined
  readonly minify: boolean
  readonly isStatic: boolean
  readonly dev: boolean
  /** Route manifest entries with `prerendered` maps populated after Step 3 prerendering. */
  readonly routes: readonly RouteManifestEntry[]
  /** Relative paths of all public files known so far (including files registered during prerender). */
  readonly publicFiles: readonly string[]
  /** Emit an immutable build asset into dist/client/<relPath>; returns its public URL (`/_kay/<relPath>`). */
  emitAsset(relPath: string, content: string | Uint8Array): string
  /** Emit a static file into dist/public/<relPath> served at `/<relPath>` (included in `--static` and `--compile`). */
  emitPublic(relPath: string, content: string | Uint8Array): string
  /** Register a build-scoped service. */
  provide<T>(key: string, value: T): void
  /** Look up a build-scoped service. */
  inject<T>(key: string): T | undefined
  /** Merge/persist JSON-serializable build data into `manifest.pluginData[plugin.name]`. */
  setData(data: Record<string, unknown>): void
}

export interface CheckPluginContext {
  readonly root: string
  readonly routesDir: string
  /** Report a validation error from `kay check`. */
  error(message: string): void
}

export interface PluginRouteOptions {
  /** Enable CSRF Origin/Sec-Fetch-Site verification on unsafe methods (default: true). Set `false` to opt out (e.g. webhooks, bearer-token APIs). */
  csrf?: boolean | undefined
  /** Additional trusted origins merged with `KayConfig.trustedOrigins` for this route's CSRF check. */
  trustedOrigins?: readonly string[] | undefined
  /** Override `KayConfig.trustProxy` for this route's CSRF check. */
  trustProxy?: TrustProxy | undefined
}

export interface MiddlewareOptions {
  /** `'all'` (default) runs on every route; `'dynamic'` skips static/prerendered fast paths; a string prefix scopes to matching pathnames. */
  scope?: 'all' | 'dynamic' | string | undefined
}

export interface ServerPluginAPI {
  readonly root: string
  readonly outDir: string
  readonly assetPrefix: string
  readonly site?: string | undefined
  readonly dev: boolean
  /** Readonly server security configuration so plugins inherit `trustProxy` / `trustedOrigins` without overriding them. */
  readonly trustProxy: TrustProxy
  readonly trustedOrigins: readonly string[]
  /** Readonly runtime config forwarded from `kay.config.ts` (minus build-only keys). */
  readonly config?: Readonly<Record<string, unknown>> | undefined
  /** Register global (or scoped) middleware that runs before route handlers. */
  use(middleware: Middleware, options?: MiddlewareOptions): void
  /** Register a custom HTTP route (e.g. GET /sitemap.xml, POST /auth/callback). */
  route(method: string, path: string, handler: (ctx: RequestContext) => Response | Promise<Response>, options?: PluginRouteOptions): void
  /** Rewrite an incoming pathname before route matching (e.g. strip /fr locale prefix). */
  rewrite(fn: (pathname: string, ctx: RequestContext) => string | undefined): void
  /** Register a server-scoped service for other plugins or render-time helpers (isolated per server instance). */
  provide<T>(key: string, value: T): void
  /** Look up a server-scoped service registered by another plugin. */
  inject<T>(key: string): T | undefined
  /** Read persisted build data from `manifest.pluginData` (defaults to the current plugin's name). */
  getBuildData<T = Record<string, unknown>>(pluginName?: string): T | undefined
  /** Register a shutdown cleanup callback run when `app.dispose()` is called (dev reloads, tests, graceful exit). */
  onShutdown(fn: () => void | Promise<void>): void
  /** Invoke a ServerAction with Standard Schema validation and directory-scoped `_middleware.ts` checks. */
  invokeAction<I, O>(action: ServerAction<I, O>, input: I, ctx: RequestContext): Promise<ActionResult<O>>
}

export interface ServerErrorInfo {
  error: unknown
  request: Request
  source: 'route' | 'action' | 'plugin'
}

export interface DocumentHeadContext {
  /** Current document `lang` attribute (mutating sets `<html lang="...">`). */
  lang: string
  /** Extra attributes emitted on `<html>`. */
  readonly htmlAttrs: Record<string, string>
  /** Inner HTML of the page's `<title>` tag (if rendered via `<Head><title>...</title></Head>`), or `undefined`. */
  title: string | undefined
  /** Read-only view of head HTML already collected from `<Head>`, build `addHead`, and earlier plugins. */
  readonly headHtml: string
  /** Append raw HTML to `<head>` (emitted once by core when assembling the document). */
  add(html: string): void
}

export interface KayPlugin {
  name: string
  /** Execution phase: `'pre'` runs before normal plugins, `'post'` runs after them. */
  enforce?: 'pre' | 'post' | undefined
  /** Names of plugins that must run before this plugin when present. */
  after?: readonly string[] | undefined
  /** `ctx.locals` keys this plugin populates (used for startup order validation). */
  providesLocals?: readonly string[] | undefined
  /** `ctx.locals` keys this plugin reads (startup fails if a provider is ordered after it). */
  readsLocals?: readonly string[] | undefined
  /** Register server routes, global middleware, URL rewrites, or runtime services. */
  server?: (api: ServerPluginAPI) => void | Promise<void>
  /** Optional cleanup hook called when a server instance is disposed (dev reloads, tests, graceful shutdown). */
  dispose?: () => void | Promise<void>
  /** Error hook called whenever a route, action, or plugin handler throws an unhandled error. */
  onError?: (info: ServerErrorInfo) => void
  /** Build hook run after route compilation, before prerender / --static / --compile. */
  build?: (ctx: BuildPluginContext) => void | Promise<void>
  /** Post-prerender build hook run after `route.prerendered` is populated, before `--static` / `--compile` / final manifest write. */
  afterPrerender?: (ctx: FinalizeBuildContext) => void | Promise<void>
  /** Code transform run during client & server compilation (`.ts` and `.tsx`). */
  transform?: (code: string, id: string, target: 'server' | 'client') => string | undefined | void
  /** Native Bun.build plugins (e.g. bun-plugin-tailwind, images, icons). Factory is invoked per build target. */
  bunPlugins?: BunPlugin[] | ((info: { root: string, assetPrefix: string, minify: boolean, target: BuildPluginTarget }) => BunPlugin[]) | undefined
  /** Global CSS files to bundle and inject as <link rel="stylesheet"> in <head>. */
  css?: string[] | undefined
  /** Mutate `<html lang>`, `htmlAttrs`, `<title>`, or append tags to `<head>` before core renders the document once. */
  head?: (head: DocumentHeadContext, ctx: RequestContext) => void | Promise<void>
  /** Post-process rendered HTML before sending (applies to pages, `<Suspense>` shells, `_error.tsx`, and `_404.tsx`). */
  transformHtml?: (html: string, ctx: RequestContext) => string | Promise<string>
  /** Expand or filter prerender URLs for a route (e.g. @kayjs/i18n expanding `/posts/a` -> `['/posts/a', '/fr/posts/a']`). */
  prerenderPaths?: (paths: string[], route: RouteManifestEntry) => string[] | Promise<string[]>
  /** Client bootstrap module path — bundled ONLY when this plugin is active. */
  clientEntry?: string | undefined
  /** Validate plugin-specific invariants during `kay check` (e.g. missing i18n keys, content frontmatter). */
  check?: (ctx: CheckPluginContext) => void | Promise<void>
  /** Extra directories or files (relative to app root or absolute) for `kay dev` to watch. */
  watchPaths?: string[] | ((root: string) => string[]) | undefined
  /** Register custom CLI subcommands (e.g. `kay i18n check`). */
  commands?: Record<string, (args: string[], root: string) => void | Promise<void>> | undefined
}

/** Shared runtime server options inherited from `kay.config.ts` and overridable by `createServer`, `testApp`, `devServer`, and `--compile`. */
export interface ServerRuntimeConfig {
  /** Public origin of the site (e.g. 'https://example.com'), inherited by @kayjs/seo, @kayjs/i18n, @kayjs/content, @kayjs/images, and @kayjs/auth. */
  site?: string | undefined
  lang?: string | undefined
  assetPrefix?: string | undefined
  security?: SecurityHeadersOptions | false | undefined
  trustedOrigins?: string[] | undefined
  trustProxy?: TrustProxy | undefined
  maxRequestBodySize?: number | undefined
  /** Milliseconds a streamed `<Suspense>` boundary may take before it renders its error and the response ends (default 30000). */
  streamTimeout?: number | undefined
  compress?: boolean | undefined
  onError?: ((info: ServerErrorInfo) => void) | undefined
  plugins?: KayPlugin[] | undefined
}

export interface KayConfig extends ServerRuntimeConfig {
  port?: number | undefined
  routesDir?: string | undefined
  outDir?: string | undefined
  publicDir?: string | undefined
}
