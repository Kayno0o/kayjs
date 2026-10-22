import type { Static, t, TSchema } from 'elysia'
import type { ByteSize } from './byte-size'
import type { ErrorStatus, RouteParams } from './checks'
import type { Duration } from './duration'
import type { RequestContext } from './index'
import type { EventReader, StreamStatus } from './live'
import type { Owner } from './reactive'
import { ApiError } from './api-error'
import { withBase } from './base'
import { skew } from './build'
import { durationSeconds } from './duration'
import { escapeAttribute } from './escape'
import { holdInvalid } from './invalid'
import { leave, leaving, mayLeave, navigation, prefetched } from './navigation'
import { pageData } from './page-data'
import { getOwner, liveOwner, onCleanupOf, ownSignal, undoable, untrack } from './reactive'
import { sendValue } from './send'
import { reload } from './stale'
import { FAILURE_HEADER, PAGE_HEADER, REDIRECT_HEADER, WORK_HEADER, WORK_SCRIPT } from './swap'
import { ACTION_PREFIX, ACTION_TYPE, decodeServerValue, decodeValue, malformed, serverWritten, unflattenValue } from './wire'

const ACTION = Symbol.for('kay.action')
const DAY = 86_400
const FAILURE = Symbol.for('kay.failure')

// Who made a call: the island whose setup or handler did, and how many paths were shown by then.
export interface Caller {
  owner: Owner | undefined
  arrivals: number | undefined
}

// Type only: what the handler returns on success, so a prop typed with it takes a handler that can also `ctx.fail`.
declare const RESULT: unique symbol
// Type only: what the handler passes to `ctx.fail`, so a page can type `action.failed()`.
declare const FAILED: unique symbol
// Type only: the honeypot field an action's forms render, which `kay check` then takes as one of their fields.
declare const HONEYPOT: unique symbol
const UNSAFE_URL_CHARACTERS = /[^\w/.-]/g
// A module outside the root, as a linked library is, has `..` segments in its path, which a URL would resolve away.
const PARENT_SEGMENT = /(?<=^|\/)\.\.(?=\/|$)/g

// Where the server writes the post a page with islands was rendered in answer to.
export const OUTCOME_SCRIPT = 'data-kay-outcome'

// A call whose input holds files goes as multipart: the encoded input in one part, each file in part `FILE_MARK + n`, where the input holds its index.
export const INPUT_PART = '$kay'
export const FILE_MARK = '$kayFile'
const FILE_TYPE = 'KayFile'
const SPACES = /\s+/
const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

// Where the stream a streaming action answered a call with takes a callback, handed how it ended once it did.
export const SETTLED = Symbol.for('kay.settled')

export interface Settles {
  [SETTLED]: (then: (status: StreamStatus) => void) => void
}

// The `x-kay-action` of a call whose input is a form's fields rather than encoded.
export const FORM_CALL = 'form'

export interface EncodedCall {
  headers: Record<string, string>
  body: string | FormData
}

