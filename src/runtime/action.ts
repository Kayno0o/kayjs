import type { t } from 'elysia'
import type { ActionContext, ActionProtection, Answer, Called, CallOptions, OutputSchema, ServerAction, Settled, Success } from './action-shared'
import type { RouteParams } from './checks'
import type { Schema, StandardAs, Static } from './schema'
import type { ObjectOf, SchemaShape } from './schema-record'
import type { StandardSchema } from './standard-schema'
import { callable } from './action-call'
import { minTimeOf, resolveProtection, workOf } from './action-protection'
import { ACTION, isAction } from './action-shared'
import { durationSeconds } from './duration'
import { KayError } from './kay-error'
import { isSchema, schemaOf } from './schema-record'
import { isStandardSchema } from './standard-schema'
import { ACTION_PREFIX } from './wire'

export { actionStub, OUTCOME_SCRIPT, setRequestOutcome } from './action-call'
export { decodeCall, encodeCall, FILE_MARK, FORM_CALL, INPUT_PART } from './action-encode'
export type { EncodedCall } from './action-encode'
export { ActionError, ActionRedirectError, failure, isFailure } from './action-error'
export { carrySchema, collectForms, FORM_FIELD, formAction, formChecked, formDescribed, formError, formErrors, formHere, formInitial, formInitialChecked, formInvalid, formKey, formMarked, formProtection, formScope, formStart, formValue, issueScope, PAYLOAD_PARAM, postedChecked, postedValue, postedValues, protectionFields, setStamper, STAMP_FIELD } from './action-form'
export type { FieldName } from './action-form'
export { SETTLED } from './action-owner'
export type { Caller, Settles } from './action-owner'
export { readActionResponse } from './action-post'
export { honeypotField, minTimeOf, resolveProtection, workOf } from './action-protection'
export { isAction } from './action-shared'
export type { Action, ActionContext, ActionDone, ActionErrorDetail, ActionFailed, ActionForm, ActionHookContext, ActionHooks, ActionProtect, ActionProtection, ActionRateLimit, ActionRun, ActionStartDetail, ActionStream, ActionSuccessDetail, ActionTool, Answer, Called, CallOptions, CallQueue, CallResult, Failure, FailureData, FailureOf, FailuresOf, FieldErrors, Final, FormFailure, FormSuccess, HoneypotOptions, InputOf, MinTimeOptions, MinTimeRefusal, Outcome, OutputSchema, ProofOfWorkOptions, ProofOfWorkRefusal, ProtectionMessages, RateKey, RateKeyContext, RateLimit, RateLimitRefusal, RateStore, RateWindow, Refreshable, ResolvedProtection, ResultOf, RetryOptions, Sendable, ServerAction, Settled, Success, SuccessOf, TrackedCall } from './action-shared'
export type { CallPromise, TrackHooks } from './call-result'

const UNSAFE_URL_CHARACTERS = /[^\w/.-]/g
// A module outside the root, as a linked library is, has `..` segments in its path, which a URL would resolve away.
const PARENT_SEGMENT = /(?<=^|\/)\.\.(?=\/|$)/g

export function actionUrl(moduleId: string, name: string): string {
  return `${ACTION_PREFIX}${moduleId.replace(UNSAFE_URL_CHARACTERS, '_').replace(PARENT_SEGMENT, '~')}/${name}`
}

// What an action with no input takes: no fields, so `add()` calls it.
export type NoInputAction<Output, Honeypot extends string = never> = ServerAction<EmptySchema, Output, Honeypot> & ((input?: undefined, options?: CallOptions<Answer<Success<Output>>>) => Called<Output>)

// An empty object schema built by hand: `t.Object({})` would carry Elysia into the islands importing this module, and TypeBox reads a schema by this symbol.
type EmptySchema = ReturnType<typeof t.Object<Record<never, never>>>

// Built per declaration, so an island bundle that never declares an action drops it.
const emptySchema = () => ({ [Symbol.for('TypeBox.Kind')]: 'Object', type: 'object', properties: {} }) as unknown as EmptySchema

