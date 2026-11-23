// Typed cookie jar for RequestContext (parses Cookie header, serializes Set-Cookie headers).

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
  delete(name: string, options?: Pick<CookieOptions, 'path' | 'domain'>): void
  all(): Record<string, string>
}

export function parseCookieHeader(header: string | null): Map<string, string> {
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

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  let out = `${name}=${encodeURIComponent(value)}`
  out += `; Path=${options.path ?? '/'}`
  if (options.domain !== undefined)
    out += `; Domain=${options.domain}`
  if (options.maxAge !== undefined)
    out += `; Max-Age=${Math.floor(options.maxAge)}`
  if (options.expires !== undefined)
    out += `; Expires=${options.expires.toUTCString()}`
  if (options.httpOnly ?? true)
    out += '; HttpOnly'
  if (options.secure)
    out += '; Secure'
  const sameSite = options.sameSite ?? 'lax'
  out += `; SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`
  return out
}

export class CookieStore implements Cookies {
  readonly #values: Map<string, string>
  readonly #headers: string[] = []

  constructor(cookieHeader: string | null) {
    this.#values = parseCookieHeader(cookieHeader)
  }

  get(name: string): string | undefined {
    return this.#values.get(name)
  }

  set(name: string, value: string, options?: CookieOptions): void {
    this.#values.set(name, value)
    this.#headers.push(serializeCookie(name, value, options))
  }

  delete(name: string, options?: Pick<CookieOptions, 'path' | 'domain'>): void {
    this.#values.delete(name)
    this.#headers.push(serializeCookie(name, '', { ...options, maxAge: 0, expires: new Date(0) }))
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.#values)
  }

  applyTo(headers: Headers): void {
    for (let i = 0; i < this.#headers.length; i++)
      headers.append('set-cookie', this.#headers[i]!)
  }
}
