import type { CookieMap } from 'bun'
import type { Static, TSchema } from 'elysia'
import type { Locals } from './checks'

const ACTION = Symbol.for('kay.action')
const FAILURE = Symbol.for('kay.failure')

// Type only: what the handler returns, failures included, so a page can type `ctx.failed(action)`.
declare const RESULT: unique symbol
const UNSAFE_URL_CHARACTERS = /[^\w/.-]/g

export interface ActionContext {
  request: Request
  cookies: CookieMap
  locals: Locals
  // Response status and headers, for a fetch call or the redirect after a plain form post.
  status: (code: number) => void
  headers: Headers
  redirect: (location: string, status?: 301 | 302 | 303 | 307 | 308) => never
  // `return ctx.fail(409, { message: 'Taken' })`: a plain form post goes back to its page, which reads it through `ctx.failed(action)`; a call throws an `ActionError` carrying `data`.
  fail: <const Data = undefined>(status: number, data?: Data) => Failure<Data>
}

export interface Failure<Data> {
  readonly [FAILURE]: true
  readonly status: number
  readonly data: Data
}

export type Success<Output> = Exclude<Output, Failure<unknown>>
export type FailureData<Output> = Output extends Failure<infer Data> ? Data : never

// What a page reads back through `ctx.failed(action)` after a plain form post failed.
export interface FormFailure<Input, Data> {
  status: number
  // What the form posted, so its fields can show it again; fields named like a password or a secret are left out.
  values: Partial<Record<Extract<keyof Input, string>, string>>
  // A message per field the schema refused.
  errors: Partial<Record<Extract<keyof Input, string>, string>>
  // What the handler passed to `ctx.fail`; undefined when the schema refused the input.
  data?: Data
}

export type FailureOf<Target> = Target extends Action<infer Input, infer Output> ? FormFailure<Input, FailureData<Output>> : never

// Called from the browser it posts its input and resolves with the handler's result; `form(action={...})` posts to `url`.
export interface Action<Input, Output> {
  (input: Input): Promise<Success<Output>>
  readonly url: string
  readonly [ACTION]: true
  readonly [RESULT]?: Output
}

export interface ServerAction<Schema extends TSchema, Output> extends Action<Static<Schema>, Output> {
  readonly schema: Schema
  readonly handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>
}

export class ActionError extends Error {
  override name = 'ActionError'

  // `errors` holds a message per field the schema refused, `data` what the handler passed to `ctx.fail`.
  constructor(readonly status: number, readonly body: string, readonly errors: Record<string, string> = {}, readonly data?: unknown) {
    super(`Action failed with ${status}: ${body}`)
  }
}

export function failure<Data>(status: number, data: Data): Failure<Data> {
  return { [FAILURE]: true, status, data }
}

export function isFailure(value: unknown): value is Failure<unknown> {
  return typeof value === 'object' && value !== null && FAILURE in value
}

export function actionUrl(moduleId: string, name: string): string {
  return `/_kay/action/${moduleId.replace(UNSAFE_URL_CHARACTERS, '_')}/${name}`
}

// Declares a server action in a page's `--- server` fence: Elysia validates the input against `schema` before `handler` runs.
export function action<Schema extends TSchema, Output>(schema: Schema, handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>): ServerAction<Schema, Awaited<Output>> {
  const state = { url: '' }
  const call = async (input: Static<Schema>) => post<Awaited<Output>>(state.url, input)

  return Object.defineProperties(call, {
    url: { get: () => state.url, set: (url: string) => void (state.url = url), enumerable: true },
    schema: { value: schema, enumerable: true },
    handler: { value: handler, enumerable: true },
    [ACTION]: { value: true },
  }) as unknown as ServerAction<Schema, Awaited<Output>>
}

// What a browser build exports in place of a server action.
export function actionStub(url: string): Action<unknown, unknown> {
  return Object.defineProperties(async (input: unknown) => post(url, input), {
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

export function formAction(target: string | Action<never, unknown>): string {
  return typeof target === 'string' ? target : target.url
}

export type FieldName<Target> = Target extends Action<infer Input, unknown> ? Extract<keyof Input, string> : string

async function post<Output>(url: string, input: unknown): Promise<Output> {
  return readActionResponse(await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kay-action': '1' },
    body: JSON.stringify(input),
  }))
}

// What a call got back: the handler's result, or an `ActionError` with the refused fields and the failure data.
export async function readActionResponse<Output>(response: Response): Promise<Output> {
  const body = await response.text()

  if (!response.ok) {
    const failed = response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(body) as { errors?: Record<string, string>, data?: unknown } : {}

    throw new ActionError(response.status, body, failed.errors, failed.data)
  }

  return (body === '' ? undefined : JSON.parse(body)) as Output
}
