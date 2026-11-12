import type { RateLimit, RateLimitRefusal } from '../runtime/action'
import { kayLog } from '../runtime/log'

// The limiter a `rateLimit()` object counts in, which every place taking the object counts through.
export const SHARED = Symbol.for('kay.sharedLimiter')

// Tells a limit's `onLimit` about a request it refused, without holding the refusal: a callback that throws or rejects is logged.
export function refused(name: string, limit: RateLimit, event: Omit<RateLimitRefusal, 'name'>): void {
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