// Where rate limits count, shared by every process opening it: `sqliteRates` from `kay/server`, or one of an app's own.
export interface RateStore {
  // Counts `weight` more under `key`, one attempt unless given, opening a window of `window`, such as `'60000ms'`, when none is open: the count in it so far, this hit included, and when it closes, in ms since the epoch.
  // A store of its own adds `weight` to the count, or a weighted limit, tokens say, refuses it.
  hit: (key: string, window: Duration, weight?: number) => RateWindow | Promise<RateWindow>
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

// What a rate limit's `key` reads of the request it counts: the cookies, the app's `derive` values as `locals` and the client's address, which the count falls back to.
// An action's runs before its guards and the app's `resolve` hooks, so `locals` holds what `derive` adds, a `session` say, and not what a guard sets.
export type RateKeyContext = Pick<RequestContext, 'request' | 'locale' | 'cookies' | 'locals'> & { client: string }

// What counts a request: a person's id, an API token, an account. Nothing, an empty text or a failure counts the client's address, so a limit never lifts.
export type RateKey = (ctx: RateKeyContext) => string | undefined | Promise<string | undefined>

export interface ActionRateLimit extends RateLimit {
  // What the limit counts a post under, in place of the client's address: `key: ctx => ctx.locals.user?.id`, so a person has their own allowance from any address and many of them behind one address do not share one. Without it, or when it gives `undefined`, the client's address.
  key?: RateKey | undefined
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
  // Checks only a form the browser posts itself, without kay's script, leaving a page swap's post and a call to what checks those, such as a proof of work.
  plain?: boolean | undefined
}

export interface ProofOfWorkOptions {
  // The highest number the server picks a challenge's from, which the browser finds by hashing every number from 0 up: half of it on average, so the time a post costs a bot, and a person's browser, grows with it. 100,000 by default.
  difficulty?: number | undefined
  // How long a challenge stays good: a day by default.
  maxAge?: Duration | undefined
  // Answers a wrong or replayed solution as if it went through, the handler never running, rather than refusing it.
  pretend?: boolean | undefined
  // Where the solutions already used are kept until their challenge expires: this process's memory by default, `sqliteRates(path)` to share them between the processes of a machine.
  store?: RateStore | undefined
}

// `missing` for a post without a solution, `expired` for one to a challenge past `maxAge` or signed before a restart, `wrong` for a number that does not solve it or a solution used before.
export type ProofOfWorkRefusal = 'missing' | 'expired' | 'wrong'

// How an action is offered to an agent as an MCP tool.
export interface ActionTool {
  // Its name, in place of the export's in snake case: `addNote` is `add_note`.
  name?: string | undefined
  // What the agent reads of it to choose it.
  description?: string | undefined
}

// The checks that keep scripts from an action: `action(schema, handler, { protect: { rateLimit, honeypot, minTime, proofOfWork } })`.
export interface ActionProtect<Field extends string = never> {
  // At most `max` posts from one client every `window`, seconds or a string such as '1m'; past that a post fails with 429 without reaching the handler. `store` shares the count between processes.
  // Several limits all apply, such as one on every attempt and a tighter one on the posts that went through.
  rateLimit?: ActionRateLimit | ActionRateLimit[] | undefined
  // A field a form posting to the action renders out of sight by itself, which people leave empty and bots fill in; a post filling it fails with 422 without reaching the handler.
  honeypot?: Field | HoneypotOptions<Field> | undefined
  // The least time a person takes to fill the form in, `'3s'`: a form posting to the action carries a signed stamp of when it rendered, and a post sooner than this, or with a stamp missing, forged or too old, fails with 422 without reaching the handler.
  minTime?: Duration | MinTimeOptions | undefined
  // A challenge kay's script solves in a worker while the visitor fills the form in, so each post costs CPU: `true`, the difficulty, or options. A post without the solution fails with 422 without reaching the handler, a form posted without JavaScript included unless `minTime` is set too.
  proofOfWork?: boolean | number | ProofOfWorkOptions | undefined
}

// What an action reads of its third argument, grouped by concern: `protect` for the checks above, `messages` for their refusals, `tool` for agents and `maxSize` for the body.
export interface ActionProtection<Field extends string = never> {
  // Offers the action to agents as an MCP tool when `mcp` is set in kay.config.ts: `true`, its description, or `{ name, description }`. An action without it is never offered. A call runs the action as a form post would, its guards and rate limits included, except that the `honeypot`, `minTime` and `proofOfWork` of `protect` are skipped, as they only make sense for a form a person filled in.
  tool?: boolean | string | ActionTool | undefined
  protect?: ActionProtect<Field> | undefined
  // The most a post may send, files included, bytes or a size such as `'20mb'`, in place of the app's `maxSize`; a bigger one fails with 413 before it is read.
  maxSize?: ByteSize | undefined
  // What the visitor reads when one of these refuses a post, in place of kay's English, as a schema's `error` is for a field.
  messages?: ProtectionMessages | undefined
  /** @deprecated The old place of `protect.rateLimit`, kept three minors. */
  rateLimit?: ActionRateLimit | ActionRateLimit[] | undefined
  /** @deprecated The old place of `protect.honeypot`, kept three minors. */
  honeypot?: Field | HoneypotOptions<Field> | undefined
  /** @deprecated The old place of `protect.minTime`, kept three minors. */
  minTime?: Duration | MinTimeOptions | undefined
  /** @deprecated The old place of `protect.proofOfWork`, kept three minors. */
  proofOfWork?: boolean | number | ProofOfWorkOptions | undefined
  /** @deprecated The old name of `maxSize`, kept three minors. */
  bodyLimit?: ByteSize | undefined
}

// An action's options once `protect` is read, the checks on a level with the rest: what the server reads.
export interface ResolvedProtection {
  tool?: boolean | string | ActionTool | undefined
  rateLimit?: ActionRateLimit | ActionRateLimit[] | undefined
  honeypot?: string | HoneypotOptions | undefined
  minTime?: Duration | MinTimeOptions | undefined
  proofOfWork?: boolean | number | ProofOfWorkOptions | undefined
  maxSize?: ByteSize | undefined
  bodyLimit?: ByteSize | undefined
  messages?: ProtectionMessages | undefined
}

export interface ProtectionMessages {
  // Given the seconds until the client may post again.
  rateLimit?: (string | ((wait: number) => string)) | undefined
  honeypot?: string | undefined
  // Given `early` for a post sent sooner than `minTime`, `expired` for a stamp missing, forged or past `maxAge`.
  minTime?: (string | ((reason: MinTimeRefusal) => string)) | undefined
  // Given `missing` for a post without a solution, `expired` for a challenge forged, another action's or past `maxAge`, `wrong` for a wrong number or a solution sent twice.
  proofOfWork?: (string | ((reason: ProofOfWorkRefusal) => string)) | undefined
  // Given the most bytes a post may send.
  maxSize?: (string | ((bytes: number) => string)) | undefined
  /** @deprecated The old name of `maxSize`, kept three minors. */
  bodyLimit?: (string | ((bytes: number) => string)) | undefined
  // When the handler throws, a service it sends to being down say: the error is logged, and the visitor reads this instead. A function is given the error and the action's `ctx`, so it can read what is loaded per request (a setting, a collection entry) or the page's `ctx.locale`, and may be async; one that throws leaves kay's own message, both errors logged.
  serverError?: (string | ((error: unknown, ctx: ActionContext) => string | Promise<string>)) | undefined
}

// The context every request has, `params` those of the page the action was posted from, matched against the action's own route as its guards read them: scope what it touches by them, since the input is the visitor's to choose, and a layout's action gets those every page it wraps names.
// Its `url` is that page's, as its guards read it, its `locale` that page's too, and `redirect` answers 303 unless given.
export interface ActionContext<Params extends Readonly<Record<string, unknown>> = RouteParams> extends RequestContext<Params> {
  // Response status, for a fetch call or the redirect after a plain form post.
  status: (code: number) => void
  // `return ctx.fail(409, { message: 'Taken' })`: a plain form post gets its page rendered again, which reads it through `action.failed()`; a call throws an `ActionError` carrying `data`. A string is also the form's message, under `errors['']`.
  fail: <const Data = undefined, const Status extends number = number>(status: Status & ErrorStatus<Status>, data?: Data) => Failure<Data>
}

export interface Failure<Data> {
  readonly [FAILURE]: true
  readonly status: number
  readonly data: Data
}

export type Success<Output> = Exclude<Output, Failure<unknown>>

// What a call to a handler returning an async iterable resolves with: its values read as they come, typed.
export type ActionStream<T> = EventReader<T>

// What a handler's return settles to: an async iterable stays one even when it is also a thenable, as a model's reply is, which `Awaited` would read as its text.
export type Settled<Output> = Output extends AsyncIterable<unknown> ? Output : Awaited<Output>

// What a call resolves with: a stream for a handler returning an async iterable, else what it returned.
export type Answer<Output> = Output extends AsyncIterable<infer Value> ? ActionStream<Value> : Output

// What a plain form post reads back: the last value of an async iterable, which is undefined when it gave none.
export type Final<Output> = Output extends AsyncIterable<infer Value> ? Value | undefined : Output

// Unknown for an action of any output, so any action passes where `Action<never, unknown>` is expected, and for one whose output names no `Failure`, so a handler that can `ctx.fail` passes where only its success output is typed.
export type FailureData<Output> = unknown extends Output ? unknown : [Extract<Output, Failure<unknown>>] extends [never] ? unknown : Output extends Failure<infer Data> ? Data : never

// What a page reads back through `action.failed()` after a plain form post failed.
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

// What the handler passes to `ctx.fail`, read off its phantom for the same reason.
export type FailuresOf<Target> = Target extends { readonly [FAILED]?: infer Data } ? Data : never

// The input an action's schema describes, as a form posts it or a call takes it.
export type InputOf<Target> = Target extends Action<infer Input, unknown> ? Input : never

export type FailureOf<Target> = Target extends Action<infer Input, unknown> ? FormFailure<Input, FailuresOf<Target>, Extract<HoneypotOf<Target>, string>> : never

// What a page reads back through `action.succeeded()` after a plain form post succeeded.
export interface FormSuccess<Output> {
  // What the handler returned.
  data: Output
}

export type SuccessOf<Target> = Target extends Action<never, unknown> ? FormSuccess<Final<Success<ResultOf<Target>>>> : never

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
  // Aborts the call: it rejects with the signal's reason, and the change `optimistic` showed goes back.
  signal?: AbortSignal | undefined
}

