import type { CookieMap } from 'bun'
import type { Static, TSchema } from 'elysia'
import type { CookieDeleteOptions } from '../server/cookies'
import type { Deferred, Locals, Redirect, RouteParams } from './checks'
import type { Duration } from './duration'
import type { Locale } from './i18n'
import type { PlainValue, SignalOptions } from './reactive'
import { durationMs } from './duration'
import { createEffect, createSignal, getOwner, markSignal, memo, onCleanup, ownSignal, provideContext, readContext, runWithOwner, tracking, untrack, withSetter } from './reactive'
import { tabVisible } from './visibility'

// Writes a value, or what a function makes of the current one.
export type Setter<T> = (next: T | ((current: T) => T)) => void

export interface Signal<T> {
  (): T
  set: Setter<T>
}

// What `memo` makes.
export type Memo<T> = () => T

// A signal read as `count()` and written as `count.set(1)` or `count.set(c => c + 1)`.
// kept: free
export function signal<T>(): Signal<T | undefined>
export function signal<T>(value: PlainValue<T>, options?: SignalOptions<T>): Signal<T>
export function signal<T>(value?: PlainValue<T>, options?: SignalOptions<T | undefined>): Signal<T | undefined> {
  const [read, write] = createSignal<T | undefined>(value, options)

  return withSetter(read, write)
}

const MAX_TIMER = 2_147_483_647

export interface EveryOptions {
  // Read as an effect reads: the timer starts as it turns true and stops as it turns false.
  while?: (() => boolean) | undefined
  // Runs `run` as the timer starts too, rather than one interval later: a poll showing fresh data the moment it starts.
  immediate?: boolean | undefined
  // Keeps running while the tab is hidden, which it pauses for otherwise and catches up with as the tab shows again.
  background?: boolean | undefined
}

// Runs `run` every `interval` while the island lives, and while `options.while` holds: `every('3s', refresh, { while: () => issuing })` polls the page until nothing is issuing.
// Nothing runs while the server renders or the tab is hidden, and a tick is skipped while the promise the last run returned is pending, so a slow refresh never piles up.
// An interval that is not a positive duration throws.
// kept: free
export function every(interval: Duration, run: () => unknown, options?: EveryOptions): void {
  const ms = typeof interval === 'string' ? durationMs(interval) : Number.NaN
  let paused = false

  // A timer waits 2^31 - 1 ms at most and takes anything under a millisecond for one.
  if (!(ms >= 1 && ms <= MAX_TIMER))
    throw new Error(`kay: every() takes a duration of 1 ms to 24 days such as '3s' or '250ms', not ${typeof interval === 'string' ? JSON.stringify(interval) : String(interval)}`)

  createEffect(() => {
    if (options?.while && !options.while()) {
      paused = false

      return
    }

    if (!options?.background && !tabVisible()) {
      paused = true

      return
    }

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

    if (options?.immediate || paused)
      void tick()

    paused = false
  }, 'every', run)
}

export interface WatchOptions {
  // Runs `run` on the first read too, `previous` being undefined then.
  immediate?: boolean | undefined
}

// Runs `run` whenever `source` gives a new value, not on its first read, handed the value it gave before: `watch(turn, (next, previous) => ...)`.
// The first read is the island's effects' first run, once its render is done: a write the script makes before then is part of it.
// Only `source` is tracked, never what `run` reads, and a value equal to the last one runs nothing; nothing runs while the server renders.
// kept: free
export function watch<T>(source: () => T, run: (next: T, previous: T) => unknown, options?: WatchOptions & { immediate?: false | undefined }): void
export function watch<T>(source: () => T, run: (next: T, previous: T | undefined) => unknown, options?: WatchOptions): void
export function watch<T>(source: () => T, run: (next: T, previous: T | undefined) => unknown, options?: WatchOptions): void {
  // A memo, so a read that gives the same value again reruns nothing, and what `run` registered with `onCleanup` stays.
  const value = memo(source, { equals: Object.is })
  let first = true
  let previous: T | undefined

  createEffect(() => {
    const next = value()
    const before = previous
    const runs = !first || options?.immediate === true

    first = false
    previous = next

    if (runs)
      untrack(() => run(next, before))
  }, 'watch', run)
}

