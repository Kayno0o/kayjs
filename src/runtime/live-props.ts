import { batch, ownSignal } from './reactive'

// Props read through a signal each, so an island marked `persist` the next page gives other props shows them, as a component inside an island does.
export function liveProps(initial: Record<string, unknown>): [props: object, update: (next: object) => void] {
  const props = {}
  const writes = new Map<string, (value: unknown) => void>()
  const define = (key: string, value: unknown) => {
    const [read, write] = ownSignal(value, { equals: sameData })

    writes.set(key, write)
    Object.defineProperty(props, key, { get: read, enumerable: true, configurable: true })
  }

  for (const [key, value] of Object.entries(initial))
    define(key, value)

  return [props, next => batch(() => {
    for (const key of new Set([...writes.keys(), ...Object.keys(next)])) {
      const value = (next as Record<string, unknown>)[key]
      const write = writes.get(key)

      if (write)
        write(value)
      else
        define(key, value)
    }
  })]
}

// Whether two decoded props hold the same data, so a prop the next page gives unchanged keeps its value, and what reads it, a `linked` edit included, is left alone.
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b))
    return true

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b))
    return false

  if (a instanceof Date)
    return a.getTime() === (b as Date).getTime()

  if (a instanceof RegExp || a instanceof URL)
    return String(a) === String(b)

  const entries = (value: object) => value instanceof Map || value instanceof Set ? [...value.entries()] : Object.entries(value)
  const [left, right] = [entries(a), entries(b)]

  return left.length === right.length && left.every(([key, value], index) => sameData(key, right[index]![0]) && sameData(value, right[index]![1]))
}