// How a tracked call went: what the handler returned, or the refusal the server answered.
export type CallResult<Data, Failed>
  = | { ok: true, data: Data }
    | { ok: false, status: number, errors: Record<string, string>, data: Failed | undefined }

// An action seen through the calls one island makes, so a row's button reads its own `pending()`.
export interface TrackedCall<Input, Result> {
  // Resolves with how the call went, any answer the server gave included; a failure that is no answer of this action, such as a network error, an abort or a redirect, still throws.
  (...call: object extends Input ? [input?: Input, options?: CallOptions] : [input: Input, options?: CallOptions]): Promise<Result>
  (form: FormData, options?: CallOptions): Promise<Result>
  // Whether a call made through this handle is still in flight, read reactively.
  readonly pending: () => boolean
  // Resolves once no call made through this handle is in flight, whichever way they went; never rejects.
  readonly settled: () => Promise<void>
}

// Called from the browser it posts its input and resolves with the handler's result; `form(action={...})` posts to `url`.
export interface Action<Input, Output, Honeypot extends string = never> {
  (input: Input, options?: CallOptions): Promise<Answer<Success<Output>>>
  // A form's fields, read as a plain form post reads them: `add(new FormData(form))`. Last, so `infer` and the editor read the typed input above, while `Parameters<typeof add>` reads this one.
  (form: FormData, options?: CallOptions): Promise<Answer<Success<Output>>>
  // Whether a call this page made is still in flight, read reactively: `button(disabled={add.pending()})`.
  readonly pending: () => boolean
  // Resolves once no call of this action is in flight, whichever way they went, so an island that did not await its writes can wait for them: `await add.settled()`. A stream counts until it ends. Never rejects.
  readonly settled: () => Promise<void>
  // A handle for the calls of one island, one row or one button: `const save = add.track()`, then `await save(input)` resolves with `{ ok, data }` or the refusal, and `save.pending()` reads only its own calls.
  readonly track: () => TrackedCall<Input, CallResult<Answer<Success<Output>>, FailureData<Output>>>
  // How much of the last call carrying files the browser sent, from 0 to 1, while it uploads; undefined otherwise: `progress(value={upload.progress()})`.
  readonly progress: () => number | undefined
  // How the form post the page renders for went, refused, as `failed()` reads it; in an island, how its last call went, read reactively.
  readonly failed: () => FormFailure<Input, FailureData<Output>, Honeypot> | undefined
  readonly succeeded: () => FormSuccess<Final<Success<Output>>> | undefined
  // This action for a form to post with fixed fields, as hidden inputs would carry them: `form(action={move.with({ id, to: 2 })})`. They travel in the form's action URL, so the form needs no inputs for them and posts them with or without JavaScript.
  // eslint-disable-next-line ts/method-signature-style
  with(fields: Partial<Input>): Action<Input, Output, Honeypot>
  // The message a refused post got for one field, or for the whole form under ''; a method, so any action still passes where `Action<never, unknown>` is expected.
  // eslint-disable-next-line ts/method-signature-style
  error(field?: Extract<keyof Input, string> | Honeypot | ''): string | undefined
  // Whether `error` is a call to this action the server refused, its `data` typed as the handler passes it to `ctx.fail`.
  // eslint-disable-next-line ts/method-signature-style
  refused(error: unknown): error is ActionError<FailureData<Output>>
  readonly url: string
  readonly [ACTION]: true
  readonly [RESULT]?: Success<Output>
  readonly [FAILED]?: FailureData<Output>
  // Taking the field rather than giving it, so an action with a honeypot still passes where any action is expected.
  [HONEYPOT]?: (field: Honeypot) => void
}

