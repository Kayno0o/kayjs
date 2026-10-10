import type { CookieMap } from 'bun'
import type { Static, TSchema } from 'elysia'
import type { Action, FailureOf, SuccessOf } from './action'
import type { Deferred, Locals, Redirect, RouteParams } from './checks'
import type { Duration } from './duration'
import type { Locale } from './i18n'
import type { PersistStorage } from './persist'
import type { SignalOptions } from './reactive'
import { keepValue } from './persist'
import { keepParam } from './query-param'
import { createSignal, memo, onCleanup, provideContext, readContext, tracking, untrack } from './reactive'

// Writes a value, or what a function makes of the current one.
export type Setter<T> = (next: T | ((current: T) => T)) => void

export interface Signal<T> {
  (): T
  set: Setter<T>
}

// What `memo` makes: a prop typed `Memo<T>` reads by its name in the template, as a signal does.
export type Memo<T> = () => T

// A function passed to `set` is an updater, so a signal holds no functions.
type PlainValue<T> = Exclude<T, (...args: never[]) => unknown>

export interface PersistedOptions<T> extends SignalOptions<T> {
  // `cookie`, the default, is read by the server too, so pages render with the value; `local` keeps it in localStorage, applied once the page has hydrated; `query` keeps a string in the page's URL, the server reading it too.
  storage?: PersistStorage | undefined
}

// A signal read as `count()` and written as `count.set(1)` or `count.set(c => c + 1)`.
export function signal<T>(): Signal<T | undefined>
export function signal<T>(value: PlainValue<T>, options?: SignalOptions<T>): Signal<T>
export function signal<T>(value?: PlainValue<T>, options?: SignalOptions<T | undefined>): Signal<T | undefined> {
  const [read, write] = createSignal<T | undefined>(value, options)

  return withSetter(read, write)
}

// A signal whose value is kept across pages and visits under `name`, the cookie's or the localStorage key's, or in the URL under the query param `name`, which the default leaves out.
export function persisted<T extends string = string>(name: string, value: NoInfer<T>, options: PersistedOptions<NoInfer<T>> & { storage: 'query' }): Signal<T>
export function persisted<T>(name: string, value: PlainValue<T>, options?: PersistedOptions<T> & { storage?: 'cookie' | 'local' | undefined }): Signal<T>
export function persisted<T>(name: string, value: PlainValue<T>, options?: PersistedOptions<T>): Signal<T> {
  const [own, write] = createSignal<T>(value, options)
  const kept = keepValue(name, options?.storage ?? 'cookie', own, write, value as T)

  return withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })
}

// A signal holding the page's query param `name`, read as the page's `query` schema reads it, so `queryParam<number>('page')` holds a number; the schema's default when the param is left out or refused, which writing leaves out of the URL.
// Without a schema naming the param, its text, as `persisted(name, '', { storage: 'query' })` keeps it.
export function queryParam<T = string | undefined>(name: string): Signal<T> {
  const [own, write] = createSignal<T>(undefined as T)
  const kept = keepParam(name, own, write)

  return withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })
}

// A signal an island edits locally that takes `source`'s value again whenever it changes: `const tiers = linked(() => board.tiers)` follows the prop once the page brings a new board.
export function linked<T>(source: () => T): Signal<T> {
  const from = memo(source)
  let changes = 0
  // Counts the source's changes, so an edit made before one is out of date even when the source comes back to the value it was made over.
  const generation = memo(() => {
    from()

    return ++changes
  })
  const [edit, write] = createSignal<{ at: number, value: T } | undefined>(undefined)
  const read = () => {
    const at = generation()
    const own = edit()

    return own !== undefined && own.at === at ? own.value : from()
  }

  return withSetter(read, value => write({ at: untrack(generation), value }))
}

function withSetter<T>(read: () => T, write: (value: T) => void): Signal<T> {
  const set: Setter<T> = next => write(typeof next === 'function' ? (next as (current: T) => T)(untrack(read)) : next)

  return Object.assign(read, { set })
}

