import type { AnyElysia, Elysia } from 'elysia'
import type { Action } from './action'
import type { Duration } from './duration'
import type { Component, JSX } from './jsx'

// Types behind the checks `kay check` adds to generated code; nothing here runs but the one message `kay check` reads back.

declare const ISLAND: unique symbol

// When an island hydrates: right away, once the browser is idle, or once it scrolls near the viewport; `client` renders it in the browser only, right away.
export type HydrateWhen = 'load' | 'idle' | 'visible' | 'client'

// What an `if` renders its block on, its condition's type without the falsy values, `false` and `0` included as `NonNullable` keeps them.
export type Truthy<T> = Exclude<T, false | 0 | 0n | '' | null | undefined>

// Lets the checker tell islands from plain components.
export interface IslandBrand { readonly [ISLAND]: true }

// What an interactive component's default export is; only islands take `hydrate`.
// What a static parent passes an island besides its props: when it hydrates, and whether it lives on across navigations, `persist` keeping it by its component, `persist="key"` by a key of its own.
export interface IslandOptions {
  hydrate?: HydrateWhen | undefined
  persist?: boolean | string | undefined
}

export type IslandComponent<Props> = ((props: Props & IslandOptions) => JSX.Element) & IslandBrand

// Augmented by the `.kay/types/kay-env.d.ts` that `kay check` writes with every page route, public file and API module, and by the app with `locals: LocalsOf<typeof auth>` and `app: typeof app`.
export interface Register {}

// What `kay check` reads off the server entry exporting `app`, standing in for what `Register` leaves out, and off the extensions' server plugins in `kay.config.ts`.
export interface Inferred {}

// The server plugins a config's extensions hand `pages()`, each awaited out of the function giving it.
export type ExtensionServersOf<Config> = Config extends { extensions?: readonly (infer Extension)[] | undefined } ? ServersOf<Extension> : never
type ServersOf<Extension> = Extension extends { server?: infer Server } ? Typed<Server extends (...args: never[]) => infer Built ? Awaited<Built> : Server> : never
// An extension annotated `KayExtension` with no type argument holds `AnyElysia`, which knows no locals or routes and would turn every local and link `any`, so it is left out.
type Typed<Server> = Server extends AnyElysia ? 0 extends 1 & Server['~Singleton'] ? never : Server : never
type ExtensionServers = Inferred extends { extensions: infer Servers } ? Servers : never
type Intersected<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer Each) => void ? Each : never
type ServerLocals<Server> = Server extends Pick<Elysia, '~Singleton' | '~Ephemeral' | '~Volatile'> ? LocalsOf<Server> : never

// Nothing is readable off `ctx.locals` until the app registers its type, exports its app from the server entry or lists an extension with a server plugin, whose locals add to the app's.
export type Locals = (Register extends { locals: infer Values extends object } ? Values : Inferred extends { locals: infer Values extends object } ? Values : object)
  & ([ExtensionServers] extends [never] ? unknown : Intersected<ServerLocals<ExtensionServers>>)

// The values an Elysia instance adds to every handler's context.
export type LocalsOf<App extends Pick<Elysia, '~Singleton' | '~Ephemeral' | '~Volatile'>> = App['~Singleton']['decorator'] & App['~Singleton']['derive'] & App['~Singleton']['resolve']
  & App['~Ephemeral']['derive'] & App['~Ephemeral']['resolve'] & App['~Volatile']['derive'] & App['~Volatile']['resolve']

// What a guard or an action reads in `ctx.params`: untyped, since a guard covers every route below its directory, a matcher may give anything and an optional param nothing.
export type RouteParams = Readonly<Record<string, unknown>>

// Routes as segment tuples: `[]` is `/`, `':'` a parameter, `':integer'` one a matcher kay ships checks, `'*'` a catch-all.
type RoutePatterns = Register extends { routes: infer Routes extends readonly string[] } ? Routes : never
type Split<Path extends string> = Path extends `${infer Head}/${infer Rest}` ? [Head, ...Split<Rest>] : [Path]
type SegmentsOf<Path extends string> = Path extends '/' ? [] : Path extends `/${infer Rest}` ? Rest extends `${infer Trimmed}/` ? Split<Trimmed> : Split<Rest> : never
// A catch-all serves its own directory only with a trailing slash: `/docs/` for `docs/[...path]`, never `/docs`.
type Matches<Segments extends readonly string[], Pattern extends readonly string[], Slash extends boolean> = Pattern extends readonly ['*']
  ? Segments extends readonly [] ? Slash : true
  : Pattern extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
    ? Segments extends readonly [infer Segment extends string, ...infer Others extends readonly string[]]
      ? Head extends `:${infer Matcher}` ? Segment extends '' ? false : Accepts<Segment, Matcher> extends true ? Matches<Others, Rest, Slash> : false : Segment extends Head ? Matches<Others, Rest, Slash> : Head extends Segment ? Matches<Others, Rest, Slash> : false
      : false
    : Segments extends readonly [] ? true : false
