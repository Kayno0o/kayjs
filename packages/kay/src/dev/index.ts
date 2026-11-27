// kay dev: incremental cached rebuilds, serialized rebuild queue, CSS hot-swap, streaming reload injection,
// SSE error push, and live config reload.

import type { BuildCacheStats } from '../build/graph'
import type { KayApp } from '../server/index'
import type { ChangeKind } from './watchers'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clearBuildCache } from '../build/graph'
import { build, createBuildCache } from '../build/index'
import { loadConfig, resolveServerConfig } from '../plugins/index'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '../server/http'
import { createServer } from '../server/index'
import { createModuleStore } from './modules'
import { buildErrorResponse, makeDevReloadAssets, reloadEvents, withReloadScript } from './reload'
import { createDevWatchers } from './watchers'

export interface DevServerOptions {
  root: string
  port?: number | undefined
  hostname?: string | undefined
  routesDir?: string | undefined
  maxRequestBodySize?: number | undefined
}


export async function devServer(options: DevServerOptions): Promise<{
  url: string
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
  const assetPrefix = (initialCfg.assetPrefix ?? '/_kay').replace(/\/$/, '')
  let reloadAssets = makeDevReloadAssets(assetPrefix)
  const srcDir = resolve(root, 'src')
  const port = options.port ?? initialCfg.port ?? 3000
  const hostname = options.hostname ?? '127.0.0.1'
  const buildCache = createBuildCache()
  const modules = createModuleStore(join(devRoot, 'server'))
  const watchers = createDevWatchers({ root, devRoot, srcDir, routesDir: options.routesDir, schedule: kind => scheduleRebuild(kind) })
  let activeAssetPrefix = assetPrefix

  let buildNum = 0
  let currentApp: KayApp | undefined
  let lastError: string | undefined
  let stopped = false

  // Serialized rebuild queue: rapid saves coalesce instead of racing
  let building = false
  let pending = false
  let pendingCssOnly = true
  let pendingConfigReset = false
  let pendingReloadAll = false
  let inFlight: Promise<void> | undefined

  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()

  function pushToClients(chunk: Uint8Array): void {
    for (const c of clients) {
      try {
        c.enqueue(chunk)
      }
      catch {
        clients.delete(c)
      }
    }
  }

  const broadcast = (payload: string): void => pushToClients(encoder.encode(`data: ${payload}\n\n`))

  async function runSingleBuild(cssOnly: boolean, resetCache: boolean, reloadAll: boolean): Promise<void> {
    if (stopped)
      return
    const hadError = lastError !== undefined
    const hadApp = currentApp !== undefined
    const n = ++buildNum
    const outDir = `.kay-dev/b${n}`
    const t0 = performance.now()
    try {
      if (resetCache) {
        clearBuildCache(buildCache)
        const freshCfg = await loadConfig(root, { fresh: true, dev: true })
        activeCfg = freshCfg
        activeAssetPrefix = (freshCfg.assetPrefix ?? '/_kay').replace(/\/$/, '')
        reloadAssets = makeDevReloadAssets(activeAssetPrefix)
        watchers.syncStatic(freshCfg)
        watchers.refreshPlugins(freshCfg, activeAssetPrefix)
      }
      if (reloadAll)
        modules.reloadAll()
      const manifest = await build({
        root,
        routesDir: options.routesDir,
        outDir,
        minify: false,
        prerender: false,
        copyPublic: false,
        dev: true,
        cache: buildCache,
      })
      if (stopped) {
        rmSync(join(root, outDir), { recursive: true, force: true })
        return
      }
      const serverDir = join(root, outDir, 'server')
      modules.sync(serverDir)
      const nextApp = await createServer({
        root,
        outDir,
        dev: true,
        compress: false,
        ...(options.maxRequestBodySize !== undefined ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
        importModule: modules.importFrom(serverDir),
      })
      if (stopped) {
        await nextApp.dispose?.()
        rmSync(join(root, outDir), { recursive: true, force: true })
        return
      }
      const prevApp = currentApp
      currentApp = nextApp
      await prevApp?.dispose?.()
      lastError = undefined
      watchers.syncBuild(buildCache.watchedFiles)
      if (n > 2)
        rmSync(join(devRoot, `b${n - 2}`), { recursive: true, force: true })
      console.log(`[kay dev] rebuilt in ${(performance.now() - t0).toFixed(1)} ms`)
      if (cssOnly && hadApp && !hadError && manifest.styles.length > 0)
        broadcast(`css:${JSON.stringify(manifest.styles)}`)
      else
        broadcast('reload')
    }
    catch (err) {
      if (stopped)
        return
      lastError = err instanceof Error ? err.stack ?? err.message : String(err)
      console.error(`[kay dev] build error:\n${lastError}`)
      // Push reload over SSE so open browser tabs immediately display the error overlay
      broadcast('reload')
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  function drainRebuilds(): Promise<void> {
    clearTimeout(timer)
    if (building) {
      pending = true
      return inFlight ?? Promise.resolve()
    }
    building = true
    const run = (async () => {
      try {
        do {
          clearTimeout(timer)
          const cssOnly = pendingCssOnly
          const resetCache = pendingConfigReset
          const reloadAll = pendingReloadAll
          pending = false
          pendingCssOnly = true
          pendingConfigReset = false
          pendingReloadAll = false
          await runSingleBuild(cssOnly, resetCache, reloadAll)
        } while (pending && !stopped)
      }
      finally {
        building = false
        inFlight = undefined
      }
    })()
    inFlight = run
    return run
  }

  // Initial build
  pendingCssOnly = false
  await drainRebuilds()

  const scheduleRebuild = (kind: ChangeKind) => {
    if (stopped)
      return
    if (kind === 'config')
      pendingConfigReset = true
    if (kind === 'config' || kind === 'full')
      pendingReloadAll = true
    if (kind !== 'css')
      pendingCssOnly = false
    clearTimeout(timer)
    timer = setTimeout(() => {
      void drainRebuilds()
    }, 40)
  }

  watchers.syncStatic(initialCfg)
  watchers.watchRoot(() => activeCfg)
  // Plugin-declared extra paths (e.g. content/ or messages/ directories); refreshed on kay.config.ts edits.
  try {
    watchers.refreshPlugins(initialCfg, activeAssetPrefix)
  }
  catch (err) {
    console.warn(`[kay dev] could not attach plugin watchers: ${err instanceof Error ? err.message : String(err)}`)
  }

  const pingChunk = encoder.encode(': ping\n\n')
  const pingInterval = setInterval(() => pushToClients(pingChunk), 15_000)

  const runtimeCfg = resolveServerConfig(initialCfg, { maxRequestBodySize: options.maxRequestBodySize })
  const maxRequestBodySize = runtimeCfg.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 30,
    maxRequestBodySize,
    async fetch(request, srv) {
      const url = new URL(request.url)

      if (url.pathname === reloadAssets.eventsPath) {
        srv.timeout(request, 0)
        return reloadEvents(request, clients)
      }
      if (lastError !== undefined)
        return buildErrorResponse(request, lastError, reloadAssets.script)

      const remoteIp = srv.requestIP(request)?.address
      const res = await currentApp!.handle(request, remoteIp)
      const ct = res.headers.get('content-type') ?? ''
      const isStreamedHtml = ct.includes('text/html') && request.method !== 'HEAD' && res.body !== null && !res.headers.has('content-length')
      if (ct.includes('text/event-stream') || isStreamedHtml)
        srv.timeout(request, 0)
      return withReloadScript(request, res, reloadAssets)
    },
  })

  const displayHost = hostname === '0.0.0.0' ? '127.0.0.1' : hostname
  const url = `http://${displayHost}:${server.port}`
  console.log(`[kay dev] listening on ${url}`)
  let stopPromise: Promise<void> | undefined

  return {
    url,
    rebuild() {
      pendingCssOnly = false
      return drainRebuilds()
    },
    stats() {
      return { ...buildCache.stats }
    },
    stop() {
      if (stopPromise !== undefined)
        return stopPromise
      stopped = true
      clearTimeout(timer)
      clearInterval(pingInterval)
      watchers.close()
      server.stop(true)
      stopPromise = (async () => {
        try {
          await inFlight
        }
        catch {}
        try {
          await currentApp?.dispose?.()
        }
        catch {}
        rmSync(devRoot, { recursive: true, force: true })
      })()
      return stopPromise
    },
  }
}
