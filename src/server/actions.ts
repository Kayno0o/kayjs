import type { CookieMap } from 'bun'
import type { Elysia, TSchema, ValidationError } from 'elysia'
import type { KayConfig } from '../config'
import type { GuardContext, Locals } from '../runtime'
import type { ActionContext, ServerAction } from '../runtime/action'
import type { CookieJar } from './cookies'
import type { Flash } from './flash'
import type { LoadedGuard, ServedRoute } from './guards'
import { dirname, sep } from 'node:path'
import { decodeCall, failure, FAILURE_HEADER, isAction, isFailure, REDIRECT_HEADER } from '../runtime/action'
import { encodeValue, unsendable } from '../runtime/wire'
import { importModule } from './bundle'
import { cookieJar } from './cookies'
import { submittedValues, writeFlash, writeSuccess } from './flash'
import { runGuards } from './guards'
import { reportServerError } from './report'
import { Denied, Redirect } from './signals'

// What a top-level field's JSON schema says about the text a form posts for it.
interface FieldSchema {
  type?: unknown
  items?: FieldSchema
  format?: unknown
  pattern?: unknown
  minLength?: unknown
  anyOf?: FieldSchema[]
}

interface ActionRequest {
  jar: CookieJar
  headers: Headers
}

// Thrown before the input is validated, to answer with `response` through the route's error hook.
class Refusal {
  constructor(readonly response: Response) {}
}

// What the guards set on the response, carried to the handler they let through.
const guarded = new WeakMap<Request, ActionRequest>()
const TEXT = 'text/plain; charset=utf-8'
// What a post from the site's own pages carries in `Sec-Fetch-Site`; `none` is the user's own doing, such as a bookmark.
const SAME_SITE_FETCH = new Set(['same-origin', 'none'])
// The first proxy's `X-Forwarded-Proto` saying the browser came over https.
const FORWARDED_HTTPS = /^\s*https\s*(?:,|$)/i

// A checkbox posts `on` unless it has a value of its own.
const BOOLEAN_TEXT = new Map([['true', true], ['on', true], ['false', false]])
// A decimal number as a number input posts it; `Number()` alone would also read `0x10` or `Infinity`.
const DECIMAL = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i
// The string formats Elysia gives the numeric text `t.Integer()` and `t.Numeric()` also take.
const NUMERIC_FORMATS = new Set<unknown>(['integer', 'numeric'])

// The top-level field of a validation path such as `/address/street`.
const FIELD = /^\/([^/]*)/
// Elysia names a file it refuses `body.<field>`.
const BODY_PREFIX = /^body\./

export interface ActionOptions {
  // Shows a failed action's message instead of a generic one.
  dev?: boolean
  onError?: KayConfig['onError']
}

// Registers every action the pages and layouts export as a POST route whose body Elysia validates against the action's schema.
export async function registerActionRoutes(app: Elysia, routes: ServedRoute[], options: ActionOptions = {}): Promise<void> {
  const served = new Map<string, { file: string, action: ServerAction<TSchema, unknown> }>()

  for (const [file, guards] of actionFiles(routes)) {
    const module = await importModule<Record<string, unknown>>(file)

    for (const value of Object.values(module)) {
      if (!isAction(value))
        continue

      const taken = served.get(value.url)

      // One action exported under two names is served once.
      if (taken?.action === value)
        continue

      if (taken)
        throw new Error(`kay: ${taken.file} and ${file} both export an action served at ${value.url}; rename one of the files`)

      served.set(value.url, { file, action: value })
      app.post(value.url, async context => runAction(value, context, options), {
        body: value.schema,
        transform: (context) => {
          refuseCrossSite(context.request)

          context.body = isCall(context.request) ? callInput(context.body) : formInput(value.schema, withoutEmptyFiles(context.body))
        },
        // After validation, the one stage where the app's `resolve` values are there for `ctx.locals`.
        ...(guards.length > 0 && { beforeHandle: async (context: { request: Request }) => admit(guards, context, options) }),
        error: ({ code, error, request, body }) => {
          if (code === 'VALIDATION')
            return refused(value, error, request)

          // Elysia checks a top-level `t.File({ type })` against the file's bytes once the schema passed.
          if (code === 'INVALID_FILE_TYPE') {
            const field = error.property.replace(BODY_PREFIX, '')

            return failed(request, new Headers(), cookieJar(request).cookies, { action: value.url, status: 422, values: submittedValues(body), errors: { [field]: fieldError(value, field) ?? 'Invalid file type' } })
          }

          return error instanceof Refusal ? error.response : undefined
        },
      })
    }
  }
}