type HexDigit = Digit | 'a' | 'b' | 'c' | 'd' | 'e' | 'f'
type Runs<Text extends string, Chars, Count extends unknown[] = []> = Text extends `${infer Char}${infer Rest}` ? Char extends Chars ? Runs<Rest, Chars, [...Count, 0]> : -1 : Count['length']
type Integer<Text extends string> = Text extends `-${infer Rest}` ? Runs<Rest, Digit> extends 0 | -1 ? false : true : Runs<Text, Digit> extends 0 | -1 ? false : true
type Slug<Text extends string> = Text extends `${infer Word}-${infer Rest}` ? Runs<Word, SchemeStart | Digit> extends 0 | -1 ? false : Slug<Rest> : Runs<Text, SchemeStart | Digit> extends 0 | -1 ? false : true
type Uuid<Text extends string> = Lowercase<Text> extends `${infer A}-${infer B}-${infer C}-${infer D}-${infer E}` ? [Runs<A, HexDigit>, Runs<B, HexDigit>, Runs<C, HexDigit>, Runs<D, HexDigit>, Runs<E, HexDigit>] extends [8, 4, 4, 4, 12] ? true : false : false
// A segment written out must be one the param's matcher takes, as `src/runtime/params.ts` reads it; one computed, `${number}` or `string`, is checked when the request comes.
// A computed segment is no single key: a record keyed by it is an index signature, which an empty object satisfies.
type Accepts<Segment extends string, Matcher extends string> = Record<never, never> extends Record<Segment, 1>
  ? true
  : Matcher extends 'integer' ? Integer<Segment> : Matcher extends 'slug' ? Slug<Segment> : Matcher extends 'uuid' ? Uuid<Segment> : true
type AnyMatch<Segments extends readonly string[], Pattern, Slash extends boolean> = Pattern extends readonly string[] ? Matches<Segments, Pattern, Slash> : never
type WithoutHash<Href extends string> = Href extends `${infer Path}#${string}` ? Path : Href
type PathOf<Href extends string> = WithoutHash<Href> extends `${infer Path}?${string}` ? Path : WithoutHash<Href>
type EndsWithSlash<Path extends string> = Path extends `${string}/` ? true : false
// The files in `public/`, by the path they are served at.
type PublicFiles = Register extends { files: infer Files extends string } ? Files : never
// The app registered as `app` keeps its routes, under Elysia 1.4's `~Routes`, as a tree of path segments down to their methods: `/` is the root's own `get`, `:name` a parameter, `*` the rest of the path.
type AppRoutes = Register extends { app: { '~Routes': infer Routes } } ? Routes : Inferred extends { app: { '~Routes': infer Routes } } ? Routes : never
type ServesGet<Tree> = 'get' extends keyof Tree ? true : false
// `/files/*` serves `/files/` too, as a catch-all page does.
type TreeMatches<Segments extends readonly string[], Tree, Slash extends boolean> = Segments extends readonly [infer Segment extends string, ...infer Rest extends readonly string[]]
  ? (Segment extends keyof Tree ? TreeMatches<Rest, Tree[Segment], Slash> : false)
  | (Segment extends '' ? false : { [Key in keyof Tree & `:${string}`]: TreeMatches<Rest, Tree[Key], Slash> }[keyof Tree & `:${string}`])
  | ('*' extends keyof Tree ? ServesGet<Tree['*']> : false)
  : ServesGet<Tree> | (Slash extends true ? '*' extends keyof Tree ? ServesGet<Tree['*']> : false : false)
