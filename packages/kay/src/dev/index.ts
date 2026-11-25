// kay dev: incremental cached rebuilds, serialized rebuild queue, CSS hot-swap, streaming reload injection,
// SSE error push, and live config reload.

import type { FSWatcher } from 'node:fs'
import type { KayApp } from '../server/index'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { clearBuildCache } from '../build/graph'
import { build, createBuildCache } from '../build/index'
import { createAppContext, loadConfig, resolvePlugins, runWithAppContext } from '../plugins/index'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '../server/http'
import { createServer, withCspHashes } from '../server/index'

export interface DevServerOptions {
  root: string
  port?: number | undefined
  hostname?: string | undefined
  routesDir?: string | undefined
  maxRequestBodySize?: number | undefined
}

function makeDevReloadAssets(assetPrefix: string): { script: string, hash: string, eventsPath: string } {
  const prefix = assetPrefix.replace(/\/$/, '')
  const eventsPath = `${prefix}/dev-events`
  const js = `(()=>{const stem=u=>u.replace(/-[a-z0-9]+\\.css$/i,'');const s=new EventSource(${JSON.stringify(eventsPath)});s.onmessage=(e)=>{if(e.data.startsWith('css:')){const urls=JSON.parse(e.data.slice(4));const byStem=new Map(urls.map(u=>[stem(u),u]));const old=[...document.querySelectorAll('link[rel="stylesheet"][href^=${JSON.stringify(`${prefix}/`)}]')];if(old.length===0){location.reload();return;}const next=[];for(const o of old){const m=byStem.get(stem(o.getAttribute('href')||''));if(m)next.push(m);}if(next.length===0){location.reload();return;}let left=next.length;for(const u of next){const l=document.createElement('link');l.rel='stylesheet';l.href=u;const done=()=>{if(--left===0)for(const o of old)o.remove();};l.onload=done;l.onerror=done;document.head.appendChild(l);}}else{location.reload();}};})();`
  const hash = `'sha256-${new Bun.CryptoHasher('sha256').update(js).digest('base64')}'`
  return { script: `<script>${js}</script>`, hash, eventsPath }
}

function renderErrorOverlay(errText: string, reloadScript: string): string {
  const escaped = errText
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Kay Dev Error</title><style>body{margin:0;min-height:100vh;background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;padding:2rem}main{max-width:56rem;width:100%;background:#161b22;border:1px solid #f85149;border-radius:10px;padding:1.5rem 2rem;box-shadow:0 16px 48px rgba(0,0,0,.45)}h1{margin:0 0 1rem;color:#ff7b72;font-size:1.15rem}pre{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-size:.9rem;color:#ffa198}p{margin:1rem 0 0;font-size:.8rem;color:#8b949e}</style></head><body><main><h1>Kay Dev Build Error</h1><pre>${escaped}</pre><p>Save a fix to auto-reload.</p></main>${reloadScript}</body></html>`
}

type ChangeKind = 'css' | 'code' | 'full' | 'config'

// A source edit changes the bundled bytes; any other file (content, data, public/) may be read when a module loads.
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|css)$/

function srcChangeKind(name: string): ChangeKind {
  if (name.endsWith('.css') && !name.endsWith('.module.css'))
    return 'css'
  return CODE_FILE_RE.test(name) ? 'code' : 'full'
}

// Injects the dev reload script into an HTML response while preserving streaming (<Suspense>).
function injectReloadStream(body: ReadableStream<Uint8Array>, reloadScript: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let injected = false
  let tail = ''
  const KEEP = 16 // enough to span a split `</body>` tag across chunk boundaries

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (injected) {
        controller.enqueue(chunk)
        return
      }
      const text = tail + decoder.decode(chunk, { stream: true })
      const idx = text.indexOf('</body>')
      if (idx !== -1) {
        injected = true
        tail = ''
        controller.enqueue(encoder.encode(`${text.slice(0, idx)}${reloadScript}${text.slice(idx)}`))
        return
      }
      if (text.length > KEEP) {
        const split = text.length - KEEP
        controller.enqueue(encoder.encode(text.slice(0, split)))
        tail = text.slice(split)
      }
      else {
        tail = text
      }
    },
    flush(controller) {
      const rest = tail + decoder.decode()
      if (injected) {
        if (rest.length > 0)
          controller.enqueue(encoder.encode(rest))
        return
      }
      const idx = rest.indexOf('</body>')
      if (idx !== -1)
        controller.enqueue(encoder.encode(`${rest.slice(0, idx)}${reloadScript}${rest.slice(idx)}`))
      else
        controller.enqueue(encoder.encode(rest + reloadScript))
    },
  }))
}

