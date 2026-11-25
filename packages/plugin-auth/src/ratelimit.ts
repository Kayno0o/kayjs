// In-memory sliding-window rate limiter keyed by string, bounded in distinct keys.

const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000

export interface RateLimitOptions {
  /** Max attempts per window (default: 15). */
  max?: number | undefined
  /** Window duration in ms (default: 60_000). */
  windowMs?: number | undefined
  /** Maximum distinct keys kept in memory before evicting oldest entries (default: 10_000). */
  maxKeys?: number | undefined
}

export interface RateLimiter {
  allow(key: string): boolean
  sweep(now?: number): number
  size(): number
}

export function createRateLimiter(opts: RateLimitOptions | false | undefined): RateLimiter {
  if (opts === false) {
    return {
      allow: () => true,
      sweep: () => 0,
      size: () => 0,
    }
  }
  const max = opts?.max ?? 15
  const windowMs = opts?.windowMs ?? 60_000
  const maxKeys = Math.max(1, opts?.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS)
  const hits = new Map<string, number[]>()
  let lastSweep = Date.now()

  function sweep(now = Date.now()): number {
    const cutoff = now - windowMs
    let removed = 0
    for (const [k, list] of hits) {
      const fresh = list.filter(t => t > cutoff)
      if (fresh.length === 0) {
        hits.delete(k)
        removed++
      }
      else if (fresh.length !== list.length) {
        hits.set(k, fresh)
      }
    }
    lastSweep = now
    return removed
  }

  return {
    sweep,
    size: () => hits.size,
    allow(key: string): boolean {
      const now = Date.now()
      const cutoff = now - windowMs

      if (now - lastSweep >= windowMs || hits.size >= maxKeys)
        sweep(now)

      const existing = hits.get(key)
      const list = existing ? existing.filter(t => t > cutoff) : []
      if (list.length >= max) {
        hits.delete(key)
        hits.set(key, list)
        return false
      }
      list.push(now)
      hits.delete(key)
      hits.set(key, list)

      if (hits.size > maxKeys) {
        for (const oldest of hits.keys()) {
          if (hits.size <= maxKeys)
            break
          hits.delete(oldest)
        }
      }
      return true
    },
  }
}
