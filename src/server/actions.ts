import type { CookieMap } from 'bun'
import type { Elysia, TSchema, ValidationError } from 'elysia'
import type { Server } from 'elysia/universal'
import type { KayConfig } from '../config'
import type { GuardContext, Locals, RouteParams } from '../runtime'
import type { ActionContext, RateKeyContext, ServerAction } from '../runtime/action'
import type { Locale } from '../runtime/i18n'
import type { LocaleState } from '../runtime/locale-state'
import type { BodyLimit } from './body'
import type { CookieJar } from './cookies'
import type { CorsOptions } from './cors'
import type { Flash } from './flash'
import type { LoadedGuard, ServedRoute } from './guards'
import type { I18n } from './i18n'
import type { DocumentedAction } from './openapi'
import { decodeCall, failure, FORM_CALL, isAction, isFailure, PAYLOAD_PARAM } from '../runtime/action'
import { escapeAttribute } from '../runtime/escape'
import { formInput, NUMERIC_FORMATS } from '../runtime/form'
import { localeState, runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { configuredSite } from '../runtime/site'
import { sizeText } from '../runtime/size-text'
import { FAILURE_HEADER, NAVIGATE_HEADER, PAGE_HEADER, REDIRECT_HEADER } from '../runtime/swap'
import { encodeValue, unsendable } from '../runtime/wire'
import { pageLocale } from '../runtime/words.server'
import { actionClash } from './action-clash'
import { routerPath } from './base'
import { importModule } from './bundle'
import { cookieJar } from './cookies'
import { eventBody } from './event-stream'
import { fieldMessage, validated } from './field-errors'
import { handOver, submittedValues, writeSuccess } from './flash'
import { requiredGuards, runGuards, unguarded } from './guards'
import { requestLocale, stateFor } from './i18n'
import { answeringRequest } from './log'
import { countSucceeded, isAgentCall, markChallenge, PRETEND, protectionRefusal, requestId } from './protection'
import { sharedContext } from './render'
import { reportServerError } from './report'
import { requestUrl } from './request-url'
import { guardUrl } from './routes'
import { readPersonally } from './scope'
import { carryContext } from './security'
import { Denied, NotFound, Redirect, stoppers } from './signals'
import { toolSettings } from './tool-settings'
import { answered, SERVER_SPAN, traced } from './trace'
import { visitAs } from './visit'
import { invalidWord, kayWord } from './words'

export interface GuardedRequest {
  jar: CookieJar
  headers: Headers
}

// Thrown before the input is validated, to answer with `response` through the route's error hook.
class Refusal {
  constructor(readonly response: Response | Promise<Response>) {}
}

// What a library's error carries under `Symbol.for('kay.refused')` to be answered as a refusal rather than a server error: the status, the seconds to wait and the words for the visitor.
interface Refused {
  status: number
  retryAfter?: number | undefined
  message: string
}

const REFUSED = Symbol.for('kay.refused')

function refusalOf(error: unknown): Refused | undefined {
  const refused = typeof error === 'object' && error !== null ? (error as Record<symbol, unknown>)[REFUSED] : undefined

  if (typeof refused !== 'object' || refused === null)
    return undefined

  const { status, retryAfter, message } = refused as Partial<Refused>

  if (!Number.isInteger(status) || status! < 400 || status! > 599 || typeof message !== 'string')
    return undefined

  return { status: status!, retryAfter: Number.isInteger(retryAfter) && retryAfter! >= 0 ? retryAfter : undefined, message }
}

// The action's own wording of a rate limit wins for a 429, given the seconds to wait.
function refusalMessage(action: ServerAction<TSchema, unknown>, { status, retryAfter, message }: Refused): string {
  const words = action.protection?.messages?.rateLimit

  if (status !== 429 || words === undefined || retryAfter === undefined)
    return message

  return typeof words === 'string' ? words : words(retryAfter)
}

// What the guards set on the response, carried to the handler they let through.
const guarded = new WeakMap<Request, GuardedRequest>()
// The params of the page each post came from, read by its guards and its action alike.
const pageParams = new WeakMap<Request, RouteParams>()
// The page each guarded post came from, which its guards read as `ctx.url`.
const pageUrls = new WeakMap<Request, URL>()
const TEXT = 'text/plain; charset=utf-8'
// The methods that change nothing, which any page may send anywhere.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// What a post from the site's own pages carries in `Sec-Fetch-Site`; `none` is the user's own doing, such as a bookmark.
const SAME_SITE_FETCH = new Set(['same-origin', 'none'])
// The first proxy's `X-Forwarded-Proto` saying the browser came over https.
const FORWARDED_HTTPS = /^\s*https\s*(?:,|$)/i
// A server tried on this machine, which may well run over plain http.
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/
let warnedScheme = false

// What describes the post's body, or would have the page come back compressed or as a call.
const POST_HEADERS = ['content-type', 'content-length', 'transfer-encoding', 'accept-encoding', 'x-kay-action', PAGE_HEADER, 'origin']
const HTML = /^text\/html\b/
const HEAD_START = /<head\b[^>]*>/i
// The `action` of a form posting to an action, the site's `base` before it if any.
const FORM_ACTION = /(<form\b[^>]*?\saction=")([^"]*\/_kay\/action\/[^"#]*)/gi
// Names the page a refused post was answered with, on the forms that page holds: the browser then shows the action's URL, which their next post sends as its `Referer`.
const BACK_PARAMETER = 'kay_back'

// The top-level field of a validation path such as `/address/street`.
const FIELD = /^\/([^/]*)/
// Elysia names a file it refuses `body.<field>`.
const BODY_PREFIX = /^body\./

export interface ActionOptions {
  // Shows a failed action's message instead of a generic one.
  dev?: boolean | undefined
  onError?: KayConfig['onError'] | undefined
  // An action runs in the locale of the page it was sent from, or the site's one language without `i18n`; an endpoint, which has no locale prefix, in the default one.
  i18n: I18n
  // Where the site is mounted, which the page a refused form post came from is served under.
  base?: string | undefined
  requireGuards?: boolean | undefined
  // The app's `cors`, the rule of every API module that sets none.
  cors?: CorsOptions | undefined
}

export interface RouteMatch {
  // The params `path` gives the route under any locale's pattern, with the path as the router serves the page there, none for one it sends on, such as an untranslated path; undefined when the route does not serve it.
  posted: (route: ServedRoute, path: string) => { params: Record<string, unknown>, path: string | undefined } | undefined
  // The first path the router serves the route at, each param named, `/orgs/:org`.
  served: (route: ServedRoute) => string
}

// Renders the page a refused plain form post came from, with how it failed, through the app the post reached.
type Back = (request: Request, headers: Headers, flash: Flash, server: Server | null) => Promise<Response>

// Whether each action the app serves belongs to a page with params, which it reads from the page it is posted from, so a call no page made cannot run it.
const pageBound = new WeakMap<object, boolean>()

// Registers every action the pages and layouts export as a POST route whose body Elysia validates against the action's schema, giving back the body limit of each by its path and the actions that opted in to being MCP tools.
export async function registerActionRoutes(app: Elysia, routes: ServedRoute[], match: RouteMatch, options: ActionOptions): Promise<{ limits: Map<string, BodyLimit>, tools: DocumentedAction[] }> {
  const back: Back = async (request, headers, flash, server) => renderBack(app, options.base ?? '', request, headers, flash, server)
  const served = new Map<string, { file: string, action: ServerAction<TSchema, unknown> }>()
  const limits = new Map<string, BodyLimit>()
  const tools: DocumentedAction[] = []

  for (const [file, { guards, ...page }] of actionFiles(routes, options.requireGuards)) {
    const module = await importModule<Record<string, unknown>>(file)

    for (const [name, value] of Object.entries(module)) {
      if (!isAction(value))
        continue

      const taken = served.get(value.url)

      // One action exported under two names is served once.
      if (taken?.action === value)
        continue

      if (taken)
        throw actionClash(taken.file, file, value.url)

      served.set(value.url, { file, action: value })

      const tool = toolSettings(value.protection?.tool)

      pageBound.set(value, page.params.length > 0)

      // Read once, as the rate limits' `key` hooks are fixed by the registration.
      const keyedLimit = keyed(value)

      if (tool && page.params.length === 0)
        tools.push({ name, url: value.url, schema: value.schema, tool, guards: guards.filter(guard => guard.check !== unguarded).map(guard => guard.file) })

      limits.set(value.url, { bytes: value.protection?.bodyLimit, refuse: async (request, bytes, server) => inLocale(request, options, async () => tooLarge(value, request, bytes, server, back)) })
      // A span per call, the handler's own spans and the page it renders back nested in it.
      app.post(value.url, async context => traced(`POST ${value.url}`, () => ({ kind: SERVER_SPAN, attributes: { 'http.request.method': 'POST', 'http.route': value.url, 'url.path': value.url, 'kay.request.id': requestId(context.request) } }), async (span) => {
        const response = await answeringRequest(context.request, async () => inLocale(context.request, options, async () => runAction(value, sharedContext(context.request, () => ({ ...context })), options, back, { params: () => readPage(context.request, page, match, options), url: () => cachedPageUrl(context.request, () => guardedPage(context.request, page, match, options)) })))

        if (span)
          answered(span, response.status)

        return carryContext(context.set, response)
      }), {
        body: validated(value.schema),
        transform: async (context) => {
          refuseCrossSite(context.request)

          // Guards may check the params and the page's URL, so a post from no page of the file never reaches them; without guards, only an action reading `ctx.params` needs its page.
          if (guards.length > 0)
            pageUrls.set(context.request, guardedPage(context.request, page, match, options))

          const call = isCall(context.request)
          // A call may send a form's fields, read as a plain form post's are.
          const asForm = !call || isFormCall(context.request)
          // In the request's locale, so a refusal worded by a function can read `t()`.
          const refusal = await inLocale(context.request, options, async () => protectionRefusal(value, context.request, { body: context.body, form: asForm, server: context.server, plain: !call, keyContext: keyedLimit ? () => rateKeyContext(context.request, { ...context }, options) : undefined }))

          if (refusal === PRETEND)
            throw new Refusal(pretended(value, context.request, options.base))

          // Before the schema reads the input: every attempt counts, a valid one or not.
          if (refusal)
            throw new Refusal(failed(context.request, new Headers(refusal.headers), cookieJar(context.request).cookies, { action: value.url, status: refusal.status, values: call ? {} : submittedValues(context.body), errors: { [refusal.field]: refusal.message } }, context.server, back))

          context.body = asForm ? formInput(value.schema, withFixedFields(withoutEmptyFiles(context.body), context.request)) : callInput(context.body)
        },
        // After validation, the one stage where the app's `resolve` values are there for `ctx.locals`.
        ...(guards.length > 0 && { beforeHandle: async (context: { request: Request }) => inLocale(context.request, options, async () => admit(guards, sharedContext(context.request, () => ({ ...context })), pageParams.get(context.request) ?? {}, pageUrls.get(context.request), options)) }),
        error: async (context) => {
          const { code, error, request, body, server, set } = context

          if ((code === 'VALIDATION' || code === 'INVALID_FILE_TYPE') && guards.length > 0) {
            const refusal = await inLocale(request, options, async () => guardsFirst(guards, sharedContext(request, () => ({ ...context })), pageParams.get(request) ?? {}, pageUrls.get(request), options))

            if (refusal)
              return refusal
          }

          if (code === 'VALIDATION')
            return inLocale(request, options, async () => refused(value, error, request, server, back))

          // Elysia checks a top-level `s.File({ type })` against the file's bytes once the schema passed.
          if (code === 'INVALID_FILE_TYPE') {
            const field = error.property.replace(BODY_PREFIX, '')

            return inLocale(request, options, async () => failed(request, new Headers(), cookieJar(request).cookies, { action: value.url, status: 422, values: submittedValues(body), errors: { [field]: fieldError(value, field) ?? kayWord('kay.action.invalidFile') } }, server, back))
          }

          // Read as unknown: some apps' Elysia types narrow the error to an intersection holding `number`.
          const refusal: unknown = error

          if (!(refusal instanceof Refusal))
            return undefined

          const response = await refusal.response

          // Elysia answers a hook's error 500 unless told otherwise, even with a Response, which a honeypot pretending answers 200.
          set.status = response.status

          return response
        },
      })
    }
  }

  return { limits, tools }
}

function keyed(action: ServerAction<TSchema, unknown>): boolean {
  return [action.protection?.rateLimit ?? []].flat().some(limit => limit.key !== undefined)
}

// What an action's rate limit `key` reads, before the guards ran: the cookies, the locale and what the app's `derive` hooks added.
// The context is passed as a copy: Elysia reads the cookies and headers of every request to a route whose hook hands it on as it is.
function rateKeyContext(request: Request, locals: object, options: ActionOptions): Omit<RateKeyContext, 'client'> {
  return {
    request,
    locale: contextLocale(options),
    get cookies() {
      return cookieJar(request).cookies
    },
    locals: locals as Locals,
  }
}

// A post over the action's body limit, answered as a refused one is, with a message for the whole form; another site's is refused as such.
async function tooLarge(action: ServerAction<TSchema, unknown>, request: Request, bytes: number, server: Server | null, back: Back): Promise<Response> {
  if (isCrossSite(request))
    return crossSiteRefusal(request)

  const message = action.protection?.messages?.bodyLimit ?? (most => kayWord('kay.action.bodyLimit', { size: sizeText(most, pageLocale()) }))

  return failed(request, new Headers(), cookieJar(request).cookies, { action: action.url, status: 413, values: {}, errors: { '': typeof message === 'string' ? message : message(bytes) } }, server, back)
}

// What an action file is posted from: a page of `routes`, read for the `params` they all name.
interface ActionPage {
  routes: ServedRoute[]
  params: string[]
}

// Every page and layout once, with the guards of its own directory and above: a layout's actions are not behind the guards of the pages below it.
// A page's actions read its params, a layout's those of every page it wraps.
function actionFiles(routes: ServedRoute[], required: boolean | undefined): Map<string, ActionPage & { guards: LoadedGuard[] }> {
  const files = new Map<string, ActionPage & { guards: LoadedGuard[] }>()

  for (const route of routes) {
    const modules = route.actionModules ?? []

    for (const [index, file] of [...route.layouts, ...modules, route.file].entries()) {
      const known = files.get(file)

      if (known) {
        known.routes.push(route)
        known.params = known.params.filter(name => route.params.includes(name))

        continue
      }

      // A layout runs the guards of its own directory and above, whichever page the scan met it under; a page those of its route.
      // A route built by hand, with no `layoutAccess`, refuses its layouts' actions rather than serve them unguarded.
      const access = index < route.layouts.length ? route.layoutGuards?.[index] : route.actionGuards?.[index - route.layouts.length]
      const { guards, open } = file === route.file ? route : access ?? { guards: [{ file, special: route.special, check: unguarded }] }

      files.set(file, { guards: requiredGuards(guards, { file, open }, route.special, required), routes: [route], params: route.params })
    }
  }

  return files
}

// The params of the page the post came from, kept for its guards and its action; a post reading params whose page is not one of the file's, or names none, is refused, before anything runs when guards cover the file, so no guard checking them is ever skipped.
function readPage(request: Request, page: ActionPage, match: RouteMatch, { base = '' }: ActionOptions): void {
  // Nothing to read, so the project's matchers never run on a page that has nothing to do with the action.
  if (page.params.length === 0)
    return

  if (postedPage(request, page, match, base) === undefined)
    throw notFromPage()
}

// The page url of a post, worked out once however many times the handler reads `ctx.url`.
function cachedPageUrl(request: Request, work: () => URL): URL {
  let url = pageUrls.get(request)

  if (url === undefined)
    pageUrls.set(request, url = work())

  return url
}

// The page of the file a guarded post came from, as a visit to it reaches the guards, so a path they check covers its actions: its static segments as the router names them, without `base` or a trailing slash.
// A post naming none, such as a script's, stands for the file's shortest page without params, else its first, and is refused when the file reads params.
function guardedPage(request: Request, page: ActionPage, match: RouteMatch, { base = '' }: ActionOptions): URL {
  const from = postedPage(request, page, match, base)

  // Set on the request's own URL, so a path starting `//` never names another host.
  const url = new URL(request.url)

  url.search = ''

  if (from?.path !== undefined) {
    url.pathname = from.path
    url.search = from.search

    return url
  }

  if (page.params.length > 0)
    throw notFromPage()

  const shortest = page.routes.filter(route => route.params.length === 0).reduce<ServedRoute | undefined>((best, route) => best === undefined || route.pattern.length < best.pattern.length ? route : best, undefined)

  url.pathname = match.served(shortest ?? page.routes[0]!)

  return guardUrl(url)
}

// Records the params of the page the post came from, giving its path as the router serves it and its query.
function postedPage(request: Request, page: ActionPage, match: RouteMatch, base: string): { path: string | undefined, search: string } | undefined {
  const from = postedFrom(request)

  if (from === undefined)
    return undefined

  const url = new URL(from)
  const path = routerPath(url.pathname, base)

  for (const route of page.routes) {
    const posted = match.posted(route, path)

    if (posted) {
      pageParams.set(request, Object.fromEntries(Object.entries(posted.params).filter(([name]) => page.params.includes(name))))

      return { path: posted.path, search: url.search }
    }
  }

  return undefined
}

function notFromPage(): Refusal {
  return new Refusal(new Response('Action posted from no page of its route', { status: 400, headers: { 'content-type': TEXT } }))
}

// A call's input comes encoded, multipart when it carries files; input that does not decode is answered 400.
function callInput(body: unknown): unknown {
  try {
    return decodeCall(body)
  }
  catch {
    throw new Refusal(new Response('Malformed action input', { status: 400, headers: { 'content-type': TEXT } }))
  }
}

// The `error` option the schema gives a top-level field, read in the request's locale.
function fieldError(action: ServerAction<TSchema, unknown>, field: string): string | undefined {
  return fieldMessage(action.schema, `/${field}`)
}

// The fields the form's action URL fixes through `with()`, which stand over the ones posted under the same name.
function withFixedFields(body: unknown, request: Request): unknown {
  const query = requestUrl(request).searchParams.get(PAYLOAD_PARAM)

  if (query === null)
    return body

  const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  const fixed = new Map<string, string[]>()

  for (const [name, value] of new URLSearchParams(query)) {
    // An own `__proto__` field would change the prototype of what the handler reads.
    if (name !== '__proto__')
      fixed.set(name, [...fixed.get(name) ?? [], value])
  }

  for (const [name, values] of fixed)
    fields[name] = values.length === 1 ? values[0] : values

  return fields
}

// A file input left empty still posts a nameless, empty file; dropping it lets `s.Optional(s.File())` see no file at all.
function withoutEmptyFiles(body: unknown): unknown {
  if (typeof body !== 'object' || body === null)
    return body

  const fields: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(body)) {
    if (!Array.isArray(value)) {
      if (!isEmptyFile(value))
        fields[name] = value

      continue
    }

    const files = value.filter(item => !isEmptyFile(item))

    // A multiple file input left empty posts only empty files, which is no files at all.
    if (files.length > 0 || value.length === 0)
      fields[name] = files
  }

  return fields
}

// Bun parses such a part as a Blob with no name.
function isEmptyFile(value: unknown): boolean {
  return value instanceof Blob && value.size === 0 && !(value instanceof File && value.name)
}

// Browsers send `Origin` on every POST, so a form another site submits on the user's behalf is refused before anything else runs.
function refuseCrossSite(request: Request) {
  if (isCrossSite(request))
    throw new Refusal(crossSiteRefusal(request))
}

function crossSiteRefusal(request: Request): Response {
  return crossSiteResponse(request, 'action')
}

const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/gu
const SHOWN_MOST = 100

// What a refused request sent, which a visitor controls, so cut to a line of printable text.
function shown(value: string): string {
  const text = value.replace(UNPRINTABLE, '')

  if (text.length <= SHOWN_MOST)
    return text

  const last = text.charCodeAt(SHOWN_MOST - 1)
  const cut = last >= 0xD800 && last <= 0xDBFF ? SHOWN_MOST - 1 : SHOWN_MOST

  return `${text.slice(0, cut)}...`
}

// The 403 for a request `isCrossSite` refused, saying what it sent and what kay took for the site, so a proxy changing the host is fixed in one step.
export function crossSiteResponse(request: Request, what: 'action' | 'request', site?: string): Response {
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  const head = `Cross-site ${what} refused`
  let reason: string

  if (origin !== null && !sameHost(request, URL.parse(origin), site)) {
    const own = [requestUrl(request).origin, configuredSite()?.origin, site === undefined ? undefined : URL.parse(site)?.origin].filter((value, index, all) => value !== undefined && all.indexOf(value) === index)

    reason = `Origin ${shown(origin)} is not this site (${own.join(' or ')}; set or fix site in kay.config.ts if a proxy changes the host)`
  }
  else {
    const seen = shown(fetchSite ?? '')

    reason = seen === '' && origin === null
      ? 'the request sent an empty Sec-Fetch-Site and no Origin, not same-origin or none'
      : `Sec-Fetch-Site is ${seen === '' ? 'empty' : seen}${origin === null ? ' and the request has no Origin' : ''}, not same-origin or none`
  }

  return new Response(`${head}: ${reason}`, { status: 403, headers: { 'content-type': TEXT } })
}

// A browser names where a request comes from in `Origin`, and in `Sec-Fetch-Site` too, which it sends even when it leaves `Origin` out.
export function isCrossSite(request: Request, site?: string): boolean {
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')

  return (origin !== null && !sameHost(request, URL.parse(origin), site)) || (fetchSite !== null && !SAME_SITE_FETCH.has(fetchSite))
}

// The requests an `api({ cors })` module let in from another site, which a library checking Origin itself, such as kayjs-auth, leaves alone.
const corsAdmitted = new WeakSet<Request>()

export function admitCrossSite(request: Request): void {
  corsAdmitted.add(request)
}

// Whether a browser on another site sent `request`, which no `api({ cors })` module let in.
export function unadmittedCrossSite(request: Request): boolean {
  return crossSiteOnce(request, undefined) && !corsAdmitted.has(request)
}

// Undefined until the app serves the action.
export function boundToPage(action: object): boolean | undefined {
  return pageBound.get(action)
}

// What `isCrossSite` answered for a request, as kayjs-auth asks again on every session read of one.
const crossSiteAnswers = new WeakMap<Request, { site: string | undefined, crossSite: boolean }>()

// Whether a browser's cross-site POST or websocket upgrade should be refused, for code on a plain Elysia app that kay's own actions and API do not reach; `site` is the app's public URL, whose host counts as the request's own.
export function crossSiteRefused(request: Request, site?: string): boolean {
  return (!SAFE_METHODS.has(request.method) || request.headers.get('upgrade')?.toLowerCase() === 'websocket') && crossSiteOnce(request, site) && !corsAdmitted.has(request)
}

function crossSiteOnce(request: Request, site: string | undefined): boolean {
  const known = crossSiteAnswers.get(request)

  if (known !== undefined && known.site === site)
    return known.crossSite

  const crossSite = isCrossSite(request, site)

  crossSiteAnswers.set(request, { site, crossSite })

  return crossSite
}

// Over https, kay's cookies never travel in clear; behind a proxy, `X-Forwarded-Proto` says how the browser came, and without one, in production, an https `site` in kay.config.ts stands in, for a proxy that does not pass it on.
export function overHttps(request: Request): boolean {
  if (requestUrl(request).protocol === 'https:')
    return true

  const forwarded = request.headers.get('x-forwarded-proto')

  if (forwarded !== null)
    return FORWARDED_HTTPS.test(forwarded)

  if (process.env.NODE_ENV !== 'production')
    return false

  const site = configuredSite()

  if (!site)
    warnUnknownScheme(request)

  return site?.origin.startsWith('https:') === true
}

function warnUnknownScheme(request: Request): void {
  if (warnedScheme || LOCAL_HOST.test(requestUrl(request).hostname))
    return

  warnedScheme = true
  kayLog('warn', 'a request came over http with no X-Forwarded-Proto and kay.config.ts sets no site, so kay\'s cookies go out without Secure and the session\'s without __Host-; behind a proxy, have it pass X-Forwarded-Proto, or set site to the https address')
}

export function inLocale<T>(request: Request, options: ActionOptions, run: () => T): T {
  return runInLocale(requestState(request, options), run)
}

// The locale state of a request: its locale as the host, the page it came from or the visitor's preference say, a site's single language without a lookup.
export function requestState(request: Request, options: ActionOptions): LocaleState {
  const { i18n } = options
  const locale = i18n.settings.locales.length === 1 ? i18n.settings.defaultLocale : requestLocale(i18n.settings, request, postedFrom(request) ?? null, options.base)

  return stateFor(i18n, locale, requestUrl(request).pathname, request)
}

// What `ctx.locale` reads: the request's locale, or the site's single language.
export function contextLocale({ i18n }: Pick<ActionOptions, 'i18n'>): Locale {
  // eslint-disable-next-line ts/no-unnecessary-type-assertion -- Locale is a string in kay itself and an app's own locales once its Register names them
  return (localeState()?.locale ?? i18n.settings.defaultLocale) as Locale
}

// The guards of the action's page, answering for it when one stops the request.
async function admit(guards: LoadedGuard[], context: { request: Request }, params: RouteParams, url: URL | undefined, options: ActionOptions): Promise<Response | undefined> {
  const passed = await passGuards(guards, context, params, options, url)

  if (passed instanceof Response)
    return passed

  guarded.set(context.request, passed)

  return undefined
}

// The guards of a route whose input the schema refused, run before its field errors go out, so a caller they refuse learns nothing of the input, nor sees its values echoed.
// Only `derive` values are there, `resolve` running after the schema; a guard throwing answers 500, as on valid input, never the field errors.
export async function guardsFirst(guards: LoadedGuard[], context: { request: Request }, params: RouteParams, url: URL | undefined, options: ActionOptions): Promise<Response | undefined> {
  const passed = await passGuards(guards, context, params, options, url)

  return passed instanceof Response ? passed : undefined
}

// Runs the guards of an action or an API route: the response when one stops the request, else the cookies and headers they set.
export async function passGuards(guards: LoadedGuard[], context: { request: Request }, params: RouteParams, options: ActionOptions, url = guardUrl(context.request.url)): Promise<Response | GuardedRequest> {
  const { request } = context
  const state: GuardedRequest = { jar: cookieJar(request), headers: new Headers() }
  const ctx: GuardContext = {
    request,
    url,
    locale: contextLocale(options),
    params,
    get cookies() {
      readPersonally(request)

      return state.jar.cookies
    },
    locals: context as unknown as Locals,
    headers: state.headers,
    ...stoppers(request),
  }
  const refusal = await runGuards(guards, ctx)

  if (refusal?.error instanceof Denied && refusal.error.status === 401)
    markChallenge(request)

  return refusal ? stopped(refusal.error, request, state, options) : state
}

// The host of `site` in kay.config.ts, parsed once per origin.
let siteHost: { origin: string, host: string | undefined } | undefined

function configuredHost(): string | undefined {
  const site = configuredSite()

  if (site === undefined)
    return undefined

  if (siteHost?.origin !== site.origin)
    siteHost = { origin: site.origin, host: URL.parse(site.origin)?.host }

  return siteHost.host
}

// Hosts rather than origins: behind a TLS-terminating proxy the browser says https while the request arrives as http. The host of `site` in kay.config.ts counts too, for a proxy that does not pass the browser's `Host` on.
function sameHost(request: Request, url: URL | null, appUrl?: string): url is URL {
  if (url === null)
    return false

  const { host } = url

  return host === requestUrl(request).host || host === configuredHost() || (appUrl !== undefined && host === URL.parse(appUrl)?.host)
}

// A fetch from an island wants a result; a plain form post goes back to the page it came from.
function isCall(request: Request): boolean {
  return request.headers.get('x-kay-action') === '1' || isFormCall(request)
}

function isFormCall(request: Request): boolean {
  return request.headers.get('x-kay-action') === FORM_CALL
}

// Where each post came from, worked out once however many of the post's stages ask.
const postedFromCache = new WeakMap<Request, string | null>()

// The page a post came from on this site: the one its form names when a refused post rendered it, else the one kay's script names, else its `Referer`.
export function postedFrom(request: Request): string | undefined {
  let from = postedFromCache.get(request)

  if (from === undefined)
    postedFromCache.set(request, from = fromWhere(request) ?? null)

  return from ?? undefined
}

function fromWhere(request: Request): string | undefined {
  const resolved = (named: string | null) => named === null ? null : URL.parse(named, request.url)
  const back = resolved(requestUrl(request).searchParams.get(BACK_PARAMETER))

  if (sameHost(request, back))
    return back.href

  const sent = resolved(request.headers.get(PAGE_HEADER))

  if (sameHost(request, sent))
    return sent.href

  const referer = request.headers.get('referer')

  return referer !== null && sameHost(request, URL.parse(referer)) ? referer : undefined
}

function backTo(request: Request): string {
  return postedFrom(request) ?? '/'
}

// The Elysia context, with what the app derives and resolves, is the action's `ctx.locals`.
async function runAction(action: ServerAction<TSchema, unknown>, context: { body: unknown, request: Request, server: Server | null }, options: ActionOptions, back: Back, read: { params: () => void, url: () => URL }): Promise<Response> {
  const { request } = context
  const state = guarded.get(request) ?? { jar: cookieJar(request), headers: new Headers() }
  const { jar, headers } = state
  let status = 200
  const ctx: ActionContext = {
    request,
    // The page's, as its guards read it, worked out on first use as the params are.
    get url() {
      return read.url()
    },
    locale: contextLocale(options),
    // Read on first use, so an action that never reads them runs from any page.
    get params() {
      if (!pageParams.has(request))
        read.params()

      return pageParams.get(request) ?? {}
    },
    get cookies() {
      return jar.cookies
    },
    // The app's derive and resolve hooks ran before this handler, so the context carries what `Register` declares.
    locals: context as unknown as Locals,
    headers,
    status: (code) => {
      status = code
    },
    ...stoppers(request),
    fail: <Data>(code: number, data?: Data) => failure(code, data as Data),
  }

  try {
    // An async iterable is taken as it is, as awaiting one that is also a thenable, a model's reply, would read it to its end before it could stream.
    const returned = action.handler(context.body, ctx)
    const result = isAsyncIterable(returned) ? returned : await returned

    // A string passed to `ctx.fail` is the form's message, read where a rate limit's is.
    if (isFailure(result))
      return await failed(request, headers, jar.cookies, { action: action.url, status: result.status, values: submittedValues(context.body), errors: typeof result.data === 'string' ? { '': result.data } : {}, data: result.data }, context.server, back)

    // A call reads a stream as it comes; a plain form post or an agent gets its last value, as a handler returning it would.
    const streams = isAsyncIterable(result) && isCall(request) && !isAgentCall(request)
    const answer = isAsyncIterable(result) ? await (streams ? started(result, request.signal) : lastOf(result, request.signal)) : result

    await countGoneThrough(action, request, context.server, options)

    return streams ? streamed(request, jar, headers, answer as AsyncIterable<unknown>, status, options) : succeeded(action, request, jar, headers, answer, status, options.base)
  }
  catch (error) {
    // Sent on after it went through, as to a thank-you page.
    if (error instanceof Redirect)
      await countGoneThrough(action, request, context.server, options)

    if (error instanceof Redirect || error instanceof Denied || error instanceof NotFound)
      return stopped(error, request, state, options)

    // The handler read `ctx.params` of a post from no page of its route.
    if (error instanceof Refusal)
      return error.response

    const refused = refusalOf(error)

    // A library's limit, such as kayjs-ai's, answers like the action's own rate limit.
    if (refused !== undefined) {
      if (refused.retryAfter !== undefined)
        headers.set('retry-after', String(refused.retryAfter))

      return failed(request, headers, jar.cookies, { action: action.url, status: refused.status, values: submittedValues(context.body), errors: { '': refusalMessage(action, refused) } }, context.server, back)
    }

    // A mistake, or a service the handler relies on gone down: logged as any server error, and told the visitor beside the form they keep, as a refusal is.
    reportServerError(error, request, options.onError)

    return failed(request, headers, jar.cookies, { action: action.url, status: 500, values: submittedValues(context.body), errors: { '': action.protection?.messages?.serverError ?? kayWord('kay.action.serverError') } }, context.server, back)
  }
}

// What the handler did is done, a mail sent maybe, so a store failing to count it is reported rather than answered 500, which would invite the visitor to post again.
async function countGoneThrough(action: ServerAction<TSchema, unknown>, request: Request, server: Server | null, { onError }: ActionOptions): Promise<void> {
  try {
    await countSucceeded(action, request, server)
  }
  catch (error) {
    reportServerError(error, request, onError)
  }
}

// A call gets the result; a plain form post goes back to the page it came from, which reads the result through `ctx.succeeded`.
function succeeded(action: ServerAction<TSchema, unknown>, request: Request, jar: CookieJar, headers: Headers, result: unknown, status: number, base = ''): Response {
  if (!isCall(request))
    writeSuccess(jar.cookies, { action: action.url, succeeded: true, data: result }, overHttps(request), base)

  jar.writeTo(headers)

  // An empty body reads back as `undefined`.
  if (isCall(request)) {
    headers.set('content-type', 'application/json')

    return new Response(result === undefined ? null : encodeOrExplain(result, `what ${action.url} returned`), { status, headers })
  }

  headers.set(redirectHeader(request), backTo(request))

  return new Response(null, { status: 303, headers })
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

// The client going away stops the iterable, an endless one included, as it stops a stream.
async function lastOf(source: AsyncIterable<unknown>, signal: AbortSignal): Promise<unknown> {
  const iterator = source[Symbol.asyncIterator]()
  const stop = () => void iterator.return?.()
  let last: unknown

  signal.addEventListener('abort', stop, { once: true })

  try {
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next())
      last = next.value
  }
  finally {
    signal.removeEventListener('abort', stop)
  }

  return last
}

// The iterable with its first value read, so what it throws or stops with before one answers as the handler would; it is stopped when the client goes away before reading on.
async function started(source: AsyncIterable<unknown>, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
  const iterator = source[Symbol.asyncIterator]()
  const stop = () => void iterator.return?.()

  let first: IteratorResult<unknown> | undefined

  signal.addEventListener('abort', stop, { once: true })

  try {
    first = await iterator.next()
  }
  catch (error) {
    signal.removeEventListener('abort', stop)

    throw error
  }

  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const next = first ?? await iterator.next()

        first = undefined

        if (next.done === true)
          signal.removeEventListener('abort', stop)

        return next
      },
      return: async (value?: unknown) => {
        signal.removeEventListener('abort', stop)

        return await iterator.return?.(value) ?? { done: true, value }
      },
    }),
  }
}

