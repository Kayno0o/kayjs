import type { AnyElysia } from 'elysia'
import type { AnalyticsOptions, VisitOptions } from './analytics'
import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import process from 'node:process'
import { Elysia } from 'elysia'
import { kayLog } from '../runtime/log'
import { isCrossSite } from './actions'
import { ANALYTICS_PATH, ANALYTICS_SCRIPT_PATH, CUSTOM_COLLECT_PATH, CUSTOM_SCRIPT_PATH, isGated, NOTICE_SCRIPT_PATH } from './analytics'
import { ANALYTICS_SCRIPT, NOTICE_SCRIPT } from './analytics-script'
import { BASE_PATH } from './base'
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
const DAY_MS = 86_400_000
// A GA4 session is a half hour of one visitor's page views.
const SESSION_MS = 1_800_000
const MAX_COLLECT_BYTES = 64 * 1024
const MAX_SCRIPT_BYTES = 512 * 1024
const COLLECTS_PER_MINUTE = 600
const SCRIPT_TTL_MS = 3_600_000
const COLLECT_TYPES = new Set(['application/json', 'text/plain', 'application/x-www-form-urlencoded'])
const CONSENT_COOKIE = 'kay_analytics=yes'
const OPT_OUT_COOKIE = 'kay_analytics=no'
// What a visit may carry from its query string: the campaign a link names, and nothing a page holds for one visitor, such as a token or an address.
const KEPT_PARAMETERS = /^(?:utm_[a-z]+|ref|source)$/
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu
const SCREEN = /^\d{1,5}x\d{1,5}$/
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z\d]{2,8}){0,3}$/i
const TRAILING_SLASH = /\/$/
// Logged once a minute at most per kind, so a provider that is down does not fill the log with a line per visit and a burst of one kind does not hide another.
const lastWarnings = new Map<string, number>()

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
  // A provider that wants an id for the visitor gets one made on the server, see `visitorId`.
  visitor?: string | undefined
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
// Google Analytics 4: the Measurement Protocol, https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events: POST `/mp/collect?measurement_id&api_secret` with `client_id` and `events`; `ip_override` places the visit, `device` carries the language and screen.
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
  ga4: (options: Extract<AnalyticsOptions, { provider: 'ga4' }>, visit: Visit): Forward => ({
    method: 'POST',
    url: `${(options.host ?? 'https://www.google-analytics.com').replace(TRAILING_SLASH, '')}/mp/collect?${new URLSearchParams({ measurement_id: options.measurementId, api_secret: options.apiSecret })}`,
    headers: { 'content-type': 'application/json' },
    body: {
      client_id: visit.visitor,
      events: [{ name: 'page_view', params: {
        page_location: visit.page.href,
        page_referrer: visit.referrer,
        page_title: visit.title,
        session_id: String(Math.floor(Date.now() / SESSION_MS) * SESSION_MS / 1000),
        engagement_time_msec: 100,
      } }],
      ...visit.address !== undefined && { ip_override: visit.address },
      ...(visit.screen !== undefined || visit.language !== undefined) && { device: { ...visit.language !== undefined && { language: visit.language }, ...visit.screen !== undefined && { screen_resolution: visit.screen } } },
    },
  }),
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

// The providers that need the visitor's address to tell visitors apart or place them, or were told to pass it (GA4 with `address: true`); no other is sent it. Matomo takes it only with a token.
function needsAddress(options: VisitOptions): boolean {
  return options.provider === 'plausible' || options.provider === 'umami' || (options.provider === 'ga4' && options.address === true) || (options.provider === 'matomo' && options.tokenAuth !== undefined)
}

// A visitor's id for GA4, with no cookie or storage in the browser: a keyed hash of the address and the browser, the key being a random one that changes each UTC day and lives in this process only, so the id tells a visitor apart for a day and cannot be turned back into an address.
// It only exists once the visit passed the consent check, so a visitor who has not agreed never gets one; two processes behind a balancer count a visitor twice.
let salt: { day: number, key: Buffer } | undefined