type ServedByApp<Path extends string> = [AppRoutes] extends [never] ? false : TreeMatches<SegmentsOf<Path>, AppRoutes, EndsWithSlash<Path>>
type ServedByServer<Path extends string, Server> = Server extends { '~Routes': infer Routes } ? TreeMatches<SegmentsOf<Path>, Routes, EndsWithSlash<Path>> : false
// The modules under `src/api`, each tree under its mount, as `kay check` registers them.
type ApiRoutes = Register extends { api: infer Routes } ? Routes : never
type ServedByApi<Path extends string> = [ApiRoutes] extends [never] ? false : TreeMatches<SegmentsOf<Path>, ApiRoutes, EndsWithSlash<Path>>
type IsRoute<Path extends string> = [RoutePatterns] extends [never]
  ? true
  : true extends AnyMatch<SegmentsOf<Path>, RoutePatterns, EndsWithSlash<Path>> | (Path extends PublicFiles ? true : false) | ServedByApp<Path> | ServedByServer<Path, ExtensionServers> | ServedByApi<Path> ? true : false

// The route tree of a module under `src/api`, from its default export.
export type ApiRoutesOf<Module> = Module extends { default: { '~Routes': infer Routes } } ? Routes : Record<never, never>

// What a site-relative path nothing serves fails with, which `kay check` reads to leave an extension the paths outside its prefix.
export const UNSERVED_MESSAGE = 'No page, public file or app route serves'

// A site-relative literal must match a page; opaque strings, relative paths, other schemes and what kay serves under `/_kay/`, such as resized images, are not checked.
export type CheckedHref<Href extends string> = string extends Href
  ? unknown
  : Href extends `//${string}` | `/_kay/${string}`
    ? unknown
    : Href extends `/${string}`
      ? IsRoute<PathOf<Href>> extends true ? unknown : { kayError: `${typeof UNSERVED_MESSAGE} ${PathOf<Href>}` }
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

// A literal duration is positive; a computed one is checked when it is used.
export type PositiveDuration<Length extends Duration> = number extends Length ? unknown : string extends Length ? unknown : `${Length}` extends `-${string}` | '0' | `0${'ms' | 's' | 'm' | 'h' | 'd' | 'w'}` ? { kayError: `A duration is positive, seconds or a string such as '5m', not ${Length}` } : unknown

type CronNickname = 'yearly' | 'annually' | 'monthly' | 'weekly' | 'daily' | 'midnight' | 'hourly'
// Fields may be apart by tabs as by spaces.
type Spaced<Cron extends string> = Cron extends `${infer Head}\t${infer Tail}` ? Spaced<`${Head} ${Tail}`> : Cron
type CronFields<Cron extends string> = Cron extends `${infer Field} ${infer Rest}` ? Field extends '' ? CronFields<Rest> : [Field, ...CronFields<Rest>] : Cron extends '' ? [] : [Cron]
// A day the month never has, every weekday allowed: `30 2`, `31 APR`.
type MissingDay<Day, Month extends string, Weekday> = Weekday extends '*'
  ? Day extends '30' | '31' ? Uppercase<Month> extends '2' | '02' | 'FEB' ? true : Day extends '31' ? Uppercase<Month> extends '4' | '04' | '6' | '06' | '9' | '09' | '11' | 'APR' | 'JUN' | 'SEP' | 'NOV' ? true : false : false : false
  : false

type RowOf<Each> = Each extends Iterable<infer Item> ? Item : never

// An island's `for` with no key matches its rows by `item.id`, else by the item itself: objects without an `id`, made afresh as the list is rebuilt, would make every row anew. `kay check` reports it as the `identity-key` lint.
export type IdentityKeyed<Each> = [RowOf<Each>] extends [object] ? [RowOf<Each>] extends [{ id: unknown }] ? unknown : { kayLint: 'identity-key' } : unknown

type Finite<Member> = Member extends string | number ? Record<never, never> extends Record<Member, 1> ? false : true : Member extends boolean | bigint | symbol | null | undefined ? true : false

// What a `match` with no `else` leaves out: `Rest` is the subject narrowed by its `when` lines, and a member of a finite union (literals, enum members, booleans, `null`, `undefined`) left in it is a value the template renders nothing for. `kay check` reports it as the `incomplete-match` lint.
export type Unmatched<Rest> = [Rest] extends [never] ? unknown : false extends Finite<Rest> ? unknown : IncompleteMatch<Rest>

// A named type, so the type checker's message keeps its name when it shortens the members of a long union.
export interface IncompleteMatch<Missing> { kayLint: 'incomplete-match', kayMissing: Missing }

// What `KayHanded` reads of a parameter before the type checker knows it: a generic one not yet inferred.
export interface UnresolvedParameter { kayUnresolved: true }