// A call to a handler returning an async iterable gets its values as server-sent events, `readActionResponse` reading them as a stream; a throw past the first value ends it as failed.
function streamed(request: Request, jar: CookieJar, headers: Headers, source: AsyncIterable<unknown>, status: number, { onError }: ActionOptions): Response {
  jar.writeTo(headers)
  headers.set('content-type', 'text/event-stream; charset=utf-8')
  headers.set('cache-control', 'no-cache')

  return new Response(eventBody(source, error => reportServerError(error, request, onError)), { status, headers })
}

// A bot the honeypot caught sees what a person whose post went through sees, the handler having returned nothing.
function pretended(action: ServerAction<TSchema, unknown>, request: Request, base = ''): Response {
  return succeeded(action, request, cookieJar(request), new Headers(), undefined, 200, base)
}

// A redirect or a denial goes out with the cookies set so far; anything else was a mistake, answered with a generic 500 since Elysia would send its message.
export function stopped(error: unknown, request: Request, { jar, headers }: GuardedRequest, { dev, onError }: ActionOptions): Response {
  if (error instanceof Redirect) {
    headers.set(redirectHeader(request), error.location)
    jar.writeTo(headers)

    return new Response(null, { status: error.status, headers })
  }

  if (error instanceof Denied || error instanceof NotFound) {
    headers.set('content-type', TEXT)
    jar.writeTo(headers)

    return error instanceof Denied ? new Response(error.message, { status: error.status, headers }) : new Response('Not Found', { status: 404, headers })
  }

  reportServerError(error, request, onError)

  return new Response(dev && error instanceof Error ? error.message : 'Internal Server Error', { status: 500, headers: { 'content-type': TEXT } })
}

