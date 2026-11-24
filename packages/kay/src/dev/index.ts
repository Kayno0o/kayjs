// kay dev: incremental cached rebuilds, serialized rebuild queue, CSS hot-swap, SSE error push, and live config reload.

import type { FSWatcher } from 'node:fs'
import type { KayApp } from '../server/index'
import { existsSync, rmSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { build, createBuildCache } from '../build/index'
import { createServer } from '../server/index'

export interface DevServerOptions {
  root: string
  port?: number | undefined
  routesDir?: string | undefined
}

const DEV_RELOAD_SCRIPT = `<script>(()=>{const s=new EventSource('/_kay/dev-events');s.onmessage=(e)=>{if(e.data.startsWith('css:')){const urls=JSON.parse(e.data.slice(4));const old=[...document.querySelectorAll('link[rel="stylesheet"][href^="/_kay/"]')];if(old.length===0){location.reload();return;}let left=urls.length;for(const u of urls){const l=document.createElement('link');l.rel='stylesheet';l.href=u;const done=()=>{if(--left===0)for(const o of old)o.remove();};l.onload=done;l.onerror=done;document.head.appendChild(l);}}else{location.reload();}};})();</script>`

function renderErrorOverlay(errText: string): string {
  const escaped = errText
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Kay Dev Error</title><style>body{margin:0;min-height:100vh;background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;padding:2rem}main{max-width:56rem;width:100%;background:#161b22;border:1px solid #f85149;border-radius:10px;padding:1.5rem 2rem;box-shadow:0 16px 48px rgba(0,0,0,.45)}h1{margin:0 0 1rem;color:#ff7b72;font-size:1.15rem}pre{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-size:.9rem;color:#ffa198}p{margin:1rem 0 0;font-size:.8rem;color:#8b949e}</style></head><body><main><h1>Kay Dev Build Error</h1><pre>${escaped}</pre><p>Save a fix to auto-reload.</p></main>${DEV_RELOAD_SCRIPT}</body></html>`
}

type ChangeKind = 'css' | 'full' | 'config'

export async function devServer(options: DevServerOptions): Promise<{ url: string, stop: () => void, rebuild: () => Promise<void> }> {
  const prevKayDev = process.env.KAY_DEV
  process.env.KAY_DEV = '1'
  const root = resolve(options.root)
  const srcDir = resolve(root, 'src')
  const publicDir = resolve(root, 'public')
  const configPath = join(root, 'kay.config.ts')
  const devRoot = join(root, '.kay-dev')
  const port = options.port ?? 3000
  const buildCache = createBuildCache()

  let buildNum = 0
  let currentApp: KayApp | undefined
  let lastError: string | undefined
  let stopped = false

  // Serialized rebuild queue: rapid saves coalesce instead of racing
  let building = false
  let pending = false
  let pendingCssOnly = true
  let pendingConfigReset = false
  let inFlight: Promise<void> | undefined

  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()

  function broadcast(payload: string): void {
    const chunk = encoder.encode(`data: ${payload}\n\n`)
    for (const c of clients) {
      try {
        c.enqueue(chunk)
      }
      catch {
        clients.delete(c)
      }
    }
  }

  async function runSingleBuild(cssOnly: boolean, resetCache: boolean): Promise<void> {
    if (stopped)
      return
    if (resetCache) {
      buildCache.analyses.clear()
      buildCache.domCompiled.clear()
      buildCache.ssrCompiled.clear()
    }
    const hadError = lastError !== undefined
    const hadApp = currentApp !== undefined
    const n = ++buildNum
    const outDir = `.kay-dev/b${n}`
    const t0 = performance.now()
    try {
      const manifest = await build({
        root,
        routesDir: options.routesDir,
        outDir,
        minify: false,
        prerender: false,
        copyPublic: false,
        cache: buildCache,
      })
      currentApp = await createServer({ root, outDir })
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
      lastError = err instanceof Error ? err.stack ?? err.message : String(err)
      console.error(`[kay dev] build error:\n${lastError}`)
      // Push reload over SSE so open browser tabs immediately display the error overlay
      broadcast('reload')
    }
  }

  function drainRebuilds(): Promise<void> {
    if (building) {
      pending = true
      return inFlight ?? Promise.resolve()
    }
    building = true
    const run = (async () => {
      try {
        do {
          const cssOnly = pendingCssOnly
          const resetCache = pendingConfigReset
          pending = false
          pendingCssOnly = true
          pendingConfigReset = false
          await runSingleBuild(cssOnly, resetCache)
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

  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleRebuild = (kind: ChangeKind) => {
    if (stopped)
      return
    if (kind === 'config') {
      pendingConfigReset = true
      pendingCssOnly = false
    }
    else if (kind === 'full') {
      pendingCssOnly = false
    }
    clearTimeout(timer)
    timer = setTimeout(() => {
      void drainRebuilds()
    }, 40)
  }

  const watchers: FSWatcher[] = []
  if (existsSync(srcDir)) {
    watchers.push(watch(srcDir, { recursive: true }, (_ev, filename) => {
      const name = typeof filename === 'string' ? filename : ''
      const isCss = name.endsWith('.css') && !name.endsWith('.module.css')
      scheduleRebuild(isCss ? 'css' : 'full')
    }))
  }
  if (existsSync(publicDir))
    watchers.push(watch(publicDir, { recursive: true }, () => scheduleRebuild('full')))
  if (existsSync(configPath))
    watchers.push(watch(configPath, () => scheduleRebuild('config')))

  const pingChunk = encoder.encode(': ping\n\n')
  const pingInterval = setInterval(() => {
    for (const c of clients) {
      try {
        c.enqueue(pingChunk)
      }
      catch {
        clients.delete(c)
      }
    }
  }, 15_000)

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/_kay/dev-events') {
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
        return new Response(renderErrorOverlay(lastError), {
          status: 500,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }

      const res = await currentApp!.handle(request)
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('text/html')) {
        const html = await res.text()
        const injected = html.includes('</body>')
          ? html.replace('</body>', `${DEV_RELOAD_SCRIPT}</body>`)
          : html + DEV_RELOAD_SCRIPT
        return new Response(injected, { status: res.status, headers: res.headers })
      }
      return res
    },
  })

  const url = `http://localhost:${server.port}`
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
      server.stop(true)
      rmSync(devRoot, { recursive: true, force: true })
      if (prevKayDev === undefined)
        delete process.env.KAY_DEV
      else
        process.env.KAY_DEV = prevKayDev
    },
  }
}