// `source`'s value once it has stopped changing for `delay`, starting with its value now: `watch(debounced(typed, '300ms'), lookUp)` looks a name up as the user pauses.
// The pending timer goes with the island; while the server renders, the value stays the one `source` gave first.
// kept: free
export function debounced<T>(source: () => T, delay: Duration): Memo<T> {
  const wait = durationMs(delay)
  const [settled, write] = createSignal(untrack(source))

  createEffect(() => {
    const next = source()
    const timer = setTimeout(write, wait, next)

    onCleanup(() => clearTimeout(timer))
  }, 'debounced', source)

  return settled
}

// The events `listen` types its handler by, per kind of target.
type EventMapOf<T> = T extends Window ? WindowEventMap : T extends Document ? DocumentEventMap : T extends HTMLElement ? HTMLElementEventMap : T extends MediaQueryList ? MediaQueryListEventMap : Record<string, Event>

// Listens to `type` events on `target`, `window` or `document` for instance, while the island lives; nothing listens while the server renders.
// In a `.kay` file the compiler hands `target` over as a function, so `listen(window, ...)` never reads `window` on the server; a `.ts` module writes `listen(() => window, ...)`. A target read from a signal listens to its new value as it changes.
// The handler runs under the owner `listen` was called in, so a stream it starts closes with that island or block.
// kept: free
export function listen<T extends EventTarget, K extends keyof EventMapOf<T> & string>(target: T | (() => T | null | undefined), type: K, handler: (event: EventMapOf<T>[K]) => void, options?: boolean | AddEventListenerOptions): void {
  const owner = getOwner()

  createEffect(() => {
    const at = typeof target === 'function' ? target() : target

    if (!at)
      return

    const listener = ((event: Event) => runWithOwner(owner, () => handler(event as EventMapOf<T>[K]))) as EventListener

    at.addEventListener(type, listener, options)
    onCleanup(() => at.removeEventListener(type, listener, options))
  }, 'listen', handler)
}

// A writable signal that follows `source`: an island edits it locally, and it takes `source`'s value again whenever that changes: `const tiers = linked(() => board.tiers)` follows the prop once the page brings a new board.
// kept: free
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

export interface Context<T> {
  // Makes `value` what the components this one renders read, called in its script.
  provide: (value: T) => void
  // What the nearest component above provided, else the default.
  use: () => T
}

// A value a component hands what it renders, however deep, without passing it through each one's props: `Theme.provide('dark')` in one, `Theme.use()` below it.
// kept: free
export function createContext<T>(fallback: T): Context<T> {
  const key = Symbol('kay.context')

  return {
    provide: value => provideContext(key, value),
    use: () => {
      const found = readContext(key)

      return found.found ? found.value as T : fallback
    },
  }
}

/** @deprecated Renamed `createContext` in 1.90, so it does not read as `ctx` or `defineContext`; the old name works until 1.93, and `kay upgrade` renames it. */
// kept: free
export const context = createContext

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
// kept: free
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

  return markSignal(Object.assign(read, { set, is }))
}

// What every request kay answers reads and does the same way, in a page, a layout, a guard, an endpoint and an action: who asks, where, in which locale, and how to stop with a redirect, a denial or a 404.
export interface RequestContext<Params extends Record<string, unknown> = Record<string, string>, Guarded extends object = object> {
  request: Request
  url: URL
  // The locale the request is served in, as `i18n` in kay.config.ts gives it; the site's `lang` without.
  locale: Locale
  params: Params
  // Read on demand; what is set or deleted goes out as Set-Cookie headers, redirects included. A delete takes the `secure`, `sameSite` and `partitioned` the cookie was set with.
  cookies: CookieMap & { delete: { (name: string, options?: Omit<CookieDeleteOptions, 'name'>): void, (options: CookieDeleteOptions): void } }
  // What the app's Elysia `derive`, `resolve` and `decorate` add, typed through `Register`.
  locals: Locals
  // What the `_guard.ts` files above the route returned, merged outermost first, a later one winning a key it shares: `export default guard(async ctx => ({ org: await loadOrg(ctx) }))` gives `ctx.guard.org` to the layouts, the page and the actions below it. `kay check` types it from those files; it is empty when none returns an object.
  guard: Guarded
  // Runs `load` the first time this request asks for `key` and hands the same promise to every later ask, so a guard, the layouts, the page and an action loading one thing in parallel load it once; per request, never shared between visitors, and a failure is shared too.
  once: Once
  // Aborts when the client leaves and when the request passes its `serve.timeout`: hand it to `fetch`, a database call or any work that takes one, so it stops with the request.
  signal: AbortSignal
  // Added to the response, whichever way the request ends.
  headers: Headers
  // Stops with a redirect, 302 for a read and 303 for a post unless given; it throws, so what follows does not run.
  redirect: Redirect
  // Stops with a 404, rendering the nearest `_error.kay` for a page.
  notFound: () => never
  // Ends with that status, 403 unless given, rendering the nearest `_error.kay` with `message` for a page.
  deny: (status?: number, message?: string) => never
}

