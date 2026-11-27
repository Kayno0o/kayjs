// What kay dev adds to the app's answers: the reload script and its event stream, the build-error overlay, and the script's injection into streamed HTML.

import { wantsJson } from '../server/http'
import { withCspHashes } from '../server/security'
import { REGION_HEADER } from '../server/region'

export function makeDevReloadAssets(assetPrefix: string): { script: string, hash: string, eventsPath: string } {
  const prefix = assetPrefix.replace(/\/$/, '')
  const eventsPath = `${prefix}/dev-events`
  const js = `(()=>{const stem=u=>u.replace(/-[a-z0-9]+\\.css$/i,'');const s=new EventSource(${JSON.stringify(eventsPath)});s.onmessage=(e)=>{if(e.data.startsWith('css:')){const urls=JSON.parse(e.data.slice(4));const byStem=new Map(urls.map(u=>[stem(u),u]));const old=[...document.querySelectorAll('link[rel="stylesheet"][href^=${JSON.stringify(`${prefix}/`)}]')];if(old.length===0){location.reload();return;}const next=[];for(const o of old){const m=byStem.get(stem(o.getAttribute('href')||''));if(m)next.push(m);}if(next.length===0){location.reload();return;}let left=next.length;for(const u of next){const l=document.createElement('link');l.rel='stylesheet';l.href=u;const done=()=>{if(--left===0)for(const o of old)o.remove();};l.onload=done;l.onerror=done;document.head.appendChild(l);}}else{location.reload();}};})();`
  const hash = `'sha256-${new Bun.CryptoHasher('sha256').update(js).digest('base64')}'`
  return { script: `<script>${js}</script>`, hash, eventsPath }
}

export function renderErrorOverlay(errText: string, reloadScript: string): string {
  const escaped = errText
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Kay Dev Error</title><style>body{margin:0;min-height:100vh;background:#0d1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:grid;place-items:center;padding:2rem}main{max-width:56rem;width:100%;background:#161b22;border:1px solid #f85149;border-radius:10px;padding:1.5rem 2rem;box-shadow:0 16px 48px rgba(0,0,0,.45)}h1{margin:0 0 1rem;color:#ff7b72;font-size:1.15rem}pre{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-size:.9rem;color:#ffa198}p{margin:1rem 0 0;font-size:.8rem;color:#8b949e}</style></head><body><main><h1>Kay Dev Build Error</h1><pre>${escaped}</pre><p>Save a fix to auto-reload.</p></main>${reloadScript}</body></html>`
}

export function shouldInjectReload(request: Request, res: Response, ct: string): boolean {
  return ct.includes('text/html')
    && request.method !== 'HEAD'
    && res.body !== null
    && !res.headers.has('content-encoding')
    && !request.headers.has(REGION_HEADER)
    && !res.headers.has(REGION_HEADER)
}

// Injects the dev reload script into an HTML response while preserving streaming (<Suspense>).
export function injectReloadStream(body: ReadableStream<Uint8Array>, reloadScript: string): ReadableStream<Uint8Array> {
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

/** The reload script's event stream: `controller` joins `clients` until the browser goes away. */
function reloadEvents(request: Request, clients: Set<ReadableStreamDefaultController<Uint8Array>>): Response {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
  let open = true
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller
      clients.add(controller)
      controller.enqueue(new TextEncoder().encode(': connected\n\n'))
      request.signal.addEventListener('abort', () => {
        clients.delete(controller)
        if (open) {
          open = false
          controller.close()
        }
      }, { once: true })
    },
    cancel() {
      open = false
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

/** The answer to every request while the build is broken: JSON or text when the client asks for it, else the overlay. */
export function buildErrorResponse(request: Request, error: string, reloadScript: string): Response {
  if (wantsJson(request))
    return Response.json({ ok: false, status: 500, error }, { status: 500 })
  if ((request.headers.get('accept') ?? '').startsWith('text/plain'))
    return new Response(error, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  return new Response(renderErrorOverlay(error, reloadScript), {
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/** An HTML answer with the reload script before `</body>` and its hash in the CSP; any other answer as it is. */
export function withReloadScript(request: Request, res: Response, assets: { script: string, hash: string }): Response {
  if (!shouldInjectReload(request, res, res.headers.get('content-type') ?? ''))
    return res
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  const existingCsp = headers.get('content-security-policy')
  if (existingCsp !== null)
    headers.set('content-security-policy', withCspHashes(existingCsp, { scriptHashes: [assets.hash] }))
  return new Response(injectReloadStream(res.body!, assets.script), { status: res.status, headers })
}

/** The browsers' reload streams: `broadcast` reaches each, and a ping every 15 s keeps idle ones open. */
export function createReloadHub() {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const push = (chunk: Uint8Array): void => {
    for (const c of clients) {
      try {
        c.enqueue(chunk)
      }
      catch {
        clients.delete(c)
      }
    }
  }
  const ping = encoder.encode(': ping\n\n')
  const pinger = setInterval(() => push(ping), 15_000)
  return {
    events: (request: Request): Response => reloadEvents(request, clients),
    broadcast: (payload: string): void => push(encoder.encode(`data: ${payload}\n\n`)),
    close: (): void => clearInterval(pinger),
  }
}
