// HTTP helpers, MIME table, RequestContext factory, and island tag scanner for Kay v2 server.

import type { BuildManifest } from '../build/index'
import type { KayPlugin, ServerErrorInfo } from '../plugins/index'
import type { Cookies } from './cookies'
import type { SecurityHeadersOptions, TrustProxy } from './security'
import { CookieStore } from './cookies'
import { buildSecurityHeaderEntries, getClientIp, isHttpsRequest } from './security'

export const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024

export interface ServerOptions {
  root: string
  outDir?: string | undefined
  assetPrefix?: string | undefined
  port?: number | undefined
  lang?: string | undefined
  security?: SecurityHeadersOptions | false | undefined
  trustedOrigins?: string[] | undefined
  trustProxy?: TrustProxy | undefined
  maxRequestBodySize?: number | undefined
  compress?: boolean | undefined
  onError?: ((info: ServerErrorInfo) => void) | undefined
  plugins?: KayPlugin[] | undefined
}

export interface RequestContext {
  request: Request
  url: URL
  params: Record<string, string>
  cookies: Cookies
  locals: Record<string, unknown>
  ip?: string | undefined
  json: (data: unknown, init?: ResponseInit) => Response
  text: (body: string, init?: ResponseInit) => Response
  redirect: (location: string, status?: 301 | 302 | 303 | 307 | 308) => Response
  deny: (status: number, message: string, fieldErrors?: Record<string, string>) => Response
}

export type Middleware = (ctx: RequestContext, next: () => Promise<Response>) => Response | Promise<Response>

export interface KayApp {
  handle: (request: Request, remoteIp?: string) => Promise<Response>
  serve: (port?: number, hostname?: string) => ReturnType<typeof Bun.serve>
}

export type EmbeddedBody = Uint8Array<ArrayBuffer> | string

export interface EmbeddedServerConfig {
  manifest: BuildManifest
  modules: Record<string, unknown>
  assets: Record<string, EmbeddedBody>
  publicAssets?: Record<string, EmbeddedBody> | undefined
  publicEtags?: Record<string, string> | undefined
  prerendered: Record<string, string>
  prerenderedFiles?: Record<string, string> | undefined
  assetPrefix?: string | undefined
  lang?: string | undefined
  security?: SecurityHeadersOptions | false | undefined
  trustedOrigins?: string[] | undefined
  trustProxy?: TrustProxy | undefined
  maxRequestBodySize?: number | undefined
  compress?: boolean | undefined
  onError?: ((info: ServerErrorInfo) => void) | undefined
  plugins?: KayPlugin[] | undefined
}

export const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json',
}

const ISLAND_TAG_RE = /<kay-island c="([^"]+)"([^>]*)>/g

export function extractRenderedIslands(html: string): { hasIslands: boolean, eagerChunks: string[] } {
  let hasIslands = false
  const eager = new Set<string>()
  ISLAND_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ISLAND_TAG_RE.exec(html)) !== null) {
    hasIslands = true
    const attrs = m[2] ?? ''
    if (!attrs.includes(' h="'))
      eager.add(m[1]!)
  }
  return { hasIslands, eagerChunks: [...eager] }
}

export interface RequestContextOptions {
  trustProxy?: TrustProxy | undefined
  remoteIp?: string | undefined
}

export function makeRequestContext(
  request: Request,
  params: Record<string, string>,
  opts?: RequestContextOptions,
): { ctx: RequestContext, cookieStore: CookieStore } {
  const url = new URL(request.url)
  const trustProxy = opts?.trustProxy ?? false
  const isHttps = isHttpsRequest(request, trustProxy)
  const cookieStore = new CookieStore(request.headers.get('cookie'), isHttps)
  const ip = getClientIp(request, trustProxy, opts?.remoteIp)
  const ctx: RequestContext = {
    request,
    url,
    params,
    cookies: cookieStore,
    locals: {},
    ip,
    json: (data, init) => {
      const payload = JSON.stringify(data)
      const headers = new Headers(init?.headers)
      if (!headers.has('content-type'))
        headers.set('content-type', 'application/json; charset=utf-8')
      if (!headers.has('content-length'))
        headers.set('content-length', String(Buffer.byteLength(payload, 'utf8')))
      return new Response(payload, { ...init, headers })
    },
    text: (body, init) => {
      const headers = new Headers(init?.headers)
      if (!headers.has('content-type'))
        headers.set('content-type', 'text/plain; charset=utf-8')
      if (!headers.has('content-length'))
        headers.set('content-length', String(Buffer.byteLength(body, 'utf8')))
      return new Response(body, { ...init, headers })
    },
    redirect: (location, status = 302) => new Response(null, { status, headers: { location } }),
    deny: (status, message, fieldErrors) => Response.json({ ok: false, status, error: message, fieldErrors }, { status }),
  }
  return { ctx, cookieStore }
}

/** Enforces `maxBytes` on incoming request bodies (both Content-Length and streaming body reads). */
export async function enforceRequestBodyLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true, request: Request } | { ok: false }> {
  if (request.method === 'GET' || request.method === 'HEAD' || !Number.isFinite(maxBytes) || maxBytes <= 0)
    return { ok: true, request }

  const clHeader = request.headers.get('content-length')
  if (clHeader !== null) {
    const cl = Number(clHeader)
    if (Number.isFinite(cl) && cl > maxBytes)
      return { ok: false }
  }

  // Capture headers BEFORE accessing request.body so Bun preserves FormData multipart boundaries.
  const headers = new Headers(request.headers)
  const body = request.body
  if (body === null)
    return { ok: true, request }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false }
      }
      chunks.push(value)
    }
  }
  finally {
    reader.releaseLock()
  }

  const combined = new Uint8Array(total)
  let offset = 0
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }

  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: combined,
    }),
  }
}

export function applyHstsHeader(
  res: Response,
  request: Request,
  hstsValue: string | undefined,
  trustProxy: TrustProxy,
): Response {
  if (hstsValue === undefined || process.env.NODE_ENV !== 'production' || !isHttpsRequest(request, trustProxy))
    return res
  if (res.headers.has('strict-transport-security'))
    return res
  try {
    res.headers.set('strict-transport-security', hstsValue)
    return res
  }
  catch {
    const headers = new Headers(res.headers)
    headers.set('strict-transport-security', hstsValue)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

export function finalizeResponse(
  res: Response,
  cookieStore: CookieStore,
  securityEntries: readonly [string, string][] | SecurityHeadersOptions | false | undefined,
): Response {
  const entries: readonly [string, string][] = Array.isArray(securityEntries)
    ? securityEntries
    : buildSecurityHeaderEntries(securityEntries as SecurityHeadersOptions | false | undefined)

  if (!cookieStore.hasChanges && entries.length === 0)
    return res

  // Fast path: mutate Response.headers in place (zero Response/Headers copy in Bun!)
  try {
    const h = res.headers
    if (cookieStore.hasChanges)
      cookieStore.applyTo(h)
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i]!
      if (!h.has(k))
        h.set(k, v)
    }
    return res
  }
  catch {
    // Fallback for immutable headers (e.g. proxied upstream fetch Response)
    const headers = new Headers(res.headers)
    if (cookieStore.hasChanges)
      cookieStore.applyTo(headers)
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i]!
      if (!headers.has(k))
        headers.set(k, v)
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}
