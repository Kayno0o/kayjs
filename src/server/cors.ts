import type { Duration } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { wholeSeconds } from '../runtime/duration'

interface CorsCommon {
  // Response headers a page may read beyond the ones browsers always show it, such as `x-total-count`.
  expose?: readonly string[] | undefined
  // Request headers a page may send, any it asks for by default.
  headers?: readonly string[] | undefined
  // How long a browser keeps a preflight's answer, an hour by default.
  maxAge?: Duration | undefined
}

// Which other sites' pages may call a module's routes from the browser: the origins listed, `https://*.example.com` for any subdomain, or `'*'` for any; cookies come only from listed ones.
export type CorsOptions = CorsCommon & ({ origins: '*', credentials?: false | undefined } | { origins: readonly string[], credentials?: boolean | undefined })

export interface CorsRule {
  any: boolean
  exact: Set<string>
  subdomains: RegExp[]
  credentials: boolean
  expose: readonly string[]
  headers: readonly string[] | undefined
  maxAge: number
}

const WILDCARD = /^(https?):\/\/\*\.(.+)$/
const SPECIAL = /[.*+?^${}()|[\]\\]/g
// What a route answering every method, `.all()`, takes.
const ANY_METHOD = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']

export function corsRule(options: CorsOptions): CorsRule {
  if (options.origins === '*' && options.credentials)
    throw new KayError('config-invalid', 'kay: cors sends cookies to the origins it lists only, so `credentials: true` takes `origins: [\'https://...\']`, never \'*\'')

  const exact = new Set<string>()
  const subdomains: RegExp[] = []

  for (const origin of options.origins === '*' ? [] : options.origins) {
    const wildcard = WILDCARD.exec(origin.toLowerCase())
    const concrete = wildcard ? `${wildcard[1]}://x.${wildcard[2]}` : origin.toLowerCase()

    if (!isOrigin(concrete))
      throw new KayError('config-invalid', `kay: cors lists ${JSON.stringify(origin)}, which is no origin: a scheme and a host, with a port if any and no path, as https://app.example.com, or https://*.example.com for its subdomains`)

    if (wildcard)
      subdomains.push(new RegExp(`^${wildcard[1]}://[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${wildcard[2]!.replace(SPECIAL, '\\$&')}$`))
    else
      exact.add(concrete)
  }

  return { any: options.origins === '*', exact, subdomains, credentials: options.credentials === true, expose: options.expose ?? [], headers: options.headers, maxAge: wholeSeconds(options.maxAge ?? '1h', 'cors maxAge') }
}

// A scheme and a host, with a port if any: `https://app.example.com`, or `capacitor://localhost` for an app's web view.
function isOrigin(text: string): boolean {
  if (!URL.canParse(text))
    return false

  const url = new URL(text)

  return url.host !== '' && `${url.protocol}//${url.host}` === text
}

function allows(rule: CorsRule, origin: string | null): origin is string {
  return origin !== null && (rule.any || rule.exact.has(origin) || rule.subdomains.some(pattern => pattern.test(origin)))
}

// Whether another site's request may go through: from an origin the rule lists, carrying cookies only when the rule takes them.
export function corsAdmits(rule: CorsRule, request: Request): boolean {
  return allows(rule, request.headers.get('origin')) && (rule.credentials || !request.headers.has('cookie'))
}

// Origin added to a Vary header, whatever else it names.
function varyOrigin(vary: string | null | undefined): string {
  if (vary === null || vary === undefined || vary === '')
    return 'Origin'

  return vary.split(',').some(name => ['origin', '*'].includes(name.trim().toLowerCase())) ? vary : `${vary}, Origin`
}

// What the module's rule alone decides: a route's own value for any of these is replaced by the rule's, or dropped when the rule grants the caller nothing.
const GRANT = new Set(['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-expose-headers'])