// `ctx.once`.
export type Once = <T>(key: string, load: () => T) => Promise<Awaited<T>>

export interface PageContext<Params extends Record<string, unknown> = Record<string, string>, Query = Readonly<Record<string, unknown>>, Guarded extends object = object> extends RequestContext<Params, Guarded> {
  // The search params, read against the `query` of the page and its layouts, `export const page = { query: s.Object(...) }`, merged; a query it refuses answers 400. Their raw text is `url.searchParams`.
  query: Query
  // The response status of the page being rendered.
  status: (code: number) => void
}

// A page `kay build` prerenders renders without a request, so what only a request carries is refused where it is read; a `prerender` computed as a plain `boolean` is checked when it renders.
// Written out rather than through an alias, which an error would name instead of saying why.
export type PrerenderedContext<Flag, Context> = [Flag] extends [false | null | undefined]
  ? Context
  : boolean extends Flag
    ? Context
    : Omit<Context, 'cookies' | 'query' | 'locals' | 'guard'> & {
      cookies: { kayError: 'A prerendered page renders once, at build time, with no ctx.cookies; drop prerender from export const page to render it per request' }
      query: { kayError: 'A prerendered page renders once, at build time, with no ctx.query; drop prerender from export const page to render it per request' }
      locals: { kayError: 'A prerendered page renders once, at build time, with no ctx.locals; drop prerender from export const page to render it per request' }
      guard: { kayError: 'A prerendered page renders once, at build time, before any guard runs, with no ctx.guard; drop prerender from export const page to render it per request' }
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

// The context of `_card.kay`, which lays out the 1200x630 share card `shareCard()` links: `image` is the imported image it was given, its URL, which the card's browser loads from the build.
export interface CardPageContext<Params extends Record<string, unknown> = Record<string, string>> extends PageContext<Params> {
  card: { title: string, image?: string | undefined, name?: string | undefined }
}

// What a `_guard.ts` decides from: who is asking, and the params of the page asked for, each matcher's value in place of its text.
// For an action, `url` and `params` are those of the page it was posted from; for an API route, its own as Elysia hands them to the handler.
// `Own` names locals a guard knows beyond the app's, for a library's own guard to read what its plugin adds with no cast.
// Its `guard` holds what the guards above it returned.
export type GuardContext<Own extends object = object, Guarded extends object = object> = Omit<RequestContext<RouteParams, Guarded>, 'locals'> & { locals: Locals & Own }

// A guard may return an object, which the guards, layouts, pages and actions below it read as `ctx.guard`.
export type Guard<Value = unknown> = (ctx: GuardContext) => Value | Promise<Value>

// What one guard hands on, nothing when it returns no plain object: an array or a function is dropped at runtime, a class instance too, and `undefined` from a branch leaves the rest.
export type GuardValue<G> = G extends (...args: never[]) => infer Returned ? PlainObject<Exclude<Awaited<Returned>, void | undefined>> : object

type PlainObject<Value> = [Value] extends [never] ? object : Value extends readonly unknown[] | ((...args: never[]) => unknown) ? never : Value extends object ? Value : never

// What the guards of a route hand on together, outermost first.
export type GuardValues<Guards extends readonly unknown[]> = Guards extends readonly [infer First, ...infer Rest] ? Omit<GuardValue<First>, keyof GuardValues<Rest>> & GuardValues<Rest> : object

// What the `GET` of an endpoint file reads: `src/routes/feeds/[slug].json.ts` gets `{ slug }`, the extension left out.
export type EndpointContext<Params extends Record<string, unknown> = Record<string, string>, Guarded extends object = object> = RequestContext<Params, Guarded>
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
// kept: request
export function guard<Own extends object = object, const Value extends object | void = void>(check: (ctx: GuardContext<Own, Readonly<Record<string, unknown>>>) => Value | Promise<Value>): Guard<Value> {
  return check as Guard<Value>
}

// An `await` block takes any promise whatever made it, so this is no longer needed: it still returns the promise as a promise, handling its rejection at once.
// kept: request
// eslint-disable-next-line ts/promise-function-async -- an async function would hand back a second promise, which rejects with nothing taking it
export function defer<T>(value: T | PromiseLike<T>): Deferred<T> {
  const promise = Promise.resolve(value)

  void Promise.allSettled([promise])

  return promise
}

// `export const page = { ... }` in a page's server fence; a layout takes `query` as well as `layouts`, `security`, `reload`, `noindex`, `ttl` and `search`, which apply to the pages under it, and `guards`, which opens its own actions.
export interface PageSettings {
  // `kay build` renders the page once: `true` for a route without params, else the params of each page to render, as a list, a function returning one, a content collection or a `paginate()` list.
  prerender?: boolean | object
  // `true` says the page is to be kept prerendered by `kay build` on its own, as a page reading nothing from a request is: when the build cannot show it does, the `unkept-page` lint names what stops it.
  keep?: true
  // How long a prerendered page is served before it renders again, `'1h'`: the server renders it again in the background once it is older, and a public page answers `cache-control: public, max-age=0, s-maxage=3600, stale-while-revalidate=3600` so a CDN keeps it that long (never one behind a guard, or rendered for one visitor).
  ttl?: Duration
  // What the prerendered page sends as `cache-control` to everyone, in place of the one `ttl` derives or `public, max-age=0, must-revalidate`; `false` sends the default whatever the `ttl`. A page behind a guard, or rendered for one visitor, is `private` whatever this says.
  cacheControl?: string | false
  // `false` renders the page, or the layouts below this one, without the layouts above.
  layouts?: false
  // `false` runs none of the `_guard.ts` files above the page, nor above its actions or a layout's: a sign-in page under a guard asking for a session.
  guards?: false
  // The longest the page may take to answer, in place of `serve.timeout`: a string such as '30s', or `false` for none. Past it the page answers 504 through the nearest `_error.kay`; the innermost layout or page that sets it wins.
  timeout?: Duration | false
  // The schema `ctx.query` is read against; a query it refuses answers 400.
  query?: TSchema
  // The pages of the route the sitemap lists, as `prerender` takes them; `false` leaves it out.
  sitemap?: boolean | object
  // When the page last changed, for the sitemap's `lastmod`: a `Date`, a date string such as '2026-05-06', or a function of the params of each URL the sitemap lists, returning one or nothing.
  lastmod?: Lastmod | ((params: Record<string, string>) => Lastmod | undefined | Promise<Lastmod | undefined>)
  // The collections whose feed the page's head links to, `link rel="alternate"`, beside the feed of the collection the page shows an entry of, which every such page links to already; `false` leaves the links out.
  feed?: false | object | readonly object[]
  // Keeps the page out of search engines and the sitemap.
  noindex?: boolean
  // What the page's responses send over the site's security headers; a layout's applies to every page under it, the inner one merged over the outer.
  security?: PageSecurity
  // `true` loads the page fully from any link or form of the site, past the page swap: a page whose scripts expect a fresh document.
  reload?: true
  // With `search` on in kay.config.ts, `false` leaves the page out of the index, and `weight` multiplies what its words count, 1 by default; a function of the params of each page weighs them apart, returning one or nothing.
  search?: PageSearch | ((params: Record<string, string>) => PageSearch | undefined | Promise<PageSearch | undefined>)
}

export type PageSearch = false | { weight?: number }

export type Lastmod = Date | string | number

export interface PageSecurity {
  // Sources added to the site's Content-Security-Policy directives, `{ 'script-src': ['https://cdn.example.com'] }`, a directive the policy lacks starting from the one it falls back to; `false` leaves a directive out, and as the whole value the page, with its layouts, sends no policy at all.
  csp?: Record<string, string[] | false> | false
  // Headers merged over the site's, one given `false` not sent: `{ 'cross-origin-embedder-policy': 'require-corp' }` with the site's `cross-origin-opener-policy: same-origin` isolates the page.
  headers?: Record<string, string | false>
}

// What a query schema gives `ctx.query`.
export type QueryOf<Schema> = Schema extends TSchema ? Static<Schema> : never

// What a page's template reads: every name its `--- server` fence declares.
export type PageData<Load extends (...args: never[]) => unknown> = Awaited<ReturnType<Load>>