function visitorId(address: string, userAgent: string): string {
  const day = Math.floor(Date.now() / DAY_MS)

  if (salt?.day !== day)
    salt = { day, key: randomBytes(32) }

  const hash = createHmac('sha256', salt.key).update(`${address}\n${userAgent}`).digest()

  return `${hash.readUInt32BE(0)}.${hash.readUInt32BE(4)}`
}

// Visits being passed on, so a test can wait for them and a flood cannot pile up more than a few at a time.
const pending = new Set<Promise<void>>()

export async function forwardsSettled(): Promise<void> {
  await Promise.allSettled(pending)
}

// Lets a test see a warning again that an earlier one already logged within the minute.
export function warningsReset(): void {
  lastWarnings.clear()
}

export function analyticsServer(options: AnalyticsOptions): AnyElysia {
  const gated = isGated(options)

  const tracker = new Elysia({ name: 'kay-analytics' })
    .get(ANALYTICS_SCRIPT_PATH, () => new Response(ANALYTICS_SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } }))
    .get(NOTICE_SCRIPT_PATH, () => new Response(NOTICE_SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } }))

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

      if (options.titles !== true)
        visit.title = ''

      const excluded = skippedPath(options.exclude, visit.page.pathname, baseOf(request, visit.scope))

      // A development server, a test, a visitor who has not agreed where a yes is needed (the cookie is theirs to send, so a request without it is one the notice never asked) and one who opted out are answered as a counted visit, so nothing tells them apart.
      if (process.env.NODE_ENV !== 'production' || declined(request, gated) || visit.userAgent === '' || excluded)
        return new Response(null, { status: 204 })

      const address = options.provider === 'ga4' || needsAddress(options) ? clientAddress(request, server) : ''

      // The id is made from the address even when the address is not passed on.
      send(options, { ...visit, address: needsAddress(options) && isIP(address) !== 0 ? address : undefined, ...options.provider === 'ga4' && { visitor: visitorId(address, visit.userAgent) } })

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }, { parse: 'none' })
}

// The mount point the visit's page is under: what the request path has before the tracker's route, else the one the tracker names, a proxy having taken it off the request.
function baseOf(request: Request, named: string): string {
  const path = new URL(request.url).pathname
  const stripped = path.endsWith(ANALYTICS_PATH) ? path.slice(0, -ANALYTICS_PATH.length) : ''

  return stripped === '' ? named : stripped
}

// Whether `exclude` leaves out the page, matched as the tracker does so a tracker cached from before still counts nothing it should not: `/account` covers the page and all under it, `*` stands for one segment.
function skippedPath(exclude: string[] | undefined, pathname: string, base: string): boolean {
  if (exclude === undefined || exclude.length === 0)
    return false

  const parts = (pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname).split('/').filter(Boolean)

  return exclude.some(pattern => pattern.split('/').filter(Boolean).every((word, at) => word === '*' ? parts[at] !== undefined : word === parts[at]))
}

// Passes a visit on in the background, the visitor's answer not waiting for the provider; past 200 waiting at once, a visit is dropped rather than queued.
function send(options: VisitOptions, visit: Visit): void {
  if (pending.size >= MAX_PENDING) {
    warn('slow', 'analytics: the provider is too slow, so visits are being dropped')

    return
  }

  const sent = forward(options, visit).finally(() => pending.delete(sent))

  pending.add(sent)
}

// The tracker script of another provider served from the app, its endpoint pointed at the app, and the route it posts to, passed on as it comes.
// The script and the endpoint are the app's config: nothing in a request chooses where kay fetches from or posts to.
function customServer(options: Extract<AnalyticsOptions, { provider: 'custom' }>, gated: boolean) {
  let script: { text: string, at: number } | undefined
  // One fetch in flight at a time, so concurrent requests on an empty cache share it.
  let fetching: Promise<string | undefined> | undefined

  return new Elysia({ name: 'kay-analytics-custom' })
    .get(CUSTOM_SCRIPT_PATH, async ({ request, query }) => {
      if (script === undefined || Date.now() - script.at > SCRIPT_TTL_MS) {
        fetching ??= fetchScript(options.script).finally(() => {
          fetching = undefined
        })

        const text = await fetching

        if (text === undefined)
          return new Response(null, { status: 502 })

        script = { text, at: Date.now() }
      }

      // The base a proxy took off, which kay's own script names in the query; anything but a plain path is ignored.
      const named = typeof query.base === 'string' && BASE_PATH.test(query.base) ? query.base : ''
      const prefix = new URL(request.url).pathname.slice(0, -CUSTOM_SCRIPT_PATH.length) || named

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

      if (process.env.NODE_ENV !== 'production' || declined(request, gated))
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
        warn('custom', 'analytics: the custom provider did not take a request', error)

        return new Response(null, { status: 502 })
      }
    }, { parse: 'none' })
}