// Every page and layout once, with the guards of its own directory and above: a layout's actions are not behind the guards of the pages below it.
function actionFiles(routes: ServedRoute[]): Map<string, LoadedGuard[]> {
  const files = new Map<string, LoadedGuard[]>()

  for (const route of routes) {
    for (const file of [...route.layouts, route.file]) {
      if (!files.has(file))
        files.set(file, route.guards.filter(guard => file.startsWith(dirname(guard.file) + sep)))
    }
  }

  return files
}

// A form posts text, as a query string is, and each field once per value or not at all: a top-level field is read the way its schema expects before it is validated.
// `absentAsEmpty` reads a required list or boolean that is absent as empty or unticked, which only a form means by leaving it out.
export function formInput(schema: TSchema, body: unknown, absentAsEmpty = true): unknown {
  const { properties, required = [] } = schema as { properties?: Record<string, FieldSchema>, required?: string[] }

  if (!properties || typeof body !== 'object' || body === null)
    return body

  const fields: Record<string, unknown> = { ...body }

  for (const [name, field] of Object.entries(properties)) {
    const optional = !required.includes(name)
    const value = fields[name]

    if (value === undefined) {
      // A required list may well be empty, and an unticked checkbox posts nothing; a required file list is no file chosen, refused as missing.
      if (absentAsEmpty && !optional && ((field.type === 'array' && field.items?.format !== 'binary') || field.type === 'boolean'))
        fields[name] = field.type === 'array' ? [] : false

      continue
    }

    if (optional && value === '' && !acceptsBlank(field))
      delete fields[name]
    else if (field.type === 'array')
      fields[name] = (Array.isArray(value) ? value : [value]).map(item => fromText(field.items, item))
    else
      fields[name] = fromText(field, value)
  }

  return fields
}

// A blank input fills a plain string field; any other optional field reads it as left out.
function acceptsBlank(field: FieldSchema): boolean {
  return field.type === 'string' && field.format === undefined && field.pattern === undefined && !(typeof field.minLength === 'number' && field.minLength > 0)
}

// The number or boolean a field asks for, when the text reads as one; anything else is left for Elysia to refuse.
function fromText(field: FieldSchema | undefined, value: unknown): unknown {
  if (typeof value !== 'string')
    return value

  // Elysia would read the text with `Number()` itself, so text that is no decimal number becomes one the schema refuses.
  if (field !== undefined && isNumeric(field))
    return DECIMAL.test(value) ? Number(value) : Number.NaN

  return field?.type === 'boolean' ? BOOLEAN_TEXT.get(value) ?? value : value
}

