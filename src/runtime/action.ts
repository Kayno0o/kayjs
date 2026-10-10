import type { CookieMap } from 'bun'
import type { Static, TSchema } from 'elysia'
import type { ErrorStatus, Locals, Redirect } from './checks'
import type { Duration } from './duration'
import type { Locale } from './i18n'
import { withBase } from './base'
import { durationSeconds } from './duration'
import { escapeAttribute } from './escape'
import { createSignal, undoable, untrack } from './reactive'
import { sendValue } from './send'
import { FAILURE_HEADER, prefetched, REDIRECT_HEADER, swapState } from './swap'
import { decodeValue, unflattenValue } from './wire'

const ACTION = Symbol.for('kay.action')
const DAY = 86_400
const FAILURE = Symbol.for('kay.failure')

// Type only: what the handler returns, failures included, so a page can type `ctx.failed(action)`.
declare const RESULT: unique symbol
// Type only: the honeypot field an action's forms render, which `kay check` then takes as one of their fields.
declare const HONEYPOT: unique symbol
const UNSAFE_URL_CHARACTERS = /[^\w/.-]/g

// Where the server writes the post a page with islands was rendered in answer to.
export const OUTCOME_SCRIPT = 'data-kay-outcome'

// A call whose input holds files goes as multipart: the encoded input in one part, each file in part `FILE_MARK + n`, where the input holds its index.
export const INPUT_PART = '$kay'
export const FILE_MARK = '$kayFile'
const FILE_TYPE = 'KayFile'
const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

// The `x-kay-action` of a call whose input is a form's fields rather than encoded.
export const FORM_CALL = 'form'

export interface EncodedCall {
  headers: Record<string, string>
  body: string | FormData
}

// Where rate limits count, shared by every process opening it: `sqliteRates` from `kay/server`, or one of an app's own.
export interface RateStore {
  // Counts one more attempt under `key`, opening a window of `windowMs` when none is open: the attempts in it so far, this one included, and when it closes, in ms since the epoch.
  hit: (key: string, windowMs: number) => RateWindow | Promise<RateWindow>
  // The window open under `key` without counting an attempt, undefined when none is: what a limit counting only the posts that went through reads before the handler runs.
  peek?: (key: string) => RateWindow | undefined | Promise<RateWindow | undefined>
}

export interface RateWindow {
  count: number
  resetAt: number
}

export interface RateLimit {
  max: number
  window: Duration
  // In this process's memory unless given.
  store?: RateStore | undefined
}

export interface ActionRateLimit extends RateLimit {
  // `'succeeded'` counts only the posts whose handler returned without `ctx.fail` or an error, so typos and a failing mail server lock no one out; every attempt counts unless given. Posts arriving together all read the count before any adds to it, so a burst may pass `max` by a few: pair it with a limit on every attempt.
  count?: 'succeeded' | undefined
}

export interface HoneypotOptions<Field extends string = string> {
  field: Field
  // Answers a bot filling the field in as if its post went through, the handler never running, rather than refusing it.
  pretend?: boolean | undefined
}

export type MinTimeRefusal = 'early' | 'expired'

export interface MinTimeOptions {
  // The least time between the page rendering the form and its post, seconds or a string such as '3s'.
  after: Duration
  // The most, past which a post is refused as sent from a page left open too long or a copied stamp: a day by default.
  maxAge?: Duration | undefined
  // Answers a post sent too soon as if it went through, the handler never running, rather than refusing it.
  pretend?: boolean | undefined
}

