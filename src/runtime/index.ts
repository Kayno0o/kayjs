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
import { createSignal, effect, memo, onCleanup, ownSignal, provideContext, readContext, tracking, untrack } from './reactive'

// Writes a value, or what a function makes of the current one.
export type Setter<T> = (next: T | ((current: T) => T)) => void

export interface Signal<T> {
  (): T
  set: Setter<T>
}

// What `memo` makes: a prop typed `Memo<T>` takes the memo itself, read by calling it, as a signal is.
export type Memo<T> = () => T

// A function passed to `set` is an updater, so a signal holds no functions.
type PlainValue<T> = Exclude<T, (...args: never[]) => unknown>

export interface PersistedOptions<T> extends SignalOptions<T> {
  // `cookie`, the default, is read by the server too, so pages render with the value; `local` keeps it in localStorage, applied once the page has hydrated; `query` is `queryParam(name)`, the value given standing for the param left out, after the default of a `query` schema naming it.
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
// A string unless `T` says otherwise, for a param the page's `query` schema reads as another type: the URL holds text.
export function persisted<T = string>(name: string, value: NoInfer<PlainValue<T>>, options: PersistedOptions<NoInfer<T>> & { storage: 'query' }): Signal<T>
export function persisted<T>(name: string, value: PlainValue<T>, options?: PersistedOptions<T> & { storage?: 'cookie' | 'local' | undefined }): Signal<T>
export function persisted<T>(name: string, value: PlainValue<T>, options?: PersistedOptions<T>): Signal<T> {
  const [own, write] = createSignal<T>(value, options)
  const storage = options?.storage ?? 'cookie'
  // The same as `queryParam(name)`, `value` standing for the param left out.
  const kept = storage === 'query' ? keepParam(name, own, write, value as T) : keepValue(name, storage, own, write)

  return withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })
}

// A signal holding the page's query param `name`, read as the `query` schemas of the page and its layouts read it, so `queryParam<number>('page')` holds a number; the schema's default when the param is left out or refused, which writing leaves out of the URL.
// Without a schema naming the param, its text, as `persisted(name, '', { storage: 'query' })` keeps it.
export function queryParam<T = string | undefined>(name: string): Signal<T> {
  const [own, write] = createSignal<T>(undefined as T)
  const kept = keepParam(name, own, write)

  return withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })
}

export interface EveryOptions {
  // Read as an effect reads: the timer starts as it turns true and stops as it turns false.
  while?: (() => boolean) | undefined
  // Runs `run` as the timer starts too, rather than one interval later: a poll showing fresh data the moment it starts.
  immediate?: boolean | undefined
}

// Runs `run` every `ms` milliseconds while the island lives, and while `options.while` holds: `every(3000, refresh, { while: () => issuing })` polls the page until nothing is issuing.
// Nothing runs while the server renders, and a tick is skipped while the promise the last run returned is pending, so a slow refresh never piles up.
export function every(ms: number, run: () => unknown, options?: EveryOptions): void {
  effect(() => {
    if (options?.while && !options.while())
      return

    let busy = false
    const tick = async () => {
      if (busy)
        return

      busy = true

      try {
        await untrack(run)
      }
      finally {
        busy = false
      }
    }
    const timer = setInterval(() => void tick(), ms)

    onCleanup(() => clearInterval(timer))

    if (options?.immediate)
      void tick()
  })
}

export interface WatchOptions {
  // Runs `run` on the first read too, `previous` being undefined then.
  immediate?: boolean | undefined
}

// Runs `run` whenever `source` gives a new value, not on its first read, handed the value it gave before: `watch(turn, (next, previous) => ...)`.
// The first read is the island's effects' first run, once its render is done: a write the script makes before then is part of it.
// Only `source` is tracked, never what `run` reads, and a value equal to the last one runs nothing; nothing runs while the server renders.
export function watch<T>(source: () => T, run: (next: T, previous: T) => unknown, options?: WatchOptions & { immediate?: false | undefined }): void
export function watch<T>(source: () => T, run: (next: T, previous: T | undefined) => unknown, options?: WatchOptions): void
export function watch<T>(source: () => T, run: (next: T, previous: T | undefined) => unknown, options?: WatchOptions): void {
  // A memo, so a read that gives the same value again reruns nothing, and what `run` registered with `onCleanup` stays.
  const value = memo(source, { equals: Object.is })
  let first = true
  let previous: T | undefined

  effect(() => {
    const next = value()
    const before = previous
    const runs = !first || options?.immediate === true

    first = false
    previous = next

    if (runs)
      untrack(() => run(next, before))
  })
}

