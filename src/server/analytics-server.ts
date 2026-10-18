import type { AnyElysia } from 'elysia'
import type { AnalyticsOptions, VisitOptions } from './analytics'
import { isIP } from 'node:net'
import process from 'node:process'
import { Elysia } from 'elysia'
import { kayLog } from '../runtime/log'
import { isCrossSite } from './actions'
import { ANALYTICS_PATH, ANALYTICS_SCRIPT_PATH, CUSTOM_COLLECT_PATH, CUSTOM_SCRIPT_PATH } from './analytics'
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
const COLLECT_RATE_NAME = 'kay:analytics-collect'
const MAX_PENDING = 200
const MAX_COLLECT_BYTES = 64 * 1024
const MAX_SCRIPT_BYTES = 512 * 1024
const COLLECTS_PER_MINUTE = 600
const SCRIPT_TTL_MS = 3_600_000
const COLLECT_TYPES = new Set(['application/json', 'text/plain', 'application/x-www-form-urlencoded'])
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
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: unknown
}

// How each provider takes a visit. Plausible: https://plausible.io/docs/events-api (User-Agent and X-Forwarded-For tell visitors apart).
// Umami: POST /api/send with `{ type: 'event', payload }` and a User-Agent, https://umami.is/docs/api/sending-stats; its payload may carry the visitor's `ip`.
// Simple Analytics: https://docs.simpleanalytics.com/events-api, a JSON body with the user agent and no address.
// Matomo: the tracking HTTP API, https://developer.matomo.org/api-reference/tracking-api: `matomo.php` with `idsite`, `rec`, `url`, `ua` and the rest, and `cip` for the address only with a `token_auth`; no visitor id is sent, so Matomo tells visitors apart without a cookie.
const PROVIDERS = {
  plausible: (options: Extract<AnalyticsOptions, { provider: 'plausible' }>, visit: Visit): Forward => ({
    method: 'POST',
    url: `${(options.host ?? 'https://plausible.io').replace(TRAILING_SLASH, '')}/api/event`,
    headers: { 'user-agent': visit.userAgent, 'content-type': 'application/json', ...visit.address !== undefined && { 'x-forwarded-for': visit.address } },
    body: { name: 'pageview', url: visit.page.href, domain: options.domain ?? visit.page.hostname, referrer: visit.referrer },
  }),
  umami: (options: Extract<AnalyticsOptions, { provider: 'umami' }>, visit: Visit): Forward => ({
    method: 'POST',
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
      method: 'POST',
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
  matomo: (options: Extract<AnalyticsOptions, { provider: 'matomo' }>, visit: Visit): Forward => {
    const query = new URLSearchParams({ idsite: String(options.siteId), rec: '1', apiv: '1', rand: Math.random().toString(36).slice(2), url: visit.page.href, action_name: visit.title, urlref: visit.referrer, ua: visit.userAgent })

    if (visit.screen !== undefined)
      query.set('res', visit.screen)

    if (visit.language !== undefined)
      query.set('lang', visit.language)

    if (options.tokenAuth !== undefined && visit.address !== undefined) {
      query.set('token_auth', options.tokenAuth)
      query.set('cip', visit.address)
    }

    return { method: 'GET', url: `${options.host.replace(TRAILING_SLASH, '')}/matomo.php?${query}`, headers: {} }
  },
}

// The providers that need the visitor's address to tell visitors apart; no other is sent it. Matomo takes it only with a token.
function needsAddress(options: VisitOptions): boolean {
  return options.provider === 'plausible' || options.provider === 'umami' || (options.provider === 'matomo' && options.tokenAuth !== undefined)
}

// Visits being passed on, so a test can wait for them and a flood cannot pile up more than a few at a time.
const pending = new Set<Promise<void>>()

export async function forwardsSettled(): Promise<void> {
  await Promise.allSettled(pending)
}

export function analyticsServer(options: AnalyticsOptions): AnyElysia {
  const gated = options.consent !== undefined && options.consent !== false

  const tracker = new Elysia({ name: 'kay-analytics' })
    .get(ANALYTICS_SCRIPT_PATH, () => new Response(ANALYTICS_SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } }))

  if (options.provider === 'custom')
    return tracker.use(customServer(options, gated))

  if (options.provider === 'fathom' || options.provider === 'cloudflare')
    return tracker

  const hosts = new Set((options.hosts ?? []).map(host => host.toLowerCase()))

  return tracker
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

      const address = needsAddress(options) ? clientAddress(request, server) : undefined

      send(options, { ...visit, address: address !== undefined && isIP(address) !== 0 ? address : undefined })

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }, { parse: 'none' })
}

