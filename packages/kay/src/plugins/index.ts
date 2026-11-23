// Kay v2 public Plugin API & config helpers.
// Strict architectural rule: every non-core capability (@kayjs/tailwind, @kayjs/spa, @kayjs/i18n, etc.)
// is built strictly through these public hooks — never hardcoded in @kay/core.

import type { BunPlugin } from 'bun'
import type { Middleware, RequestContext } from '../server/index'
import type { SecurityHeadersOptions } from '../server/security'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
  /** Code transform run during client & server compilation. */
  transform?: (code: string, id: string, target: 'server' | 'client') => string | undefined | void
  /** Native Bun.build plugins (e.g. bun-plugin-tailwind, MDX). */
  bunPlugins?: BunPlugin[] | undefined
  /** Global CSS files to bundle and inject as <link rel="stylesheet"> in <head>. */
  css?: string[] | undefined
  /** Post-process rendered HTML before sending. */
  transformHtml?: (html: string, ctx: RequestContext) => string | Promise<string>
  /** Client bootstrap module path — bundled ONLY when this plugin is active. */
  clientEntry?: string | undefined
  /** Register custom CLI subcommands (e.g. `kay i18n check`). */
  commands?: Record<string, (args: string[], root: string) => void | Promise<void>> | undefined
}

export interface KayConfig {
  lang?: string | undefined
  routesDir?: string | undefined
  outDir?: string | undefined
  assetPrefix?: string | undefined
  security?: SecurityHeadersOptions | false | undefined
  trustedOrigins?: string[] | undefined
  plugins?: KayPlugin[] | undefined
}

export function defineConfig(config: KayConfig): KayConfig {
  return config
}

export function definePlugin(plugin: KayPlugin): KayPlugin {
  return plugin
}

export async function loadConfig(root: string): Promise<KayConfig> {
  const absRoot = resolve(root)
  const configPath = join(absRoot, 'kay.config.ts')
  if (!existsSync(configPath))
    return {}
  const mod = await import(configPath) as { default?: KayConfig }
  return mod.default ?? {}
}
