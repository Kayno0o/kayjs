import type { CookieMap } from 'bun'
import type { Setter, SignalOptions } from 'solid-js'
import type { Action, FailureOf } from './action'
import type { Locals } from './checks'
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

// What a page's template reads: every name its `--- server` fence declares.
export type PageData<Load extends (...args: never[]) => unknown> = Awaited<ReturnType<Load>>

export type { Action, ActionContext, Failure, FailureOf, FieldName, FormFailure, ServerAction } from './action'
export { action, ActionError, actionStub, formAction, isAction, registerActions } from './action'
export type { CheckedHref, HydrateWhen, IslandComponent, IslandProp, Locals, LocalsOf, Register } from './checks'
