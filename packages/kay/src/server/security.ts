// Built-in security basics: CSRF/Origin verification on state-changing requests + safe default headers + strict CSP hashes.

import { KAY_STREAM_SCRIPT } from '../ssr/context'
import { KAY_ISLAND_STYLE, KAY_SUSPENSE_STYLE } from '../ssr/index'

function cspSha256(content: string): string {
  const digest = new Bun.CryptoHasher('sha256').update(content).digest('base64')
  return `'sha256-${digest}'`
}

export const KAY_ISLAND_STYLE_HASH = cspSha256(KAY_ISLAND_STYLE)
export const KAY_SUSPENSE_STYLE_HASH = cspSha256(KAY_SUSPENSE_STYLE)
export const KAY_STREAM_SCRIPT_HASH = cspSha256(KAY_STREAM_SCRIPT)

/** Augments a Content-Security-Policy header with exact SHA-256 hashes (no `'unsafe-inline'` required). */
export function withCspHashes(
  csp: string,
  opts: { styleHashes?: readonly string[], scriptHashes?: readonly string[] },
): string {
  const styleHashes = opts.styleHashes ?? []
  const scriptHashes = opts.scriptHashes ?? []
  if (styleHashes.length === 0 && scriptHashes.length === 0)
    return csp

  const rawParts = csp.split(';').map(s => s.trim()).filter(Boolean)
  const directives = new Map<string, string[]>()
  const order: string[] = []
  for (const part of rawParts) {
    const tokens = part.split(/\s+/)
    const name = tokens[0]!.toLowerCase()
    if (!directives.has(name)) {
      order.push(name)
      directives.set(name, tokens.slice(1))
    }
  }

  const defaultSrc = directives.get('default-src') ?? ["'self'"]
  const addHashes = (dirName: string, hashes: readonly string[]) => {
    if (hashes.length === 0)
      return
    let tokens = directives.get(dirName)
    if (tokens === undefined) {
      tokens = [...defaultSrc]
      directives.set(dirName, tokens)
      order.push(dirName)
    }
    if (tokens.includes("'unsafe-inline'"))
      return
    const noneIdx = tokens.indexOf("'none'")
    if (noneIdx !== -1)
      tokens.splice(noneIdx, 1)
    for (const h of hashes) {
      if (!tokens.includes(h))
        tokens.push(h)
    }
  }

  addHashes('style-src', styleHashes)
  if (directives.has('style-src-elem'))
    addHashes('style-src-elem', styleHashes)
  addHashes('script-src', scriptHashes)
  if (directives.has('script-src-elem'))
    addHashes('script-src-elem', scriptHashes)

  return order.map((name) => {
    const tokens = directives.get(name)!
    return tokens.length > 0 ? `${name} ${tokens.join(' ')}` : name
  }).join('; ')
}

export const DEFAULT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
export const DEFAULT_HSTS = 'max-age=31536000; includeSubDomains'
export const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()'