export interface ActionProtection<Field extends string = never> {
  // At most `max` posts from one client every `window`, seconds or a string such as '1m'; past that a post fails with 429 without reaching the handler. `store` shares the count between processes.
  // Several limits all apply, such as one on every attempt and a tighter one on the posts that went through.
  rateLimit?: ActionRateLimit | ActionRateLimit[] | undefined
  // A field a form posting to the action renders out of sight by itself, which people leave empty and bots fill in; a post filling it fails with 422 without reaching the handler.
  honeypot?: Field | HoneypotOptions<Field> | undefined
  // The least time a person takes to fill the form in, `'3s'`: a form posting to the action carries a signed stamp of when it rendered, and a post sooner than this, or with a stamp missing, forged or too old, fails with 422 without reaching the handler.
  minTime?: Duration | MinTimeOptions | undefined
  // The most bytes a post may send, files included, in place of the app's `bodyLimit`; a bigger one fails with 413 before it is read.
  bodyLimit?: number | undefined
  // What the visitor reads when one of these refuses a post, in place of kay's English, as a schema's `error` is for a field.
  messages?: ProtectionMessages | undefined
}

export interface ProtectionMessages {
  // Given the seconds until the client may post again.
  rateLimit?: (string | ((wait: number) => string)) | undefined
  honeypot?: string | undefined
  // Given `early` for a post sent sooner than `minTime`, `expired` for a stamp missing, forged or past `maxAge`.
  minTime?: (string | ((reason: MinTimeRefusal) => string)) | undefined
  // Given the most bytes a post may send.
  bodyLimit?: (string | ((bytes: number) => string)) | undefined
  // When the handler throws, a service it sends to being down say: the error is logged, and the visitor reads this instead.
  serverError?: string | undefined
}

export interface ActionContext {
  request: Request
  // The locale of the page the action was sent from, as `i18n` in kay.config.ts serves it; empty without.
  locale: Locale
  cookies: CookieMap
  locals: Locals
  // Response status and headers, for a fetch call or the redirect after a plain form post.
  status: (code: number) => void
  headers: Headers
  redirect: Redirect
  // `return ctx.fail(409, { message: 'Taken' })`: a plain form post gets its page rendered again, which reads it through `ctx.failed(action)`; a call throws an `ActionError` carrying `data`. A string is also the form's message, under `errors['']`.
  fail: <const Data = undefined, const Status extends number = number>(status: Status & ErrorStatus<Status>, data?: Data) => Failure<Data>
}

export interface Failure<Data> {
  readonly [FAILURE]: true
  readonly status: number
  readonly data: Data
}

export type Success<Output> = Exclude<Output, Failure<unknown>>
// Unknown for an action of any output, so any action passes where `Action<never, unknown>` is expected.
export type FailureData<Output> = unknown extends Output ? unknown : Output extends Failure<infer Data> ? Data : never

// What a page reads back through `ctx.failed(action)` after a plain form post failed.
export interface FormFailure<Input, Data, Honeypot extends string = never> {
  status: number
  // What the form posted, so its fields can show it again; fields named like a password or a secret are left out.
  values: Partial<Record<Extract<keyof Input, string>, string>>
  // A message per field the schema refused or the honeypot caught, and under '' one for the whole form, as a rate limit's refusal.
  errors: Partial<Record<Extract<keyof Input, string> | Honeypot | '', string>>
  // What the handler passed to `ctx.fail`; undefined when the schema refused the input.
  data?: Data
}

// Read off the phantom directly: `infer Output` through `Action` drops the `undefined` of a handler ending without a return.
export type ResultOf<Target> = Target extends { readonly [RESULT]?: infer Output } ? Output : never

export type FailureOf<Target> = Target extends Action<infer Input, unknown> ? FormFailure<Input, FailureData<ResultOf<Target>>, Extract<HoneypotOf<Target>, string>> : never

// What a page reads back through `ctx.succeeded(action)` after a plain form post succeeded.
export interface FormSuccess<Output> {
  // What the handler returned.
  data: Output
}

export type SuccessOf<Target> = Target extends Action<never, unknown> ? FormSuccess<Awaited<ReturnType<Target>>> : never

// How a post to an action went: a refusal, or what its handler returned.
export type Outcome
  = | { action: string, succeeded?: undefined, status: number, values: Record<string, string>, errors: Record<string, string>, data?: unknown }
    | { action: string, succeeded: true, data: unknown }

