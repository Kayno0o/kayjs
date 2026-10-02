import type { JSX } from '@solidjs/web'

// Types behind the checks `kay check` adds to generated code; nothing here runs.

declare const ISLAND: unique symbol

// What an interactive component's default export is: the brand lets the checker tell islands from plain components.
export type IslandComponent<Props> = ((props: Props) => JSX.Element) & { readonly [ISLAND]: true }

// Augmented by the `.kay/types/kay-env.d.ts` that `kay check` writes, listing every route the pages directory serves.

export interface Register {}

// Routes as segment tuples: `[]` is `/`, `':'` a parameter, `'*'` a catch-all.
type RoutePatterns = Register extends { routes: infer Routes extends readonly string[] } ? Routes : never
type Split<Path extends string> = Path extends `${infer Head}/${infer Rest}` ? [Head, ...Split<Rest>] : [Path]
type SegmentsOf<Path extends string> = Path extends '/' ? [] : Path extends `/${infer Rest}` ? Rest extends `${infer Trimmed}/` ? Split<Trimmed> : Split<Rest> : never
type Matches<Segments extends readonly string[], Pattern extends readonly string[]> = Pattern extends readonly ['*']
  ? Segments extends readonly [] ? false : true
  : Pattern extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
    ? Segments extends readonly [infer Segment extends string, ...infer Others extends readonly string[]]
      ? Head extends ':' ? Segment extends '' ? false : Matches<Others, Rest> : Segment extends Head ? Matches<Others, Rest> : false
      : false
    : Segments extends readonly [] ? true : false
type AnyMatch<Segments extends readonly string[], Pattern> = Pattern extends readonly string[] ? Matches<Segments, Pattern> : never
type PathOf<Href extends string> = Href extends `${infer Path}?${string}` ? Path : Href extends `${infer Path}#${string}` ? Path : Href
type IsRoute<Path extends string> = [RoutePatterns] extends [never] ? true : true extends AnyMatch<SegmentsOf<Path>, RoutePatterns> ? true : false

// A site-relative literal must match a page; opaque strings, relative paths and other schemes are not checked.
export type CheckedHref<Href extends string> = string extends Href
  ? unknown
  : Href extends `//${string}`
    ? unknown
    : Href extends `/${string}`
      ? IsRoute<PathOf<Href>> extends true ? unknown : { kayError: `No page serves ${PathOf<Href>}` }
      : unknown

type IsSerializable<T> = T extends string | number | boolean | null | undefined
  ? true
  : T extends ((...args: never[]) => unknown) | Date | Map<unknown, unknown> | Set<unknown> | RegExp | bigint | symbol
    ? false
    : T extends readonly (infer Item)[]
      ? IsSerializable<Item>
      : T extends object
        ? false extends { [Key in keyof T]-?: IsSerializable<T[Key]> }[keyof T] ? false : true
        : false

// Props a static parent passes to an island travel as JSON, so they must survive it.
export type IslandProp<Component, Value> = Component extends { readonly [ISLAND]: true }
  ? [IsSerializable<Value>] extends [true] ? unknown : { kayError: 'An island receives its props as JSON: no functions, Dates, Maps, Sets or class instances' }
  : unknown
