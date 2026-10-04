import type { JSX } from '@solidjs/web'
import type { Elysia } from 'elysia'

// Types behind the checks `kay check` adds to generated code; nothing here runs.

declare const ISLAND: unique symbol

// When an island hydrates: right away, once the browser is idle, or once it scrolls near the viewport.
export type HydrateWhen = 'load' | 'idle' | 'visible'

// What an interactive component's default export is: the brand lets the checker tell islands from plain components, and only islands take `hydrate`.
export type IslandComponent<Props> = ((props: Props & { hydrate?: HydrateWhen }) => JSX.Element) & { readonly [ISLAND]: true }

// Augmented by the `.kay/types/kay-env.d.ts` that `kay check` writes with every page route and public file, and by the app with `locals: LocalsOf<typeof auth>` and `app: typeof app`.
export interface Register {}

// Nothing is readable off `ctx.locals` until the app registers its type.
export type Locals = Register extends { locals: infer Values extends object } ? Values : object

// The values an Elysia instance adds to every handler's context.
export type LocalsOf<App extends Pick<Elysia, '~Singleton' | '~Ephemeral' | '~Volatile'>> = App['~Singleton']['decorator'] & App['~Singleton']['derive'] & App['~Singleton']['resolve']
  & App['~Ephemeral']['derive'] & App['~Ephemeral']['resolve'] & App['~Volatile']['derive'] & App['~Volatile']['resolve']

// Routes as segment tuples: `[]` is `/`, `':'` a parameter, `'*'` a catch-all.
type RoutePatterns = Register extends { routes: infer Routes extends readonly string[] } ? Routes : never
type Split<Path extends string> = Path extends `${infer Head}/${infer Rest}` ? [Head, ...Split<Rest>] : [Path]
type SegmentsOf<Path extends string> = Path extends '/' ? [] : Path extends `/${infer Rest}` ? Rest extends `${infer Trimmed}/` ? Split<Trimmed> : Split<Rest> : never
// A catch-all serves its own directory only with a trailing slash: `/docs/` for `docs/[...path]`, never `/docs`.
type Matches<Segments extends readonly string[], Pattern extends readonly string[], Slash extends boolean> = Pattern extends readonly ['*']
  ? Segments extends readonly [] ? Slash : true
  : Pattern extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
    ? Segments extends readonly [infer Segment extends string, ...infer Others extends readonly string[]]
      ? Head extends ':' ? Segment extends '' ? false : Matches<Others, Rest, Slash> : Segment extends Head ? Matches<Others, Rest, Slash> : Head extends Segment ? Matches<Others, Rest, Slash> : false
      : false
    : Segments extends readonly [] ? true : false
type AnyMatch<Segments extends readonly string[], Pattern, Slash extends boolean> = Pattern extends readonly string[] ? Matches<Segments, Pattern, Slash> : never
type WithoutHash<Href extends string> = Href extends `${infer Path}#${string}` ? Path : Href
type PathOf<Href extends string> = WithoutHash<Href> extends `${infer Path}?${string}` ? Path : WithoutHash<Href>
type EndsWithSlash<Path extends string> = Path extends `${string}/` ? true : false
// The files in `public/`, by the path they are served at.
type PublicFiles = Register extends { files: infer Files extends string } ? Files : never
// The app registered as `app` keeps its routes, under Elysia 1.4's `~Routes`, as a tree of path segments down to their methods: `/` is the root's own `get`, `:name` a parameter, `*` the rest of the path.
type AppRoutes = Register extends { app: { '~Routes': infer Routes } } ? Routes : never
type ServesGet<Tree> = 'get' extends keyof Tree ? true : false
type TreeMatches<Segments extends readonly string[], Tree> = Segments extends readonly [infer Segment extends string, ...infer Rest extends readonly string[]]
  ? (Segment extends keyof Tree ? TreeMatches<Rest, Tree[Segment]> : false)
  | (Segment extends '' ? false : { [Key in keyof Tree & `:${string}`]: TreeMatches<Rest, Tree[Key]> }[keyof Tree & `:${string}`])
  | ('*' extends keyof Tree ? ServesGet<Tree['*']> : false)
  : ServesGet<Tree>
type ServedByApp<Path extends string> = [AppRoutes] extends [never] ? false : TreeMatches<SegmentsOf<Path>, AppRoutes>
type IsRoute<Path extends string> = [RoutePatterns] extends [never]
  ? true
  : true extends AnyMatch<SegmentsOf<Path>, RoutePatterns, EndsWithSlash<Path>> | (Path extends PublicFiles ? true : false) | ServedByApp<Path> ? true : false

// A site-relative literal must match a page; opaque strings, relative paths and other schemes are not checked.
export type CheckedHref<Href extends string> = string extends Href
  ? unknown
  : Href extends `//${string}`
    ? unknown
    : Href extends `/${string}`
      ? IsRoute<PathOf<Href>> extends true ? unknown : { kayError: `No page, public file or app route serves ${PathOf<Href>}` }
      : unknown

// `ctx.redirect`: a site path is checked like a link, so a redirect cannot point at a page that does not exist.
export type Redirect = <const Location extends string>(location: Location & CheckedHref<Location>, status?: 301 | 302 | 303 | 307 | 308) => never

// What crosses to the browser besides plain objects and arrays, as `src/runtime/wire.ts` encodes it.
type Sendable = string | number | boolean | bigint | null | undefined | Date | RegExp | URL | URLSearchParams

type IsSerializable<T> = T extends Sendable
  ? true
  : T extends ((...args: never[]) => unknown) | symbol
    ? false
    : T extends ReadonlyMap<infer Key, infer Value>
      ? [IsSerializable<Key>, IsSerializable<Value>] extends [true, true] ? true : false
      : T extends ReadonlySet<infer Item>
        ? IsSerializable<Item>
        : T extends readonly (infer Item)[]
          ? IsSerializable<Item>
          : T extends object
            ? false extends { [Key in keyof T]-?: IsSerializable<T[Key]> }[keyof T] ? false : true
            : false

// Props a static parent passes to an island are serialized for the browser, so they must survive it.
export type IslandProp<Component, Value> = Component extends { readonly [ISLAND]: true }
  ? [IsSerializable<Value>] extends [true] ? unknown : { kayError: 'An island receives its props serialized: plain objects, arrays, Dates, Maps, Sets, bigints, URLs and RegExps, but no functions, symbols or class instances' }
  : unknown

declare const DEFERRED: unique symbol

// A promise `defer()` marked for an `await` block.
export type Deferred<T> = Promise<T> & { readonly [DEFERRED]: true }

// A promise rejecting before its block renders would crash the process, unless `defer()` took it when it was made; checked across a union too.
export type AwaitValue<T> = [Exclude<Extract<T, PromiseLike<unknown>>, { readonly [DEFERRED]: true }>] extends [never] ? unknown : { kayError: 'Wrap the promise in defer() where it is made: a rejection before the page renders it would crash the server' }

// What a template's `await` block compiles to: the value, then a function per block.
export interface AwaitProps<T> {
  value: T & AwaitValue<T>
  pending?: () => JSX.Element
  ready: (value: Awaited<T>) => JSX.Element
  failed?: (error: unknown) => JSX.Element
}
