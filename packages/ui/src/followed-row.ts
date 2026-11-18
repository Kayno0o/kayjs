import { untrack } from 'kay'

// Draws what a block shows for one row once, though the row is replaced by a copy under the same key: the block reads the row it is given where it uses it, and gets the current one each time, so its markup keeps its nodes, and a field in it its focus. A call made from a template would track the row it is handed and draw the block again on each replacement.
export function followedRow<Row, Drawn>(read: () => Row | undefined, draw: (row: Row) => Drawn): Drawn {
  const first = untrack(read)

  if (typeof first !== 'object' || first === null)
    return untrack(() => draw(first as Row))

  const view = new Proxy({}, {
    get: (_, key) => (read() as Record<PropertyKey, unknown> | undefined)?.[key],
    has: (_, key) => key in (read() ?? {}),
    ownKeys: () => Reflect.ownKeys(read() ?? {}),
    getOwnPropertyDescriptor: (_, key) => {
      const own = Object.getOwnPropertyDescriptor(read() ?? {}, key)

      return own && { ...own, configurable: true }
    },
  })

  return untrack(() => draw(view as Row))
}