// On the server, the form post the request being answered carries: null for none, undefined outside a request.
let requestOutcome: (() => Outcome | null | undefined) | undefined

export function setRequestOutcome(read: () => Outcome | null | undefined): void {
  requestOutcome = read
}

export interface CallOptions {
  // Whether the page shows what the call changed once it succeeded, its loads run again as `refresh()` runs them; on unless `false`, and only where the page swap runs.
  refresh?: boolean | undefined
  // Shows the change at once, as the call goes: the signals it writes go back to what they held if the call fails, unless something wrote them since.
  optimistic?: (() => void) | undefined
}

// Called from the browser it posts its input and resolves with the handler's result; `form(action={...})` posts to `url`.
export interface Action<Input, Output, Honeypot extends string = never> {
  (input: Input, options?: CallOptions): Promise<Success<Output>>
  // A form's fields, read as a plain form post reads them: `add(new FormData(form))`. Last, so `infer` and the editor read the typed input above, while `Parameters<typeof add>` reads this one.
  (form: FormData, options?: CallOptions): Promise<Success<Output>>
  // Whether a call this page made is still in flight, read reactively: `button(disabled={add.pending()})`.
  readonly pending: () => boolean
  // How the form post the page renders for went, refused, as `ctx.failed` reads it; in an island, how its last call went, read reactively.
  readonly failed: () => FormFailure<Input, FailureData<Output>, Honeypot> | undefined
  readonly succeeded: () => FormSuccess<Success<Output>> | undefined
  // The message a refused post got for one field, or for the whole form under ''; a method, so any action still passes where `Action<never, unknown>` is expected.
  // eslint-disable-next-line ts/method-signature-style
  error(field?: Extract<keyof Input, string> | Honeypot | ''): string | undefined
  readonly url: string
  readonly [ACTION]: true
  readonly [RESULT]?: Output
  // Taking the field rather than giving it, so an action with a honeypot still passes where any action is expected.
  [HONEYPOT]?: (field: Honeypot) => void
}

export interface ServerAction<Schema extends TSchema, Output, Honeypot extends string = never> extends Action<Static<Schema>, Output, Honeypot> {
  readonly schema: Schema
  readonly handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>
  readonly protection?: ActionProtection<string>
}

export class ActionError extends Error {
  override name = 'ActionError'

  // `errors` holds a message per field the schema refused, `data` what the handler passed to `ctx.fail`.
  constructor(readonly status: number, readonly body: string, readonly errors: Record<string, string> = {}, readonly data?: unknown, message = `Action failed with ${status}: ${body}`) {
    super(message)
  }
}

// Thrown by a call whose action redirected, where there is no browser to send: a test, a script.
export class ActionRedirect extends ActionError {
  override name = 'ActionRedirect'

  constructor(status: number, readonly location: string) {
    super(status, `Redirected to ${location}`, {}, undefined, `Action redirected with ${status} to ${location}`)
  }
}

export function failure<Data>(status: number, data: Data): Failure<Data> {
  // A call reads a success status as the handler's result, so a failure must not carry one.
  if (!Number.isInteger(status) || status < 400 || status > 599)
    throw new RangeError(`kay: ctx.fail takes an error status, from 400 to 599, not ${status}`)

  return { [FAILURE]: true, status, data }
}

export function isFailure(value: unknown): value is Failure<unknown> {
  return typeof value === 'object' && value !== null && FAILURE in value
}

export function actionUrl(moduleId: string, name: string): string {
  return `/_kay/action/${moduleId.replace(UNSAFE_URL_CHARACTERS, '_')}/${name}`
}