export interface Context<T> {
  // Makes `value` what the components this one renders read, called in its script.
  provide: (value: T) => void
  // What the nearest component above provided, else the default.
  use: () => T
}

// A value a component hands what it renders, however deep, without passing it through each one's props: `Theme.provide('dark')` in one, `Theme.use()` below it.
export function context<T>(fallback: T): Context<T> {
  const key = Symbol('kay.context')

  return {
    provide: value => provideContext(key, value),
    use: () => {
      const found = readContext(key)

      return found.found ? found.value as T : fallback
    },
  }
}

export interface Selection<Key> {
  (): Key | undefined
  set: (key: Key | undefined | ((current: Key | undefined) => Key | undefined)) => void
  // Whether `key` is the selected one, tracked per key.
  is: (key: Key) => boolean
}

interface Flag {
  read: () => boolean
  write: (selected: boolean) => void
  readers: number
}

// One selected key among many rows: `is(key)` reads a flag of that key's own, so a change re-runs what read the old key and the new one, not every row.
// Flags are made on first read and dropped once nothing reads them.
export function selection<Key extends string | number>(initial?: Key): Selection<Key> {
  const [read, write] = createSignal<Key | undefined>(initial)
  const flags = new Map<Key, Flag>()
  let current = initial

  const set: Selection<Key>['set'] = (next) => {
    const key = typeof next === 'function' ? next(current) : next

    if (key === current)
      return

    if (current !== undefined)
      flags.get(current)?.write(false)

    if (key !== undefined)
      flags.get(key)?.write(true)

    current = key
    write(key)
  }

  const is = (key: Key): boolean => {
    if (!tracking())
      return key === current

    let flag = flags.get(key)

    if (!flag) {
      const [readFlag, writeFlag] = createSignal(key === current, undefined, false)

      flag = { read: readFlag, write: writeFlag, readers: 0 }
      flags.set(key, flag)
    }

    const held = flag

    held.readers++
    onCleanup(() => {
      if (--held.readers === 0 && flags.get(key) === held)
        flags.delete(key)
    })

    return held.read()
  }

  return Object.assign(read, { set, is })
}

export interface PageContext<Params extends Record<string, unknown> = Record<string, string>, Query = Readonly<Record<string, unknown>>> {
  request: Request
  url: URL
  // The locale the page is served in, as `i18n` in kay.config.ts gives it; the site's `lang` without.
  locale: Locale
  params: Params
  // The search params, read against the page's `export const page = { query: s.Object(...) }`; a query it refuses answers 400. Their raw text is `url.searchParams`.
  query: Query
  // Read on demand; what a page sets or deletes goes out as Set-Cookie headers, redirects included.
  cookies: CookieMap
  // What the app's Elysia `derive`, `resolve` and `decorate` add, typed through `Register`.
  locals: Locals
  // Response status and headers of the page being rendered.
  status: (code: number) => void
  headers: Headers
  redirect: Redirect
  notFound: () => never
  // Ends with that status, 403 unless given, rendering the nearest `_error.kay` with `message`.
  deny: (status?: number, message?: string) => never
  // Why the plain form post to `action` this page answers was refused, when it was.
  failed: <Target extends Action<never, unknown>>(action: Target) => FailureOf<Target> | undefined
  // What the last plain form post to `action` returned, when it succeeded; read once, on the page the browser went back to.
  succeeded: <Target extends Action<never, unknown>>(action: Target) => SuccessOf<Target> | undefined
}

// A page `kay build` prerenders renders without a request, so what only a request carries is refused where it is read; a `prerender` computed as a plain `boolean` is checked when it renders.
// Written out rather than through an alias, which an error would name instead of saying why.
export type PrerenderedContext<Flag, Context> = [Flag] extends [false | null | undefined]
  ? Context
  : boolean extends Flag
    ? Context
    : Omit<Context, 'cookies' | 'query' | 'locals'> & {
      cookies: { kayError: 'A prerendered page renders once, at build time, with no ctx.cookies; drop prerender from export const page to render it per request' }
      query: { kayError: 'A prerendered page renders once, at build time, with no ctx.query; drop prerender from export const page to render it per request' }
      locals: { kayError: 'A prerendered page renders once, at build time, with no ctx.locals; drop prerender from export const page to render it per request' }
    }

