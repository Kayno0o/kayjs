import type { RateLimit, RateStore } from '../runtime/action'
import type { Limiter } from './protection'
import { makeLimiter, rateKey } from './protection'
import { refused } from './rate-refusal'

// Seconds until the client may try again under `name`, in the app's `store.rates` else this process's memory, or undefined while it is under the limit: for kay's own routes.
const overLimiters = new Map<object | string, Limiter>()

export const overLimit = async (name: string, client: string, max: number, windowMs: number): Promise<number | undefined> => overLimitOf(name, client, { max, windowMs })

// The same for a limit the app's config gave, with its own `store` and an `onLimit` told of each request refused.
export async function overLimitOf(name: string, client: string, rate: { max: number, windowMs: number, store?: RateStore | undefined, onLimit?: RateLimit['onLimit'] }, request?: Request): Promise<number | undefined> {
  const id = rate.store === undefined ? `${name}\n${rate.max}\n${rate.windowMs}` : rate
  const counting = overLimiters.get(id) ?? makeLimiter({ name, max: rate.max, ms: rate.windowMs, store: rate.store })
  const key = rateKey(client)
  const wait = await counting.enforce(key)

  overLimiters.set(id, counting)

  if (wait !== undefined)
    refused(name, rate, { key, wait, request })

  return wait
}
