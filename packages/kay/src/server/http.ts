// HTTP helpers, MIME table, RequestContext factory, and island tag scanner for Kay v2 server.

import type { BuildManifest } from '../build/index'
import type { KayChild } from '../jsx-runtime'
import type { KayPlugin, ServerErrorInfo } from '../plugins/index'
import type { Cookies } from './cookies'
import type { KayLocals } from './index'
import type { SecurityHeadersOptions, TrustProxy } from './security'
import { CookieStore } from './cookies'
import { nodeEnv } from './env'
import { getClientIp, isHttpsRequest } from './security'

export const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024

const NOT_FOUND_SYMBOL = Symbol.for('kay.notFound')
declare const NOT_FOUND_BRAND: unique symbol

export interface NotFoundResult {
  readonly [NOT_FOUND_BRAND]: true
}

/** Return (or throw) from `load()` to render `_404.tsx` with HTTP status 404. */
export function notFound(): NotFoundResult {
  return { [NOT_FOUND_SYMBOL]: true } as unknown as NotFoundResult
}

export function isNotFound(value: unknown): value is NotFoundResult {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[NOT_FOUND_SYMBOL] === true
}

type SegmentParam<Seg extends string> =
  Seg extends `[...${infer Name}]`
    ? { [K in Name]: string }
    : Seg extends `[${infer Name}]`
      ? { [K in Name]: string }
      : Seg extends `*${infer Name}`
        ? { [K in Name extends '' ? 'rest' : Name]: string }
        : Seg extends `:${infer Name}`
          ? { [K in Name]: string }
          : unknown

type MergeParams<A, B> = {
  [K in keyof A | keyof B]: K extends keyof B ? B[K] : K extends keyof A ? A[K] : never
}

type ExtractRouteParamsRec<Path extends string, Acc = {}> =
  Path extends `${infer Seg}/${infer Rest}`
    ? ExtractRouteParamsRec<Rest, Seg extends '' ? Acc : MergeParams<Acc, SegmentParam<Seg>>>
    : Path extends ''
      ? Acc
      : MergeParams<Acc, SegmentParam<Path>>

/** Extracts typed route params from a Kay route path (`'/notices/[id]'` -> `{ id: string }`, `'/docs/[...rest]'` -> `{ rest: string }`). */
export type ExtractRouteParams<Path extends string> =
  string extends Path
    ? Record<string, string>
    : ExtractRouteParamsRec<Path>

export type LoaderFn = (...args: never[]) => unknown

/** Infers the resolved page `data` type returned by a route's `load()` function, excluding `Response` and `notFound()`. */
export type LoaderData<T extends LoaderFn> = Exclude<Awaited<ReturnType<T>>, Response | NotFoundResult>

type InferLoaderParams<T extends LoaderFn> =
  Parameters<T> extends [ctx: { params: infer P }, ...unknown[]]
    ? P
    : Record<string, string>

/** Props passed to a Kay route page component. Pass `typeof load` to infer `data` (and `params` when `load` uses `RouteContext<Path>`), or a route path string when there is no `load`. */
export type PageProps<
  TLoadOrPath extends LoaderFn | string | undefined = undefined,
  TPath extends string = string,
> = {
  params: TLoadOrPath extends string
    ? ExtractRouteParams<TLoadOrPath>
    : string extends TPath
      ? (TLoadOrPath extends LoaderFn ? InferLoaderParams<TLoadOrPath> : Record<string, string>)
      : ExtractRouteParams<TPath>
  locals: KayLocals
  url: URL
} & (TLoadOrPath extends LoaderFn ? { data: LoaderData<TLoadOrPath> } : { data?: undefined })

/** Props passed to a Kay `_layout.tsx` component. */
export interface LayoutProps<Path extends string = string> {
  children: KayChild
  params: ExtractRouteParams<Path>
  locals: KayLocals
  url: URL
}

export interface ServerOptions {
  root: string
  outDir?: string | undefined
  assetPrefix?: string | undefined
  site?: string | undefined
  port?: number | undefined
  lang?: string | undefined
  security?: SecurityHeadersOptions | false | undefined
  trustedOrigins?: string[] | undefined
  trustProxy?: TrustProxy | undefined
  maxRequestBodySize?: number | undefined
  /** Milliseconds a streamed `<Suspense>` boundary may take before it renders its error and the response ends (default 30000). */
  streamTimeout?: number | undefined
  compress?: boolean | undefined
  dev?: boolean | undefined
  onError?: ((info: ServerErrorInfo) => void) | undefined
  plugins?: KayPlugin[] | undefined
  /** @internal Imports a built server module by absolute path; `kay dev` passes one that keeps unchanged modules loaded. */
  importModule?: ((path: string) => Promise<Record<string, unknown>>) | undefined
}

export interface RequestContext<Params = Record<string, string>> {
  request: Request
  url: URL
  params: Params
  cookies: Cookies
  locals: KayLocals
  ip?: string | undefined
  json: (data: unknown, init?: ResponseInit) => Response
  text: (body: string, init?: ResponseInit) => Response
  redirect: (location: string, status?: 301 | 302 | 303 | 307 | 308) => Response
  deny: (status: number, message: string, fieldErrors?: Record<string, string>) => Response
}

