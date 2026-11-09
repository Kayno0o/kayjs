import type { Context } from 'elysia'
import { BUILD_HEADER } from '../runtime/swap'
import { requestIdHeader } from './protection'

// One set of a file route's headers, as it is and with the security headers, which such a route sends itself: set on the context instead, they make Elysia copy its response into a second one.
export interface HeaderCopies {
  plain: Record<string, string>
  secured: Record<string, string>
  security: [name: string, value: string][]
  // `secured` as a Headers, which Bun copies into a response far faster than an object of a dozen entries; never changed.
  securedHeaders: Headers
  // The security headers alone, as the request hook sets them on the context.
  hooked: Record<string, string>
}

export function headerCopies(headers: Record<string, string>, security: Record<string, string> | undefined): HeaderCopies {
  const secured = security ? { ...security, ...headers } : headers

  return { plain: headers, secured, security: Object.entries(security ?? {}), securedHeaders: new Headers(secured), hooked: security ?? {} }
}

// The security headers set on the context, under any the app set there first.
export function setSecurityHeaders(set: Context['set'], security: [name: string, value: string][]): void {
  for (const [name, value] of security)
    set.headers[name] ??= value
}

// The copy a file route answers with: the secured one when the context holds no header, since the response's own would win over the app's; else the plain one, the security headers going on the context as on every other route.
// The request id and build every context holds go on the response itself when it is alone there, so Elysia has no header to copy the response for.
export function ownHeaders(set: Context['set'], copies: HeaderCopies): Record<string, string> {
  const own = takeOwnHeaders(set)

  if (own !== undefined)
    return { ...copies.secured, ...own }

  if (Object.keys(set.headers).length === 0)
    return copies.secured

  setSecurityHeaders(set, copies.security)

  return copies.plain
}

// What `ownHeaders` gives, as the headers of a `new Response`: a prebuilt Headers copied in one step with the request id and build set on it, in place of an object of every header parsed per request.
export function ownHeadersInit(set: Context['set'], copies: HeaderCopies, hooked = false): Headers | Record<string, string> {
  const own = takeOwnHeaders(set, hooked ? copies.hooked : undefined)

  if (own !== undefined) {
    const headers = new Headers(copies.securedHeaders)

    for (const name in own)
      headers.set(name, own[name]!)

    return headers
  }

  if (Object.keys(set.headers).length === 0)
    return copies.securedHeaders

  setSecurityHeaders(set, copies.security)

  return copies.plain
}

// What `startingHeaders` took off a request's context, so another response made for the same request (a render run again for the viewer) starts from them too, and an answer to an error thrown after it gets them back.
const started = new WeakMap<Request, { own: Record<string, string>, hooked: Record<string, string> }>()

// The requests whose context got its headers back for an error answer: a render the page's timeout left running takes nothing off it again.
const restored = new WeakSet<Request>()

// The headers a response made by kay itself starts with when the context holds nothing but what the request hooks put there: the security headers, the request id and the build, taken off it so Elysia has nothing to copy the response for. Undefined when the app or an extension set a header on the context too, for the caller to build its headers as before.
export function startingHeaders(set: Context['set'], copies: HeaderCopies, request: Request): Headers | undefined {
  if (restored.has(request))
    return undefined

  const own = started.get(request)?.own ?? takeOwnHeaders(set, copies.hooked)

  if (own === undefined)
    return undefined

  started.set(request, { own, hooked: copies.hooked })

  const headers = new Headers(copies.securedHeaders)

  for (const name in own)
    headers.set(name, own[name]!)

  return headers
}

// The names a response was given from the context, by response: a response answered twice, as a constant is, has them taken off before it gets the second request's.
const carried = new WeakMap<Response, string[]>()

// The names a response was given from the context by an earlier request.
export function carriedNames(response: Response): readonly string[] {
  return carried.get(response) ?? []
}

