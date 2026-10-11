// Field paths as kay's markers write them: dotted keys, list indexes as numbers, `sections.1.heading`.

const INDEX = /^\d+$/

export function pathSegments(path: string): string[] {
  return path === '' ? [] : path.split('.')
}

export function joinPath(parent: string, key: string | number): string {
  return parent === '' ? String(key) : `${parent}.${key}`
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