// Passes a visit on in the background, the visitor's answer not waiting for the provider; past 200 waiting at once, a visit is dropped rather than queued.
function send(options: VisitOptions, visit: Visit): void {
  if (pending.size >= MAX_PENDING) {
    warn('analytics: the provider is too slow, so visits are being dropped')

    return
  }

  const sent = forward(options, visit).finally(() => pending.delete(sent))

  pending.add(sent)
}

// The tracker script of another provider served from the app, its endpoint pointed at the app, and the route it posts to, passed on as it comes.
// The script and the endpoint are the app's config: nothing in a request chooses where kay fetches from or posts to.
function customServer(options: Extract<AnalyticsOptions, { provider: 'custom' }>, gated: boolean) {
  let script: { text: string, at: number } | undefined

  return new Elysia({ name: 'kay-analytics-custom' })
    .get(CUSTOM_SCRIPT_PATH, async ({ request }) => {
      if (script === undefined || Date.now() - script.at > SCRIPT_TTL_MS) {
        const text = await fetchScript(options.script)

        if (text === undefined)
          return new Response(null, { status: 502 })

        script = { text, at: Date.now() }
      }

      const prefix = new URL(request.url).pathname.slice(0, -CUSTOM_SCRIPT_PATH.length)

      return new Response(script.text.replaceAll(options.endpoint, `${prefix}${CUSTOM_COLLECT_PATH}`), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
    })
    .post(CUSTOM_COLLECT_PATH, async ({ request, server }) => {
      if (isCrossSite(request))
        return new Response(null, { status: 403 })

      if (Number(request.headers.get('content-length') ?? 0) > MAX_COLLECT_BYTES)
        return new Response(null, { status: 413 })

      if (overLimit(COLLECT_RATE_NAME, clientAddress(request, server), COLLECTS_PER_MINUTE, MINUTE_MS) !== undefined)
        return new Response(null, { status: 429 })

      const raw = request.headers.get('content-type') ?? ''
      const type = (raw.includes(';') ? raw.slice(0, raw.indexOf(';')) : raw).trim().toLowerCase()

      if (type !== '' && !COLLECT_TYPES.has(type))
        return new Response(null, { status: 415 })

      const body = await readCapped(request, MAX_COLLECT_BYTES)

      if (body === undefined)
        return new Response(null, { status: 413 })

      if (process.env.NODE_ENV !== 'production' || (gated && !hasConsent(request)))
        return new Response(null, { status: 204 })

      const address = options.address === true ? clientAddress(request, server) : undefined
      const userAgent = (request.headers.get('user-agent') ?? '').replace(CONTROL_CHARACTERS, ' ').trim().slice(0, MAX_USER_AGENT_LENGTH)
      const headers = { ...type !== '' && { 'content-type': type }, ...userAgent !== '' && { 'user-agent': userAgent }, ...address !== undefined && isIP(address) !== 0 && { 'x-forwarded-for': address } }

      try {
        const answer = await fetch(options.endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
        const text = await readCapped(new Request('http://nowhere.invalid', { method: 'POST', body: answer.body }), MAX_COLLECT_BYTES)

        return new Response(text ?? null, { status: answer.status >= 200 && answer.status < 600 ? answer.status : 502, headers: { 'content-type': answer.headers.get('content-type')?.startsWith('application/json') === true ? 'application/json' : 'text/plain', 'cache-control': 'no-store' } })
      }
      catch (error) {
        warn('analytics: the custom provider did not take a request', error)

        return new Response(null, { status: 502 })
      }
    }, { parse: 'none' })
}

async function fetchScript(url: string): Promise<string | undefined> {
  try {
    const answer = await fetch(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
    const text = answer.ok ? await readCapped(new Request('http://nowhere.invalid', { method: 'POST', body: answer.body }), MAX_SCRIPT_BYTES) : undefined

    if (text === undefined)
      warn(`analytics: the tracker script at ${url} could not be fetched, answering ${answer.status} or too large`)

    return text
  }
  catch (error) {
    warn(`analytics: the tracker script at ${url} could not be fetched`, error)

    return undefined
  }
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
async function forward(options: VisitOptions, visit: Visit): Promise<void> {
  const { method, url, headers, body } = (PROVIDERS[options.provider] as (options: VisitOptions, visit: Visit) => Forward)(options, visit)

  try {
    await fetch(url, { method, headers, ...body !== undefined && { body: JSON.stringify(body) }, redirect: 'manual', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
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