// `action` as `kay check` reads it in a page's server fence, whose `ctx.params` are those of the page's route: not something to write.
export interface ActionFor<Params extends Readonly<Record<string, unknown>>, Guarded extends object = object> {
  <const Honeypot extends string = never, Output = never, Shape extends OutputSchema = OutputSchema>(options: ActionProtection<Honeypot, Success<Settled<Output>>, Shape> & { input?: undefined }, handler: (ctx: ActionContext<Params, string, Guarded>) => Output | Promise<Output>): NoInputAction<Settled<Output>, Honeypot>
  <Spec extends Schema, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(options: ActionProtection<Honeypot, Success<Settled<Output>>, Shape> & { input: Spec }, handler: (input: Static<Spec>, ctx: ActionContext<Params, Extract<keyof Static<Spec>, string>, Guarded>) => Output | Promise<Output>): ServerAction<Spec, Settled<Output>, Honeypot>
  <Validator extends StandardSchema, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(options: ActionProtection<Honeypot, Success<Settled<Output>>, Shape> & { input: Validator }, handler: (input: Static<StandardAs<Validator>>, ctx: ActionContext<Params, Extract<keyof Static<StandardAs<Validator>>, string>, Guarded>) => Output | Promise<Output>): ServerAction<StandardAs<Validator>, Settled<Output>, Honeypot>
  <const Fields extends SchemaShape, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(options: ActionProtection<Honeypot, Success<Settled<Output>>, Shape> & { input: Fields }, handler: (input: Static<ObjectOf<Fields>>, ctx: ActionContext<Params, Extract<keyof Static<ObjectOf<Fields>>, string>, Guarded>) => Output | Promise<Output>): ServerAction<ObjectOf<Fields>, Settled<Output>, Honeypot>
  <Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(handler: (ctx: ActionContext<Params, string, Guarded>) => Output | Promise<Output>, protection?: ActionProtection<Honeypot, Success<Settled<Output>>, Shape>): NoInputAction<Settled<Output>, Honeypot>
  <Spec extends Schema, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(schema: Spec, handler: (input: Static<Spec>, ctx: ActionContext<Params, Extract<keyof Static<Spec>, string>, Guarded>) => Output | Promise<Output>, protection?: ActionProtection<Honeypot, Success<Settled<Output>>, Shape>): ServerAction<Spec, Settled<Output>, Honeypot>
  <const Fields extends SchemaShape, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(fields: Fields, handler: (input: Static<ObjectOf<Fields>>, ctx: ActionContext<Params, Extract<keyof Static<ObjectOf<Fields>>, string>, Guarded>) => Output | Promise<Output>, protection?: ActionProtection<Honeypot, Success<Settled<Output>>, Shape>): ServerAction<ObjectOf<Fields>, Settled<Output>, Honeypot>
}

// Declares a server action in a page's `--- server` fence: the options come first, as an API route's do, `input` a plain record of fields or any schema that kay checks the post against before `handler` runs.
// Without an `input` the action takes no input, as with an empty object schema, and its handler gets the context alone.
// The form before 1.107, `action(schema, handler, options)`, works until 2.0: the `deprecated-action-options` lint rewrites it.
// kept: free, it registers a route answering a POST, which the page's own render never runs, and a kept page is refreshed after the first request that can write.
export function action<const Honeypot extends string = never, Output = never, Shape extends OutputSchema = OutputSchema>(options: ActionProtection<Honeypot, Success<Settled<Output>>, Shape> & { input?: undefined }, handler: (ctx: ActionContext) => Output | Promise<Output>): NoInputAction<Settled<Output>, Honeypot>
export function action<Spec extends Schema, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(options: ActionProtection<Honeypot, Success<Settled<Output>>, Shape> & { input: Spec }, handler: (input: Static<Spec>, ctx: ActionContext<RouteParams, Extract<keyof Static<Spec>, string>>) => Output | Promise<Output>): ServerAction<Spec, Settled<Output>, Honeypot>
export function action<Validator extends StandardSchema, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(options: ActionProtection<Honeypot, Success<Settled<Output>>, Shape> & { input: Validator }, handler: (input: Static<StandardAs<Validator>>, ctx: ActionContext<RouteParams, Extract<keyof Static<StandardAs<Validator>>, string>>) => Output | Promise<Output>): ServerAction<StandardAs<Validator>, Settled<Output>, Honeypot>
export function action<const Fields extends SchemaShape, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(options: ActionProtection<Honeypot, Success<Settled<Output>>, Shape> & { input: Fields }, handler: (input: Static<ObjectOf<Fields>>, ctx: ActionContext<RouteParams, Extract<keyof Static<ObjectOf<Fields>>, string>>) => Output | Promise<Output>): ServerAction<ObjectOf<Fields>, Settled<Output>, Honeypot>
export function action<Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(handler: (ctx: ActionContext) => Output | Promise<Output>, protection?: ActionProtection<Honeypot, Success<Settled<Output>>, Shape>): NoInputAction<Settled<Output>, Honeypot>
export function action<Spec extends Schema, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(schema: Spec, handler: (input: Static<Spec>, ctx: ActionContext<RouteParams, Extract<keyof Static<Spec>, string>>) => Output | Promise<Output>, protection?: ActionProtection<Honeypot, Success<Settled<Output>>, Shape>): ServerAction<Spec, Settled<Output>, Honeypot>
export function action<const Fields extends SchemaShape, Output, const Honeypot extends string = never, Shape extends OutputSchema = OutputSchema>(fields: Fields, handler: (input: Static<ObjectOf<Fields>>, ctx: ActionContext<RouteParams, Extract<keyof Static<ObjectOf<Fields>>, string>>) => Output | Promise<Output>, protection?: ActionProtection<Honeypot, Success<Settled<Output>>, Shape>): ServerAction<ObjectOf<Fields>, Settled<Output>, Honeypot>
export function action(first: unknown, second?: unknown, third?: ActionProtection<string>): unknown {
  if (typeof first === 'function') {
    const handler = first as (ctx: ActionContext) => unknown

    return declare(emptySchema(), (_input, ctx) => handler(ctx), second as ActionProtection<string> | undefined)
  }

  if (third === undefined && isOptions(first)) {
    const { input, ...options } = first as { input?: Schema | SchemaShape }
    const handler = second as (...args: unknown[]) => unknown

    // Without an `input` the handler takes the context alone, though an empty record before 1.107 gave it `(input, ctx)`.
    return declare(input === undefined ? emptySchema() : schemaOf(input), input === undefined && handler.length < 2 ? (_input, ctx) => handler(ctx) : handler, options)
  }

  return declare(schemaOf(first as Schema | SchemaShape), second as (input: unknown, ctx: ActionContext) => unknown, third)
}