// A result holding a function or a class instance is a mistake in the handler, logged with what it returned.
function encodeOrExplain(value: unknown, what: string): string {
  try {
    return encodeValue(value)
  }
  catch (error) {
    const reason = unsendable(error)

    throw reason === undefined ? error : new TypeError(`kay: ${what} cannot reach the browser: ${reason}`)
  }
}

// The formats Elysia gives its own string types, which a visitor does not name: a number, a boolean, an object or array in text, a file.
const INTERNAL_FORMATS = new Set(['boolean', 'ObjectString', 'ArrayString', 'binary'])

// Whether the pattern holds for the text; one a plain RegExp cannot compile is taken as failed, as the schema refused it.
function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text)
  }
  catch {
    return false
  }
}

// The `kay.invalid.*` text for what an issue refused, Elysia's own summary when the site words none; the limit it names goes in as `{min}` or `{max}`, a format as `{format}`.
function refusalText(issue: { summary?: string | undefined, schema?: unknown, value?: unknown }): string {
  const schema = (typeof issue.schema === 'object' && issue.schema !== null ? issue.schema : {}) as { minLength?: number, maxLength?: number, pattern?: string, format?: string, minimum?: number, maximum?: number, minItems?: number, maxItems?: number }
  const { value } = issue

  if (value === undefined)
    return invalidWord('kay.invalid.required', issue.summary)

  if (typeof value === 'string') {
    if (value === '' && schema.minLength === 1)
      return invalidWord('kay.invalid.required', issue.summary)

    if (schema.minLength !== undefined && value.length < schema.minLength)
      return invalidWord('kay.invalid.tooShort', issue.summary, { min: schema.minLength })

    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return invalidWord('kay.invalid.tooLong', issue.summary, { max: schema.maxLength })

    if (schema.pattern !== undefined && !matches(schema.pattern, value))
      return invalidWord('kay.invalid.pattern', issue.summary)

    if (schema.format !== undefined && !NUMERIC_FORMATS.has(schema.format) && !INTERNAL_FORMATS.has(schema.format))
      return invalidWord('kay.invalid.format', issue.summary, { format: schema.format })
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return invalidWord('kay.invalid.tooFewItems', issue.summary, { min: schema.minItems })

    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return invalidWord('kay.invalid.tooManyItems', issue.summary, { max: schema.maxItems })
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return invalidWord('kay.invalid.tooSmall', issue.summary, { min: schema.minimum })

    if (schema.maximum !== undefined && value > schema.maximum)
      return invalidWord('kay.invalid.tooBig', issue.summary, { max: schema.maximum })
  }

  return invalidWord('kay.invalid.type', issue.summary)
}