// Bun never unloads a module, so each build's server files are copied into a generation store.
// If any non-chunk module that other entries may statically import changes (e.g. standalone actions), bump generation so static importers re-resolve cleanly.
function createModuleStore(storeRoot: string) {
  const hashes = new Map<string, string>()
  let generation = 0
  let stale = false
  const generationDir = (g: number): string => join(storeRoot, `g${g}`)
  return {
    reloadAll(): void {
      stale = true
    },
    sync(serverDir: string, sharedRelFiles: ReadonlySet<string>): void {
      const nextFiles = new Map<string, { bytes: Buffer, hash: string }>()
      for (const entry of readdirSync(serverDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile())
          continue
        const from = join(entry.parentPath, entry.name)
        const rel = relative(serverDir, from).replaceAll('\\', '/')
        const bytes = readFileSync(from)
        const hash = Bun.hash(bytes).toString(36)
        nextFiles.set(rel, { bytes, hash })
      }

      // If an already-loaded standalone action file (statically imported by routes) changed, bump generation so static importers re-resolve cleanly.
      if (!stale && hashes.size > 0) {
        for (const [rel, { hash }] of nextFiles) {
          const prev = hashes.get(rel)
          if (prev !== undefined && prev !== hash && sharedRelFiles.has(rel)) {
            stale = true
            break
          }
        }
      }

      if (stale) {
        stale = false
        hashes.clear()
        generation++
        // The previous generation stays for requests the old app is still serving.
        rmSync(generationDir(generation - 2), { recursive: true, force: true })
      }
      const storeDir = generationDir(generation)
      for (const [rel, { bytes, hash }] of nextFiles) {
        if (hashes.get(rel) === hash)
          continue
        const to = join(storeDir, rel)
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, bytes)
        hashes.set(rel, hash)
      }
      // Prune removed chunk files from current generation to avoid unbounded disk/map growth.
      for (const rel of [...hashes.keys()]) {
        if (!nextFiles.has(rel)) {
          hashes.delete(rel)
          rmSync(join(storeDir, rel), { force: true })
        }
      }
    },
    importFrom(serverDir: string) {
      const storeDir = generationDir(generation)
      return async (path: string): Promise<Record<string, unknown>> => {
        const rel = relative(serverDir, path).replaceAll('\\', '/')
        try {
          return await import(`${join(storeDir, rel)}?v=${hashes.get(rel)}`)
        }
        catch (err) {
          stale = true
          throw err
        }
      }
    },
  }
}