export interface SecurityHeadersOptions {
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false | undefined
  referrerPolicy?: string | false | undefined
  contentTypeOptions?: boolean | undefined
  permissionsPolicy?: string | false | undefined
  csp?: string | false | undefined
  hsts?: string | boolean | undefined
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** How many reverse proxies sit in front of the app: `true` is one, a number is that many, `false` trusts no forwarded header. */
export type TrustProxy = boolean | number

function proxyHops(trustProxy: TrustProxy): number {
  return trustProxy === true ? 1 : trustProxy === false ? 0 : Math.max(0, Math.floor(trustProxy))
}

// Proxies append to X-Forwarded-*, so only the entries the trusted hops wrote count: the one `hops` from the right.
function forwardedValue(request: Request, header: string, trustProxy: TrustProxy): string | undefined {
  const hops = proxyHops(trustProxy)
  if (hops === 0)
    return undefined
  const entries = (request.headers.get(header) ?? '').split(',').map(e => e.trim()).filter(e => e !== '')
  return entries[Math.max(0, entries.length - hops)]
}

function forwardedOrigin(request: Request, trustProxy: TrustProxy): string | undefined {
  const proto = forwardedValue(request, 'x-forwarded-proto', trustProxy)
  const host = forwardedValue(request, 'x-forwarded-host', trustProxy) || request.headers.get('host')?.trim()
  if (!proto || !host)
    return undefined
  try {
    return new URL(`${proto}://${host}`).origin
  }
  catch {
    return undefined
  }
}

/** Returns true when the request arrived over HTTPS (directly, or via X-Forwarded-Proto when `trustProxy` is true). */
export function isHttpsRequest(request: Request, trustProxy: TrustProxy = false): boolean {
  return request.url.startsWith('https:')
    || forwardedValue(request, 'x-forwarded-proto', trustProxy)?.toLowerCase() === 'https'
}

/** Extracts the client IP from the trusted proxies' headers, or falls back to the direct socket IP. */
export function getClientIp(request: Request, trustProxy: TrustProxy = false, remoteIp?: string): string | undefined {
  if (proxyHops(trustProxy) > 0) {
    const forwarded = forwardedValue(request, 'x-forwarded-for', trustProxy)
    if (forwarded)
      return forwarded
    const realIp = request.headers.get('x-real-ip')?.trim()
    if (realIp)
      return realIp
  }
  return remoteIp || undefined
}

/** Returns true when `origin` matches the request's direct (or trusted forwarded) origin or `trustedOrigins`. */
export function isTrustedOrigin(
  origin: string,
  request: Request,
  trustedOrigins?: ReadonlySet<string>,
  trustProxy: TrustProxy = false,
): boolean {
  return origin === new URL(request.url).origin
    || origin === forwardedOrigin(request, trustProxy)
    || trustedOrigins?.has(origin) === true
}

/** Rejects cross-site state-changing requests based on Origin / Sec-Fetch-Site headers. */
export function verifyOrigin(
  request: Request,
  trustedOrigins?: ReadonlySet<string>,
  trustProxy: TrustProxy = false,
): { ok: true } | { ok: false, reason: string } {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase()))
    return { ok: true }

  const origin = request.headers.get('origin')
  if (origin !== null) {
    if (isTrustedOrigin(origin, request, trustedOrigins, trustProxy))
      return { ok: true }
    return { ok: false, reason: `Cross-site request blocked: untrusted origin ${origin}` }
  }

  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none')
    return { ok: false, reason: `Cross-site request blocked: sec-fetch-site=${fetchSite}` }

  return { ok: true }
}

export function resolveCspPolicy(options: SecurityHeadersOptions | false | undefined): string | undefined {
  if (options === false)
    return undefined
  if (options?.csp === false)
    return undefined
  return options?.csp ?? DEFAULT_CSP
}

export function resolveHstsValue(options: SecurityHeadersOptions | false | undefined): string | undefined {
  if (options === false)
    return undefined
  if (options?.hsts === false)
    return undefined
  return typeof options?.hsts === 'string' ? options.hsts : DEFAULT_HSTS
}

export function buildSecurityHeaderEntries(options: SecurityHeadersOptions | false | undefined): readonly [string, string][] {
  if (options === false)
    return []
  const opts = options ?? {}
  const entries: [string, string][] = []
  if (opts.contentTypeOptions ?? true)
    entries.push(['x-content-type-options', 'nosniff'])
  if (opts.frameOptions !== false)
    entries.push(['x-frame-options', opts.frameOptions ?? 'SAMEORIGIN'])
  if (opts.referrerPolicy !== false)
    entries.push(['referrer-policy', opts.referrerPolicy ?? 'strict-origin-when-cross-origin'])
  if (opts.permissionsPolicy !== false)
    entries.push(['permissions-policy', opts.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY])
  if (opts.csp !== false)
    entries.push(['content-security-policy', opts.csp ?? DEFAULT_CSP])
  return entries
}
