// Built-in security basics: CSRF/Origin verification on state-changing requests + safe default headers.

export interface SecurityHeadersOptions {
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false | undefined
  referrerPolicy?: string | false | undefined
  contentTypeOptions?: boolean | undefined
  csp?: string | undefined
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Rejects cross-site state-changing requests based on Origin / Sec-Fetch-Site headers. */
export function verifyOrigin(request: Request, trustedOrigins?: ReadonlySet<string>): { ok: true } | { ok: false, reason: string } {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase()))
    return { ok: true }

  const url = new URL(request.url)
  const expectedOrigin = url.origin
  const origin = request.headers.get('origin')

  if (origin !== null) {
    if (origin === expectedOrigin || trustedOrigins?.has(origin))
      return { ok: true }
    return { ok: false, reason: `Cross-site request blocked: origin ${origin} does not match ${expectedOrigin}` }
  }

  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none')
    return { ok: false, reason: `Cross-site request blocked: sec-fetch-site=${fetchSite}` }

  return { ok: true }
}

export function applySecurityHeaders(headers: Headers, options: SecurityHeadersOptions = {}): void {
  if ((options.contentTypeOptions ?? true) && !headers.has('x-content-type-options'))
    headers.set('x-content-type-options', 'nosniff')

  if (options.frameOptions !== false && !headers.has('x-frame-options'))
    headers.set('x-frame-options', options.frameOptions ?? 'SAMEORIGIN')

  if (options.referrerPolicy !== false && !headers.has('referrer-policy'))
    headers.set('referrer-policy', options.referrerPolicy ?? 'strict-origin-when-cross-origin')

  if (options.csp !== undefined && !headers.has('content-security-policy'))
    headers.set('content-security-policy', options.csp)
}
