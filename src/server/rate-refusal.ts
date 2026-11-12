import type { RateLimit, RateLimitRefusal } from '../runtime/action'
import { KayError } from '../compiler/errors'
import { durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'

// Checks a limit declared on an API module or route, as `rateLimit()` checks its own.
export function checkApiLimit(name: string, limit: RateLimit): void {
  if (!Number.isInteger(limit.max) || limit.max < 1)
    throw new KayError('config-invalid', `kay: the rateLimit of ${name} has a max of ${limit.max}; it takes a whole number of at least 1`)

  durationSeconds(limit.window, `the rateLimit window of ${name}`)

  if (limit.onLimit !== undefined && typeof limit.onLimit !== 'function')
    throw new KayError('config-invalid', `kay: the rateLimit of ${name} has an onLimit that is not a function; it takes a function of the refusal`)

  if (limit.key !== undefined && typeof limit.key !== 'function')
    throw new KayError('config-invalid', `kay: the rateLimit of ${name} has a key that is not a function; it takes a function of the request returning the string to count under`)

  if (limit.store !== undefined && typeof limit.store?.hit !== 'function')
    throw new KayError('config-invalid', `kay: the rateLimit of ${name} has a store without a hit(key, window) method; give it a RateStore`)
}

// Tells a limit's `onLimit` about a request it refused, without holding the refusal: a callback that throws or rejects is logged.
export function refused(name: string, limit: Pick<RateLimit, 'onLimit'>, event: Omit<RateLimitRefusal, 'name'>): void {
  if (limit.onLimit)
    void notify(name, limit.onLimit, { ...event, name })
}

async function notify(name: string, onLimit: NonNullable<RateLimit['onLimit']>, event: RateLimitRefusal): Promise<void> {
  try {
    await onLimit(event)
  }
  catch (error) {
    kayLog('warn', `the onLimit of the rateLimit ${name} threw`, error)
  }
}
