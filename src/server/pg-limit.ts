import { kayLog } from '../runtime/log'
import { timeLimited, TimeoutError } from './pg-poll'

// How long a call of a store may take: inside the default shutdown timeout of 10 seconds, so a database that stopped answering fails a request, a worker's claim or a schedule's lock before it holds up a stop.
export const STORE_TIMEOUT_MS = 8_000

// How long the first call may take to find or create the tables, past the two minutes a replica waits for an index another one builds.
export const READY_TIMEOUT_MS = 150_000

// How long maintenance may take, a sweep, a purge or a listing that scans a table: as long as the first call, as a table can be large.
export const MAINTENANCE_TIMEOUT_MS = READY_TIMEOUT_MS

// Runs one store call under the time limit, a call given up on being logged before its error goes on to the caller.
export async function limited<Result>(what: string, work: () => Promise<Result>, ms = STORE_TIMEOUT_MS): Promise<Result> {
  try {
    return await timeLimited(work, ms, what)
  }
  catch (error) {
    if (error instanceof TimeoutError)
      kayLog('error', `${what} was given up on; the database stopped answering`, error)

    throw error
  }
}

// Puts every function of a store under the time limit, in place, so a method added later is limited without being listed; the `unlimited` ones, such as a listener registration that does not touch the database, stay as they are. A member that is not an async function and not named in `unlimited` throws, as wrapping it would turn its synchronous value into a promise. `ready` is awaited first under its own, longer limit: the first call creates the tables, which may take a while. The `slow` methods scan a table and have the maintenance limit.
export function limitedStore<Store extends object>(store: Store, what: string, options: { ready?: () => Promise<unknown>, slow?: readonly (keyof Store & string)[], unlimited?: readonly (keyof Store & string)[] } = {}): Store {
  const { ready, slow = [], unlimited = [] } = options
  let found = false

  for (const name of Object.keys(store) as (keyof Store & string)[]) {
    const method = store[name] as unknown

    if (typeof method !== 'function' || unlimited.includes(name))
      continue

    if (method.constructor.name !== 'AsyncFunction')
      throw new Error(`${what} ${name} is not an async function: name it in unlimited to keep it synchronous, or make it async`)

    store[name] = (async (...args: unknown[]) => {
      if (ready && !found) {
        await limited(`${what} finding its tables`, ready, READY_TIMEOUT_MS)
        found = true
      }

      return limited(`${what} ${name}`, async () => (method as (...args: unknown[]) => Promise<unknown>).apply(store, args), slow.includes(name) ? MAINTENANCE_TIMEOUT_MS : STORE_TIMEOUT_MS)
    }) as Store[typeof name]
  }

  return store
}