// Declares a server action in a page's `--- server` fence: Elysia validates the input against `schema` before `handler` runs.
export function action<Schema extends TSchema, Output, const Honeypot extends string = never>(schema: Schema, handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>, protection?: ActionProtection<Honeypot>): ServerAction<Schema, Awaited<Output>, Honeypot> {
  // Refused as the module loads, rather than on the first post.
  if (protection?.minTime !== undefined)
    minTimeOf(protection)

  for (const limit of [protection?.rateLimit ?? []].flat()) {
    durationSeconds(limit.window, 'rateLimit.window')

    if (limit.count === 'succeeded' && limit.store && !limit.store.peek)
      throw new Error('kay: a rateLimit counting only the posts that went through reads its count before the handler runs, so its store needs a peek(key) method')
  }

  const state = { url: '' }
  const { call, reads } = callable(() => state.url)

  return Object.defineProperties(call, {
    ...reads,
    url: { get: () => state.url, set: (url: string) => void (state.url = url), enumerable: true },
    schema: { value: schema, enumerable: true },
    handler: { value: handler, enumerable: true },
    protection: { value: protection, enumerable: true },
    [ACTION]: { value: true },
  }) as unknown as ServerAction<Schema, Awaited<Output>, Honeypot>
}

// What a browser build exports in place of a server action.
export function actionStub(url: string): Action<unknown, unknown> {
  const { call, reads } = callable(() => url)

  return Object.defineProperties(call, {
    ...reads,
    url: { value: url, enumerable: true },
    [ACTION]: { value: true },
  }) as unknown as Action<unknown, unknown>
}

export function isAction(value: unknown): value is ServerAction<TSchema, unknown> {
  return typeof value === 'function' && ACTION in value
}

// Gives every action a page module exports the URL the server registers it under.
export function registerActions(moduleId: string, exports: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(exports)) {
    if (isAction(value))
      (value as { url: string }).url = actionUrl(moduleId, name)
  }
}

// The actions the forms of the page being rendered post to, for the server to send their schemas along; set while it renders.
let renderedForms: Set<Action<never, unknown>> | undefined

export function collectForms<T>(render: () => T): { result: T, forms: Set<Action<never, unknown>> } {
  const forms = new Set<Action<never, unknown>>()
  const previous = renderedForms

  renderedForms = forms

  try {
    return { result: render(), forms }
  }
  finally {
    renderedForms = previous
  }
}

export function formAction(target: string | Action<never, unknown>): string {
  if (typeof target === 'string')
    return target

  renderedForms?.add(target)

  return target.url
}

export type FieldName<Target> = Target extends Action<infer Input, unknown> ? Extract<keyof Input, string> | HoneypotOf<Target> : string

type HoneypotOf<Target> = Target extends { [HONEYPOT]?: (field: infer Field) => void } ? Field : never

// An action as the fields of a form posting to it read it, whatever its input.
type FormTarget = Action<Record<string, unknown>, unknown>

// What a refused post sent for a field of a form posting to `target`, to show it again; undefined without one, and for the honeypot.
export function formValue(target: unknown, name: string): string | undefined {
  if (!isAction(target) || name === honeypotField(target.protection))
    return undefined

  return untrack((target as FormTarget).failed)?.values[name]
}

// The field carrying when a form posting to an action with `minTime` rendered.
export const STAMP_FIELD = 'kay_since'

// Signs that stamp, or gives back the one a refused post sent while it is still good; the server sets it, holding the secret.
let stamper: ((action: string, sent: string | undefined, maxAge: number) => string) | undefined

// What a form posting to `target` renders besides its own fields: the honeypot, out of sight and out of reach of the keyboard, screen readers and password managers, whose autofill would otherwise refuse a person, and the stamp `minTime` reads.
export function formProtection(target: unknown): string {
  if (!isAction(target))
    return ''

  const field = honeypotField(target.protection)
  const honeypot = field === undefined ? '' : `<div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true" inert><input name="${escapeAttribute(field)}" type="text" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>`

  if (target.protection?.minTime === undefined || !stamper)
    return honeypot

  // A refused post keeps the time its form rendered at, so the visitor is not sent back to zero.
  const sent = untrack((target as FormTarget).failed)?.values[STAMP_FIELD]

  return `${honeypot}<input type="hidden" name="${STAMP_FIELD}" value="${escapeAttribute(stamper(target.url, sent, minTimeOf(target.protection)!.maxAge))}">`
}