async function fetchScript(url: string): Promise<string | undefined> {
  try {
    const answer = await fetch(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
    const text = answer.ok ? await readCapped(new Request('http://nowhere.invalid', { method: 'POST', body: answer.body }), MAX_SCRIPT_BYTES) : undefined

    if (text === undefined)
      warn('script', `analytics: the tracker script at ${url} could not be fetched, answering ${answer.status} or too large`)

    return text
  }
  catch (error) {
    warn('script', `analytics: the tracker script at ${url} could not be fetched`, error)

    return undefined
  }
}

// A gated provider needs the visitor's yes; one counting without asking stops for a visitor who opted out.
function declined(request: Request, gated: boolean): boolean {
  const cookies = new Set((request.headers.get('cookie') ?? '').split(';').map(cookie => cookie.trim()))

  return gated ? !cookies.has(CONSENT_COOKIE) : cookies.has(OPT_OUT_COOKIE)
}

// The visit a browser reported, or undefined when anything is off: the page must be one of this site's own, so the route forwards for no other host.
function readVisit(text: string, request: Request, hosts: ReadonlySet<string>): (Omit<Visit, 'address'> & { scope: string }) | undefined {
  let body: Record<string, unknown>

  try {
    body = JSON.parse(text) as Record<string, unknown>
  }
  catch {
    return undefined
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return undefined

  const { u, r, t, w, l, s } = body
  const page = typeof u === 'string' && u.length <= MAX_URL_LENGTH ? URL.parse(u) : null

  if (page === null || (page.protocol !== 'https:' && page.protocol !== 'http:') || page.username !== '' || page.password !== '')
    return undefined

  if (page.hostname !== new URL(request.url).hostname && !hosts.has(page.hostname)) {
    warn('host', `analytics: a visit names ${page.hostname} but the request came to ${new URL(request.url).hostname}, so it was dropped; a proxy that rewrites Host needs the host listed in hosts`)

    return undefined
  }

  if ([r, t, w, l, s].some(value => value !== undefined && typeof value !== 'string'))
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
    scope: typeof s === 'string' && BASE_PATH.test(s) ? s : '',
  }
}

// Posts the visit to the provider with headers made here: none of the visitor's own, no cookie, no referer, no authorization, goes with it.
async function forward(options: VisitOptions, visit: Visit): Promise<void> {
  const { method, url, headers, body } = (PROVIDERS[options.provider] as (options: VisitOptions, visit: Visit) => Forward)(options, visit)

  try {
    const response = await fetch(url, { method, headers, ...body !== undefined && { body: JSON.stringify(body) }, redirect: 'manual', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })

    if (!response.ok)
      warn(`provider-${options.provider}-${response.status}`, `analytics: the ${options.provider} provider answered ${response.status} to a visit, so the visits are lost until its settings are right (a wrong site id, domain or secret answers this way)`)

    // The body is never read, so it is cancelled to free the connection.
    await response.body?.cancel()
  }
  catch (error) {
    // Bun's error carries the request URL as `path`, which holds a GA4 secret or a Matomo token, so only its message is logged.
    warn('provider', `analytics: the ${options.provider} provider did not take a visit`, error instanceof Error ? error.message : undefined)
  }
}

function warn(kind: string, message: string, error?: unknown): void {
  if (Date.now() - (lastWarnings.get(kind) ?? 0) <= MINUTE_MS)
    return

  lastWarnings.set(kind, Date.now())
  kayLog('warn', message, error)
}