// Puts the headers a response of the module carries on the headers a route set, or on a response it built: an answer naming the caller's origin differs by it, so caches keep one per origin.
export function withCors(rule: CorsRule, request: Request, headers: Record<string, unknown> | Headers): void {
  const set = (name: string, value: string) => headers instanceof Headers ? headers.set(name, value) : headers[name] = value

  dropGrant(headers)

  for (const [name, value] of Object.entries(corsHeaders(rule, request)))
    set(name, value)

  if (!rule.any)
    set('vary', varyOrigin(headers instanceof Headers ? headers.get('vary') : headers.vary as string | undefined))
}

// The grant headers a route set itself, whatever their case, off the headers.
function dropGrant(headers: Record<string, unknown> | Headers): void {
  if (headers instanceof Headers) {
    for (const name of GRANT)
      headers.delete(name)

    return
  }

  for (const name of Object.keys(headers)) {
    if (GRANT.has(name.toLowerCase()))
      delete headers[name]
  }
}

// The responses kay made with the module's grant on them, a preflight or a refusal, which are no route's own and keep it.
export const grantedByKay = new WeakSet<Response>()

// The grant headers a response of the route's own carries, off its headers: false when they are immutable.
export function dropOwnGrant(headers: Headers): boolean {
  try {
    dropGrant(headers)

    return true
  }
  catch {
    return false
  }
}

// A response of the route's own without the grant headers it carries itself, the module's rule alone granting: the same response, or a mutable copy when its headers are immutable, a `fetch()` result's in some runtimes, which takes the context's Vary since the copy is Elysia's to merge no more.
export function withoutOwnGrant(response: Response, contextVary: unknown): Response {
  try {
    dropGrant(response.headers)

    return response
  }
  catch {
    const headers = new Headers(response.headers)

    dropGrant(headers)

    if (typeof contextVary === 'string')
      headers.set('vary', contextVary)

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}

// Origin kept in the Vary of a response the route made: the grant itself rides on the context, which carries it onto this response for the one request, so a response answered twice never keeps another caller's.
// Immutable headers, such as a `fetch()` result's, take it through the context's Vary instead.
export function varyByOrigin(rule: CorsRule, headers: Headers, context: Record<string, unknown>): void {
  if (rule.any)
    return

  const vary = varyOrigin(headers.get('vary'))

  try {
    headers.set('vary', vary)
  }
  catch {
    context.vary = vary
  }
}

// A response built before the route ran, such as a body over the limit, with the headers the module's answers carry.
export function corsResponse(rule: CorsRule, request: Request, response: Response): Response {
  withCors(rule, request, response.headers)
  grantedByKay.add(response)

  return response
}

function corsHeaders(rule: CorsRule, request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  const headers: Record<string, string> = {}

  if (!allows(rule, origin))
    return headers

  headers['access-control-allow-origin'] = rule.any ? '*' : origin

  if (rule.credentials)
    headers['access-control-allow-credentials'] = 'true'

  if (rule.expose.length > 0)
    headers['access-control-expose-headers'] = rule.expose.join(', ')

  return headers
}

// The answer to a browser asking whether another site's page may send a request: the module's methods and the headers allowed, kept for `maxAge`; an origin the rule does not list gets no grant.
export function preflight(rule: CorsRule, methods: readonly string[], request: Request): Response {
  const headers = new Headers()

  withCors(rule, request, headers)

  if (allows(rule, request.headers.get('origin'))) {
    const asked = request.headers.get('access-control-request-headers')

    headers.set('access-control-allow-methods', [...new Set(methods.flatMap(method => method === 'ALL' ? ANY_METHOD : [method]))].join(', '))
    headers.set('access-control-max-age', String(rule.maxAge))

    if (rule.headers) {
      headers.set('access-control-allow-headers', rule.headers.join(', '))
    }
    else {
      headers.append('vary', 'Access-Control-Request-Headers')

      if (asked !== null)
        headers.set('access-control-allow-headers', asked)
    }
  }

  const answer = new Response(null, { status: 204, headers })

  grantedByKay.add(answer)

  return answer
}