export function setStamper(sign: typeof stamper): void {
  stamper = sign
}

// `minTime` in milliseconds, read once it is set.
export function minTimeOf(protection: ActionProtection<string>): { after: number, maxAge: number, pretend: boolean } | undefined {
  const { minTime } = protection

  if (minTime === undefined)
    return undefined

  const options = typeof minTime === 'object' ? minTime : { after: minTime }

  return { after: durationSeconds(options.after, 'minTime') * 1000, maxAge: durationSeconds(options.maxAge ?? DAY, 'minTime.maxAge') * 1000, pretend: options.pretend === true }
}

export function honeypotField(protection: ActionProtection<string> | undefined): string | undefined {
  const honeypot = protection?.honeypot

  return typeof honeypot === 'object' ? honeypot.field : honeypot
}

// Whether a checkbox or radio button was ticked in a refused post; undefined without one. One with no `value` posts `on`, read as `true` by a boolean field.
export function formChecked(target: unknown, name: string, value: unknown): boolean | undefined {
  const posted = isAction(target) ? untrack((target as FormTarget).failed)?.values : undefined

  // A refusal that read no field, such as a body too large, has nothing to tick or untick.
  if (!posted || Object.keys(posted).length === 0)
    return undefined

  return value === undefined ? posted[name] !== undefined && posted[name] !== 'false' : posted[name] === String(value)
}

// `aria-invalid` for a field a refused post or call got an error for.
export function formInvalid(target: unknown, name: string): 'true' | undefined {
  return isAction(target) && (target as FormTarget).error(name) !== undefined ? 'true' : undefined
}

// The post a page with islands was rendered in answer to, read again once a swap brings another page.
let pageRead: [Element | null, Outcome | undefined] | undefined

function pageOutcome(): Outcome | undefined {
  if (typeof document === 'undefined')
    return undefined

  const script = document.querySelector(`script[${OUTCOME_SCRIPT}]`)

  if (pageRead?.[0] !== script)
    pageRead = [script, script ? decodeValue(script.textContent ?? '') as Outcome : undefined]

  return pageRead[1]
}

// Posts a call, counting the ones in flight; a call that redirects never settles, so the action stays pending while the page goes.
// How a post went is the request's on the server; in the browser the last call's once the page shown made one, else the post the page answers.
function callable(url: () => string): { call: (input: never, options?: CallOptions) => Promise<unknown>, reads: PropertyDescriptorMap } {
  const [inFlight, setInFlight] = createSignal(0, undefined, false)
  const [last, setLast] = createSignal<{ page: number, outcome: Outcome | null } | undefined>(undefined, undefined, false)
  const shift = (by: number) => setInFlight(untrack(inFlight) + by)
  const called = (outcome: Outcome | null) => setLast({ page: swapState.page, outcome })
  const outcome = () => {
    const posted = requestOutcome?.()
    const own = last()
    const found = posted !== undefined ? posted : own?.page === swapState.page ? own.outcome : pageOutcome()

    return found?.action === url() ? found : undefined
  }
  const failed = () => {
    const found = outcome()

    return found && !found.succeeded ? { status: found.status, values: found.values, errors: found.errors, data: found.data } : undefined
  }
  const read = (value: unknown) => ({ value, enumerable: true })

  return {
    call: async (input: unknown, options?: CallOptions) => {
      shift(1)
      called(null)

      let undo: (() => void) | undefined
      let posted = false

      try {
        undo = options?.optimistic ? undoable(options.optimistic) : undefined

        const data = await post(url(), input)

        posted = true

        called({ action: url(), succeeded: true, data })

        // Started before the caller goes on, so a navigation it starts next supersedes the refresh rather than the other way round; the swap is loaded already.
        if (swapState.started && options?.refresh !== false) {
          const { refresh } = await import('./navigate')

          void refresh()
        }

        return data
      }
      catch (error) {
        // A redirect leaves the page as it is until the next one shows.
        if (!posted && !(error instanceof ActionRedirect))
          undo?.()

        if (error instanceof ActionError && !(error instanceof ActionRedirect))
          called({ action: url(), status: error.status, values: {}, errors: error.errors, data: error.data })

        throw error
      }
      finally {
        shift(-1)
      }
    },
    reads: {
      pending: read(() => inFlight() > 0),
      failed: read(failed),
      succeeded: read(() => {
        const found = outcome()

        return found?.succeeded ? { data: found.data } : undefined
      }),
      error: read((field = '') => failed()?.errors[field]),
    },
  }
}

