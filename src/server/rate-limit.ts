import type { Server } from 'bun'
import type { GuardContext } from '../runtime'
import type { RateLimit } from '../runtime/action'
import { KayError } from '../compiler/errors'
import { durationSeconds } from '../runtime/duration'
import { actionKey, clientAddress, makeLimiter, rateKey, shareLimiter, waitFor } from './protection'
import { refused } from './rate-refusal'
import { kayWord } from './words'

// What `rateLimit()` returns: the limit itself, so it goes wherever a `RateLimit` does (an action's `protect.rateLimit`, `api({ rateLimit })`, `page.rateLimit`) and every place counts in its one counter.
export interface RateLimiter extends RateLimit {
  // Counts an attempt from the request's client, or under the app's own key such as an account id: the seconds it must wait before the next one once over the limit, else undefined. `server` is the one serving the request, read from `pages()`'s app when left out.
  // `weight` counts that many at once, the tokens a reply used say, against a `max` of tokens.
  hit: (from: Request | string, server?: Server<unknown> | null, weight?: number) => Promise<number | undefined>
  // Not `limiter().enforce(key, weight)`, which takes a key and answers the seconds to wait. This one takes a guard's `ctx`: it counts the request under the limit's `key` or the client's address and, once over the limit, sets `Retry-After` and denies with 429, `message` (a text or a function of the seconds to wait) in place of kay's.
  enforce: (ctx: Pick<GuardContext, 'request' | 'headers' | 'deny' | 'locale' | 'cookies' | 'locals'>, message?: string | ((wait: number) => string)) => Promise<void>
}

// A limit for a guard, an API route or a library, counted as an action's `rateLimit` is: `max` attempts from one client every `window`, under `name`, which limits sharing it count together.
export function rateLimit(name: string, limit: RateLimit): RateLimiter {
  if (!Number.isInteger(limit.max) || limit.max < 1)
    throw new KayError('config-invalid', `kay: rateLimit('${name}')'s max is ${limit.max}; it takes a whole number of at least 1`)

  const counting = makeLimiter({ name, max: limit.max, ms: durationSeconds(limit.window, `rateLimit('${name}')'s window`) * 1000, store: limit.store })

  const hit = async (key: string, weight: number, request?: Request): Promise<number | undefined> => {
    const window = await counting.hit(key, weight)

    // A count below the weight holds less than this hit alone: the store counted one, which shows on a window's first hit.
    if (window.count < weight)
      throw new KayError('config-invalid', `kay: rateLimit('${name}')'s store ignores the weight of a hit; its hit(key, window, weight) adds weight to the count`)

    const wait = waitFor(window, limit.max)

    if (wait !== undefined)
      refused(name, limit, { key, wait, request })

    return wait
  }

  const limiter: RateLimiter = {
    ...limit,
    hit: async (from, server, weight = 1) => {
      if (!Number.isSafeInteger(weight) || weight < 1)
        throw new KayError('config-invalid', `kay: rateLimit('${name}').hit()'s weight is ${weight}; it takes a whole number of at least 1`)

      return hit(typeof from === 'string' ? `key:${from}` : rateKey(clientAddress(from, server)), weight, typeof from === 'string' ? undefined : from)
    },
    enforce: async (ctx, message) => {
      const { request } = ctx
      const key = await actionKey(name, limiter, request, clientAddress(request, undefined), () => ({ request, locale: ctx.locale, cookies: ctx.cookies, locals: ctx.locals }))
      const wait = await hit(key, 1, request)

      if (wait === undefined)
        return

      ctx.headers.set('retry-after', String(wait))
      ctx.deny(429, typeof message === 'function' ? message(wait) : message ?? kayWord('kay.protection.rateLimit', { seconds: wait }))
    },
  }

  shareLimiter(limiter, counting)

  return limiter
}