export interface ServerAction<Schema extends TSchema, Output, Honeypot extends string = never> extends Action<Static<Schema>, Output, Honeypot> {
  readonly schema: Schema
  readonly handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>
  readonly protection?: ResolvedProtection
}

export class ActionError<Data = unknown> extends ApiError {
  override name = 'ActionError'

  // `errors` holds a message per field the schema refused, `data` what the handler passed to `ctx.fail`, undefined when the call was refused before it ran.
  constructor(status: number, readonly body: string, readonly errors: Record<string, string> = {}, readonly data?: Data, message = `Action failed with ${status}: ${body}`) {
    super(status, message, body)
  }
}

// Thrown by a call whose action redirected, where there is no browser to send: a test, a script.
export class ActionRedirectError extends ActionError {
  override name = 'ActionRedirectError'

  constructor(status: number, readonly location: string) {
    super(status, `Redirected to ${location}`, {}, undefined, `Action redirected with ${status} to ${location}`)
  }
}

/** @deprecated Renamed `ActionRedirectError` in 1.70; the old name goes in 1.73. */
export const ActionRedirect = ActionRedirectError
/** @deprecated Renamed `ActionRedirectError` in 1.70; the old name goes in 1.73. */
export type ActionRedirect = ActionRedirectError

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
  return `${ACTION_PREFIX}${moduleId.replace(UNSAFE_URL_CHARACTERS, '_').replace(PARENT_SEGMENT, '~')}/${name}`
}

// What an action with no input takes: no fields, so `add()` calls it.
export type NoInputAction<Output, Honeypot extends string = never> = ServerAction<EmptySchema, Output, Honeypot> & ((input?: undefined, options?: CallOptions) => Promise<Answer<Success<Output>>>)

// An empty object schema built by hand: `t.Object({})` would carry Elysia into the islands importing this module, and TypeBox reads a schema by this symbol.
type EmptySchema = ReturnType<typeof t.Object<Record<never, never>>>

// Built per declaration, so an island bundle that never declares an action drops it.
const emptySchema = () => ({ [Symbol.for('TypeBox.Kind')]: 'Object', type: 'object', properties: {} }) as unknown as EmptySchema

// `action` as `kay check` reads it in a page's server fence, whose `ctx.params` are those of the page's route: not something to write.
export interface ActionFor<Params extends Readonly<Record<string, unknown>>> {
  <Output, const Honeypot extends string = never>(handler: (ctx: ActionContext<Params>) => Output | Promise<Output>, protection?: ActionProtection<Honeypot>): NoInputAction<Settled<Output>, Honeypot>
  <Schema extends TSchema, Output, const Honeypot extends string = never>(schema: Schema, handler: (input: Static<Schema>, ctx: ActionContext<Params>) => Output | Promise<Output>, protection?: ActionProtection<Honeypot>): ServerAction<Schema, Settled<Output>, Honeypot>
}