async function post<Output>(url: string, input: unknown): Promise<Output> {
  const response = await fetch(withBase(url), { method: 'POST', ...encodeCall(input) })

  prefetched.clear()

  return readActionResponse(response)
}

// The encoding keeps numbers, booleans and Dates typed, which form fields would turn into strings; only a call carrying files needs multipart, whose boundary fetch writes.
export function encodeCall(input: unknown): EncodedCall {
  // Sent as the form it is, for the server to read as a form post and answer as a call.
  if (input instanceof FormData)
    return { headers: { 'x-kay-action': FORM_CALL }, body: input }

  const files: Blob[] = []
  const text = sendValue(input, { [FILE_TYPE]: (value: unknown) => value instanceof Blob && [files.push(value) - 1] })

  if (files.length === 0)
    return { headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: text }

  const form = new FormData()

  form.set(INPUT_PART, text)

  // A browser names a bare Blob `blob`; naming it here does the same everywhere, so the handler always gets a File.
  for (const [index, file] of files.entries())
    form.set(`${FILE_MARK}${index}`, file, file instanceof File ? file.name : 'blob')

  return { headers: { 'x-kay-action': '1' }, body: form }
}

// The input `encodeCall` sent, from the JSON body Elysia parsed or the multipart one carrying its files; throws on anything else.
export function decodeCall(body: unknown): unknown {
  const parts = typeof body === 'object' && body !== null && INPUT_PART in body ? body as Record<string, unknown> : { [INPUT_PART]: body }
  const revivers = {
    [FILE_TYPE]: ([index]: [number]) => {
      const file = parts[`${FILE_MARK}${index}`]

      if (!(file instanceof Blob))
        throw new TypeError(`kay: the call names file ${index}, which it did not send`)

      return file
    },
  }
  const input = parts[INPUT_PART]

  // Elysia may already have parsed the input part as JSON.
  return typeof input === 'string' ? decodeValue(input, revivers) : unflattenValue(input, revivers)
}

// What a call got back: the handler's result, or an `ActionError` with the refused fields and the failure data.
export async function readActionResponse<Output>(response: Response): Promise<Output> {
  const target = response.headers.get(REDIRECT_HEADER)

  if (target !== null) {
    if (typeof window === 'undefined')
      throw new ActionRedirect(response.status, target)

    // Only a page goes there: a `javascript:` target would run in this one.
    if (!HTTP_PROTOCOLS.has(new URL(target, window.location.href).protocol))
      throw new TypeError(`kay: the action redirected to ${JSON.stringify(target)}, which is no page`)

    // The page goes away, so whatever awaited the call never resumes.
    void goTo(target)

    return new Promise<never>(() => undefined)
  }

  const body = await response.text()

  if (!response.ok) {
    const failed = response.headers.get(FAILURE_HEADER) === null ? {} : decodeValue(body) as { errors?: Record<string, string>, data?: unknown }

    throw new ActionError(response.status, body, failed.errors, failed.data)
  }

  return (body === '' ? undefined : decodeValue(body)) as Output
}

// Imported when needed: an island calling actions on a site with `navigation: false` ships none of the swap.
async function goTo(target: string): Promise<void> {
  const { navigate } = await import('./navigate')

  await navigate(target)
}