// Whether the first argument is the options of the form since 1.107, not the schema or the record of fields of the form before: an object that names an `input` which is a record or an object schema, or names no field at all.
function isOptions(first: unknown): boolean {
  if (typeof first !== 'object' || first === null || isSchema(first) || isStandardSchema(first))
    return false

  const entries = Object.entries(first)

  if ('input' in first) {
    const { input } = first

    // An `input` that is a schema or a record is options; so is one left undefined. A legacy record holding a field called `input` has a schema beside it, which options never do.
    if (input === undefined)
      return true

    if (typeof input !== 'object' || input === null)
      return false

    return !entries.some(([name, value]) => name !== 'input' && (isSchema(value) || isStandardSchema(value)))
  }

  return !entries.some(([, value]) => isSchema(value) || isStandardSchema(value))
}

export function declare(schema: Schema, handler: (input: unknown, ctx: ActionContext) => unknown, options: ActionProtection<string> | undefined): ServerAction<Schema, unknown> {
  const protection = resolveProtection(options)

  // Refused as the module loads, rather than on the first post.
  if (protection?.minTime !== undefined)
    minTimeOf(protection)

  if (protection?.proofOfWork !== undefined)
    workOf(protection)

  for (const limit of [protection?.rateLimit ?? []].flat()) {
    durationSeconds(limit.window, 'rateLimit.window')

    if (limit.onLimit !== undefined && typeof limit.onLimit !== 'function')
      throw new KayError('config-invalid', 'kay: a rateLimit has an onLimit that is not a function; it takes a function of the refusal')

    if (limit.count === 'succeeded' && limit.store && !limit.store.peek)
      throw new KayError('config-invalid', 'kay: a rateLimit counting only the posts that went through reads its count before the handler runs, so its store needs a peek(key) method')
  }

  const state = { url: '' }
  const { call, reads } = callable(() => state.url)

  return Object.defineProperties(call, {
    ...reads,
    url: { get: () => state.url, set: (url: string) => void (state.url = url), enumerable: true },
    schema: { value: schema, enumerable: true, writable: true },
    handler: { value: handler, enumerable: true },
    protection: { value: protection, enumerable: true },
    [ACTION]: { value: true },
  }) as unknown as ServerAction<Schema, unknown>
}

// Gives every action a page module exports the URL the server registers it under.
export function registerActions(moduleId: string, exports: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(exports)) {
    if (isAction(value))
      (value as { url: string }).url = actionUrl(moduleId, name)
  }
}
