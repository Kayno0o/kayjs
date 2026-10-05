import type { Elysia } from 'elysia'
import type { Component, JSX } from './jsx'

// Types behind the checks `kay check` adds to generated code; nothing here runs.

declare const ISLAND: unique symbol

// When an island hydrates: right away, once the browser is idle, or once it scrolls near the viewport; `client` renders it in the browser only, right away.
export type HydrateWhen = 'load' | 'idle' | 'visible' | 'client'

// Lets the checker tell islands from plain components.
export interface IslandBrand { readonly [ISLAND]: true }

// What an interactive component's default export is; only islands take `hydrate`.
// What a static parent passes an island besides its props: when it hydrates, and whether it lives on across navigations, `persist` keeping it by its component, `persist="key"` by a key of its own.
export interface IslandOptions {
  hydrate?: HydrateWhen
  persist?: boolean | string
}

export type IslandComponent<Props> = ((props: Props & IslandOptions) => JSX.Element) & IslandBrand

// Augmented by the `.kay/types/kay-env.d.ts` that `kay check` writes with every page route, public file and API module, and by the app with `locals: LocalsOf<typeof auth>` and `app: typeof app`.
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
// `/files/*` serves `/files/` too, as a catch-all page does.
type TreeMatches<Segments extends readonly string[], Tree, Slash extends boolean> = Segments extends readonly [infer Segment extends string, ...infer Rest extends readonly string[]]
  ? (Segment extends keyof Tree ? TreeMatches<Rest, Tree[Segment], Slash> : false)
  | (Segment extends '' ? false : { [Key in keyof Tree & `:${string}`]: TreeMatches<Rest, Tree[Key], Slash> }[keyof Tree & `:${string}`])
  | ('*' extends keyof Tree ? ServesGet<Tree['*']> : false)
  : ServesGet<Tree> | (Slash extends true ? '*' extends keyof Tree ? ServesGet<Tree['*']> : false : false)
type ServedByApp<Path extends string> = [AppRoutes] extends [never] ? false : TreeMatches<SegmentsOf<Path>, AppRoutes, EndsWithSlash<Path>>
// The modules under `src/api`, each tree under its mount, as `kay check` registers them.
type ApiRoutes = Register extends { api: infer Routes } ? Routes : never
type ServedByApi<Path extends string> = [ApiRoutes] extends [never] ? false : TreeMatches<SegmentsOf<Path>, ApiRoutes, EndsWithSlash<Path>>
type IsRoute<Path extends string> = [RoutePatterns] extends [never]
  ? true
  : true extends AnyMatch<SegmentsOf<Path>, RoutePatterns, EndsWithSlash<Path>> | (Path extends PublicFiles ? true : false) | ServedByApp<Path> | ServedByApi<Path> ? true : false

// The route tree of a module under `src/api`, from its default export.
export type ApiRoutesOf<Module> = Module extends { default: { '~Routes': infer Routes } } ? Routes : Record<never, never>

// A site-relative literal must match a page; opaque strings, relative paths and other schemes are not checked.
export type CheckedHref<Href extends string> = string extends Href
  ? unknown
  : Href extends `//${string}`
    ? unknown
    : Href extends `/${string}`
      ? IsRoute<PathOf<Href>> extends true ? unknown : { kayError: `No page, public file or app route serves ${PathOf<Href>}` }
      : unknown

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type SchemeStart = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
type SchemeRest<Text extends string> = Text extends '' ? true : Text extends `${infer Char}${infer Rest}` ? Char extends SchemeStart | Digit | '+' | '.' | '-' ? SchemeRest<Rest> : false : false
type TrimStart<Text extends string> = Text extends ` ${infer Rest}` ? TrimStart<Rest> : Text
// What comes before a URL's first `:` names its scheme when it is one, as `src/server/signals.ts` reads it.
type SchemeOf<Head extends string> = Lowercase<TrimStart<Head>> extends `${infer First extends SchemeStart}${infer Rest}` ? SchemeRest<Rest> extends true ? `${First}${Rest}` : never : never

// A literal target must be a path or an http(s) URL on one line, as the server refuses any other at runtime: a `javascript:` target would run in the page an island's call redirects.
type CheckedTarget<Location extends string> = string extends Location
  ? unknown
  : Location extends `${string}${'\n' | '\r' | '\t' | '\0'}${string}`
    ? { kayError: 'A redirect target holds a line break or another control character' }
    : Location extends `${infer Head}:${string}`
      ? [SchemeOf<Head>] extends [never] ? unknown : SchemeOf<Head> extends 'http' | 'https' ? unknown : { kayError: `A redirect goes to a path or an http(s) URL, not to a ${SchemeOf<Head>}: URL` }
      : unknown

// `ctx.redirect`: a site path is checked like a link, so a redirect cannot point at a page that does not exist.
export type Redirect = <const Location extends string>(location: Location & CheckedHref<Location> & CheckedTarget<Location>, status?: 301 | 302 | 303 | 307 | 308) => never

// A literal status `ctx.fail` takes is an error one, from 400 to 599; a computed one is checked when the action runs.
export type ErrorStatus<Status extends number> = number extends Status ? unknown : `${Status}` extends `${'4' | '5'}${Digit}${Digit}` ? unknown : { kayError: `ctx.fail takes an error status, from 400 to 599, not ${Status}` }

