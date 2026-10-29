import type { Static, t, TSchema } from 'elysia'
import type { ActionContext, ActionProtection, Answer, CallOptions, ServerAction, Settled, Success } from './action-shared'
import { callable } from './action-call'
import { minTimeOf, resolveProtection, workOf } from './action-protection'
import { ACTION, isAction } from './action-shared'
import { durationSeconds } from './duration'
import { ACTION_PREFIX } from './wire'

export { actionStub, OUTCOME_SCRIPT, readActionResponse, setRequestOutcome } from './action-call'
export { decodeCall, encodeCall, FILE_MARK, FORM_CALL, INPUT_PART } from './action-encode'
export type { EncodedCall } from './action-encode'
export { ActionError, ActionRedirectError, failure, isFailure } from './action-error'
export { collectForms, formAction, formChecked, formDescribed, formError, formInvalid, formMarked, formProtection, formValue, PAYLOAD_PARAM, setStamper, STAMP_FIELD } from './action-form'
export type { FieldName } from './action-form'
export { SETTLED } from './action-owner'
export type { Caller, Settles } from './action-owner'
export { honeypotField, minTimeOf, resolveProtection, workOf } from './action-protection'
export { isAction } from './action-shared'
export type { Action, ActionContext, ActionProtect, ActionProtection, ActionRateLimit, ActionStream, ActionTool, Answer, CallOptions, CallResult, Failure, FailureData, FailureOf, FailuresOf, Final, FormFailure, FormSuccess, HoneypotOptions, InputOf, MinTimeOptions, MinTimeRefusal, Outcome, ProofOfWorkOptions, ProofOfWorkRefusal, ProtectionMessages, RateKey, RateKeyContext, RateLimit, RateStore, RateWindow, ResolvedProtection, ResultOf, Sendable, ServerAction, Settled, Success, SuccessOf, TrackedCall } from './action-shared'

const UNSAFE_URL_CHARACTERS = /[^\w/.-]/g
// A module outside the root, as a linked library is, has `..` segments in its path, which a URL would resolve away.
const PARENT_SEGMENT = /(?<=^|\/)\.\.(?=\/|$)/g

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
// kept: free, it registers a route answering a POST, which the page's own render never runs, and a kept page is refreshed after the first request that can write.
export function action<Output, const Honeypot extends string = never>(handler: (ctx: ActionContext) => Output | Promise<Output>, protection?: ActionProtection<Honeypot>): NoInputAction<Settled<Output>, Honeypot>
export function action<Schema extends TSchema, Output, const Honeypot extends string = never>(schema: Schema, handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>, protection?: ActionProtection<Honeypot>): ServerAction<Schema, Settled<Output>, Honeypot>
export function action(first: unknown, second?: unknown, third?: ActionProtection<string>): unknown {
  if (typeof first === 'function') {
    const handler = first as (ctx: ActionContext) => unknown

    return declare(emptySchema(), (_input, ctx) => handler(ctx), second as ActionProtection<string> | undefined)
  }

  return declare(first as TSchema, second as (input: unknown, ctx: ActionContext) => unknown, third)
}

export function declare(schema: TSchema, handler: (input: unknown, ctx: ActionContext) => unknown, options: ActionProtection<string> | undefined): ServerAction<TSchema, unknown> {
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
    schema: { value: schema, enumerable: true, writable: true },
    handler: { value: handler, enumerable: true },
    protection: { value: protection, enumerable: true },
    [ACTION]: { value: true },
  }) as unknown as ServerAction<TSchema, unknown>
}

// Gives every action a page module exports the URL the server registers it under.
export function registerActions(moduleId: string, exports: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(exports)) {
    if (isAction(value))
      (value as { url: string }).url = actionUrl(moduleId, name)
  }
}
