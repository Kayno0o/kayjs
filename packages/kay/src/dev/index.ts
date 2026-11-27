// kay dev: incremental cached rebuilds, serialized rebuild queue, CSS hot-swap, streaming reload injection,
// SSE error push, and live config reload.

import type { Server } from 'bun'
import type { BuildCacheStats } from '../build/graph'
import type { KayApp } from '../server/index'
import type { RecycleReason } from './protocol'
import type { PendingBuild } from './queue'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clearBuildCache } from '../build/graph'
import { build, createBuildCache } from '../build/index'
import { loadConfig, resolveServerConfig } from '../plugins/index'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '../server/http'
import { createServer } from '../server/index'
import { createModuleStore } from './modules'
import { DEV_CLIENT_IP_HEADER } from './protocol'
import { createRebuildQueue } from './queue'
import { buildErrorResponse, createReloadHub, makeDevReloadAssets, withReloadScript } from './reload'
import { createDevWatchers } from './watchers'


export interface DevServerOptions {
  root: string
  port?: number | undefined
  hostname?: string | undefined
  routesDir?: string | undefined
  maxRequestBodySize?: number | undefined
  /** Listens on this Unix socket instead of a port, behind a parent that keeps the port and sets {@link DEV_CLIENT_IP_HEADER}. */
  unix?: string | undefined
  /** Receives each reload event instead of a stream this server serves. */
  broadcast?: ((payload: string) => void) | undefined
  /** Called instead of reloading `kay.config.ts` in place, on an edit to it or to a file it imports, and once the RSS passes `maxRssMb` after a build. */
  recycle?: ((reason: RecycleReason) => void) | undefined
  maxRssMb?: number | undefined
}

const errorText = (err: unknown): string => err instanceof Error ? err.stack ?? err.message : String(err)

