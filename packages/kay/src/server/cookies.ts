// Typed cookie jar for RequestContext (lazy Cookie header parsing, validated & deduplicated Set-Cookie serialization).

export interface CookieOptions {
  path?: string | undefined
  domain?: string | undefined
  maxAge?: number | undefined
  expires?: Date | undefined
  httpOnly?: boolean | undefined
  secure?: boolean | undefined
  sameSite?: 'strict' | 'lax' | 'none' | undefined
}

export interface Cookies {
  get(name: string): string | undefined
  set(name: string, value: string, options?: CookieOptions): void
  delete(name: string, options?: Pick<CookieOptions, 'path' | 'domain' | 'secure'>): void
  all(): Record<string, string>
}

const VALID_COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const UNSAFE_ATTR_VAL = /[;\r\n\u0000-\u001F\u007F]/

function parseCookieHeader(header: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!header)
    return map
  const parts = header.split(';')
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const eq = part.indexOf('=')
    if (eq <= 0)
      continue
    const name = part.slice(0, eq).trim()
    // RFC 6265 §5.4: more specific path cookies come first, so first wins.
    if (name === '' || map.has(name))
      continue
    const raw = part.slice(eq + 1).trim()
    try {
      map.set(name, decodeURIComponent(raw))
    }
    catch {
      map.set(name, raw)
    }
  }
  return map
}

function serializeCookie(name: string, value: string, options: CookieOptions = {}, defaultSecure = false): string {
  if (!VALID_COOKIE_NAME.test(name))
    throw new TypeError(`kay: invalid cookie name "${name}"`)
  const path = options.path ?? '/'
  if (UNSAFE_ATTR_VAL.test(path))
    throw new TypeError(`kay: invalid cookie path "${path}"`)
  if (options.domain !== undefined && UNSAFE_ATTR_VAL.test(options.domain))
    throw new TypeError(`kay: invalid cookie domain "${options.domain}"`)

  const secure = options.secure ?? defaultSecure
  const sameSite = options.sameSite ?? 'lax'
  if (sameSite === 'none' && !secure)
    throw new Error(`kay: Cookie "${name}" with sameSite: "none" requires secure: true`)

  let out = `${name}=${encodeURIComponent(value)}`
  out += `; Path=${path}`
  if (options.domain !== undefined)
    out += `; Domain=${options.domain}`
  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge))
      throw new TypeError(`kay: invalid cookie maxAge "${options.maxAge}"`)
    out += `; Max-Age=${Math.floor(options.maxAge)}`
  }
  if (options.expires !== undefined)
    out += `; Expires=${options.expires.toUTCString()}`
  if (options.httpOnly ?? true)
    out += '; HttpOnly'
  if (secure)
    out += '; Secure'
  out += `; SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`
  return out
}

function cookieKey(name: string, options?: Pick<CookieOptions, 'path' | 'domain'>): string {
  return `${name}\0${options?.path ?? '/'}\0${options?.domain ?? ''}`
}

export class CookieStore implements Cookies {
  #rawHeader: string | null
  #values: Map<string, string> | undefined
  readonly #headers = new Map<string, string>()
  readonly #isHttps: boolean

  constructor(cookieHeader: string | null, isHttps = false) {
    this.#rawHeader = cookieHeader
    this.#isHttps = isHttps
  }

  #ensureValues(): Map<string, string> {
    if (this.#values === undefined) {
      this.#values = parseCookieHeader(this.#rawHeader)
      this.#rawHeader = null
    }
    return this.#values
  }

  get(name: string): string | undefined {
    return this.#ensureValues().get(name)
  }

  set(name: string, value: string, options?: CookieOptions): void {
    const serialized = serializeCookie(name, value, options, this.#isHttps)
    this.#ensureValues().set(name, value)
    this.#headers.set(cookieKey(name, options), serialized)
  }

  delete(name: string, options?: Pick<CookieOptions, 'path' | 'domain' | 'secure'>): void {
    this.#ensureValues().delete(name)
    this.#headers.set(cookieKey(name, options), serializeCookie(name, '', { ...options, maxAge: 0, expires: new Date(0) }, this.#isHttps))
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.#ensureValues())
  }

  get hasChanges(): boolean {
    return this.#headers.size > 0
  }

  applyTo(headers: Headers): void {
    for (const serialized of this.#headers.values())
      headers.append('set-cookie', serialized)
  }
}
