import type { CookieMap } from 'bun'
import type { Elysia, TSchema, ValidationError } from 'elysia'
import type { Server } from 'elysia/universal'
import type { KayConfig } from '../config'
import type { GuardContext, Locals, RouteParams } from '../runtime'
import type { ActionContext, ServerAction } from '../runtime/action'
import type { Locale } from '../runtime/i18n'
import type { BodyLimit } from './body'
import type { CookieJar } from './cookies'
import type { Flash } from './flash'
import type { LoadedGuard, ServedRoute } from './guards'
import type { I18n } from './i18n'
import { dirname, sep } from 'node:path'
import { decodeCall, failure, FORM_CALL, isAction, isFailure } from '../runtime/action'
import { escapeAttribute } from '../runtime/escape'
import { formInput } from '../runtime/form'
import { localeState, runInLocale } from '../runtime/locale-state'
import { configuredSite } from '../runtime/site'
import { FAILURE_HEADER, NAVIGATE_HEADER, PAGE_HEADER, REDIRECT_HEADER } from '../runtime/swap'
import { encodeValue, unsendable } from '../runtime/wire'
import { routerPath } from './base'
import { sizeText } from './body'
import { importModule } from './bundle'
import { cookieJar } from './cookies'
import { handOver, submittedValues, writeSuccess } from './flash'
import { runGuards } from './guards'
import { requestLocale, stateFor } from './i18n'
import { countSucceeded, PRETEND, protectionRefusal } from './protection'
import { reportServerError } from './report'
import { Denied, Redirect } from './signals'
import { answered, SERVER_SPAN, traced } from './trace'
import { visitAs } from './visit'

export interface GuardedRequest {
  jar: CookieJar
  headers: Headers
}

// Thrown before the input is validated, to answer with `response` through the route's error hook.
class Refusal {
  constructor(readonly response: Response | Promise<Response>) {}
}

// What the guards set on the response, carried to the handler they let through.
const guarded = new WeakMap<Request, GuardedRequest>()
// The params of the page each post came from, read by its guards and its action alike.
const pageParams = new WeakMap<Request, RouteParams>()
const TEXT = 'text/plain; charset=utf-8'
// What a visitor reads when the handler throws and its action words nothing of its own.
const SERVER_ERROR = 'Something went wrong on our side; try again later'
// What a post from the site's own pages carries in `Sec-Fetch-Site`; `none` is the user's own doing, such as a bookmark.
const SAME_SITE_FETCH = new Set(['same-origin', 'none'])
// The first proxy's `X-Forwarded-Proto` saying the browser came over https.
const FORWARDED_HTTPS = /^\s*https\s*(?:,|$)/i

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
  // An action runs in the locale of the page it was sent from, or the site's one language without `i18n`.
  i18n: I18n
  // Where the site is mounted, which the page a refused form post came from is served under.
  base?: string | undefined
}

// The params `path` gives the route, under any locale's pattern; undefined when the route does not serve it.
export type RouteMatch = (route: ServedRoute, path: string) => Record<string, unknown> | undefined

// Renders the page a refused plain form post came from, with how it failed, through the app the post reached.
type Back = (request: Request, headers: Headers, flash: Flash, server: Server | null) => Promise<Response>