export async function devServer(options: DevServerOptions): Promise<{
  url: string
  assetPrefix: string
  stop: () => Promise<void>
  rebuild: () => Promise<void>
  stats: () => BuildCacheStats
}> {
  const root = resolve(options.root)
  const devRoot = join(root, '.kay-dev')
  const initialCfg = await loadConfig(root, { dev: true })
  // Clean stale `.kay-dev/` left behind by a previously killed dev process.
  rmSync(devRoot, { recursive: true, force: true })
  let activeCfg = initialCfg
  let activeAssetPrefix = (initialCfg.assetPrefix ?? '/_kay').replace(/\/$/, '')
  let reloadAssets = makeDevReloadAssets(activeAssetPrefix)
  const buildCache = createBuildCache()
  const modules = createModuleStore(join(devRoot, 'server'))
  const hub = options.broadcast === undefined ? createReloadHub() : undefined
  const broadcast = options.broadcast ?? hub!.broadcast
  const recycle = options.recycle
  const queue = createRebuildQueue(runSingleBuild)
  const watchers = createDevWatchers({
    root,
    devRoot,
    srcDir: resolve(root, 'src'),
    routesDir: options.routesDir,
    schedule: kind => kind === 'config' && recycle !== undefined ? recycle('config') : queue.schedule(kind),
  })
  const serverOptions = { root, dev: true, compress: false, ...(options.maxRequestBodySize !== undefined ? { maxRequestBodySize: options.maxRequestBodySize } : {}) }

  let buildNum = 0
  let current: { app: KayApp, outDir: string } | undefined
  let lastError: string | undefined
  let stopped = false

  async function swapApp(outDir: string): Promise<void> {
    const nextApp = await createServer({ ...serverOptions, outDir, importModule: modules.importFrom(join(root, outDir, 'server')) })
    if (stopped) {
      await nextApp.dispose?.()
      return
    }
    const prev = current?.app
    current = { app: nextApp, outDir }
    await prev?.dispose?.()
  }

  async function runSingleBuild({ cssOnly, publicOnly, resetCache, reloadAll }: PendingBuild): Promise<void> {
    if (stopped)
      return
    const hadError = lastError !== undefined
    const hadApp = current !== undefined
    const n = buildNum + 1
    const outDir = `.kay-dev/b${n}`
    const t0 = performance.now()
    try {
      // An edited `public/` file only needs the app's file table, and its ETag, built again.
      if (publicOnly && current !== undefined && !hadError) {
        await swapApp(current.outDir)
        broadcast('reload')
        return
      }
      buildNum = n
      if (resetCache) {
        clearBuildCache(buildCache)
        activeCfg = await loadConfig(root, { fresh: true, dev: true })
        activeAssetPrefix = (activeCfg.assetPrefix ?? '/_kay').replace(/\/$/, '')
        reloadAssets = makeDevReloadAssets(activeAssetPrefix)
        watchers.syncStatic(activeCfg)
        watchers.refreshPlugins(activeCfg, activeAssetPrefix)
      }
      if (reloadAll)
        modules.reloadAll()
      const manifest = await build({ root, routesDir: options.routesDir, outDir, minify: false, prerender: false, copyPublic: false, dev: true, cache: buildCache })
      if (!stopped) {
        modules.sync(join(root, outDir, 'server'))
        await swapApp(outDir)
      }
      if (stopped) {
        rmSync(join(root, outDir), { recursive: true, force: true })
        return
      }
      lastError = undefined
      watchers.syncBuild(buildCache.watchedFiles, manifest.publicFiles)
      if (n > 2)
        rmSync(join(devRoot, `b${n - 2}`), { recursive: true, force: true })
      console.log(`[kay dev] rebuilt in ${(performance.now() - t0).toFixed(1)} ms`)
      broadcast(cssOnly && hadApp && !hadError && manifest.styles.length > 0 ? `css:${JSON.stringify(manifest.styles)}` : 'reload')
      if (n > 1 && recycle !== undefined && options.maxRssMb !== undefined && process.memoryUsage().rss > options.maxRssMb * 1024 * 1024)
        recycle('memory')
    }
    catch (err) {
      if (stopped)
        return
      lastError = errorText(err)
      console.error(`[kay dev] build error:\n${lastError}`)
      // Push reload over SSE so open browser tabs immediately display the error overlay
      broadcast('reload')
    }
  }

  await queue.now()

  watchers.syncStatic(initialCfg)
  watchers.watchRoot(() => activeCfg, recycle !== undefined)
  // Plugin-declared extra paths (e.g. content/ or messages/ directories); refreshed on kay.config.ts edits.
  try {
    watchers.refreshPlugins(initialCfg, activeAssetPrefix)
  }
  catch (err) {
    console.warn(`[kay dev] could not attach plugin watchers: ${err instanceof Error ? err.message : String(err)}`)
  }

  const runtimeCfg = resolveServerConfig(initialCfg, { maxRequestBodySize: options.maxRequestBodySize })
  const hostname = options.hostname ?? '127.0.0.1'
  const serveOptions = {
    maxRequestBodySize: runtimeCfg.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE,
    async fetch(request: Request, srv: Server<undefined>): Promise<Response> {
      if (hub !== undefined && new URL(request.url).pathname === reloadAssets.eventsPath) {
        srv.timeout(request, 0)
        return hub.events(request)
      }
      if (lastError !== undefined)
        return buildErrorResponse(request, lastError, reloadAssets.script)

      const remoteIp = options.unix !== undefined ? request.headers.get(DEV_CLIENT_IP_HEADER) ?? undefined : srv.requestIP(request)?.address
      const res = await current!.app.handle(request, remoteIp)
      const ct = res.headers.get('content-type') ?? ''
      const isStreamedHtml = ct.includes('text/html') && request.method !== 'HEAD' && res.body !== null && !res.headers.has('content-length')
      if (ct.includes('text/event-stream') || isStreamedHtml)
        srv.timeout(request, 0)
      return withReloadScript(request, res, reloadAssets)
    },
  }
  const server = options.unix !== undefined
    ? Bun.serve({ ...serveOptions, unix: options.unix })
    : Bun.serve({ ...serveOptions, port: options.port ?? initialCfg.port ?? 3000, hostname, idleTimeout: 30 })

  // `0.0.0.0` is printed as the loopback address a browser on this machine opens.
  const url = options.unix !== undefined ? `unix:${options.unix}` : `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${server.port}`
  if (options.unix === undefined)
    console.log(`[kay dev] listening on ${url}`)
  let stopPromise: Promise<void> | undefined

  return {
    url,
    assetPrefix: activeAssetPrefix,
    rebuild: () => queue.now(),
    stats: () => ({ ...buildCache.stats }),
    stop() {
      if (stopPromise !== undefined)
        return stopPromise
      stopped = true
      hub?.close()
      watchers.close()
      server.stop(true)
      stopPromise = (async () => {
        await queue.stop()
        try {
          await current?.app.dispose?.()
        }
        catch (err) {
          console.warn(`[kay dev] the app failed to dispose: ${errorText(err)}`)
        }
        rmSync(devRoot, { recursive: true, force: true })
      })()
      return stopPromise
    },
  }
}
