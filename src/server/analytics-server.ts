import type { AnyElysia } from 'elysia'
import type { AnalyticsOptions } from './analytics'
import { isIP } from 'node:net'
import process from 'node:process'
import { Elysia } from 'elysia'
import { kayLog } from '../runtime/log'
import { isCrossSite } from './actions'
import { ANALYTICS_PATH, ANALYTICS_SCRIPT_PATH } from './analytics'
import { ANALYTICS_SCRIPT } from './analytics-script'
import { readCapped } from './errors'
import { clientAddress, overLimit } from './protection'

// A visit is a URL, a title and a few short words: past this it is no visit.
const MAX_BODY_BYTES = 4096
const MAX_URL_LENGTH = 2048
const MAX_TITLE_LENGTH = 300
const MAX_USER_AGENT_LENGTH = 512
const VISITS_PER_MINUTE = 120
const MINUTE_MS = 60_000
const PROVIDER_TIMEOUT_MS = 5000
const RATE_NAME = 'kay:analytics'
const CONSENT_COOKIE = 'kay_analytics=yes'
// What a visit may carry from its query string: the campaign a link names, and nothing a page holds for one visitor, such as a token or an address.
const KEPT_PARAMETERS = /^(?:utm_[a-z]+|ref|source)$/
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu
const SCREEN = /^\d{1,5}x\d{1,5}$/
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z\d]{2,8}){0,3}$/i
const TRAILING_SLASH = /\/$/
// Logged once a minute at most, so a provider that is down does not fill the log with a line per visit.
let lastWarning = 0

// What a visit says of the page and the browser, checked: nothing of it reaches a provider unchecked.
interface Visit {
  page: URL
  referrer: string
  title: string
  screen: string | undefined
  language: string | undefined
  userAgent: string
  // The visitor's address, only when the provider needs it to tell visitors apart and place them.
  address: string | undefined
}

interface Forward {
  url: string
  headers: Record<string, string>
  body: unknown
}

// How each provider takes a visit. Plausible: https://plausible.io/docs/events-api (User-Agent and X-Forwarded-For tell visitors apart).
// Umami: POST /api/send with `{ type: 'event', payload }` and a User-Agent, https://umami.is/docs/api/sending-stats; its payload may carry the visitor's `ip`.
// Simple Analytics: https://docs.simpleanalytics.com/events-api, a JSON body with the user agent and no address.
const PROVIDERS = {
  plausible: (options: Extract<AnalyticsOptions, { provider: 'plausible' }>, visit: Visit): Forward => ({
    url: `${(options.host ?? 'https://plausible.io').replace(TRAILING_SLASH, '')}/api/event`,
    headers: { 'user-agent': visit.userAgent, 'content-type': 'application/json', ...visit.address !== undefined && { 'x-forwarded-for': visit.address } },
    body: { name: 'pageview', url: visit.page.href, domain: options.domain ?? visit.page.hostname, referrer: visit.referrer },
  }),
  umami: (options: Extract<AnalyticsOptions, { provider: 'umami' }>, visit: Visit): Forward => ({
    url: `${(options.host ?? 'https://cloud.umami.is').replace(TRAILING_SLASH, '')}/api/send`,
    headers: { 'user-agent': visit.userAgent, 'content-type': 'application/json' },
    body: { type: 'event', payload: {
      website: options.websiteId,
      hostname: visit.page.hostname,
      url: visit.page.pathname + visit.page.search,
      title: visit.title,
      referrer: visit.referrer,
      ...visit.screen !== undefined && { screen: visit.screen },
      ...visit.language !== undefined && { language: visit.language },
      ...visit.address !== undefined && { ip: visit.address },
    } },
  }),
  simpleanalytics: (options: Extract<AnalyticsOptions, { provider: 'simpleanalytics' }>, visit: Visit): Forward => {
    const [width, height] = visit.screen?.split('x').map(Number) ?? []

    return {
      url: `${(options.host ?? 'https://queue.simpleanalyticscdn.com').replace(TRAILING_SLASH, '')}/events`,
      headers: { 'content-type': 'application/json' },
      body: {
        type: 'pageview',
        hostname: options.hostname ?? visit.page.hostname,
        event: 'pageview',
        path: visit.page.pathname + visit.page.search,
        ua: visit.userAgent,
        https: visit.page.protocol === 'https:',
        referrer: visit.referrer,
        ...width !== undefined && { screen_width: width, screen_height: height },
        ...visit.language !== undefined && { language: visit.language },
      },
    }
  },
}

