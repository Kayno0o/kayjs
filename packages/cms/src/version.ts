// The version of a loaded entry, a hash of what its loader gave for it, so a save made over a change of the entry is told apart without the loader naming a version; the same content gives the same version, and a key order never changes it.
// With the collection's schema, only the fields it declares count: a loader that adds computed fields (a url, a read time) or changes them on every read causes no conflict, and a save does not claim to protect what the editor does not edit.
export function contentVersion({ data, body }: { data?: unknown, body?: string | undefined }, schema?: unknown): string {
  return new Bun.CryptoHasher('sha1').update(JSON.stringify({ data: declared(data, schema), body: body ?? '' }, canonical)).digest('hex')
}

// The top-level fields of `data` the schema declares, all of them when it declares none.
function declared(data: unknown, schema: unknown): unknown {
  const properties = (schema as { properties?: unknown } | null | undefined)?.properties

  if (properties === null || typeof properties !== 'object' || data === null || typeof data !== 'object' || Array.isArray(data))
    return data

  return Object.fromEntries(Object.entries(data).filter(([key]) => Object.hasOwn(properties, key)))
}

function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  if (a === b)
    return 0

  return a < b ? -1 : 1
}

// A JSON replacer, which runs after `toJSON`: keys sorted, and the values JSON cannot hold given a form of their own.
function canonical(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint')
    return `bigint:${value}`

  if (value instanceof Map || value instanceof Set)
    return { [value.constructor.name]: [...value] }

  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return Object.fromEntries(Object.entries(value).sort(byKey))

  return value
}
