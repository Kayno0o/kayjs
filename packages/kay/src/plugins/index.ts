// Kay v2 public Plugin API & config helpers.
// Strict architectural rule: every non-core capability (@kayjs/tailwind, @kayjs/spa, @kayjs/i18n, etc.)
// is built strictly through these public hooks — never hardcoded in @kay/core.

import type { BunPlugin } from 'bun'
import type { RouteManifestEntry } from '../build/index'
import type { Middleware, RequestContext } from '../server/index'
import type { SecurityHeadersOptions } from '../server/security'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface BuildPluginContext {
  readonly root: string
  readonly outDir: string
  readonly assetPrefix: string
  readonly minify: boolean
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
}

export interface CheckPluginContext {
  readonly root: string
  readonly routesDir: string
  /** Report a validation error from `kay check`. */
  error(message: string): void
}

export interface ServerPluginAPI {
  /** Register global middleware that runs before route handlers. */
  use(middleware: Middleware): void
  /** Register a custom HTTP route (e.g. GET /sitemap.xml, POST /auth/callback). */
  route(method: string, path: string, handler: (ctx: RequestContext) => Response | Promise<Response>): void
  /** Rewrite an incoming pathname before route matching (e.g. strip /fr locale prefix). */
  rewrite(fn: (pathname: string, ctx: RequestContext) => string | undefined): void
}

export interface KayPlugin {
  name: string
  /** Register server routes, global middleware, or URL rewrites. */
  server?: (api: ServerPluginAPI) => void | Promise<void>
  /** Build hook run after route compilation, before prerender / --static / --compile. */
  build?: (ctx: BuildPluginContext) => void | Promise<void>
  /** Code transform run during client & server compilation. */
  transform?: (code: string, id: string, target: 'server' | 'client') => string | undefined | void
  /** Native Bun.build plugins (e.g. bun-plugin-tailwind, images, icons). */
  bunPlugins?: BunPlugin[] | ((info: { root: string, assetPrefix: string, minify: boolean }) => BunPlugin[]) | undefined
  /** Global CSS files to bundle and inject as <link rel="stylesheet"> in <head>. */
  css?: string[] | undefined
  /** Post-process rendered HTML before sending. */
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

export interface KayConfig {
  lang?: string | undefined
  routesDir?: string | undefined
  outDir?: string | undefined
  publicDir?: string | undefined
  assetPrefix?: string | undefined
  security?: SecurityHeadersOptions | false | undefined
  trustedOrigins?: string[] | undefined
  compress?: boolean | undefined
  plugins?: KayPlugin[] | undefined
}

export function defineConfig(config: KayConfig): KayConfig {
  return config
}

export function definePlugin(plugin: KayPlugin): KayPlugin {
  return plugin
}

const KAY_ROOT_KEY = Symbol.for('kay.root')
let configReloadSeq = 0

export async function loadConfig(root: string, options?: { fresh?: boolean }): Promise<KayConfig> {
  const absRoot = resolve(root)
  ;(globalThis as Record<symbol, unknown>)[KAY_ROOT_KEY] = absRoot
  const configPath = join(absRoot, 'kay.config.ts')
  if (!existsSync(configPath))
    return {}
  const spec = options?.fresh || process.env.KAY_DEV === '1'
    ? `${configPath}?v=${++configReloadSeq}-${Date.now()}`
    : configPath
  const mod = await import(spec) as { default?: KayConfig }
  return mod.default ?? {}
}
