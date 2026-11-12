import type { JobStore } from './queue'

// The changes to the store that move a job in or out of the waiting and running ones, or change what they show.
const CHANGES = new Set<PropertyKey>(['add', 'claim', 'complete', 'retry', 'release', 'progress', 'update', 'fail', 'revive'])

// The store of a queue with `live`, telling it of each change once the store made it: every path that writes a job, the workers, drains, `remove` and the jobs page alike, goes through it.
export function tellingStore(own: () => JobStore, changed: () => void): () => JobStore {
  const told = new WeakMap<JobStore, JobStore>()

  return () => {
    const store = own()
    let telling = told.get(store)

    if (telling === undefined) {
      telling = new Proxy(store, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver)

          if (typeof value !== 'function' || !CHANGES.has(property))
            return value

          // A claim that found no job changed nothing: an idle queue claims at every look.
          const tell = (result: unknown) => {
            if (property !== 'claim' || result !== undefined)
              changed()
          }

          return (...args: unknown[]) => {
            const result: unknown = Reflect.apply(value, target, args)

            if (result instanceof Promise)
              return toldOnce(result, tell)

            tell(result)

            return result
          }
        },
      })
      told.set(store, telling)
    }

    return telling
  }
}

async function toldOnce(result: Promise<unknown>, tell: (result: unknown) => void): Promise<unknown> {
  const value: unknown = await result

  tell(value)

  return value
}
