import type { DraftEntry } from './kay/contract'
import type { FieldPath } from './markers'
import { BODY } from './markers'
// Field paths as kay's markers write them: dotted keys, list indexes as numbers, `sections.1.heading`.

const INDEX = /^\d+$/

// An address under the prefix the screens are mounted at, which the root prefix `/` adds nothing to: `screenPath('/', '/uploads')` is `/uploads`, `screenPath('/', '')` is `/`.
export function screenPath(prefix: string, path = ''): string {
  return `${prefix === '/' ? '' : prefix}${path}` || '/'
}

export function pathSegments(path: string): string[] {
  return path === '' ? [] : path.split('.')
}

export function joinPath(parent: string, key: string | number): string {
  return parent === '' ? String(key) : `${parent}.${key}`
}

// The path of the field `key` beside the one at `path`, in the same object.
export function siblingPath(path: string, key: string | number): string {
  return joinPath(pathSegments(path).slice(0, -1).join('.'), key)
}

export function valueAt(data: unknown, path: string): unknown {
  let value = data

  for (const segment of pathSegments(path)) {
    if (value === null || typeof value !== 'object')
      return undefined

    value = (value as Record<string, unknown>)[segment]
  }

  return value
}

// A copy of `data` with `value` at `path`, creating the objects and lists on the way; what it leaves alone is shared, not copied.
export function withValueAt<T>(data: T, path: string, value: unknown): T {
  return setIn(data, pathSegments(path), value) as T
}

function setIn(container: unknown, segments: string[], value: unknown): unknown {
  const [segment, ...rest] = segments

  if (segment === undefined)
    return value

  if (Array.isArray(container)) {
    const copy = [...container]

    copy[Number(segment)] = setIn(copy[Number(segment)], rest, value)

    return copy
  }

  if (container === null || typeof container !== 'object') {
    const fresh: unknown[] | Record<string, unknown> = INDEX.test(segment) ? [] : {}

    return setIn(fresh, segments, value)
  }

  return { ...container, [segment]: setIn((container as Record<string, unknown>)[segment], rest, value) }
}

// The first key of a dotted path: the field of the entry's data it lies in.
export function topKey(path: string): string {
  const dot = path.indexOf('.')

  return dot < 0 ? path : path.slice(0, dot)
}

// The paths where two entries' data differ, down to the leaves, then `BODY` when their Markdown bodies do.
export function differing(a: DraftEntry, b: DraftEntry): FieldPath[] {
  const paths: FieldPath[] = []

  function walk(path: string, left: unknown, right: unknown): void {
    if (JSON.stringify(left) === JSON.stringify(right))
      return

    const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
    const lists = Array.isArray(left) && Array.isArray(right)

    if ((plain(left) && plain(right)) || lists) {
      const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)])

      for (const key of keys)
        walk(joinPath(path, key), (left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])

      return
    }

    paths.push(path)
  }

  walk('', a.data, b.data)

  if ((a.body ?? '') !== (b.body ?? ''))
    paths.push(BODY)

  return paths
}
