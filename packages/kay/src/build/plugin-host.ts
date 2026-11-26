// What plugins see of a build: the `build(ctx)` and `afterPrerender(ctx)` hooks, and the shared lists (assets, styles, head tags, public files) those hooks add to.

import type { AppRuntimeContext } from '../plugins/context'
import type { BuildPluginContext, FinalizeBuildContext, KayPlugin } from '../plugins/index'
import type { RouteManifestEntry } from './manifest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { precompressFile } from './files'

const LEADING_SLASHES_RE = /^\/+/
const BACKSLASH_RE = /\\/g

function cleanRel(relPath: string): string {
  return relPath.replace(LEADING_SLASHES_RE, '').replace(BACKSLASH_RE, '/')
}

export interface PublicFiles {
  /** Public files known so far, as relative paths in registration order. */
  files: string[]
  /** Records a public file and returns its normalized relative path. */
  register: (relPath: string) => string
}

/** A plugin hook's throw, renamed `kay build: plugin "<name>" <hook> failed: <message>` with the original as `cause`. */
export function pluginHookError(plugin: Pick<KayPlugin, 'name'>, hook: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`kay build: plugin "${plugin.name}" ${hook} failed: ${message}`, { cause: error })
}

/** Runs one plugin hook, so a throw names the plugin and the hook. */
export async function runPluginHook<T>(plugin: Pick<KayPlugin, 'name'>, hook: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    throw pluginHookError(plugin, hook, error)
  }
}

export function createPublicFiles(): PublicFiles {
  const files: string[] = []
  const seen = new Set<string>()
  return {
    files,
    register(relPath) {
      const clean = cleanRel(relPath)
      if (clean !== '' && !seen.has(clean)) {
        seen.add(clean)
        files.push(clean)
      }
      return clean
    },
  }
}

export interface PluginHostOptions {
  plugins: KayPlugin[]
  appCtx: AppRuntimeContext
  root: string
  outDir: string
  clientDir: string
  outPublicDir: string
  assetPrefix: string
  site?: string | undefined
  minify: boolean
  isStatic: boolean
  isDev: boolean
  routes: RouteManifestEntry[]
  publicFiles: PublicFiles
  /** Client files already emitted, relative to the client dir. */
  assets: string[]
  styleUrls: string[]
  globalStyles: string[]
}

export function createPluginHost(options: PluginHostOptions) {
  const { plugins, appCtx, outDir, clientDir, outPublicDir, assetPrefix, routes, assets, styleUrls, globalStyles } = options
  const assetSet = new Set(assets)
  const styleSet = new Set(styleUrls)
  const globalStyleSet = new Set(globalStyles)
  const headTags: string[] = []
  const pluginData: Record<string, Record<string, unknown>> = {}
  const precompressed = new Set<string>()

  function emitAsset(relPath: string, content: string | Uint8Array): string {
    const clean = cleanRel(relPath)
    const dst = join(clientDir, clean)
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, content)
    if (!assetSet.has(clean)) {
      assetSet.add(clean)
      assets.push(clean)
    }
    return `${assetPrefix}/${clean}`
  }

  function emitPublic(relPath: string, content: string | Uint8Array): string {
    const clean = options.publicFiles.register(relPath)
    const dst = join(outPublicDir, clean)
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, content)
    return `/${clean}`
  }

  function addStyleUrl(href: string): void {
    if (!styleSet.has(href)) {
      styleSet.add(href)
      styleUrls.push(href)
    }
  }

  const pluginDataOwners = new Map<string, KayPlugin>()
  const setDataFor = (plugin: KayPlugin) => (data: Record<string, unknown>): void => {
    const existingOwner = pluginDataOwners.get(plugin.name)
    if (existingOwner !== undefined && existingOwner !== plugin) {
      throw new Error(`kay: duplicate pluginData key "${plugin.name}": two plugin instances share the name "${plugin.name}" and both call setData(). Give each plugin instance a distinct name.`)
    }
    pluginDataOwners.set(plugin.name, plugin)
    pluginData[plugin.name] = { ...pluginData[plugin.name], ...data }
  }

  const shared = {
    root: options.root,
    outDir,
    assetPrefix,
    ...(options.site !== undefined ? { site: options.site } : {}),
    minify: options.minify,
    isStatic: options.isStatic,
    dev: options.isDev,
    routes,
    emitAsset,
    emitPublic,
    provide: appCtx.provide,
    inject: appCtx.inject,
  }

  const buildCtx = {
    ...shared,
    addStyle(href: string) {
      addStyleUrl(href)
      if (!globalStyleSet.has(href)) {
        globalStyleSet.add(href)
        globalStyles.push(href)
      }
      for (const r of routes) {
        if (r.styles !== undefined && !r.styles.includes(href))
          r.styles.push(href)
      }
    },
    addRouteStyle(routePath: string, href: string) {
      addStyleUrl(href)
      const route = routes.find(r => r.path === routePath)
      if (route !== undefined) {
        route.styles ??= [...globalStyles]
        if (!route.styles.includes(href))
          route.styles.push(href)
      }
    },
    addHead(html: string) {
      if (html !== '')
        headTags.push(html)
    },
    addRouteHead(routePath: string, html: string) {
      const route = html === '' ? undefined : routes.find(r => r.path === routePath)
      if (route !== undefined)
        (route.headTags ??= []).push(html)
    },
  }

  return {
    headTags,
    pluginData,
    /** Runs every plugin's `build(ctx)`, so plugins can emit hashed assets, public files, styles, <head> tags, or services. */
    async runBuild(): Promise<void> {
      for (const plugin of plugins) {
        if (plugin.build !== undefined) {
          const ctx: BuildPluginContext = { ...buildCtx, setData: setDataFor(plugin) }
          await runPluginHook(plugin, 'build', () => plugin.build!(ctx))
        }
      }
    },

    /** Runs every plugin's `afterPrerender(ctx)`, once `route.prerendered` and prerender-emitted public files are known. */
    async runAfterPrerender(): Promise<boolean> {
      let ran = false
      for (const plugin of plugins) {
        if (plugin.afterPrerender !== undefined) {
          ran = true
          const ctx: FinalizeBuildContext = { ...shared, publicFiles: options.publicFiles.files, setData: setDataFor(plugin) }
          await runPluginHook(plugin, 'afterPrerender', () => plugin.afterPrerender!(ctx))
        }
      }
      return ran
    },

    /** Writes `.br`/`.gz` sidecars for client assets not compressed yet (production server builds only: `--static` compresses its own output). */
    precompressAssets(): void {
      if (options.isDev || options.isStatic)
        return
      for (const rel of assets) {
        if (!precompressed.has(rel)) {
          precompressed.add(rel)
          precompressFile(join(clientDir, rel), 256)
        }
      }
    },
  }
}