export interface PageError {
  status: number
  // The thrown error's message in development; production shows a generic one and logs the real error.
  message: string
  // Development only.
  stack?: string | undefined
}

// The context of `_error.kay`, rendered when a page's load or render throws.
export interface ErrorPageContext<Params extends Record<string, unknown> = Record<string, string>> extends PageContext<Params> {
  error: PageError
}

// What a `_guard.ts` decides from: who is asking, and the params of the page asked for, each matcher's value in place of its text.
// For an action, `url` is the action's and `params` those of the page it was posted from; for an API route, its own as Elysia hands them to the handler.
export type GuardContext = Pick<PageContext<RouteParams>, 'request' | 'url' | 'locale' | 'params' | 'cookies' | 'locals' | 'headers' | 'redirect' | 'deny'>

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

// `export const page = { ... }` in a page's server fence; a layout takes `layouts` alone.
export interface PageSettings {
  // `kay build` renders the page once: `true` for a route without params, else the params of each page to render, as a list, a function returning one, a content collection or a `paginate()` list.
  prerender?: boolean | object
  // How long a prerendered page is served before it renders again.
  revalidate?: Duration
  // `false` renders the page, or the layouts below this one, without the layouts above.
  layouts?: false
  // The schema `ctx.query` is read against; a query it refuses answers 400.
  query?: TSchema
  // The pages of the route the sitemap lists, as `prerender` takes them; `false` leaves it out.
  sitemap?: boolean | object
  // Keeps the page out of search engines and the sitemap.
  noindex?: boolean
}

// What a page's query schema gives `ctx.query`.
export type QueryOf<Schema> = Schema extends TSchema ? Static<Schema> : never

// What a page's template reads: every name its `--- server` fence declares.
export type PageData<Load extends (...args: never[]) => unknown> = Awaited<ReturnType<Load>>

export { s, t } from '#schema'
export type { Action, ActionContext, ActionProtection, ActionRateLimit, CallOptions, Failure, FailureData, FailureOf, FieldName, FormFailure, FormSuccess, HoneypotOptions, MinTimeOptions, MinTimeRefusal, ProtectionMessages, RateLimit, RateStore, RateWindow, ServerAction, Success, SuccessOf } from './action'
export { action, ActionError, ActionRedirect } from './action'
export { localPath, withBase } from './base'
export type { ApiRoutesOf, AwaitProps, CheckedHref, CheckedHtml, Deferred, ExtensionServersOf, FunctionProp, HydrateWhen, IdentityKeyed, Inferred, IslandBrand, IslandComponent, IslandOptions, IslandProp, Locals, LocalsOf, Redirect, Register, RouteParams, SafeHtml, TemplateHelpers } from './checks'
export type { Duration } from './duration'
export type { PublicEnv, PublicEnvOf } from './env'
export { publicEnv } from './env'
export type { Component, EventHandler, JSX } from './jsx'
export type { LeaveGuardOptions } from './leave'
export { guardLeave } from './leave'
export type { EventReader, EventStream, Jsonified, Resource, ResourceFailure, ResourcePath, ResourceStatus, Socket, SocketPath, SocketStatus, StreamPath, StreamStatus } from './live'
export { dispatch, resource, socket, stream } from './live'
export type { NavigateOptions, QueryChanges } from './navigate'
export { navigate, refresh } from './navigate'
export type { PersistStorage } from './persist'
export { previewing } from './preview'
export type { SignalOptions } from './reactive'
export { batch, effect, flush, memo, onCleanup, onMount, root, untrack } from './reactive'
export { sanitizeHtml, trustHtml } from './sanitize'
export type { TransitionClasses } from './transition'
export { uid } from './uid'
