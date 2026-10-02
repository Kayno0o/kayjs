import type { Static, TSchema } from 'elysia'

const ACTION = Symbol.for('kay.action')
const UNSAFE_URL_CHARACTERS = /[^\w/.-]/g

export interface ActionContext {
  request: Request
  // Response status and headers, for a fetch call or the redirect after a plain form post.
  status: (code: number) => void
  headers: Headers
  redirect: (location: string, status?: 301 | 302 | 303 | 307 | 308) => never
}

// Called from the browser it posts its input and resolves with the handler's result; `form(action={...})` posts to `url`.
export interface Action<Input, Output> {
  (input: Input): Promise<Output>
  readonly url: string
  readonly [ACTION]: true
}

export interface ServerAction<Schema extends TSchema, Output> extends Action<Static<Schema>, Output> {
  readonly schema: Schema
  readonly handler: (input: Static<Schema>, ctx: ActionContext) => Output | Promise<Output>
}

export class ActionError extends Error {
  override name = 'ActionError'

  constructor(readonly status: number, readonly body: string) {
    super(`Action failed with ${status}: ${body}`)
  }
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

// A form field's `name`, checked against the input of the action its form posts to.
export function field<Target>(_target: Target, name: FieldName<Target>): string {
  return name
}

async function post<Output>(url: string, input: unknown): Promise<Output> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kay-action': '1' },
    body: JSON.stringify(input),
  })
  const body = await response.text()

  if (!response.ok)
    throw new ActionError(response.status, body)

  return (body === '' ? undefined : JSON.parse(body)) as Output
}
