import type { Static, TSchema } from 'elysia'
import type { ActionError, FAILURE } from './action-error'
import type { ByteSize } from './byte-size'
import type { CallResult } from './call-result'
import type { ErrorStatus, RouteParams } from './checks'
import type { Duration } from './duration'
import type { RequestContext } from './index'
import type { EventReader } from './live'

export type { CallResult }

export const ACTION = Symbol.for('kay.action')

// Type only: what the handler returns on success, so a prop typed with it takes a handler that can also `ctx.fail`.
declare const RESULT: unique symbol
// Type only: what the handler passes to `ctx.fail`, so a page can type `action.failed()`.
declare const FAILED: unique symbol
// Type only: the honeypot field an action's forms render, which `kay check` then takes as one of their fields.
declare const HONEYPOT: unique symbol

// Where rate limits count, shared by every process opening it: `sqliteRates` from `kay/server`, or one of an app's own.
export interface RateStore {
  // Counts `weight` more under `key`, one attempt unless given, opening a window of `window`, such as `'60000ms'`, when none is open: the count in it so far, this hit included, and when it closes, in ms since the epoch.
  // A store of its own adds `weight` to the count, or a weighted limit, tokens say, refuses it.
  hit: (key: string, window: Duration, weight?: number) => RateWindow | Promise<RateWindow>
  // The window open under `key` without counting an attempt, undefined when none is: what a limit counting only the posts that went through reads before the handler runs.
  peek?: (key: string) => RateWindow | undefined | Promise<RateWindow | undefined>
  // Takes back one attempt `hit` counted under `key` in the window closing at `resetAt`, never below zero, and does nothing once that window is gone: how kay lets a call that started no work, such as kayjs-ai's resume of a reply it keeps, not spend the limit. A store without it simply keeps the attempt counted.
  refund?: (key: string, resetAt: number) => void | Promise<void>
  // Forgets the window open under `key`, so its next hit opens a fresh one: how kayjs-auth clears a count once the attempt it guards succeeds, a sign-in say.
  reset?: (key: string) => void | Promise<void>
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
  // The least time between the page rendering the form and its post, a string such as '3s'.
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
  // What a library showing the calls to a visitor calls it, `Read the home` for `home_state`: kayjs-ai's `Chat` names the call with it. An agent never reads it.
  label?: string | undefined
  // The action only reads: an agent may run it without asking anyone. Left out, a library asking the visitor before it runs a model's tool call, as kayjs-ai's `Chat` does, asks for this one.
  readOnly?: boolean | undefined
}

// The checks that keep scripts from an action: `action(schema, handler, { protect: { rateLimit, honeypot, minTime, proofOfWork } })`.
export interface ActionProtect<Field extends string = never> {
  // At most `max` posts from one client every `window`, a string such as '1m'; past that a post fails with 429 without reaching the handler. `store` shares the count between processes.
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
}

// An action's options once `protect` is read, the checks on a level with the rest: what the server reads.
export interface ResolvedProtection {
  tool?: boolean | string | ActionTool | undefined
  rateLimit?: ActionRateLimit | ActionRateLimit[] | undefined
  honeypot?: string | HoneypotOptions | undefined
  minTime?: Duration | MinTimeOptions | undefined
  proofOfWork?: boolean | number | ProofOfWorkOptions | undefined
  maxSize?: ByteSize | undefined
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
export interface ActionStream<T> extends EventReader<T> {
  // Resolves with the last value once the stream ran to its end, undefined when it sent none; rejects with an `ActionError` when it failed, and an `AbortError` when it was closed first.
  ended: () => Promise<T | undefined>
}

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

export interface CallOptions {
  // Whether the page shows what the call changed once it succeeded, its loads run again as `refresh()` runs them; on unless `false`, and only where the page swap runs.
  refresh?: boolean | undefined
  // Shows the change at once, as the call goes: the signals it writes go back to what they held if the call fails, unless something wrote them since.
  optimistic?: (() => void) | undefined
  // Aborts the call: it rejects with the signal's reason, and the change `optimistic` showed goes back.
  signal?: AbortSignal | undefined
  // Headers sent with the call, which the handler reads from `ctx.request`; the ones kay sets itself win.
  headers?: Record<string, string> | undefined
}

// An action seen through the calls one island makes, so a row's button reads its own `pending()`.
export interface TrackedCall<Input, Result> {
  (form: FormData, options?: CallOptions): Promise<Result>
  // Resolves with how the call went, any answer the server gave included; a failure that is no answer, such as a network error, an abort or a redirect, still throws. Last, as on `Action`, so a wrong field is named.
  (...call: object extends Input ? [input?: Input, options?: CallOptions] : [input: Input, options?: CallOptions]): Promise<Result>
  // Whether a call made through this handle is still in flight, read reactively.
  readonly pending: () => boolean
  // Resolves once no call made through this handle is in flight, whichever way they went; never rejects.
  readonly settled: () => Promise<void>
}

// Called from the browser it posts its input and resolves with the handler's result; `form(action={...})` posts to `url`.
export interface Action<Input, Output, Honeypot extends string = never> {
  // A form's fields, read as a plain form post reads them: `add(new FormData(form))`. First, so a call matching neither is reported against the typed input below, naming its wrong field, and `Parameters<typeof add>` reads that one.
  (form: FormData, options?: CallOptions): Promise<Answer<Success<Output>>>
  (input: Input, options?: CallOptions): Promise<Answer<Success<Output>>>
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

// What a call may send for an input the handler reads: a `Blob` where it reads a `File`, since the server names every posted Blob, and `undefined` on an optional field, which the schema takes as the field left out.
export type Sendable<Value> = Value extends File ? Blob : Value extends readonly unknown[] ? { [Key in keyof Value]: Sendable<Value[Key]> } : Value extends Record<string, unknown> ? { [Key in keyof Value]: Partial<Pick<Value, Key>> extends Pick<Value, Key> ? Sendable<Value[Key]> | undefined : Sendable<Value[Key]> } : Value

export interface ServerAction<Schema extends TSchema, Output, Honeypot extends string = never> extends Action<Sendable<Static<Schema>>, Output, Honeypot> {
  readonly schema: Schema
  readonly handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>
  readonly protection?: ResolvedProtection
}

export function isAction(value: unknown): value is ServerAction<TSchema, unknown> {
  return typeof value === 'function' && ACTION in value
}

export type HoneypotOf<Target> = Target extends { [HONEYPOT]?: (field: infer Field) => void } ? Field : never
