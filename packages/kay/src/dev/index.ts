// kay dev: fast incremental rebuild (~5-10 ms) + in-place server hot swap + SSE browser live reload.

import type { KayApp } from '../server/index'
import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { build } from '../build/index'
import { createServer } from '../server/index'

export interface DevServerOptions {
  root: string
  port?: number | undefined
  routesDir?: string | undefined
}

const DEV_RELOAD_SCRIPT = `<script>(()=>{const s=new EventSource('/_kay/dev-events');s.onmessage=()=>location.reload();})();</script>`

export async function devServer(options: DevServerOptions): Promise<{ url: string, stop: () => void }> {
  const root = resolve(options.root)
  const srcDir = resolve(root, 'src')
  const port = options.port ?? 3000
  let buildNum = 0
  let currentApp: KayApp | undefined
  let lastError: string | undefined
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()

  async function rebuild(): Promise<void> {
    const outDir = `.kay-dev/b${++buildNum}`
    const t0 = performance.now()
    try {
      await build({ root, routesDir: options.routesDir, outDir, minify: false })
      currentApp = await createServer({ root, outDir })
      lastError = undefined
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
  const watcher = watch(srcDir, { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => void rebuild(), 40)
  })

  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/_kay/dev-events') {
        let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            ctrl = controller
            clients.add(controller)
            controller.enqueue(encoder.encode(': connected\n\n'))
          },
          cancel() {
            if (ctrl !== undefined)
              clients.delete(ctrl)
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          },
        })
      }

      if (lastError !== undefined) {
        return new Response(
          `<!DOCTYPE html><html><body style="font-family:monospace;padding:2rem;background:#111;color:#f87171"><h1>Kay Dev Error</h1><pre>${lastError.replaceAll('<', '&lt;')}</pre>${DEV_RELOAD_SCRIPT}</body></html>`,
          { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
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
      watcher.close()
      server.stop(true)
    },
  }
}