// A signal or memo the template hands on whole lands in a parameter typed `unknown` or `any`, which takes the signal itself, so a string or JSON of it is the function's source. `kay check` reports it as the `uncalled-signal` lint.
// A parameter typed `Signal<T>`, `Memo<T>`, a function type, or a generic `T` the call infers from the signal stays silent.
// `KayHanded` returns the signal in a conditional that is always true, which only lets TypeScript infer `Parameter` from the type the call expects there.
export type HandedSignal<Parameter> = 0 extends 1 & Parameter ? { kayLint: 'uncalled-signal' } : [Parameter] extends [UnresolvedParameter] ? unknown : unknown extends Parameter ? { kayLint: 'uncalled-signal' } : unknown

// A literal schedule has five fields or is a nickname, and comes some day; a computed one, or a field this does not read, is checked when the server starts.
export type CronSchedule<Cron extends string> = string extends Cron
  ? unknown
  : Cron extends `@${infer Name}`
    ? Lowercase<Name> extends CronNickname ? unknown : { kayError: `A schedule nickname is @yearly, @monthly, @weekly, @daily or @hourly, not ${Cron}` }
    : CronFields<Spaced<Cron>> extends [string, string, infer Day, infer Month extends string, infer Weekday]
      ? MissingDay<Day, Month, Weekday> extends true ? { kayError: `The schedule ${Cron} never comes` } : unknown
      : { kayError: `A schedule has five fields, minute hour day month weekday, not ${Cron}` }

// What crosses to the browser besides plain objects and arrays, as `src/runtime/wire.ts` encodes it.
type Sendable = string | number | boolean | bigint | null | undefined | Date | RegExp | URL | URLSearchParams

// A type already being checked further up, such as a tree's own children, adds nothing new, so recursive types end there.
type Visiting<T, Seen> = Seen extends unknown ? [T] extends [Seen] ? [Seen] extends [T] ? true : never : never : never

type IsSerializable<T, Seen = never> = T extends Sendable | Action<never, unknown>
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

// A field named like what a page must not carry: an island's props are written into the page source, so each one is public. Matched on the lowercase name, so `passwordHash`, `API_KEY` and `resetToken` all read.
type SecretWord = 'password' | 'passwd' | 'secret' | 'token' | 'apikey' | 'api_key' | 'privatekey' | 'private_key' | 'credential' | 'email'

// A flag such as `emailVerified` or a count such as `tokenCount` holds no secret.
type SecretKey<Key extends string, Field> = Lowercase<Key> extends `${string}${SecretWord}${string}` ? 0 extends 1 & Field ? Key : [NonNullable<Field>] extends [boolean | number | Date] ? never : Key : never

// The paths to the secret-looking fields a value holds, in arrays as `rows[].email`; a type seen further up ends there, and eight levels are read at most so a deep type stays cheap.
type SecretPaths<T, Seen = never, Depth extends unknown[] = [], Prefix extends string = ''> = 0 extends 1 & T
  ? never
  : T extends Sendable | ((...args: never[]) => unknown) | symbol
    ? never
    : Depth['length'] extends 8
      ? never
      : true extends Visiting<T, Seen>
        ? never
        : T extends ReadonlyMap<unknown, infer Value>
          ? SecretPaths<Value, Seen | T, [...Depth, 0], `${Prefix}[]`>
          : T extends ReadonlySet<infer Item> | readonly (infer Item)[]
            ? SecretPaths<Item, Seen | T, [...Depth, 0], `${Prefix}[]`>
            : T extends object
              ? { [Key in keyof T & string]-?: ([SecretKey<Key, T[Key]>] extends [never] ? never : Joined<Prefix, Key>) | SecretPaths<T[Key], Seen | T, [...Depth, 0], Joined<Prefix, Key>> }[keyof T & string]
              : never

type Joined<Prefix extends string, Key extends string> = Prefix extends '' ? Key : `${Prefix}.${Key}`

type SecretProp<Value> = [SecretPaths<Value>] extends [never] ? unknown : { kayLint: 'secret-prop', kayPath: SecretPaths<Value> }

// Whether a value is or holds an action, three levels deep; with `Open`, a type that says nothing (`any`, `unknown`) counts as holding one.
type HoldsAction<T, Open extends boolean, Depth extends unknown[] = []> = 0 extends 1 & T
  ? Open
  : unknown extends T
    ? Open
    : T extends Action<never, unknown>
      ? true
      : Depth['length'] extends 3
        ? false
        : T extends readonly (infer Item)[]
          ? HoldsAction<Item, Open, [...Depth, 0]>
          : T extends object
            ? true extends { [Key in keyof T]-?: HoldsAction<T[Key], Open, [...Depth, 0]> }[keyof T] ? true : false
            : false