// A literal duration in seconds is positive; a computed one is checked when it is used.
export type PositiveSeconds<Seconds extends number> = number extends Seconds ? unknown : `${Seconds}` extends `-${string}` | '0' ? { kayError: `A duration is a positive number of seconds, not ${Seconds}` } : unknown

type CronNickname = 'yearly' | 'annually' | 'monthly' | 'weekly' | 'daily' | 'midnight' | 'hourly'
type CronFields<Cron extends string> = Cron extends `${infer Field} ${infer Rest}` ? Field extends '' ? CronFields<Rest> : [Field, ...CronFields<Rest>] : Cron extends '' ? [] : [Cron]
// A day the month never has, every weekday allowed: `30 2`, `31 APR`.
type MissingDay<Day, Month extends string, Weekday> = Weekday extends '*'
  ? Day extends '30' | '31' ? Uppercase<Month> extends '2' | '02' | 'FEB' ? true : Day extends '31' ? Uppercase<Month> extends '4' | '04' | '6' | '06' | '9' | '09' | '11' | 'APR' | 'JUN' | 'SEP' | 'NOV' ? true : false : false : false
  : false

// A literal schedule has five fields or is a nickname, and comes some day; a computed one, or a field this does not read, is checked when the server starts.
export type CronSchedule<Cron extends string> = string extends Cron
  ? unknown
  : Cron extends `@${infer Name}`
    ? Name extends CronNickname ? unknown : { kayError: `A schedule nickname is @yearly, @monthly, @weekly, @daily or @hourly, not ${Cron}` }
    : CronFields<Cron> extends [string, string, infer Day, infer Month extends string, infer Weekday]
      ? MissingDay<Day, Month, Weekday> extends true ? { kayError: `The schedule ${Cron} never comes` } : unknown
      : { kayError: `A schedule has five fields, minute hour day month weekday, not ${Cron}` }

// What crosses to the browser besides plain objects and arrays, as `src/runtime/wire.ts` encodes it.
type Sendable = string | number | boolean | bigint | null | undefined | Date | RegExp | URL | URLSearchParams

// A type already being checked further up, such as a tree's own children, adds nothing new, so recursive types end there.
type Visiting<T, Seen> = Seen extends unknown ? [T] extends [Seen] ? [Seen] extends [T] ? true : never : never : never

type IsSerializable<T, Seen = never> = T extends Sendable
  ? true
  : T extends ((...args: never[]) => unknown) | symbol
    ? false
    : true extends Visiting<T, Seen>
      ? true
      : T extends ReadonlyMap<infer Key, infer Value>
        ? [IsSerializable<Key, Seen | T>, IsSerializable<Value, Seen | T>] extends [true, true] ? true : false
        : T extends ReadonlySet<infer Item>
          ? IsSerializable<Item, Seen | T>
          : T extends readonly (infer Item)[]
            ? IsSerializable<Item, Seen | T>
            : T extends object
              ? false extends { [Key in keyof T]-?: IsSerializable<T[Key], Seen | T> }[keyof T] ? false : true
              : false

// Props a static parent passes to an island are serialized for the browser, so they must survive it.
export type IslandProp<Component, Value> = Component extends IslandBrand ? [IsSerializable<Value>] extends [true] ? unknown : { kayError: 'An island receives its props serialized: plain objects, arrays, Dates, Maps, Sets, bigints, URLs and RegExps, but no functions, symbols or class instances' } : unknown

// A function written in the attribute is checked apart from its value, which a wrapping call would stop a generic component from typing: `0` stands for the attribute.
export type FunctionProp<Component> = Component extends IslandBrand ? { kayError: 'An island receives its props serialized: plain objects, arrays, Dates, Maps, Sets, bigints, URLs and RegExps, but no functions, symbols or class instances' } : 0

// Lines under an island's tag in a static parent, which cannot cross to the browser: `0` stands for them.
export type ChildrenProp<Component> = Component extends IslandBrand ? { kayError: 'An island takes no children: pass data as props, or make the parent interactive too' } : 0

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

type PropsOf<Tag> = Tag extends keyof JSX.IntrinsicElements ? JSX.IntrinsicElements[Tag] : Tag extends Component<infer Props> ? Props : Record<string, unknown>

// What the template's control flow and dynamic tags read as in the code the type checker reads: `for` and an aliased `if` hand their block values, which TypeScript narrows, where the browser build hands accessors.
export interface TemplateHelpers {
  For: {
    <T>(props: { each: readonly T[] | null | undefined | false, keyed: (item: T) => unknown, fallback?: JSX.Element, children: (item: T, index: number) => JSX.Element }): JSX.Element
    <T>(props: { each: readonly T[] | null | undefined | false, keyed: false, fallback?: JSX.Element, children: (item: T, index: number) => JSX.Element }): JSX.Element
  }
  Show: <T>(props: { when: T, fallback?: JSX.Element, children: (value: NonNullable<T>) => JSX.Element }) => JSX.Element
  staticFor: <T>(each: readonly T[] | null | undefined | false, render: (item: T, index: number) => JSX.Element, fallback?: () => JSX.Element) => JSX.Element
  Dynamic: <Tag>(props: { component: Tag } & PropsOf<Tag>) => JSX.Element
  componentClass: (list: readonly unknown[]) => string | undefined
  omit: <Props extends object, Key extends keyof Props>(props: Props, ...keys: Key[]) => Omit<Props, Key>
  head: (tags: { tag: string, props: Record<string, unknown> }[]) => void
  Try: (props: { block: () => JSX.Element, failed?: (error: unknown) => JSX.Element }) => JSX.Element
}