/** `RequestContext` with `params` inferred from a Kay route pattern (e.g. `RouteContext<'/notices/[id]'>`). */
export type RouteContext<Path extends string = string> = RequestContext<ExtractRouteParams<Path>>

export type Middleware = (ctx: RequestContext, next: () => Promise<Response>) => Response | Promise<Response>

export interface KayApp {
  handle: (request: Request, remoteIp?: string) => Promise<Response>
  serve: (port?: number, hostname?: string) => ReturnType<typeof Bun.serve>
  /** Runs plugin shutdown hooks and releases timers/resources (safe to call multiple times). */
  dispose?: () => Promise<void>
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
  root?: string | undefined
  outDir?: string | undefined
  publicDir?: string | undefined
  assetPrefix?: string | undefined
  site?: string | undefined
  lang?: string | undefined
  security?: SecurityHeadersOptions | false | undefined
  trustedOrigins?: string[] | undefined
  trustProxy?: TrustProxy | undefined
  maxRequestBodySize?: number | undefined
  /** Milliseconds a streamed `<Suspense>` boundary may take before it renders its error and the response ends (default 30000). */
  streamTimeout?: number | undefined
  compress?: boolean | undefined
  dev?: boolean | undefined
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
  /** The parsed `request.url`, when the caller already has it. */
  url?: URL | undefined
}

// None of these read the request, so every context shares them.
const json: RequestContext['json'] = (data, init) => {
  const payload = JSON.stringify(data)
  const headers = new Headers(init?.headers)
  if (!headers.has('content-type'))
    headers.set('content-type', 'application/json; charset=utf-8')
  if (!headers.has('content-length'))
    headers.set('content-length', String(Buffer.byteLength(payload, 'utf8')))
  return new Response(payload, { ...init, headers })
}
const text: RequestContext['text'] = (body, init) => {
  const headers = new Headers(init?.headers)
  if (!headers.has('content-type'))
    headers.set('content-type', 'text/plain; charset=utf-8')
  if (!headers.has('content-length'))
    headers.set('content-length', String(Buffer.byteLength(body, 'utf8')))
  return new Response(body, { ...init, headers })
}
const redirect: RequestContext['redirect'] = (location, status = 302) => new Response(null, { status, headers: { location } })
const deny: RequestContext['deny'] = (status, message, fieldErrors) => Response.json({ ok: false, status, error: message, fieldErrors }, { status })

/** RFC 9110 weak ETag comparison supporting `*`, comma-separated lists, and `W/` prefixes. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch)
    return false
  const trimmed = ifNoneMatch.trim()
  if (trimmed === '*')
    return true
  const stripWeak = (v: string) => (v.startsWith('W/') || v.startsWith('w/') ? v.slice(2) : v)
  const target = stripWeak(etag)
  for (const part of trimmed.split(',')) {
    if (stripWeak(part.trim()) === target)
      return true
  }
  return false
}

export function makeRequestContext(
  request: Request,
  params: Record<string, string>,
  opts?: RequestContextOptions,
): { ctx: RequestContext, cookieStore: CookieStore } {
  const trustProxy = opts?.trustProxy ?? false
  const remoteIp = opts?.remoteIp
  const cookieStore = new CookieStore(request.headers.get('cookie'), isHttpsRequest(request, trustProxy))
  let cachedIp: string | undefined
  let ipComputed = false
  const ctx: RequestContext = {
    request,
    url: opts?.url ?? new URL(request.url),
    params,
    cookies: cookieStore,
    locals: {},
    get ip() {
      if (!ipComputed) {
        ipComputed = true
        cachedIp = getClientIp(request, trustProxy, remoteIp)
      }
      return cachedIp
    },
    set ip(val: string | undefined) {
      ipComputed = true
      cachedIp = val
    },
    json,
    text,
    redirect,
    deny,
  }
  return { ctx, cookieStore }
}

/** True when the client sent or asked for JSON: such requests get JSON errors, not pages. */
export function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json')
    || (request.headers.get('content-type') ?? '').includes('application/json')
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
        try {
          await reader.cancel()
        }
        catch {}
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

  headers.delete('transfer-encoding')
  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: combined,
      signal: request.signal,
    }),
  }
}

export function applyHstsHeader(
  res: Response,
  request: Request,
  hstsValue: string | undefined,
  trustProxy: TrustProxy,
  isDev = false,
): Response {
  const env = nodeEnv()
  if (hstsValue === undefined || isDev || env === 'development' || env === 'test' || !isHttpsRequest(request, trustProxy))
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

/** Adds the pending cookies (when any) and the security headers the response does not set itself. */
export function finalizeResponse(
  res: Response,
  cookieStore: CookieStore | undefined,
  entries: readonly [string, string][],
): Response {
  const hasCookies = cookieStore?.hasChanges === true
  if (!hasCookies && entries.length === 0)
    return res

  const apply = (h: Headers): void => {
    if (hasCookies)
      cookieStore!.applyTo(h)
    for (const [k, v] of entries) {
      if (!h.has(k))
        h.set(k, v)
    }
  }
  // Mutate in place (no copy in Bun); a response with immutable headers (e.g. a proxied upstream fetch) is rebuilt.
  try {
    apply(res.headers)
    return res
  }
  catch {
    const headers = new Headers(res.headers)
    apply(headers)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}
