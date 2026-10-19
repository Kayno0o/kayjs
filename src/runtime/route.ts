import type { Register } from './checks'

// The page patterns `kay check` registers, `/todos/:id`, an optional param as `:page?` and a catch-all as `*path`; any string where nothing is registered.
export type RoutePattern = Register extends { patterns: infer Patterns extends string } ? Patterns : string

type Value = string | number
type CatchAll = Value | readonly Value[]
type SegmentParams<Segment extends string> = Segment extends `:${infer Name}?`
  ? Partial<Record<Name, Value | undefined>>
  : Segment extends `:${infer Name}` ? Record<Name, Value> : Segment extends `*${infer Name}` ? Record<Name, CatchAll> : unknown
type ParamsOf<Pattern extends string> = Pattern extends `/${infer Head}/${infer Rest}` ? SegmentParams<Head> & ParamsOf<`/${Rest}`> : Pattern extends `/${infer Last}` ? SegmentParams<Last> : unknown
const OPTIONAL = /\?$/

type Flat<Shape> = { [Key in keyof Shape]: Shape[Key] }

export interface RouteOptions {
  // Added as the query string: `undefined` is left out and an array repeats its key.
  query?: Readonly<Record<string, Value | boolean | null | undefined | readonly (Value | boolean)[]>> | undefined
  hash?: string | undefined
}

// A pattern with no param takes only the options, one with params takes them first.
export type RouteArgs<Pattern extends string> = string extends Pattern
  ? [params?: Readonly<Record<string, unknown>>, options?: RouteOptions]
  : [keyof ParamsOf<Pattern>] extends [never]
    ? [options?: RouteOptions]
    : Record<never, never> extends Flat<ParamsOf<Pattern>> ? [params?: Flat<ParamsOf<Pattern>>, options?: RouteOptions] : [params: Flat<ParamsOf<Pattern>>, options?: RouteOptions]

// One segment of a path: `/`, `?`, `#` and `%` encoded. Empty, `.` and `..` throw: the first makes another route and a browser resolves the others, even as `%2E`.
function segment(name: string, value: unknown): string {
  const given = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
  const text = given ? String(value) : ''

  if (text === '' || text === '.' || text === '..')
    throw new TypeError(`route(): param "${name}" is ${typeof value === 'number' || typeof value === 'string' ? `"${text}"` : String(value)}`)

  try {
    return encodeURIComponent(text)
  }
  catch {
    throw new TypeError(`route(): param "${name}" is not valid text`)
  }
}

// The path of a page for its params, encoded, as a literal `href` would write it: the mount point and the locale are put on it as they are on any link of the site.
export function route<const Pattern extends RoutePattern>(pattern: Pattern, ...args: RouteArgs<Pattern>): string {
  const parts = pattern.split('/').slice(1)
  const parameterized = parts.some(part => part[0] === ':' || part[0] === '*')
  const [first, second] = args as unknown as [Record<string, unknown> | undefined, RouteOptions | undefined]
  const params = parameterized ? first ?? {} : {}
  const options = parameterized ? second : second ?? first
  const path = parts.flatMap((part) => {
    const name = part.slice(1).replace(OPTIONAL, '')

    if (part[0] === '*') {
      const value = params[name]

      // An empty catch-all is the directory's own path, `/docs/`.
      const each: unknown[] = typeof value === 'string' ? value.split('/') : [value].flat()

      return each.length === 0 || (each.length === 1 && each[0] === '') ? [''] : each.map(one => segment(name, one))
    }

    if (part[0] !== ':')
      return [part]

    return part.endsWith('?') && params[name] === undefined ? [] : [segment(name, params[name])]
  }).join('/')
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(options?.query ?? {})) {
    for (const each of [value].flat()) {
      if (each !== undefined && each !== null)
        search.append(key, String(each))
    }
  }

  return `/${path}${search.size > 0 ? `?${search}` : ''}${typeof options?.hash === 'string' && options.hash !== '' ? `#${encodeURIComponent(options.hash)}` : ''}`
}
