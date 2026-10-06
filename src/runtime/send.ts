import { CONSTANTS, isIndex, SPARSE } from './wire'

// Writes a custom type the reducer of its name recognizes, returning what stands for it or a falsy value for any other.
export type Reducer = (value: unknown) => unknown

// What the browser sends as devalue text, the types kay reads back and those `reducers` write; throws on anything else, a function or a class instance.
export function sendValue(value: unknown, reducers: Record<string, Reducer> = {}): string {
  const custom = Object.entries(reducers)
  const written: string[] = []
  const indexes = new Map<unknown, number>()

  function flatten(thing: unknown): number {
    if (thing === undefined || typeof thing === 'number') {
      for (const [index, constant] of CONSTANTS) {
        if (Object.is(thing, constant))
          return index as number
      }
    }

    const known = indexes.get(thing)

    if (known !== undefined)
      return known

    // Reserved before its contents, so they come after it as in devalue's own text.
    const index = written.push('') - 1

    indexes.set(thing, index)
    written[index] = write(thing)

    return index
  }

  function write(thing: unknown): string {
    for (const [type, reduce] of custom) {
      const reduced = reduce(thing)

      if (reduced)
        return `[${JSON.stringify(type)},${flatten(reduced)}]`
    }

    if (typeof thing === 'bigint')
      return `["BigInt","${thing}"]`

    if (typeof thing === 'function' || typeof thing === 'symbol')
      refuse(`a ${typeof thing}`)

    if (thing === null || typeof thing !== 'object')
      return JSON.stringify(thing)

    if (thing instanceof Date)
      return `["Date",${JSON.stringify(thing.toISOString())}]`

    if (thing instanceof URL || thing instanceof URLSearchParams)
      return `[${JSON.stringify(thing.constructor.name)},${JSON.stringify(String(thing))}]`

    if (thing instanceof RegExp)
      return `["RegExp",${JSON.stringify(thing.source)}${thing.flags === '' ? '' : `,"${thing.flags}"`}]`

    if (thing instanceof Set)
      return `["Set"${[...thing].map(item => `,${flatten(item)}`).join('')}]`

    if (thing instanceof Map)
      return `["Map"${[...thing].map(([key, item]) => `,${flatten(key)},${flatten(item)}`).join('')}]`

    if (Array.isArray(thing))
      return writeArray(thing, flatten)

    const prototype: unknown = Object.getPrototypeOf(thing)

    if (prototype !== Object.prototype && prototype !== null)
      refuse(`an instance of ${(thing.constructor as { name?: string } | undefined)?.name ?? 'a class'}`)

    if (Object.getOwnPropertySymbols(thing).length > 0)
      refuse('an object with symbol keys')

    const entries = Object.entries(thing)

    if (Object.hasOwn(thing, '__proto__'))
      refuse('an object with a __proto__ key')

    return prototype === null
      ? `["null"${entries.map(([key, item]) => `,${JSON.stringify(key)},${flatten(item)}`).join('')}]`
      : `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${flatten(item)}`).join(',')}}`
  }

  const root = flatten(value)

  return root < 0 ? String(root) : `[${written.join(',')}]`
}

// A sparse array lists only the entries it holds, so one with a single far index costs no more than its entries.
function writeArray(array: unknown[], flatten: (thing: unknown) => number): string {
  let holes = false

  for (let at = 0; at < array.length && !holes; at++)
    holes = !Object.hasOwn(array, at)

  if (!holes)
    return `[${array.map(flatten).join(',')}]`

  const entries = Object.keys(array).filter(key => isIndex(Number(key), array.length))

  return `[${SPARSE},${array.length}${entries.map(key => `,${key},${flatten(array[Number(key)])}`).join('')}]`
}

function refuse(what: string): never {
  throw new TypeError(`kay: ${what} cannot be sent to the server or kept by a persisted signal`)
}