// `source`'s value once it has stopped changing for `ms` milliseconds, starting with its value now: `watch(debounced(typed, 300), lookUp)` looks a name up as the user pauses.
// The pending timer goes with the island; while the server renders, the value stays the one `source` gave first.
export function debounced<T>(source: () => T, ms: number): Memo<T> {
  const [settled, write] = createSignal(untrack(source))

  effect(() => {
    const next = source()
    const timer = setTimeout(write, ms, next)

    onCleanup(() => clearTimeout(timer))
  })

  return settled
}

// The events `listen` types its handler by, per kind of target.
type EventMapOf<T> = T extends Window ? WindowEventMap : T extends Document ? DocumentEventMap : T extends HTMLElement ? HTMLElementEventMap : T extends MediaQueryList ? MediaQueryListEventMap : Record<string, Event>

// Listens to `type` events on `target`, `window` or `document` for instance, while the island lives; nothing listens while the server renders.
// In a `.kay` file the compiler hands `target` over as a function, so `listen(window, ...)` never reads `window` on the server; a `.ts` module writes `listen(() => window, ...)`. A target read from a signal listens to its new value as it changes.
export function listen<T extends EventTarget, K extends keyof EventMapOf<T> & string>(target: T | (() => T | null | undefined), type: K, handler: (event: EventMapOf<T>[K]) => void, options?: boolean | AddEventListenerOptions): void {
  effect(() => {
    const at = typeof target === 'function' ? target() : target

    if (!at)
      return

    const listener = handler as EventListener

    at.addEventListener(type, listener, options)
    onCleanup(() => at.removeEventListener(type, listener, options))
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
  const flags = new Map<Key, Flag>()
  // The key the flags were last set for, which a write kept in a request's scope leaves behind: the key to answer with is the signal's own.
  let flagged = initial
  // Follows every write of the main signal, so an optimistic change's undo, which writes it alone, moves the flags too.
  const [read, write] = createSignal<Key | undefined>(initial, {
    written: (key) => {
      if (flagged !== undefined)
        flags.get(flagged)?.write(false)

      if (key !== undefined)
        flags.get(key)?.write(true)

      flagged = key
    },
  })
  const current = () => untrack(read)

  const set: Selection<Key>['set'] = next => write(typeof next === 'function' ? next(current()) : next)

  const is = (key: Key): boolean => {
    if (!tracking())
      return key === current()

    let flag = flags.get(key)

    if (!flag) {
      const [readFlag, writeFlag] = ownSignal(key === current())

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
  // The search params, read against the `query` of the page and its layouts, `export const page = { query: s.Object(...) }`, merged; a query it refuses answers 400. Their raw text is `url.searchParams`.
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

// What the `GET` of an endpoint file reads: `src/routes/feeds/[slug].json.ts` gets `{ slug }`, the extension left out.
export type EndpointContext<Params extends Record<string, unknown> = Record<string, string>> = Pick<PageContext<Params>, 'request' | 'url' | 'params' | 'locals'>
// A string or a Blob it returns is served with the type its file's extension names; a Response goes out as it is.
export type EndpointBody = string | Blob | Response

declare global {
  // `import.meta.glob`, which kay's build expands, typed as Vite types it: `T` is what each file gives, its module or with `import` one export.
  interface ImportMeta {
    glob: {
      <T = unknown>(pattern: string | string[], options: { eager: true, import?: string }): Record<string, T>
      <T = unknown>(pattern: string | string[], options?: { eager?: false, import?: string }): Record<string, () => Promise<T>>
    }
  }
}

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

// `export const page = { ... }` in a page's server fence; a layout takes `query` as well as `layouts`, `security` and `reload`, which apply to the pages under it, and `guards`, which opens its own actions.
export interface PageSettings {
  // `kay build` renders the page once: `true` for a route without params, else the params of each page to render, as a list, a function returning one, a content collection or a `paginate()` list.
  prerender?: boolean | object
  // How long a prerendered page is served before it renders again.
  revalidate?: Duration
  // `false` renders the page, or the layouts below this one, without the layouts above.
  layouts?: false
  // `false` runs none of the `_guard.ts` files above the page, nor above its actions or a layout's: a sign-in page under a guard asking for a session.
  guards?: false
  // The schema `ctx.query` is read against; a query it refuses answers 400.
  query?: TSchema
  // The pages of the route the sitemap lists, as `prerender` takes them; `false` leaves it out.
  sitemap?: boolean | object
  // Keeps the page out of search engines and the sitemap.
  noindex?: boolean
  // What the page's responses send over the site's security headers; a layout's applies to every page under it, the inner one merged over the outer.
  security?: PageSecurity
  // `true` loads the page fully from any link or form of the site, past the page swap: a page whose scripts expect a fresh document.
  reload?: true
  // With `search` on in kay.config.ts, `false` leaves the page out of the index, and `weight` multiplies what its words count, 1 by default.
  search?: false | { weight?: number }
}

export interface PageSecurity {
  // Sources added to the site's Content-Security-Policy directives, `{ 'script-src': ['https://cdn.example.com'] }`, a directive the policy lacks starting from the one it falls back to; `false` leaves a directive out.
  csp?: Record<string, string[] | false>
  // Headers merged over the site's, one given `false` not sent: `{ 'cross-origin-embedder-policy': 'require-corp' }` with the site's `cross-origin-opener-policy: same-origin` isolates the page.
  headers?: Record<string, string | false>
}

// What a query schema gives `ctx.query`.
export type QueryOf<Schema> = Schema extends TSchema ? Static<Schema> : never

// What a page's template reads: every name its `--- server` fence declares.
export type PageData<Load extends (...args: never[]) => unknown> = Awaited<ReturnType<Load>>

export { s, t } from '#schema'
export type { Action, ActionContext, ActionProtection, ActionRateLimit, CallOptions, Failure, FailureData, FailureOf, FieldName, FormFailure, FormSuccess, HoneypotOptions, MinTimeOptions, MinTimeRefusal, ProofOfWorkOptions, ProofOfWorkRefusal, ProtectionMessages, RateLimit, RateStore, RateWindow, ServerAction, Success, SuccessOf } from './action'
export { action, ActionError, ActionRedirect } from './action'
export { localPath, withBase } from './base'
export type { ApiRoutesOf, AwaitProps, CheckedHref, CheckedHtml, Deferred, ExtensionServersOf, FunctionProp, HydrateWhen, IdentityKeyed, Inferred, IslandBrand, IslandComponent, IslandOptions, IslandProp, Locals, LocalsOf, Redirect, Register, RouteParams, SafeHtml, TemplateHelpers } from './checks'
export { describeField } from './described'
export type { Duration } from './duration'
export type { PublicEnv, PublicEnvOf } from './env'
export { publicEnv } from './env'
export { focusInvalid } from './focus'
export { markInvalid } from './invalid'
export type { Component, EventHandler, JSX } from './jsx'
export type { LeaveGuardOptions } from './leave'
export { guardLeave } from './leave'
export type { Answered, ApiAnswer, ApiCallOptions, CallMethod, CallPath, EventReader, EventStream, Jsonified, Resource, ResourceFailure, ResourcePath, ResourceStatus, Socket, SocketPath, SocketStatus, StreamPath, StreamRun, StreamStartOptions, StreamStatus } from './live'
export { ApiError, call, dispatch, resource, socket, stream } from './live'
export type { Log } from './log'
export { logFrom } from './log'
export type { NavigateOptions, QueryChanges } from './navigate'
export { navigate, refresh } from './navigate'
export type { PersistStorage } from './persist'
export { editing, previewing } from './preview'
export type { SignalOptions } from './reactive'
export { batch, effect, flush, memo, onCleanup, onMount, root, untrack } from './reactive'
export { sanitizeHtml, trustHtml } from './sanitize'
export type { SanitizeOptions } from './sanitize'
export type { SearchHit, SearchOptions, SearchResults } from './search'
export { searchResults, searchSite } from './search-results'
export type { ShortcutOptions } from './shortcut'
export { shortcut } from './shortcut'
export type { TransitionClasses } from './transition'
export { uid } from './uid'