// An island whose props name no action receives one as a bare function, which its chunk cannot revive: it needs `Action` imported from `kay` in its script, as the type of the prop. `kay check` reports it as the `island-action` lint.
type ActionProp<Component, Value> = true extends HoldsAction<Value, false> ? Component extends (props: infer Props) => unknown ? true extends HoldsAction<Props, true> ? unknown : { kayLint: 'island-action' } : unknown : unknown

// Props a static parent passes to an island are serialized for the browser, so they must survive it, and are public, so they should hold no secret-looking field. `kay check` reports the second as the `secret-prop` lint.
export type IslandProp<Component, Value> = Component extends IslandBrand ? [IsSerializable<Value>] extends [true] ? SecretProp<Value> & ActionProp<Component, Value> : { kayError: 'A layout, or a page with a server fence, sends an island its props serialized: plain objects, arrays, Dates, Maps, Sets, bigints, URLs and RegExps, but no functions, symbols or class instances; a component of its own passing one renders as an island in its place' } : unknown

// A function written in the attribute is checked apart from its value, which a wrapping call would stop a generic component from typing: `0` stands for the attribute.
export type FunctionProp<Component> = Component extends IslandBrand ? { kayError: 'A layout, or a page with a server fence, sends an island its props serialized: plain objects, arrays, Dates, Maps, Sets, bigints, URLs and RegExps, but no functions, symbols or class instances; a component of its own passing one renders as an island in its place' } : 0

// What `defer()` returns, a plain promise: an `await` block takes any promise, so nothing marks one.
export type Deferred<T> = Promise<T>

// What an `await` block's `then` block takes: what a promise resolves to, or each part of an async iterable.
export type Settled<T> = T extends AsyncIterable<infer Part> ? Part : Awaited<T>

// What a template's `await` block compiles to: the value, then a function per block.
export interface AwaitProps<T> {
  value: T
  pending?: (() => JSX.Element) | undefined
  ready: (value: Settled<T>) => JSX.Element
  failed?: ((error: unknown) => JSX.Element) | undefined
}

type PropsOf<Tag> = Tag extends keyof JSX.IntrinsicElements ? JSX.IntrinsicElements[Tag] : Tag extends Component<infer Props> ? Props : Record<string, unknown>

// What the template's control flow and dynamic tags read as in the code the type checker reads: `for` and an aliased `if` hand their block values, which TypeScript narrows, where the browser build hands accessors.
export interface TemplateHelpers {
  For: {
    <T>(props: { each: readonly T[] | null | undefined | false, keyed: (item: T) => unknown, fallback?: JSX.Element, children: (item: T, index: number) => JSX.Element }): JSX.Element
    <T>(props: { each: readonly T[] | null | undefined | false, keyed: false, fallback?: JSX.Element, children: (item: T, index: number) => JSX.Element }): JSX.Element
  }
  Show: <T>(props: { when: T, fallback?: JSX.Element, children: (value: Truthy<T>) => JSX.Element }) => JSX.Element
  staticFor: <T>(each: readonly T[] | null | undefined | false, render: (item: T, index: number) => JSX.Element, fallback?: () => JSX.Element) => JSX.Element
  Dynamic: <Tag>(props: { component: Tag } & PropsOf<Tag>) => JSX.Element
  componentClass: (list: readonly unknown[]) => string | undefined
  omit: <Props extends object, Key extends keyof Props>(props: Props, ...keys: Key[]) => Omit<Props, Key>
  head: (tags: { tag: string, props: Record<string, unknown> }[]) => void
  Try: (props: { block: () => JSX.Element, failed?: (error: unknown) => JSX.Element }) => JSX.Element
}

declare const SAFE_HTML: unique symbol

// Markup fit for `innerHTML`: what `sanitizeHtml()` kept, or what `trustHtml()` vouches for.
export type SafeHtml = string & { readonly [SAFE_HTML]: true }

// What innerHTML would render as markup without anyone saying it may: a computed string, a template literal with values in it, as opposed to markup written out or made safe.
type UnsafeHtml<Markup> = Markup extends SafeHtml | null | undefined ? never : Record<never, never> extends Record<Markup & string, 1> ? Markup : never

export type CheckedHtml<Markup> = [UnsafeHtml<Markup>] extends [never] ? unknown : { kayError: 'This string would render as markup: pass sanitizeHtml(value) for markup a user wrote, or trustHtml(value) for markup the app made' }
