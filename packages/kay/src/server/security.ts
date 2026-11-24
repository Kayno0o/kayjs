// Built-in security basics: CSRF/Origin verification on state-changing requests + safe default headers.

export interface SecurityHeadersOptions {
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false | undefined
  referrerPolicy?: string | false | undefined
  contentTypeOptions?: boolean | undefined
  csp?: string | undefined
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function requestOrigins(request: Request): { expectedOrigin: string, forwardedOrigin: string | undefined } {
  const expectedOrigin = new URL(request.url).origin
  const fwdProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const fwdHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host')?.trim()
  let forwardedOrigin: string | undefined
  if (fwdProto && fwdHost) {
    try {
      forwardedOrigin = new URL(`${fwdProto}://${fwdHost}`).origin
    }
    catch {
      forwardedOrigin = `${fwdProto}://${fwdHost}`
    }
  }
  return { expectedOrigin, forwardedOrigin }
}

/** Returns true when `origin` matches the request's direct/forwarded origin or `trustedOrigins`. */
export function isTrustedOrigin(
  origin: string,
  request: Request,
  trustedOrigins?: ReadonlySet<string>,
): boolean {
  const { expectedOrigin, forwardedOrigin } = requestOrigins(request)
  return origin === expectedOrigin
    || (forwardedOrigin !== undefined && origin === forwardedOrigin)
    || trustedOrigins?.has(origin) === true
}

/** Rejects cross-site state-changing requests based on Origin / Sec-Fetch-Site headers. */
export function verifyOrigin(request: Request, trustedOrigins?: ReadonlySet<string>): { ok: true } | { ok: false, reason: string } {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase()))
    return { ok: true }

  const { expectedOrigin, forwardedOrigin } = requestOrigins(request)
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