// What the context holds goes onto the response itself, so Elysia has no header to copy the response for; a response of the route's own wins over the context, as it does in Elysia's merge.
// Left to Elysia's copy: a cookie (the jar's, or a header of the context's), a status the response would not keep, a response that streams, and headers that cannot be written (`Response.redirect`).
// A static response is cloned by Elysia after this runs, so it carries the headers of the request that is answered, not the one before.
export function carryContext<T extends Response>(set: Context['set'], response: T): T {
  const { status } = set
  const { headers } = response
  const names: string[] = []

  try {
    for (const name of carried.get(response) ?? [])
      headers.delete(name)

    carried.delete(response)

    if (set.cookie || set.headers['set-cookie'] !== undefined || (status !== undefined && status !== 200 && (typeof status !== 'number' || response.status === 200)) || headers.get('transfer-encoding') === 'chunked')
      return response

    for (const name in set.headers) {
      if (!headers.has(name)) {
        headers.set(name, set.headers[name] as string)
        names.push(name)
      }
    }
  }
  catch {
    // Immutable headers, nothing written: the context's go on through Elysia's copy.
    return response
  }

  carried.set(response, names)
  set.headers = {}

  if (status !== 200)
    set.status = 200

  return response
}

// What a shared cache stores: `public`, or an `s-maxage` it takes as permission.
const SHARED_CACHE = /\bpublic\b|\bs-maxage\b/i

function headerKey(headers: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(headers).find(key => key.toLowerCase() === name)
}

// A cookie is for the visitor it goes to, so no shared cache may keep the response it rides on, whatever the route or the page said: a `public` or `s-maxage` cache-control on a response, or on the context's headers, that carries a `set-cookie` becomes `private, no-cache`.
// Called as the last step by the app for every route, and by a plugin that adds a cookie itself, so a response its own app does not wrap is covered too.
export function keepCookiesPrivate(set: { headers: Record<string, unknown> }, response?: unknown): void {
  const given = response instanceof Response ? response : undefined
  const setCookie = headerKey(set.headers, 'set-cookie')

  if (given?.headers.has('set-cookie') !== true && setCookie === undefined)
    return

  const control = headerKey(set.headers, 'cache-control')

  if (control !== undefined && SHARED_CACHE.test(String(set.headers[control])))
    set.headers[control] = 'private, no-cache'

  try {
    if (given !== undefined && SHARED_CACHE.test(given.headers.get('cache-control') ?? ''))
      given.headers.set('cache-control', 'private, no-cache')
  }
  catch {
    // Immutable headers: the response is one `fetch()` returned, which a route does not hand a cookie to.
  }
}

// The same for headers built per request: the security headers go under what the response sets, and the request id on the response when it is alone on the context.
export function ownedHeaders(set: Context['set'], headers: Record<string, string>, security: [name: string, value: string][]): Record<string, string> {
  const own = takeOwnHeaders(set)

  if (own === undefined && Object.keys(set.headers).length > 0) {
    setSecurityHeaders(set, security)

    return headers
  }

  Object.assign(headers, own)

  for (const [name, value] of security)
    headers[name] ??= value

  return headers
}

// The request id and the build every context holds, when they are all that is there, taken off it for the response to carry.
// With `hooked`, the security headers the request hook set on the context count as kay's too, when they hold the value it gave them, and are taken off with the rest.
function takeOwnHeaders(set: Context['set'], hooked?: Record<string, string>): Record<string, string> | undefined {
  const own: Record<string, string> = {}
  const taken: string[] = []

  for (const name in set.headers) {
    taken.push(name)

    if (name === requestIdHeader() || name === BUILD_HEADER)
      own[name] = String(set.headers[name])
    else if (hooked?.[name] === undefined || set.headers[name] !== hooked[name])
      return undefined
  }

  if (taken.length === 0 || (Object.keys(own).length === 0 && hooked === undefined))
    return undefined

  for (const name of taken)
    delete set.headers[name]

  return own
}

// Puts back on the context what `startingHeaders` took off it for a request, for an answer made after it by Elysia or an error hook, the app's own included, to carry them.
export function restoreStartedHeaders(request: Request, set: Context['set'] | undefined): void {
  const taken = started.get(request)

  if (taken === undefined || set === undefined)
    return

  restored.add(request)

  for (const name in taken.hooked)
    set.headers[name] ??= taken.hooked[name]!

  for (const name in taken.own)
    set.headers[name] ??= taken.own[name]!
}