// Registers every action the pages and layouts export as a POST route whose body Elysia validates against the action's schema, giving back the body limit of each by its path.
export async function registerActionRoutes(app: Elysia, routes: ServedRoute[], match: RouteMatch, options: ActionOptions): Promise<Map<string, BodyLimit>> {
  const back: Back = async (request, headers, flash, server) => renderBack(app, options.base ?? '', request, headers, flash, server)
  const served = new Map<string, { file: string, action: ServerAction<TSchema, unknown> }>()
  const limits = new Map<string, BodyLimit>()

  for (const [file, { guards, ...page }] of actionFiles(routes)) {
    const module = await importModule<Record<string, unknown>>(file)

    for (const value of Object.values(module)) {
      if (!isAction(value))
        continue

      const taken = served.get(value.url)

      // One action exported under two names is served once.
      if (taken?.action === value)
        continue

      if (taken)
        throw actionClash(taken.file, file, value.url)

      served.set(value.url, { file, action: value })
      limits.set(value.url, { bytes: value.protection?.bodyLimit, refuse: async (request, bytes, server) => tooLarge(value, request, bytes, server, back) })
      // A span per call, the handler's own spans and the page it renders back nested in it.
      app.post(value.url, async context => traced(`POST ${value.url}`, { kind: SERVER_SPAN, attributes: { 'http.request.method': 'POST', 'http.route': value.url, 'url.path': value.url } }, async (span) => {
        const response = await inLocale(context.request, options, async () => runAction(value, context, options, back, () => readPage(context.request, page, match, options)))

        if (span)
          answered(span, response.status)

        return response
      }), {
        body: value.schema,
        transform: async (context) => {
          refuseCrossSite(context.request)

          // Guards may check the params, so a post from no page of the file never reaches them; without guards, only an action reading `ctx.params` needs its page.
          if (guards.length > 0)
            readPage(context.request, page, match, options)

          const call = isCall(context.request)
          // A call may send a form's fields, read as a plain form post's are.
          const asForm = !call || isFormCall(context.request)
          const refusal = await protectionRefusal(value, context.request, context.body, asForm, context.server, !call)

          if (refusal === PRETEND)
            throw new Refusal(pretended(value, context.request))

          // Before the schema reads the input: every attempt counts, a valid one or not.
          if (refusal)
            throw new Refusal(failed(context.request, new Headers(refusal.headers), cookieJar(context.request).cookies, { action: value.url, status: refusal.status, values: call ? {} : submittedValues(context.body), errors: { [refusal.field]: refusal.message } }, context.server, back))

          context.body = asForm ? formInput(value.schema, withoutEmptyFiles(context.body)) : callInput(context.body)
        },
        // After validation, the one stage where the app's `resolve` values are there for `ctx.locals`.
        ...(guards.length > 0 && { beforeHandle: async (context: { request: Request }) => inLocale(context.request, options, async () => admit(guards, context, pageParams.get(context.request) ?? {}, options)) }),
        error: async ({ code, error, request, body, server, set }) => {
          if (code === 'VALIDATION')
            return refused(value, error, request, server, back)

          // Elysia checks a top-level `t.File({ type })` against the file's bytes once the schema passed.
          if (code === 'INVALID_FILE_TYPE') {
            const field = error.property.replace(BODY_PREFIX, '')

            return failed(request, new Headers(), cookieJar(request).cookies, { action: value.url, status: 422, values: submittedValues(body), errors: { [field]: fieldError(value, field) ?? 'Invalid file type' } }, server, back)
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

  return limits
}

// A post over the action's body limit, answered as a refused one is, with a message for the whole form; another site's is refused as such.
async function tooLarge(action: ServerAction<TSchema, unknown>, request: Request, bytes: number, server: Server | null, back: Back): Promise<Response> {
  if (isCrossSite(request))
    return crossSiteRefusal()

  const message = action.protection?.messages?.bodyLimit ?? (most => `Too large to send; ${sizeText(most)} at most`)

  return failed(request, new Headers(), cookieJar(request).cookies, { action: action.url, status: 413, values: {}, errors: { '': typeof message === 'string' ? message : message(bytes) } }, server, back)
}

// Two files whose paths differ only where a URL keeps neither, `a b.kay` and `a_b.kay`, serve their actions at one URL.
export function actionClash(first: string, second: string, url: string): Error {
  return new Error(`kay: ${first} and ${second} both export an action served at ${url}; rename one of the files`)
}

// What an action file is posted from: a page of `routes`, read for the `params` they all name.
interface ActionPage {
  routes: ServedRoute[]
  params: string[]
}

// Every page and layout once, with the guards of its own directory and above: a layout's actions are not behind the guards of the pages below it.
// A page's actions read its params, a layout's those of every page it wraps.
function actionFiles(routes: ServedRoute[]): Map<string, ActionPage & { guards: LoadedGuard[] }> {
  const files = new Map<string, ActionPage & { guards: LoadedGuard[] }>()

  for (const route of routes) {
    for (const file of [...route.layouts, route.file]) {
      const known = files.get(file)

      if (known) {
        known.routes.push(route)
        known.params = known.params.filter(name => route.params.includes(name))

        continue
      }

      files.set(file, { guards: route.guards.filter(guard => file.startsWith(dirname(guard.file) + sep)), routes: [route], params: route.params })
    }
  }

  return files
}

// The params of the page the post came from, kept for its guards and its action; a post reading params whose page is not one of the file's, or names none, is refused, before anything runs when guards cover the file, so no guard checking them is ever skipped.
function readPage(request: Request, page: ActionPage, match: RouteMatch, { base = '' }: ActionOptions): void {
  // Nothing to read, so the project's matchers never run on a page that has nothing to do with the action.
  if (page.params.length === 0)
    return

  const from = postedFrom(request)
  const path = routerPath(new URL(from ?? '/', request.url).pathname, base)

  for (const route of from === undefined ? [] : page.routes) {
    const params = match(route, path)

    if (params) {
      pageParams.set(request, Object.fromEntries(Object.entries(params).filter(([name]) => page.params.includes(name))))

      return
    }
  }

  throw new Refusal(new Response('Action posted from no page of its route', { status: 400, headers: { 'content-type': TEXT } }))
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

// The `error` option the schema gives a top-level field, when it is a string.
function fieldError(action: ServerAction<TSchema, unknown>, field: string): string | undefined {
  const error = (action.schema as { properties?: Record<string, { error?: unknown }> }).properties?.[field]?.error

  return typeof error === 'string' ? error : undefined
}

// A file input left empty still posts a nameless, empty file; dropping it lets `t.Optional(t.File())` see no file at all.
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
    throw new Refusal(crossSiteRefusal())
}

function crossSiteRefusal(): Response {
  return new Response('Cross-site action refused', { status: 403 })
}

// A browser names where a request comes from in `Origin`, and in `Sec-Fetch-Site` too, which it sends even when it leaves `Origin` out.
export function isCrossSite(request: Request): boolean {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')

  return (origin !== null && !sameHost(request, origin)) || (site !== null && !SAME_SITE_FETCH.has(site))
}

// Over https, kay's cookies never travel in clear; behind a proxy, `X-Forwarded-Proto` says how the browser came.
export function overHttps(request: Request): boolean {
  return new URL(request.url).protocol === 'https:' || FORWARDED_HTTPS.test(request.headers.get('x-forwarded-proto') ?? '')
}

export function inLocale<T>(request: Request, options: ActionOptions, run: () => T): T {
  const locale = requestLocale(options.i18n.settings, request, postedFrom(request) ?? null)

  return runInLocale(stateFor(options.i18n, locale, new URL(request.url).pathname, request), run)
}

// What `ctx.locale` reads: the request's locale, or the site's single language.
function contextLocale(): Locale {
  // eslint-disable-next-line ts/no-unnecessary-type-assertion -- Locale is a string in kay itself and an app's own locales once its Register names them
  return (localeState()?.locale ?? '') as Locale
}

// The guards of the action's page, answering for it when one stops the request.
async function admit(guards: LoadedGuard[], context: { request: Request }, params: RouteParams, options: ActionOptions): Promise<Response | undefined> {
  const passed = await passGuards(guards, context, params, options)

  if (passed instanceof Response)
    return passed

  guarded.set(context.request, passed)

  return undefined
}

// Runs the guards of an action or an API route: the response when one stops the request, else the cookies and headers they set.
export async function passGuards(guards: LoadedGuard[], context: { request: Request }, params: RouteParams, options: ActionOptions): Promise<Response | GuardedRequest> {
  const { request } = context
  const state: GuardedRequest = { jar: cookieJar(request), headers: new Headers() }
  const ctx: GuardContext = {
    request,
    url: new URL(request.url),
    locale: contextLocale(),
    params,
    get cookies() {
      return state.jar.cookies
    },
    locals: context as unknown as Locals,
    headers: state.headers,
    redirect: (location, code = 303) => {
      throw new Redirect(location, code)
    },
    deny: (code = 403, message) => {
      throw new Denied(code, message)
    },
  }
  const refusal = await runGuards(guards, ctx)

  return refusal ? stopped(refusal.error, request, state, options) : state
}

// Hosts rather than origins: behind a TLS-terminating proxy the browser says https while the request arrives as http. The host of `site` in kay.config.ts counts too, for a proxy that does not pass the browser's `Host` on.
function sameHost(request: Request, url: string | null): url is string {
  if (url === null || !URL.canParse(url))
    return false

  const { host } = new URL(url)
  const site = configuredSite()

  return host === new URL(request.url).host || (site !== undefined && host === new URL(site.origin).host)
}

// A fetch from an island wants a result; a plain form post goes back to the page it came from.
function isCall(request: Request): boolean {
  return request.headers.get('x-kay-action') === '1' || isFormCall(request)
}

function isFormCall(request: Request): boolean {
  return request.headers.get('x-kay-action') === FORM_CALL
}

// The page a post came from on this site: the one its form names when a refused post rendered it, else the one kay's script names, else its `Referer`.
function postedFrom(request: Request): string | undefined {
  const page = (named: string | null) => named !== null && URL.canParse(named, request.url) ? new URL(named, request.url).href : null
  const back = page(new URL(request.url).searchParams.get(BACK_PARAMETER))
  const sent = page(request.headers.get(PAGE_HEADER))
  const referer = request.headers.get('referer')

  if (sameHost(request, back))
    return back

  if (sameHost(request, sent))
    return sent

  return sameHost(request, referer) ? referer : undefined
}

function backTo(request: Request): string {
  return postedFrom(request) ?? '/'
}

// The Elysia context, with what the app derives and resolves, is the action's `ctx.locals`.
async function runAction(action: ServerAction<TSchema, unknown>, context: { body: unknown, request: Request, server: Server | null }, options: ActionOptions, back: Back, readParams: () => void): Promise<Response> {
  const { request } = context
  const state = guarded.get(request) ?? { jar: cookieJar(request), headers: new Headers() }
  const { jar, headers } = state
  let status = 200
  const ctx: ActionContext = {
    request,
    locale: contextLocale(),
    // Read on first use, so an action that never reads them runs from any page.
    get params() {
      if (!pageParams.has(request))
        readParams()

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
    redirect: (location, code = 303) => {
      throw new Redirect(location, code)
    },
    fail: <Data>(code: number, data?: Data) => failure(code, data as Data),
  }

  try {
    const result = await action.handler(context.body, ctx)

    // A string passed to `ctx.fail` is the form's message, read where a rate limit's is.
    if (isFailure(result))
      return await failed(request, headers, jar.cookies, { action: action.url, status: result.status, values: submittedValues(context.body), errors: typeof result.data === 'string' ? { '': result.data } : {}, data: result.data }, context.server, back)

    await countGoneThrough(action, request, context.server, options)

    return succeeded(action, request, jar, headers, result, status)
  }
  catch (error) {
    // Sent on after it went through, as to a thank-you page.
    if (error instanceof Redirect)
      await countGoneThrough(action, request, context.server, options)

    if (error instanceof Redirect || error instanceof Denied)
      return stopped(error, request, state, options)

    // The handler read `ctx.params` of a post from no page of its route.
    if (error instanceof Refusal)
      return error.response

    // A mistake, or a service the handler relies on gone down: logged as any server error, and told the visitor beside the form they keep, as a refusal is.
    reportServerError(error, request, options.onError)

    return failed(request, headers, jar.cookies, { action: action.url, status: 500, values: submittedValues(context.body), errors: { '': action.protection?.messages?.serverError ?? SERVER_ERROR } }, context.server, back)
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
function succeeded(action: ServerAction<TSchema, unknown>, request: Request, jar: CookieJar, headers: Headers, result: unknown, status: number): Response {
  if (!isCall(request))
    writeSuccess(jar.cookies, { action: action.url, succeeded: true, data: result }, overHttps(request))

  jar.writeTo(headers)

  // An empty body reads back as `undefined`.
  if (isCall(request)) {
    headers.set('content-type', 'application/json')

    return new Response(result === undefined ? null : encodeOrExplain(result, `what ${action.url} returned`), { status, headers })
  }

  headers.set(redirectHeader(request), backTo(request))

  return new Response(null, { status: 303, headers })
}

// A bot the honeypot caught sees what a person whose post went through sees, the handler having returned nothing.
function pretended(action: ServerAction<TSchema, unknown>, request: Request): Response {
  return succeeded(action, request, cookieJar(request), new Headers(), undefined, 200)
}

// A redirect or a denial goes out with the cookies set so far; anything else was a mistake, answered with a generic 500 since Elysia would send its message.
function stopped(error: unknown, request: Request, { jar, headers }: GuardedRequest, { dev, onError }: ActionOptions): Response {
  if (error instanceof Redirect) {
    headers.set(redirectHeader(request), error.location)
    jar.writeTo(headers)

    return new Response(null, { status: error.status, headers })
  }

  if (error instanceof Denied) {
    headers.set('content-type', TEXT)
    jar.writeTo(headers)

    return new Response(error.message, { status: error.status, headers })
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

// Input the schema refused: a message per field, the schema's own `error` when it has one.
async function refused(action: ServerAction<TSchema, unknown>, error: Readonly<ValidationError>, request: Request, server: Server | null, back: Back): Promise<Response> {
  const errors: Record<string, string> = {}

  for (const issue of error.all) {
    const field = 'path' in issue ? FIELD.exec(issue.path)?.[1] ?? '' : ''
    const custom = 'schema' in issue ? (issue.schema as { error?: unknown }).error : undefined

    errors[field] ??= typeof custom === 'string' ? custom : issue.summary ?? 'Invalid value'
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
