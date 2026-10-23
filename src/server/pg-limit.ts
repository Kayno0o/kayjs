import { kayLog } from '../runtime/log'
import { timeLimited } from './pg-poll'

// How long a call of a store may take: inside the default shutdown timeout of 10 seconds, so a database that stopped answering fails a request, a worker's claim or a schedule's lock before it holds up a stop.
export const STORE_TIMEOUT_MS = 8_000

// How long the first call may take to find or create the tables, past the two minutes a replica waits for an index another one builds.
export const READY_TIMEOUT_MS = 150_000

// Runs one store call under the time limit, a call given up on being logged before its error goes on to the caller.
export async function limited<Result>(what: string, work: () => Promise<Result>): Promise<Result> {
  try {
    return await timeLimited(work, STORE_TIMEOUT_MS, what)
  }
  catch (error) {
    if ((error as { timedOut?: boolean }).timedOut === true)
      kayLog('error', `${what} was given up on; the database stopped answering`, error)

    throw error
  }
}

// Puts the listed async methods of a store under the time limit, in place. `ready` is awaited first under its own, longer limit: the first call creates the tables, which may take a while.
export function limitedStore<Store extends object>(store: Store, what: string, methods: readonly (keyof Store & string)[], ready?: () => Promise<unknown>): Store {
  for (const name of methods) {
    const method = store[name] as (...args: unknown[]) => Promise<unknown>

    store[name] = (async (...args: unknown[]) => {
      if (ready)
        await timeLimited(ready, READY_TIMEOUT_MS, `${what} finding its tables`)

      return limited(`${what} ${name}`, async () => method.apply(store, args))
    }) as Store[typeof name]
  }

  return store
}
