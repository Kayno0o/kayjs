import type { CookieInit, CookieMap, CookieStoreDeleteOptions } from 'bun'
import type { CookieDefaults } from '../config'
import { KayError } from '../compiler/errors'
import { requestRecord } from './request-record'
import { overHttps } from './request-url'

const SAME_SITE = new Set(['lax', 'strict', 'none'])

// The `security.cookies` setting with its gaps filled, and the mount point as the default path.
export interface ResolvedCookieDefaults {
  httpOnly: boolean
  sameSite: 'lax' | 'strict' | 'none'
  secure: boolean | 'auto'
  path: string
}

// What `security.cookies` gives every cookie an app sets with `ctx.cookies.set`, or undefined for an app that sets none.
export function cookieDefaults(setting: CookieDefaults | false | undefined, base: string): ResolvedCookieDefaults | undefined {
  if (setting === undefined || setting === false)
    return undefined

  const { httpOnly = true, sameSite = 'lax', secure = 'auto', path = base || '/' } = setting

  if (!SAME_SITE.has(sameSite))
    throw new KayError('config-invalid', `kay: security.cookies.sameSite is 'lax', 'strict' or 'none'; got ${JSON.stringify(sameSite)}`)

  if (typeof secure !== 'boolean' && secure !== 'auto')
    throw new KayError('config-invalid', `kay: security.cookies.secure is true, false or 'auto'; got ${JSON.stringify(secure)}`)

  if (!path.startsWith('/'))
    throw new KayError('config-invalid', `kay: security.cookies.path starts with a slash; got ${JSON.stringify(path)}`)

  return { httpOnly, sameSite, secure, path }
}

// Records the app's cookie defaults on each request it gets, for the cookie jar to apply.
export function defaultCookies(app: { onRequest: (hook: (context: { request: Request }) => void) => unknown }, defaults: ResolvedCookieDefaults | undefined): void {
  if (defaults === undefined)
    return

  app.onRequest(({ request }) => {
    requestRecord(request).cookieDefaults = defaults
  })
}

// What `ctx.cookies.delete` takes: the cookie's name and the `domain` and `path` it was set with, and the `secure`, `sameSite` and `partitioned` it was set with when they differ from the defaults.
export type CookieDeleteOptions = CookieStoreDeleteOptions & Pick<CookieInit, 'secure' | 'sameSite' | 'partitioned'>

const defined = (given: object): [string, unknown][] => Object.entries(given).filter(([, value]) => value !== undefined)

// The cookies of a request, a cookie set without an option taking the app's default for it, `secure: 'auto'` following the scheme the request came over, as kay's own cookies do.
// A `Bun.Cookie` is the app's own whole cookie and goes as it is.
class DefaultedCookies extends Bun.CookieMap {
  readonly #defaults: ResolvedCookieDefaults
  readonly #request: Request

  constructor(header: string, defaults: ResolvedCookieDefaults, request: Request) {
    super(header)
    this.#defaults = defaults
    this.#request = request
  }

  #given(options: CookieInit | undefined): CookieInit {
    const { secure, ...rest } = this.#defaults
    const merged: CookieInit = { ...rest, ...Object.fromEntries(defined(options ?? {})) }

    merged.secure ??= secure === 'auto' ? overHttps(this.#request) : secure

    // Browsers refuse a `SameSite=None` cookie that is not `Secure`, unless the app said so.
    if (options?.secure === undefined && merged.sameSite === 'none')
      merged.secure = true

    return merged
  }

  override set(name: string, value: string, options?: CookieInit): void
  override set(options: CookieInit): void
  override set(cookie: Bun.Cookie): void
  override set(first: string | CookieInit | Bun.Cookie, value?: string, options?: CookieInit): void {
    if (typeof first === 'string')
      super.set(first, value!, this.#given(options))
    else if (first instanceof Bun.Cookie)
      super.set(first)
    else
      super.set(this.#given(first) as CookieInit & { name: string, value: string })
  }

  override delete(name: string): void
  override delete(options: CookieDeleteOptions): void
  // Written as an expired cookie with the attributes a set would carry, as a `__Host-` or `__Secure-` cookie, or a `Secure` one, is only cleared by a header that is `Secure` too; the options of the set that wrote it, as `secure: false`, say how it was.
  override delete(first: string | CookieDeleteOptions): void {
    const { name, domain, path, ...attributes } = typeof first === 'string' ? { name: first, domain: undefined, path: undefined } : first

    super.set(this.#given({ ...Object.fromEntries(defined(attributes)), name, value: '', expires: new Date(0), ...domain == null ? {} : { domain }, ...path === undefined ? {} : { path } }) as CookieInit & { name: string, value: string })
  }
}

export interface CookieJar {
  readonly cookies: CookieMap
  // Appends a Set-Cookie header per cookie changed through `cookies`.
  writeTo: (headers: Headers) => void
}

// Parses the request's cookies only when a page or action first reads them.
export function cookieJar(request: Request): CookieJar {
  let map: CookieMap | undefined

  return {
    get cookies() {
      if (map)
        return map

      const defaults = requestRecord(request).cookieDefaults

      return map = defaults === undefined ? new Bun.CookieMap(request.headers.get('cookie') ?? '') : new DefaultedCookies(request.headers.get('cookie') ?? '', defaults, request)
    },
    writeTo(headers) {
      for (const cookie of map?.toSetCookieHeaders() ?? [])
        headers.append('set-cookie', cookie)
    },
  }
}

// The cookies the request came with, parsed once however many of kay's sessions, locales and scopes read them; shared, so only read, never set.
export function requestCookies(request: Request): Pick<CookieMap, 'get' | 'has'> {
  const record = requestRecord(request)

  return record.cookies ??= new Bun.CookieMap(request.headers.get('cookie') ?? '')
}
