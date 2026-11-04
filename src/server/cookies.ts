import type { CookieInit, CookieMap, CookieStoreDeleteOptions } from 'bun'
import type { AnyElysia } from 'elysia'
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

interface CookieApp {
  onRequest: (hook: (context: { request: Request }) => void) => unknown
  mapResponse: (options: { as: 'scoped' }, hook: (context: { request: Request, set: { cookie?: Record<string, { secure?: boolean, sameSite?: unknown }> | undefined } }) => undefined) => unknown
  config: { cookie?: object | undefined }
}

// Records the app's cookie defaults on each request it gets, for the cookie jar to apply.
// The cookies of an `api()` route are Elysia's own, which reads `httpOnly`, `sameSite` and `path` from the app's config, and gets `Secure` from the request here, a cookie's own option winning in both.
export function defaultCookies(app: AnyElysia, defaults: ResolvedCookieDefaults | undefined): void {
  if (defaults === undefined)
    return

  const { onRequest, mapResponse, config } = app as unknown as CookieApp

  onRequest.call(app, ({ request }) => {
    requestRecord(request).cookieDefaults = defaults
  })
  config.cookie = { ...config.cookie, httpOnly: defaults.httpOnly, sameSite: defaults.sameSite, path: defaults.path }
  mapResponse.call(app, { as: 'scoped' }, ({ request, set }) => {
    for (const cookie of Object.values(set.cookie ?? {})) {
      if (cookie.secure === undefined)
        cookie.secure = cookie.sameSite === 'none' || (defaults.secure === 'auto' ? overHttps(request) : defaults.secure)
    }

    return undefined
  })
}

// What `ctx.cookies.delete` takes: the cookie's name and the `domain` and `path` it was set with, and the `secure`, `sameSite` and `partitioned` it was set with when they differ from the defaults.
export type CookieDeleteOptions = CookieStoreDeleteOptions & Pick<CookieInit, 'secure' | 'sameSite' | 'partitioned'>

const defined = (given: object): [string, unknown][] => Object.entries(given).filter(([, value]) => value !== undefined)

// The cookies of a request, a cookie set without an option taking the app's default for it, `secure: 'auto'` following the scheme the request came over, as kay's own cookies do.
// A `Bun.Cookie` is the app's own whole cookie and goes as it is.
// With no defaults, a set is Bun's own, and a delete is too unless it names an attribute of its own.
class DefaultedCookies extends Bun.CookieMap {
  readonly #defaults: ResolvedCookieDefaults | undefined
  readonly #request: Request

  constructor(header: string, defaults: ResolvedCookieDefaults | undefined, request: Request) {
    super(header)
    this.#defaults = defaults
    this.#request = request
  }

  #given(options: CookieInit | undefined): CookieInit {
    if (this.#defaults === undefined)
      return Object.fromEntries(defined(options ?? {}))

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

  override delete(name: string, options?: Omit<CookieDeleteOptions, 'name'>): void
  override delete(options: CookieDeleteOptions): void
  // Written as an expired cookie with the attributes a set would carry, as a `__Host-` or `__Secure-` cookie, or a `Secure` one, is only cleared by a header that is `Secure` too; the options of the set that wrote it, as `secure: false`, say how it was.
  override delete(first: string | CookieDeleteOptions, options?: Omit<CookieDeleteOptions, 'name'>): void {
    const { name, domain, path, ...attributes } = typeof first === 'string' ? { ...options, name: first } : first

    if (this.#defaults === undefined && Object.keys(defined(attributes)).length === 0) {
      super.delete({ name, ...domain == null ? {} : { domain }, ...path === undefined ? {} : { path } })

      return
    }

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

      return map = new DefaultedCookies(request.headers.get('cookie') ?? '', requestRecord(request).cookieDefaults, request)
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