export async function devServer(options: DevServerOptions): Promise<{ url: string, stop: () => void, rebuild: () => Promise<void> }> {
  const prevKayDev = process.env.KAY_DEV
  process.env.KAY_DEV = '1'
  const root = resolve(options.root)
  const devRoot = join(root, '.kay-dev')
  const initialCfg = await loadConfig(root).catch((err) => {
    console.warn(`[kay dev] failed to load kay.config.ts: ${err instanceof Error ? err.message : String(err)}`)
    return {} as Awaited<ReturnType<typeof loadConfig>>
  })
  const assetPrefix = (initialCfg.assetPrefix ?? '/_kay').replace(/\/$/, '')
  let reloadAssets = makeDevReloadAssets(assetPrefix)
  const srcDir = resolve(root, 'src')
  const routesDir = resolve(root, options.routesDir ?? initialCfg.routesDir ?? 'src/routes')
  const publicDir = resolve(root, initialCfg.publicDir ?? 'public')
  const port = options.port ?? initialCfg.port ?? 3000
  const hostname = options.hostname ?? '127.0.0.1'
  const buildCache = createBuildCache()
  const modules = createModuleStore(join(devRoot, 'server'))
  const watchers: FSWatcher[] = []
  const watchedDirs = new Set<string>()
  const pluginWatchers: FSWatcher[] = []
  let activeAssetPrefix = assetPrefix

  function refreshPluginWatchers(cfg: Awaited<ReturnType<typeof loadConfig>>): void {
    for (const w of pluginWatchers)
      w.close()
    pluginWatchers.length = 0
    const seen = new Set<string>(watchedDirs)
    const watchCtx = createAppContext({ root, outDir: devRoot, publicDir, assetPrefix: activeAssetPrefix, site: cfg.site, dev: true })
    for (const plugin of resolvePlugins(cfg.plugins)) {
      const paths = runWithAppContext(watchCtx, () =>
        typeof plugin.watchPaths === 'function' ? plugin.watchPaths(root) : (plugin.watchPaths ?? []))
      for (const p of paths) {
        const abs = resolve(root, p)
        if (seen.has(abs) || !existsSync(abs))
          continue
        seen.add(abs)
        const isDir = statSync(abs).isDirectory()
        pluginWatchers.push(watch(abs, isDir ? { recursive: true } : {}, () => scheduleRebuild('full')))
      }
    }
  }

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
        const freshCfg = await loadConfig(root, { fresh: true })
        activeAssetPrefix = (freshCfg.assetPrefix ?? '/_kay').replace(/\/$/, '')
        reloadAssets = makeDevReloadAssets(activeAssetPrefix)
        refreshPluginWatchers(freshCfg)
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
      const routeFiles = new Set(manifest.routes.map(r => r.file.replace(/^server\//, '')))
      const sharedRelFiles = new Set<string>()
      for (const a of manifest.actions) {
        const rel = a.file.replace(/^server\//, '')
        if (!routeFiles.has(rel))
          sharedRelFiles.add(rel)
      }
      modules.sync(serverDir, sharedRelFiles)
      const nextApp = await createServer({
        root,
        outDir,
        dev: true,
        compress: false,
        importModule: modules.importFrom(serverDir),
      })
      if (stopped) {
        await nextApp.dispose?.()
        rmSync(join(root, outDir), { recursive: true, force: true })
        return
      }
      const prevApp = currentApp
      currentApp = nextApp
      void prevApp?.dispose?.()
      lastError = undefined
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

  const addDirWatch = (dir: string, handler: (filename: string) => void) => {
    if (watchedDirs.has(dir) || !existsSync(dir))
      return
    watchedDirs.add(dir)
    watchers.push(watch(dir, { recursive: true }, (_ev, filename) => {
      handler(typeof filename === 'string' ? filename : '')
    }))
  }

  addDirWatch(srcDir, name => scheduleRebuild(srcChangeKind(name)))
  // If routesDir sits outside src/, watch it too!
  if (!routesDir.startsWith(`${srcDir}/`) && !routesDir.startsWith(`${srcDir}\\`) && routesDir !== srcDir)
    addDirWatch(routesDir, name => scheduleRebuild(srcChangeKind(name)))
  addDirWatch(publicDir, () => scheduleRebuild('full'))

  // Watch root (non-recursive) for kay.config.ts so atomic editor saves (temp + rename) still fire events.
  watchers.push(watch(root, (_ev, filename) => {
    if (filename === 'kay.config.ts')
      scheduleRebuild('config')
  }))

  // Watch plugin-declared extra paths (e.g. content/ or messages/ directories); refreshed on kay.config.ts edits.
  try {
    refreshPluginWatchers(initialCfg)
  }
  catch (err) {
    console.warn(`[kay dev] could not attach plugin watchers: ${err instanceof Error ? err.message : String(err)}`)
  }

  const pingChunk = encoder.encode(': ping\n\n')
  const pingInterval = setInterval(() => pushToClients(pingChunk), 15_000)

  const maxRequestBodySize = options.maxRequestBodySize ?? initialCfg.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 30,
    maxRequestBodySize,
    async fetch(request, srv) {
      const url = new URL(request.url)

      if (url.pathname === reloadAssets.eventsPath) {
        srv.timeout(request, 0)
        let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            ctrl = controller
            clients.add(controller)
            controller.enqueue(encoder.encode(': connected\n\n'))
            request.signal.addEventListener('abort', () => {
              clients.delete(controller)
              try {
                controller.close()
              }
              catch {}
            }, { once: true })
          },
          cancel() {
            if (ctrl !== undefined)
              clients.delete(ctrl)
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no',
          },
        })
      }

      if (lastError !== undefined) {
        return new Response(renderErrorOverlay(lastError, reloadAssets.script), {
          status: 500,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }

      const remoteIp = srv.requestIP(request)?.address
      const res = await currentApp!.handle(request, remoteIp)
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('text/event-stream'))
        srv.timeout(request, 0)
      if (ct.includes('text/html') && request.method !== 'HEAD' && res.body !== null) {
        const headers = new Headers(res.headers)
        headers.delete('content-length')
        const existingCsp = headers.get('content-security-policy')
        if (existingCsp !== null)
          headers.set('content-security-policy', withCspHashes(existingCsp, { scriptHashes: [reloadAssets.hash] }))
        return new Response(injectReloadStream(res.body, reloadAssets.script), { status: res.status, headers })
      }
      return res
    },
  })

  const displayHost = hostname === '0.0.0.0' ? '127.0.0.1' : hostname
  const url = `http://${displayHost}:${server.port}`
  console.log(`[kay dev] listening on ${url}`)

  return {
    url,
    rebuild() {
      pendingCssOnly = false
      return drainRebuilds()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      clearInterval(pingInterval)
      for (const w of watchers)
        w.close()
      for (const w of pluginWatchers)
        w.close()
      server.stop(true)
      void currentApp?.dispose?.()
      rmSync(devRoot, { recursive: true, force: true })
      if (prevKayDev === undefined)
        delete process.env.KAY_DEV
      else
        process.env.KAY_DEV = prevKayDev
    },
  }
}