// Input the schema refused: a message per field, the schema's own `error` when it has one, a function `error` called in the request's locale.
async function refused(action: ServerAction<TSchema, unknown>, error: Readonly<ValidationError>, request: Request, server: Server | null, back: Back): Promise<Response> {
  const errors: Record<string, string> = {}

  for (const issue of error.all) {
    const field = 'path' in issue ? FIELD.exec(issue.path)?.[1] ?? '' : ''
    const own = 'schema' in issue ? (issue.schema as { error?: unknown }).error : undefined
    const custom = ('path' in issue ? fieldMessage(action.schema, issue.path) : undefined) ?? (typeof own === 'string' ? own : undefined)

    errors[field] ??= custom ?? refusalText(issue)
  }

  return failed(request, new Headers(), cookieJar(request).cookies, { action: action.url, status: 422, values: submittedValues(error.value), errors }, server, back)
}

// A call gets the failure as JSON; a plain form post gets the page it came from, rendered with the failure.
async function failed(request: Request, headers: Headers, cookies: CookieMap, flash: Flash, server: Server | null, back: Back): Promise<Response> {
  for (const cookie of cookies.toSetCookieHeaders())
    headers.append('set-cookie', cookie)

  if (!isCall(request))
    return back(request, headers, flash, server)

  headers.set('content-type', 'application/json')
  headers.set(FAILURE_HEADER, '1')

  return new Response(encodeOrExplain({ errors: flash.errors, data: flash.data }, `what ${flash.action} passed to ctx.fail`), { status: flash.status, headers })
}

