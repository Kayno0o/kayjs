import type { CookieMap } from 'bun'
import type { Setter, SignalOptions } from 'solid-js'
import type { Action, FailureOf } from './action'
import type { Deferred, Locals } from './checks'
import { createSignal } from 'solid-js'

export interface Signal<T> {
  (): T
  set: Setter<T>
}

type PlainValue<T> = Exclude<T, (...args: never[]) => unknown>

// Solid reads a function argument as a computation; signal() narrows its input to plain values, so this one overload is all it reaches.
const createValueSignal = createSignal as unknown as <T>(value: T, options?: SignalOptions<T>) => [read: () => T, set: Setter<T>]

// A signal read as `count()` and written as `count.set(1)` or `count.set(c => c + 1)`.
export function signal<T>(): Signal<T | undefined>
export function signal<T>(value: PlainValue<T>, options?: SignalOptions<T>): Signal<T>
export function signal<T>(value?: PlainValue<T>, options?: SignalOptions<T | undefined>): Signal<T | undefined> {
  const [read, set] = createValueSignal<T | undefined>(value, options)

  return Object.assign(read, { set })
}

export interface PageContext<Params extends Record<string, string> = Record<string, string>> {
  request: Request
  url: URL
  params: Params
  // Read on demand; what a page sets or deletes goes out as Set-Cookie headers, redirects included.
  cookies: CookieMap
  // What the app's Elysia `derive`, `resolve` and `decorate` add, typed through `Register`.
  locals: Locals
  // Response status and headers of the page being rendered.
  status: (code: number) => void
  headers: Headers
  redirect: (location: string, status?: 301 | 302 | 303 | 307 | 308) => never
  notFound: () => never
  // Ends with that status, 403 unless given, rendering the nearest `_error.kay` with `message`.
  deny: (status?: number, message?: string) => never
  // Why the last plain form post to `action` failed, when it did; read once, on the page the browser went back to.
  failed: <Target extends Action<never, unknown>>(action: Target) => FailureOf<Target> | undefined
}

export interface PageError {
  status: number
  // The thrown error's message in development; production shows a generic one and logs the real error.
  message: string
  // Development only.
  stack?: string
}

// The context of `_error.kay`, rendered when a page's load or render throws.
export interface ErrorPageContext<Params extends Record<string, string> = Record<string, string>> extends PageContext<Params> {
  error: PageError
}

// What a `_guard.ts` decides from: who is asking, never a page's params, which an action has none of. For an action, `url` is the action's.
export type GuardContext = Pick<PageContext, 'request' | 'url' | 'cookies' | 'locals' | 'headers' | 'redirect' | 'deny'>

export type Guard = (ctx: GuardContext) => void | Promise<void>

// The default export of a `_guard.ts`: runs before every page and every action in its directory and below, and lets the request through unless it redirects or denies.
export function guard(check: Guard): Guard {
  return check
}

// Marks a promise for an `await` block and handles its rejection at once: the block renders the failure, and nothing crashes the process before it does.
export function defer<T>(value: T | PromiseLike<T>): Deferred<T> {
  const promise = Promise.resolve(value)

  void Promise.allSettled([promise])

  return promise as Deferred<T>
}

// What a page's template reads: every name its `--- server` fence declares.
export type PageData<Load extends (...args: never[]) => unknown> = Awaited<ReturnType<Load>>

export type { Action, ActionContext, Failure, FailureOf, FieldName, FormFailure, ServerAction } from './action'
export { action, ActionError, actionStub, formAction, isAction, registerActions } from './action'
export type { AwaitProps, CheckedHref, Deferred, HydrateWhen, IslandComponent, IslandProp, Locals, LocalsOf, Register } from './checks'
export { staticFor } from './static'
