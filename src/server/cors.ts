import type { Duration } from '../runtime/duration'
import { durationSeconds } from '../runtime/duration'

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

export function corsRule(options: CorsOptions): CorsRule {
  if (options.origins === '*' && options.credentials)
    throw new Error('kay: cors sends cookies to the origins it lists only, so `credentials: true` takes `origins: [\'https://...\']`, never \'*\'')

  const exact = new Set<string>()
  const subdomains: RegExp[] = []

  for (const origin of options.origins === '*' ? [] : options.origins) {
    const wildcard = WILDCARD.exec(origin.toLowerCase())
    const concrete = wildcard ? `${wildcard[1]}://x.${wildcard[2]}` : origin.toLowerCase()

    if (!URL.canParse(concrete) || new URL(concrete).origin !== concrete)
      throw new Error(`kay: cors lists ${JSON.stringify(origin)}, which is no origin: a scheme and a host, with a port if any and no path, as https://app.example.com, or https://*.example.com for its subdomains`)

    if (wildcard)
      subdomains.push(new RegExp(`^${wildcard[1]}://[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${wildcard[2]!.replace(SPECIAL, '\\$&')}$`))
    else
      exact.add(concrete)
  }

  return { any: options.origins === '*', exact, subdomains, credentials: options.credentials === true, expose: options.expose ?? [], headers: options.headers, maxAge: durationSeconds(options.maxAge ?? '1h', 'cors maxAge') }
}

function allows(rule: CorsRule, origin: string | null): origin is string {
  return origin !== null && (rule.any || rule.exact.has(origin) || rule.subdomains.some(pattern => pattern.test(origin)))
}

// Whether another site's request may go through: from an origin the rule lists, carrying cookies only when the rule takes them.
export function corsAdmits(rule: CorsRule, request: Request): boolean {
  return allows(rule, request.headers.get('origin')) && (rule.credentials || !request.headers.has('cookie'))
}

// The headers a response of the module carries: an answer naming the caller's origin differs by it, so caches keep one per origin.
export function corsHeaders(rule: CorsRule, request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  const headers: Record<string, string> = rule.any ? {} : { vary: 'Origin' }

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
  const headers = new Headers(corsHeaders(rule, request))

  if (allows(rule, request.headers.get('origin'))) {
    const asked = request.headers.get('access-control-request-headers')

    headers.set('access-control-allow-methods', methods.join(', '))
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

  return new Response(null, { status: 204, headers })
}