// The page renders as for a visit, through the app, its guards and hooks included, and the failure reaches `ctx.failed` in memory, so all the visitor typed comes back whatever its length.
// It answers the post itself, with the failure's status: a reload posts again, as after any form a server answers in place, and without the page swap a `base` keeps relative links pointing where they did on the page.
async function renderBack(app: Elysia, base: string, request: Request, headers: Headers, flash: Flash, server: Server | null): Promise<Response> {
  const from = new URL(backTo(request), request.url)
  const path = routerPath(from.pathname, base)
  const sent = visitHeaders(request)
  const forget = handOver(sent, flash)
  let page: Response
  let html: string | undefined

  // Read through before the failure is forgotten: an `await` block streamed after the shell may read `ctx.failed` too.
  try {
    page = await visitAs(request, new Request(new URL(`${path}${from.search}`, request.url), { headers: sent }), server, async visit => app.handle(visit))

    if (page.ok && HTML.test(page.headers.get('content-type') ?? ''))
      html = await page.text()
  }
  finally {
    forget()
  }

  if (html === undefined) {
    for (const cookie of headers.getSetCookie())
      page.headers.append('set-cookie', cookie)

    return page
  }

  const swapped = request.headers.get(NAVIGATE_HEADER) === '1'
  const answer = new Headers(page.headers)

  for (const [name, value] of headers)
    answer.append(name, value)

  answer.delete('content-length')
  answer.delete('etag')
  answer.set('cache-control', 'private, no-store')
  answer.set(FAILURE_HEADER, '1')

  return new Response(swapped ? html : backedForms(html, from).replace(HEAD_START, tag => `${tag}<base href="${escapeAttribute(from.href)}">`), { status: flash.status, headers: answer })
}

// Each form posting to an action names the page, so a post refused again renders it again, and one that goes through goes back to it.
function backedForms(html: string, from: URL): string {
  const back = encodeURIComponent(from.pathname + from.search)

  return html.replace(FORM_ACTION, (_, start: string, url: string) => `${start}${url}${url.includes('?') ? '&amp;' : '?'}${BACK_PARAMETER}=${back}`)
}

// What the browser sent that a visit would send too, the post's body aside.
function visitHeaders(request: Request): Headers {
  const headers = new Headers(request.headers)

  for (const name of POST_HEADERS)
    headers.delete(name)

  headers.set('accept', 'text/html')

  return headers
}

// `fetch` and XMLHttpRequest would follow a `location` and hand the script the next page's HTML; a call, or a form the page swap posts, reads where to go instead.
function redirectHeader(request: Request): string {
  return isCall(request) || request.headers.get(NAVIGATE_HEADER) === '1' ? REDIRECT_HEADER : 'location'
}