// Declares a server action in a page's `--- server` fence: Elysia validates the input against `schema` before `handler` runs.
// Without a schema the action takes no input, as with an empty object schema, and its handler gets the context alone.
export function action<Output, const Honeypot extends string = never>(handler: (ctx: ActionContext) => Output | Promise<Output>, protection?: ActionProtection<Honeypot>): NoInputAction<Settled<Output>, Honeypot>
export function action<Schema extends TSchema, Output, const Honeypot extends string = never>(schema: Schema, handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>, protection?: ActionProtection<Honeypot>): ServerAction<Schema, Settled<Output>, Honeypot>
export function action(first: unknown, second?: unknown, third?: ActionProtection<string>): unknown {
  if (typeof first === 'function') {
    const handler = first as (ctx: ActionContext) => unknown

    return declare(emptySchema(), (_input, ctx) => handler(ctx), second as ActionProtection<string> | undefined)
  }

  return declare(first as TSchema, second as (input: unknown, ctx: ActionContext) => unknown, third)
}

// The options with `protect` read: its checks on a level with the rest, which the old flat form (`{ honeypot, rateLimit }`, read until 1.74) already is, `protect` winning where both set one.
export function resolveProtection(options: ActionProtection<string> | undefined): ResolvedProtection | undefined {
  if (options === undefined)
    return undefined

  const { protect, ...rest } = options

  if (protect == null)
    return rest

  const grouped: ResolvedProtection = { ...rest }

  for (const [key, value] of Object.entries(protect)) {
    if (value !== undefined)
      (grouped as Record<string, unknown>)[key] = value
  }

  return grouped
}

function declare(schema: TSchema, handler: (input: unknown, ctx: ActionContext) => unknown, options: ActionProtection<string> | undefined): ServerAction<TSchema, unknown> {
  const protection = resolveProtection(options)

  // Refused as the module loads, rather than on the first post.
  if (protection?.minTime !== undefined)
    minTimeOf(protection)

  if (protection?.proofOfWork !== undefined)
    workOf(protection)

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
  }) as unknown as ServerAction<TSchema, unknown>
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

// Called by the chunk of an island that types a prop as an action, so the props a page passes it revive as callable stubs: only a URL under the actions' own path is one, whatever the text says.
export function reviveActions(): void {
  serverWritten[ACTION_TYPE] = (url: string) => typeof url === 'string' && url.startsWith(ACTION_PREFIX) ? actionStub(url) : malformed(url, ACTION_TYPE)
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

// The query of an action's URL carrying the fields `with` fixes, as a form's own encoding of them.
export const PAYLOAD_PARAM = 'kay_with'

// Fields as a form posts them: text, numbers, booleans and dates as text, a list as one entry per item, nothing for undefined and null.
function payloadQuery(fields: Record<string, unknown>): string {
  const query = new URLSearchParams()

  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null)
        continue

      if (typeof item === 'object' && !(item instanceof Date))
        throw new TypeError(`kay: ${name} in \`with()\` is neither text, a number, a boolean, a date nor a list of them`)

      query.append(name, item instanceof Date ? item.toISOString() : String(item))
    }
  }

  return query.toString()
}

// The same action for a form to post with `fields` fixed, a further `with` adding to them; its other readings are the action's own.
function withFields<Target extends object>(target: Target, fields: Record<string, unknown>): Target {
  const query = payloadQuery(fields)

  // The URL a form posts to, which the action's own `url` stays apart from: the stamp and the protections name that one.
  // Over a function of its own, whose properties the traps may answer differently from the action's, which holds `with` read-only.
  return new Proxy((() => undefined) as unknown as Target, {
    get: (_, key) => {
      if (key === 'with')
        return (more: Record<string, unknown>) => withFields(target, { ...fields, ...more })

      return key === 'formUrl' ? `${(target as { url: string }).url}?${PAYLOAD_PARAM}=${encodeURIComponent(query)}` : Reflect.get(target, key)
    },
    apply: (_, self, args: unknown[]): unknown => Reflect.apply(target as unknown as () => unknown, self, args),
    has: (_, key) => key in target,
  })
}

export function formAction(target: string | Action<never, unknown>): string {
  if (typeof target === 'string')
    return target

  renderedForms?.add(target)

  return (target as { formUrl?: string }).formUrl ?? target.url
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

// `proofOfWork` with its defaults, `maxAge` in milliseconds; undefined when it is off.
export function workOf(protection: ResolvedProtection): { difficulty: number, maxAge: number, pretend: boolean, store: RateStore | undefined } | undefined {
  const { proofOfWork } = protection

  if (proofOfWork === undefined || proofOfWork === false)
    return undefined

  const numeric: ProofOfWorkOptions = typeof proofOfWork === 'number' ? { difficulty: proofOfWork } : {}
  const options = typeof proofOfWork === 'object' ? proofOfWork : numeric
  const difficulty = options.difficulty ?? 100_000

  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 1e9)
    throw new Error(`kay: proofOfWork's difficulty is ${difficulty}; it takes a whole number from 1 to 1,000,000,000`)

  return { difficulty, maxAge: durationSeconds(options.maxAge ?? DAY, 'proofOfWork.maxAge') * 1000, pretend: options.pretend === true, store: options.store }
}