// The providers that need the visitor's address to tell visitors apart; no other is sent it.
const NEEDS_ADDRESS: ReadonlySet<string> = new Set<keyof typeof PROVIDERS>(['plausible', 'umami'])

export function analyticsServer(options: AnalyticsOptions): AnyElysia {
  const hosts = new Set((options.hosts ?? []).map(host => host.toLowerCase()))
  const gated = options.consent !== undefined && options.consent !== false

  return new Elysia({ name: 'kay-analytics' })
    .get(ANALYTICS_SCRIPT_PATH, () => new Response(ANALYTICS_SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } }))
    .post(ANALYTICS_PATH, async ({ request, server }) => {
      if (isCrossSite(request))
        return new Response(null, { status: 403 })

      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES)
        return new Response(null, { status: 413 })

      if (overLimit(RATE_NAME, clientAddress(request, server), VISITS_PER_MINUTE, MINUTE_MS) !== undefined)
        return new Response(null, { status: 429 })

      const text = await readCapped(request, MAX_BODY_BYTES)

      if (text === undefined)
        return new Response(null, { status: 413 })

      const visit = readVisit(text, request, hosts)

      if (visit === undefined)
        return new Response(null, { status: 400 })

      // A development server, a test and a visitor who has not agreed (the cookie is theirs to send, so a request without it is one the notice never asked) are answered as a counted visit, so nothing tells them apart.
      if (process.env.NODE_ENV !== 'production' || (gated && !hasConsent(request)) || visit.userAgent === '')
        return new Response(null, { status: 204 })

      const address = NEEDS_ADDRESS.has(options.provider) ? clientAddress(request, server) : undefined

      await forward(options, { ...visit, address: address !== undefined && isIP(address) !== 0 ? address : undefined })

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }, { parse: 'none' })
}

function hasConsent(request: Request): boolean {
  return (request.headers.get('cookie') ?? '').split(';').some(cookie => cookie.trim() === CONSENT_COOKIE)
}

// The visit a browser reported, or undefined when anything is off: the page must be one of this site's own, so the route forwards for no other host.
function readVisit(text: string, request: Request, hosts: ReadonlySet<string>): Omit<Visit, 'address'> | undefined {
  let body: Record<string, unknown>

  try {
    body = JSON.parse(text) as Record<string, unknown>
  }
  catch {
    return undefined
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return undefined

  const { u, r, t, w, l } = body
  const page = typeof u === 'string' && u.length <= MAX_URL_LENGTH ? URL.parse(u) : null

  if (page === null || (page.protocol !== 'https:' && page.protocol !== 'http:') || page.username !== '' || page.password !== '')
    return undefined

  if (page.hostname !== new URL(request.url).hostname && !hosts.has(page.hostname)) {
    warn(`analytics: a visit names ${page.hostname} but the request came to ${new URL(request.url).hostname}, so it was dropped; a proxy that rewrites Host needs the host listed in hosts`)

    return undefined
  }

  if ([r, t, w, l].some(value => value !== undefined && typeof value !== 'string'))
    return undefined

  const referrer = typeof r === 'string' && r.length <= MAX_URL_LENGTH ? URL.parse(r) : null
  const kept = [...page.searchParams].filter(([name]) => KEPT_PARAMETERS.test(name))

  page.hash = ''
  page.search = new URLSearchParams(kept).toString()

  return {
    page,
    referrer: referrer !== null && (referrer.protocol === 'https:' || referrer.protocol === 'http:') ? referrer.origin + referrer.pathname : '',
    title: typeof t === 'string' ? t.replace(CONTROL_CHARACTERS, ' ').slice(0, MAX_TITLE_LENGTH) : '',
    screen: typeof w === 'string' && SCREEN.test(w) ? w : undefined,
    language: typeof l === 'string' && LANGUAGE.test(l) ? l : undefined,
    userAgent: (request.headers.get('user-agent') ?? '').replace(CONTROL_CHARACTERS, ' ').trim().slice(0, MAX_USER_AGENT_LENGTH),
  }
}

// Posts the visit to the provider with headers made here: none of the visitor's own, no cookie, no referer, no authorization, goes with it.
async function forward(options: AnalyticsOptions, visit: Visit): Promise<void> {
  const { url, headers, body } = (PROVIDERS[options.provider] as (options: AnalyticsOptions, visit: Visit) => Forward)(options, visit)

  try {
    await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
  }
  catch (error) {
    warn(`analytics: the ${options.provider} provider did not take a visit`, error)
  }
}

function warn(message: string, error?: unknown): void {
  if (Date.now() - lastWarning <= MINUTE_MS)
    return

  lastWarning = Date.now()
  kayLog('warn', message, error)
}
