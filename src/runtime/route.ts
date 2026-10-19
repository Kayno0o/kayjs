import type { Register } from './checks'

// The page patterns `kay check` registers, `/todos/:id`, an optional param as `:page?` and a catch-all as `*path`; any string where nothing is registered.
export type RoutePattern = Register extends { patterns: infer Patterns extends string } ? Patterns : string

type Value = string | number
type CatchAll = Value | readonly Value[]
type SegmentParams<Segment extends string> = Segment extends `:${infer Name}?`
  ? Partial<Record<Name, Value | undefined>>
  : Segment extends `:${infer Name}` ? Record<Name, Value> : Segment extends `*${infer Name}` ? Record<Name, CatchAll> : unknown
type ParamsOf<Pattern extends string> = Pattern extends `/${infer Head}/${infer Rest}` ? SegmentParams<Head> & ParamsOf<`/${Rest}`> : Pattern extends `/${infer Last}` ? SegmentParams<Last> : unknown
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

const DOT_SEGMENT = /^\.{1,2}$/

// One segment as a path holds it: `/`, `?`, `#` and `%` encoded, and `.` and `..` too, which a browser would resolve away.
function segment(name: string, value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new TypeError(`route(): the param "${name}" is ${value === undefined || value === null ? String(value) : typeof value}, not a string or a number`)

  const text = String(value)

  if (text === '')
    throw new TypeError(`route(): the param "${name}" is empty`)

  return DOT_SEGMENT.test(text) ? text.replaceAll('.', '%2E') : encodeURIComponent(text)
}

// The path of a page for its params, encoded, as a literal `href` would write it: the mount point and the locale are put on it as they are on any link of the site.
export function route<const Pattern extends RoutePattern>(pattern: Pattern, ...args: RouteArgs<Pattern>): string {
  const rest = args as unknown[]
  const parameterized = pattern.split('/').some(part => part.startsWith(':') || part.startsWith('*'))
  const params = (parameterized ? rest[0] : undefined) as Record<string, unknown> | undefined ?? {}
  const options = (parameterized ? rest[1] : rest[0]) as RouteOptions | undefined
  const parts: string[] = []

  for (const part of pattern.split('/').slice(1)) {
    if (part.startsWith('*')) {
      const name = part.slice(1)
      const value = params[name]
      const segments: unknown[] = typeof value === 'string' ? value.split('/') : [value].flat()

      // An empty catch-all is the directory's own path, `/docs/`.
      parts.push(...segments.length === 0 || (segments.length === 1 && segments[0] === '') ? [''] : segments.map(each => segment(name, each)))
    }
    else if (part.startsWith(':')) {
      const optional = part.endsWith('?')
      const name = part.slice(1, optional ? -1 : undefined)

      if (!optional || params[name] !== undefined)
        parts.push(segment(name, params[name]))
    }
    else {
      parts.push(part)
    }
  }

  const path = `/${parts.join('/')}`
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(options?.query ?? {})) {
    for (const each of Array.isArray(value) ? value : [value]) {
      if (each !== undefined && each !== null)
        search.append(key, String(each))
    }
  }

  const query = search.size > 0 ? `?${search}` : ''
  const hash = options?.hash === undefined || options.hash === '' ? '' : `#${encodeURIComponent(options.hash)}`

  return path + query + hash
}
