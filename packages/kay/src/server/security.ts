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
  addHashes('script-src', scriptHashes)

  return order.map((name) => {
    const tokens = directives.get(name)!
    return tokens.length > 0 ? `${name} ${tokens.join(' ')}` : name
  }).join('; ')
}

export const DEFAULT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
export const DEFAULT_HSTS = 'max-age=31536000; includeSubDomains'

export interface SecurityHeadersOptions {
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false | undefined
  referrerPolicy?: string | false | undefined
  contentTypeOptions?: boolean | undefined
  csp?: string | false | undefined
  hsts?: string | boolean | undefined
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function requestOrigins(request: Request, trustProxy = false): { expectedOrigin: string, forwardedOrigin: string | undefined } {
  const expectedOrigin = new URL(request.url).origin
  let forwardedOrigin: string | undefined
  if (trustProxy) {
    const fwdProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    const fwdHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host')?.trim()
    if (fwdProto && fwdHost) {
      try {
        forwardedOrigin = new URL(`${fwdProto}://${fwdHost}`).origin
      }
      catch {
        forwardedOrigin = `${fwdProto}://${fwdHost}`
      }
    }
  }
  return { expectedOrigin, forwardedOrigin }
}

/** Returns true when the request arrived over HTTPS (directly, or via X-Forwarded-Proto when `trustProxy` is true). */
export function isHttpsRequest(request: Request, trustProxy = false): boolean {
  try {
    if (new URL(request.url).protocol === 'https:')
      return true
  }
  catch {}
  if (trustProxy) {
    const fwdProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    if (fwdProto === 'https')
      return true
  }
  return false
}

/** Extracts the client IP from proxy headers (only when `trustProxy` is true) or falls back to the direct socket IP. */
export function getClientIp(request: Request, trustProxy = false, remoteIp?: string): string | undefined {
  if (trustProxy) {
    const xff = request.headers.get('x-forwarded-for')
    if (xff) {
      const first = xff.split(',')[0]?.trim()
      if (first)
        return first
    }
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
  trustProxy = false,
): boolean {
  const { expectedOrigin, forwardedOrigin } = requestOrigins(request, trustProxy)
  return origin === expectedOrigin
    || (forwardedOrigin !== undefined && origin === forwardedOrigin)
    || trustedOrigins?.has(origin) === true
}

/** Rejects cross-site state-changing requests based on Origin / Sec-Fetch-Site headers. */
export function verifyOrigin(
  request: Request,
  trustedOrigins?: ReadonlySet<string>,
  trustProxy = false,
): { ok: true } | { ok: false, reason: string } {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase()))
    return { ok: true }

  const { expectedOrigin, forwardedOrigin } = requestOrigins(request, trustProxy)
  const origin = request.headers.get('origin')

  if (origin !== null) {
    if (origin === expectedOrigin || (forwardedOrigin !== undefined && origin === forwardedOrigin) || trustedOrigins?.has(origin))
      return { ok: true }
    return { ok: false, reason: `Cross-site request blocked: origin ${origin} does not match ${forwardedOrigin ?? expectedOrigin}` }
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
  if (opts.csp !== false)
    entries.push(['content-security-policy', opts.csp ?? DEFAULT_CSP])
  return entries
}

export function applySecurityHeaders(headers: Headers, options: SecurityHeadersOptions = {}): void {
  if ((options.contentTypeOptions ?? true) && !headers.has('x-content-type-options'))
    headers.set('x-content-type-options', 'nosniff')

  if (options.frameOptions !== false && !headers.has('x-frame-options'))
    headers.set('x-frame-options', options.frameOptions ?? 'SAMEORIGIN')

  if (options.referrerPolicy !== false && !headers.has('referrer-policy'))
    headers.set('referrer-policy', options.referrerPolicy ?? 'strict-origin-when-cross-origin')

  if (options.csp !== false && !headers.has('content-security-policy'))
    headers.set('content-security-policy', options.csp ?? DEFAULT_CSP)
}