// `t.Number()`, or `t.Integer()` and `t.Numeric()`, which Elysia writes as a number or a numeric string; `t.Date()` takes a number too, but not only.
function isNumeric(field: FieldSchema): boolean {
  return field.type === 'number' || field.type === 'integer' || (field.anyOf?.every(member => isNumeric(member) || NUMERIC_FORMATS.has(member.format)) ?? false)
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
// A browser names where a post comes from in `Origin`, and in `Sec-Fetch-Site` too, which it sends even when it leaves `Origin` out.
function refuseCrossSite(request: Request) {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')

  if ((origin !== null && !sameHost(request, origin)) || (site !== null && !SAME_SITE_FETCH.has(site)))
    throw new Refusal(new Response('Cross-site action refused', { status: 403 }))
}

// Over https, the flash cookie never travels in clear; behind a proxy, `X-Forwarded-Proto` says how the browser came.
function overHttps(request: Request): boolean {
  return new URL(request.url).protocol === 'https:' || FORWARDED_HTTPS.test(request.headers.get('x-forwarded-proto') ?? '')
}

// The guards of the action's page, answering for it when one stops the request.
async function admit(guards: LoadedGuard[], context: { request: Request }, options: ActionOptions): Promise<Response | undefined> {
  const { request } = context
  const state: ActionRequest = { jar: cookieJar(request), headers: new Headers() }
  const ctx: GuardContext = {
    request,
    url: new URL(request.url),
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

  if (refusal)
    return stopped(refusal.error, request, state, options)

  guarded.set(request, state)

  return undefined
}

// Hosts rather than origins: behind a TLS-terminating proxy the browser says https while the request arrives as http.
function sameHost(request: Request, url: string | null): url is string {
  return url !== null && URL.canParse(url) && new URL(url).host === new URL(request.url).host
}

// A fetch from an island wants a result; a plain form post goes back to the page it came from.
function isCall(request: Request): boolean {
  return request.headers.get('x-kay-action') === '1'
}

function backTo(request: Request): string {
  const referer = request.headers.get('referer')

  return sameHost(request, referer) ? referer : '/'
}

// The Elysia context, with what the app derives and resolves, is the action's `ctx.locals`.
async function runAction(action: ServerAction<TSchema, unknown>, context: { body: unknown, request: Request }, options: ActionOptions): Promise<Response> {
  const { request } = context
  const state = guarded.get(request) ?? { jar: cookieJar(request), headers: new Headers() }
  const { jar, headers } = state
  let status = 200
  const ctx: ActionContext = {
    request,
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

    if (isFailure(result))
      return failed(request, headers, jar.cookies, { action: action.url, status: result.status, values: submittedValues(context.body), errors: {}, data: result.data })

    if (!isCall(request))
      writeSuccess(jar.cookies, { action: action.url, succeeded: true, data: result }, overHttps(request))

    jar.writeTo(headers)

    // An empty body reads back as `undefined`.
    if (isCall(request)) {
      headers.set('content-type', 'application/json')

      return new Response(result === undefined ? null : encodeOrExplain(result, `what ${action.url} returned`), { status, headers })
    }

    headers.set('location', backTo(request))

    return new Response(null, { status: 303, headers })
  }
  catch (error) {
    return stopped(error, request, state, options)
  }
}

// A redirect or a denial goes out with the cookies set so far; anything else was a mistake, answered with a generic 500 since Elysia would send its message.
function stopped(error: unknown, request: Request, { jar, headers }: ActionRequest, { dev, onError }: ActionOptions): Response {
  if (error instanceof Redirect) {
    // `fetch` would follow a `location` and hand the island the next page's HTML; a call reads where to go instead.
    headers.set(isCall(request) ? REDIRECT_HEADER : 'location', error.location)
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
function refused(action: ServerAction<TSchema, unknown>, error: Readonly<ValidationError>, request: Request): Response {
  const errors: Record<string, string> = {}

  for (const issue of error.all) {
    const field = 'path' in issue ? FIELD.exec(issue.path)?.[1] ?? '' : ''
    const custom = 'schema' in issue ? (issue.schema as { error?: unknown }).error : undefined

    errors[field] ??= typeof custom === 'string' ? custom : issue.summary ?? 'Invalid value'
  }

  return failed(request, new Headers(), cookieJar(request).cookies, { action: action.url, status: 422, values: submittedValues(error.value), errors })
}

// A call gets the failure as JSON; a plain form post goes back to its page with the failure in a cookie.
function failed(request: Request, headers: Headers, cookies: CookieMap, flash: Flash): Response {
  const call = isCall(request)

  if (!call)
    writeFlash(cookies, flash, overHttps(request))

  for (const cookie of cookies.toSetCookieHeaders())
    headers.append('set-cookie', cookie)

  if (call) {
    headers.set('content-type', 'application/json')
    headers.set(FAILURE_HEADER, '1')

    return new Response(encodeOrExplain({ errors: flash.errors, data: flash.data }, `what ${flash.action} passed to ctx.fail`), { status: flash.status, headers })
  }

  headers.set('location', backTo(request))

  return new Response(null, { status: 303, headers })
}
