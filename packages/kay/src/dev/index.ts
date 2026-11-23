// kay dev: fast incremental rebuild (~5-10 ms) + in-place server hot swap + SSE browser live reload.

import type { FSWatcher } from 'node:fs'
import type { KayApp } from '../server/index'
import { existsSync, rmSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../build/index'
import { createServer } from '../server/index'

export interface DevServerOptions {
  root: string
  port?: number | undefined
  routesDir?: string | undefined
}

const DEV_RELOAD_SCRIPT = `<script>(()=>{const s=new EventSource('/_kay/dev-events');s.onmessage=()=>location.reload();})();</script>`

function renderErrorOverlay(errText: string): string {
  const escaped = errText
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Kay Dev Error</title><style>body{margin:0;min-height:100vh;background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;padding:2rem}main{max-width:56rem;width:100%;background:#161b22;border:1px solid #f85149;border-radius:10px;padding:1.5rem 2rem;box-shadow:0 16px 48px rgba(0,0,0,.45)}h1{margin:0 0 1rem;color:#ff7b72;font-size:1.15rem}pre{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-size:.9rem;color:#ffa198}p{margin:1rem 0 0;font-size:.8rem;color:#8b949e}</style></head><body><main><h1>Kay Dev Build Error</h1><pre>${escaped}</pre><p>Save a fix to auto-reload.</p></main>${DEV_RELOAD_SCRIPT}</body></html>`
}

export async function devServer(options: DevServerOptions): Promise<{ url: string, stop: () => void }> {
  process.env.KAY_DEV = '1'
  const root = resolve(options.root)
  const srcDir = resolve(root, 'src')
  const publicDir = resolve(root, 'public')
  const configPath = join(root, 'kay.config.ts')
  const devRoot = join(root, '.kay-dev')
  const port = options.port ?? 3000
  let buildNum = 0
  let currentApp: KayApp | undefined
  let lastError: string | undefined
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()

  async function rebuild(): Promise<void> {
    const n = ++buildNum
    const outDir = `.kay-dev/b${n}`
    const t0 = performance.now()
    try {
      await build({ root, routesDir: options.routesDir, outDir, minify: false })
      currentApp = await createServer({ root, outDir })
      lastError = undefined
      if (n > 2)
        rmSync(join(devRoot, `b${n - 2}`), { recursive: true, force: true })
      console.log(`[kay dev] rebuilt in ${(performance.now() - t0).toFixed(1)} ms`)
      for (const c of clients) {
        try {
          c.enqueue(encoder.encode(`data: reload\n\n`))
        }
        catch {
          clients.delete(c)
        }
      }
    }
    catch (err) {
      lastError = err instanceof Error ? err.stack ?? err.message : String(err)
      console.error(`[kay dev] build error:\n${lastError}`)
    }
  }

  await rebuild()

  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleRebuild = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void rebuild(), 40)
  }

  const watchers: FSWatcher[] = []
  if (existsSync(srcDir))
    watchers.push(watch(srcDir, { recursive: true }, scheduleRebuild))
  if (existsSync(publicDir))
    watchers.push(watch(publicDir, { recursive: true }, scheduleRebuild))
  if (existsSync(configPath))
    watchers.push(watch(configPath, scheduleRebuild))

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
    stop() {
      clearTimeout(timer)
      clearInterval(pingInterval)
      for (const w of watchers)
        w.close()
      server.stop(true)
      rmSync(devRoot, { recursive: true, force: true })
    },
  }
}