// `minTime` in milliseconds, read once it is set.
export function minTimeOf(protection: ResolvedProtection): { after: number, maxAge: number, pretend: boolean } | undefined {
  const { minTime } = protection

  if (minTime === undefined)
    return undefined

  const options = typeof minTime === 'object' ? minTime : { after: minTime }

  return { after: durationSeconds(options.after, 'minTime') * 1000, maxAge: durationSeconds(options.maxAge ?? DAY, 'minTime.maxAge') * 1000, pretend: options.pretend === true }
}

export function honeypotField(protection: ResolvedProtection | undefined): string | undefined {
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

// What holds the mark of a refused field in an island, beside a component marking the same control.
const REFUSED = {}

// Marks an island field `aria-invalid` while a refused post or call gave `field` of a form posting to `target` a message, and takes kay's mark off once there is none, leaving one a component still holds.
// The template writes no `aria-invalid` on a field kay marks, so one found is the server's render of this same refusal.
export function formMarked(element: Element, target: unknown, field: string): void {
  holdInvalid(element, REFUSED, formError(target, field) !== undefined, false)
}

// Adds `id` to an island field's `aria-describedby` while a refused post or call gave `field` of a form posting to `target` a message (`''` for the form's own), and takes it out once there is none, leaving the ids others wrote there.
export function formDescribed(element: Element, target: unknown, field: string, id: string): void {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(SPACES).filter(name => name !== '')
  const refused = formError(target, field) !== undefined

  if (refused === ids.includes(id))
    return

  const next = refused ? [...ids, id] : ids.filter(name => name !== id)

  if (next.length > 0)
    element.setAttribute('aria-describedby', next.join(' '))
  else
    element.removeAttribute('aria-describedby')
}

// The message a refused post or call gave `field` of a form posting to `target`, or under '' the form's own: what an `error` line shows.
export function formError(target: unknown, field: string): string | undefined {
  return isAction(target) ? (target as FormTarget).error(field) : undefined
}

// The post a page with islands was rendered in answer to, read again once a swap brings another page.
// The action URL each refused call was made to, which `refused` matches.
const refusedAt = new WeakMap<ActionError, string>()

function pageOutcome(): Outcome | undefined {
  return typeof document === 'undefined' ? undefined : pageData<Outcome>(`script[${OUTCOME_SCRIPT}]`, decodeServerValue, true)[0]
}

// An `ownSignal` made when first read, as most actions are only called: what is written before holds as its value.
function lazySignal<T>(value: T): [read: () => T, write: (next: T) => void, peek: () => T] {
  let current = value
  let signal: ReturnType<typeof ownSignal<T>> | undefined

  return [() => (signal ??= ownSignal(current))[0](), (next) => {
    current = next
    signal?.[1](next)
  }, () => current]
}

// Posts a call, counting the ones in flight; a call that redirects never settles, so the action stays pending while the page goes, unless the visitor stays or already went elsewhere.
// How a post went is the request's on the server; in the browser the last call's once the page shown made one, else the post the page answers.
function callable(url: () => string): { call: (input: never, options?: CallOptions) => Promise<unknown>, reads: PropertyDescriptorMap } {
  const [inFlight, setInFlight, flying] = lazySignal(0)
  const [last, setLast] = lazySignal<{ page: number, outcome: Outcome | null } | undefined>(undefined)
  const [progress, setProgress] = lazySignal<number | undefined>(undefined)
  const idle = whenIdle()
  const shift = (by: number) => {
    setInFlight(flying() + by)
    idle.check(flying())
  }
  const called = (page: number, outcome: Outcome | null) => setLast({ page, outcome })
  const outcome = () => {
    let found = requestOutcome?.()
    const own = last()

    if (found === undefined)
      found = own?.page === navigation.page ? own.outcome : pageOutcome()

    return found?.action === url() ? found : undefined
  }
  const failed = () => {
    const found = outcome()

    return found && !found.succeeded ? { status: found.status, values: found.values, errors: found.errors, data: found.data } : undefined
  }
  const read = (value: unknown) => ({ value, enumerable: true })

  const call = async (input: unknown, options?: CallOptions) => {
    // The page the call was made on, whose outcome it is even once the visitor went elsewhere.
    const page = navigation.page
    const visits = navigation.visits
    const left = () => navigation.visits !== visits
    // The island calling, from its setup or a handler, whose end ends a stream the call answers with; else the page, as long as no other path is shown.
    const caller: Caller = { owner: liveOwner(getOwner()), arrivals: navigation.arrivals }

    shift(1)
    called(page, null)

    let undo: (() => void) | undefined
    let posted = false
    let sent = false
    // A stream keeps the call in flight until it ends.
    let streaming = false
    // Started before the caller goes on, so a navigation it starts next supersedes the refresh rather than the other way round; a site with `navigation: false` shows a call's effects itself.
    const refreshPage = () => {
      if (options?.refresh !== false && !left() && navigation.hooks)
        void refreshed()
    }

    try {
      undo = options?.optimistic ? undoable(options.optimistic) : undefined

      const data = await post(url(), input, setProgress, options?.signal, () => {
        sent = true
      }, left, caller)

      posted = true

      streaming = onStreamEnd(data, (status) => {
        if (status === 'done') {
          called(page, { action: url(), succeeded: true, data: untrack((data as ActionStream<unknown>).last) })
          refreshPage()
        }

        shift(-1)
      })

      if (!streaming) {
        called(page, { action: url(), succeeded: true, data })
        refreshPage()
      }

      return data
    }
    catch (error) {
      // A redirect leaves the page as it is until the next one shows.
      if (!posted && !(error instanceof ActionRedirectError))
        undo?.()

      // The server may have run a call aborted once it was sent, which the page then shows as it stands.
      if (sent && options?.signal?.aborted === true)
        refreshPage()

      if (error instanceof ActionError && !(error instanceof ActionRedirectError))
        called(page, { action: url(), status: error.status, values: {}, errors: error.errors, data: error.data })

      throw error
    }
    finally {
      if (!streaming)
        shift(-1)

      setProgress(undefined)
    }
  }

  return {
    call,
    reads: {
      pending: read(() => inFlight() > 0),
      settled: read(async () => idle.wait(flying())),
      progress: read(progress),
      failed: read(failed),
      succeeded: read(() => {
        const found = outcome()

        return found?.succeeded ? { data: found.data } : undefined
      }),
      error: read((field = '') => failed()?.errors[field]),
      refused: read((error: unknown) => error instanceof ActionError && refusedAt.get(error) === url()),
      track: read(() => tracked(call, url)),
      with: read((fields: Record<string, unknown>) => withFields(call, fields)),
    },
  }
}

// A stream ends with the block or island that started it, or the nearest one around it still alive when its answer arrives (a persist island's living on across pages), and one whose block goes in that same task, the call's own result removing it, passes to the block around it. One started under no owner, after an `await` in a handler say, ends once a path other than the call's is shown.
function closeWithCaller(stream: ActionStream<unknown> & Settles, caller: Caller | undefined): void {
  let answering = true
  let ended = false
  let owner: Owner | undefined

  setTimeout(() => {
    answering = false
  }, 0)

  function release() {
    const from = owner

    owner = undefined

    if (!answering || !from) {
      stream.close()

      return
    }

    // After the pass that disposes the block, so the nearest one around it still alive then takes the stream.
    queueMicrotask(() => {
      const to = liveOwner(from.owner)

      if (ended)
        return

      if (to)
        attach(to)
      else
        stream.close()
    })
  }

  function attach(to: Owner) {
    owner = to
    onCleanupOf(to, release)
  }

  const first = liveOwner(caller?.owner)

  if (first) {
    attach(first)
  }
  else if (caller && navigation.arrivals !== caller.arrivals) {
    stream.close()
  }
  else if (caller) {
    leaving.add(stream.close)
  }

  // One per call, so an island answering many clicks with a stream does not keep every one until it goes.
  stream[SETTLED](() => {
    ended = true
    leaving.delete(stream.close)

    const at = owner?.cleanups?.indexOf(release) ?? -1

    if (at !== -1)
      owner!.cleanups!.splice(at, 1)
  })
}

// Hands `then` how a stream ended, once it ended, failed or was closed; false when `data` is no stream.
function onStreamEnd(data: unknown, then: (status: StreamStatus) => void): boolean {
  const settles = (data as Partial<Settles> | null | undefined)?.[SETTLED]

  settles?.(then)

  return settles !== undefined
}

// A handle with a pending count of its own over `call`, whose refusals of this action it answers as results.
function tracked(call: (input: never, options?: CallOptions) => Promise<unknown>, url: () => string): TrackedCall<never, unknown> {
  const [inFlight, setInFlight] = ownSignal(0)
  const idle = whenIdle()
  const shift = (by: number) => {
    setInFlight(untrack(inFlight) + by)
    idle.check(untrack(inFlight))
  }

  const run = async (input: unknown, options?: CallOptions) => {
    let streaming = false

    shift(1)

    try {
      const data = await call(input as never, options)

      streaming = onStreamEnd(data, () => shift(-1))

      return { ok: true, data }
    }
    catch (error) {
      if (!(error instanceof ActionError) || error instanceof ActionRedirectError || refusedAt.get(error) !== url())
        throw error

      return { ok: false, status: error.status, errors: error.errors, data: error.data }
    }
    finally {
      if (!streaming)
        shift(-1)
    }
  }

  return Object.assign(run, { pending: () => inFlight() > 0, settled: async () => idle.wait(untrack(inFlight)) })
}

// What `settled()` waits on: callers resolved as the count of calls in flight reaches 0.
function whenIdle(): { wait: (count: number) => Promise<void>, check: (count: number) => void } {
  let waiting: (() => void)[] = []

  return {
    wait: async count => count === 0 ? undefined : new Promise<void>(resolve => void waiting.push(resolve)),
    check: (count) => {
      if (count !== 0 || waiting.length === 0)
        return

      const resolving = waiting

      waiting = []

      for (const resolve of resolving)
        resolve()
    },
  }
}

async function post<Output>(url: string, input: unknown, onProgress: (sent: number) => void, signal: AbortSignal | undefined, onSent: () => void, left: () => boolean, caller: Caller): Promise<Output> {
  const { headers, body } = encodeCall(input)
  const sent: Record<string, string> = { ...headers }

  // A test or a script calling it has no page.
  if (typeof location !== 'undefined')
    sent[PAGE_HEADER] = location.pathname + location.search

  // fetch tells nothing of an upload's progress, which a call carrying files reports.
  const send = async (solution: string | undefined) => {
    const headers = solution === undefined ? sent : { ...sent, [WORK_HEADER]: solution }

    const files = body instanceof FormData && typeof XMLHttpRequest !== 'undefined' ? body : undefined
    // Loaded before the call counts as sent, as an abort while it loads sends nothing.
    const upload = files && await import('./upload')

    // A signal aborted already sends nothing.
    if (signal?.aborted !== true)
      onSent()

    return files && upload ? upload.uploaded('POST', withBase(url), headers, files, onProgress, signal) : fetch(withBase(url), { method: 'POST', headers, body, ...signal && { signal } })
  }

  // A page holding a challenge for the action solves it from the moment one of its forms takes focus.
  let response = await send(typeof document !== 'undefined' && document.querySelector(`script[${WORK_SCRIPT}]`) ? await (await import('./work.client')).spendWork(url) : undefined)
  const challenge = response.status === 422 ? response.headers.get(WORK_HEADER) : null

  // A call with no challenge to solve, or a stale one, is answered a fresh one, and goes again with its solution.
  if (challenge !== null)
    response = await send(await (await import('./work.client')).spendWork(url, challenge))

  prefetched.clear()

  void skew(response)

  return readActionResponse(response, url, left, caller)
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

// What a call to `action` got back: the handler's result, or an `ActionError` with the refused fields and the failure data.
// `left` tells whether the visitor went to another page since the call was made, which a redirect then no longer takes them from; a stream closes with the island that called, else once another path is shown.
export async function readActionResponse<Output>(response: Response, action: string, left?: () => boolean, caller?: Caller): Promise<Output> {
  const target = response.headers.get(REDIRECT_HEADER)

  if (target !== null) {
    if (typeof window === 'undefined')
      throw new ActionRedirectError(response.status, target)

    // Only a page goes there: a `javascript:` target would run in this one.
    if (!HTTP_PROTOCOLS.has(new URL(target, window.location.href).protocol))
      throw new TypeError(`kay: the action redirected to ${JSON.stringify(target)}, which is no page`)

    if (left?.() === true)
      throw new ActionRedirectError(response.status, target)

    // The page goes away, so whatever awaited the call never resumes; a leave guard keeping the visitor here settles it instead.
    if (await goTo(target))
      return new Promise<never>(() => undefined)

    throw new ActionRedirectError(response.status, target)
  }

  // Loaded only once an action streams, so a page calling none does not carry it.
  if (response.ok && response.headers.get('content-type')?.startsWith('text/event-stream') === true) {
    const stream = (await import('./action-stream')).actionStream(response, SETTLED)

    closeWithCaller(stream, caller)

    return stream as Output
  }

  const body = await response.text()

  if (!response.ok) {
    const failed = response.headers.get(FAILURE_HEADER) === null ? {} : decodeServerValue(body) as { errors?: Record<string, string>, data?: unknown }

    const error = new ActionError(response.status, body, failed.errors, failed.data)

    refusedAt.set(error, action)

    throw error
  }

  return (body === '' ? undefined : decodeServerValue(body)) as Output
}

// The code of `navigate()` and `refresh()`, loaded on first use; a chunk a deploy removed asks the server whether the build changed, which reloads the page; undefined means the code is unavailable.
async function navigateApi(): Promise<typeof import('./navigate-api') | undefined> {
  try {
    return await import('./navigate-api')
  }
  catch {
    await skew()

    return undefined
  }
}

// The page's loads again through the swap, unless the visitor or the app went elsewhere while its code loaded, as a refresh started before them would have given way to them.
// Without the swap's code the page reloads, as a deploy's would, so an action's effect still shows; a reload that would lose what was typed, or came within the minute, leaves the page and the next link loads in full.
async function refreshed(): Promise<void> {
  const [navigations, visits] = [navigation.navigations, navigation.visits]
  const api = await navigateApi()

  if (navigation.navigations !== navigations || navigation.visits !== visits)
    return

  if (api)
    await api.refresh()
  else
    reload()
}

// Through the swap once it took over the app's links; a site with `navigation: false` loads the page, asking the leave guards first as `navigate()` would.
// Whether the page went, or a leave guard kept the visitor on it.
async function goTo(target: string): Promise<boolean> {
  const api = navigation.hooks ? await navigateApi() : undefined

  if (api) {
    const [before, released] = [navigation.current, navigation.released]

    await api.navigate(target)

    return navigation.current !== before || (!released && navigation.released)
  }

  const url = new URL(target, location.href)

  if (!await mayLeave(url))
    return false

  leave(url)

  return true
}
