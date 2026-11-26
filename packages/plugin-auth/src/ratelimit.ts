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

function firstFreshIndex(list: number[], cutoff: number): number {
  let i = 0
  while (i < list.length && list[i]! <= cutoff)
    i++
  return i
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
      if (list.length === 0 || list[list.length - 1]! <= cutoff) {
        hits.delete(k)
        removed++
      }
      else if (list[0]! <= cutoff) {
        hits.set(k, list.slice(firstFreshIndex(list, cutoff)))
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

      // Sweep at most once per window; capacity pressure uses O(1) LRU eviction instead of an O(maxKeys) scan.
      if (now - lastSweep >= windowMs)
        sweep(now)

      const existing = hits.get(key)
      let list: number[]
      if (existing !== undefined) {
        const start = firstFreshIndex(existing, cutoff)
        if (start > 0)
          existing.splice(0, start)
        list = existing
      }
      else {
        list = []
      }

      if (list.length >= max) {
        hits.delete(key)
        hits.set(key, list)
        return false
      }

      if (existing === undefined && hits.size >= maxKeys) {
        const oldest = hits.keys().next().value
        if (oldest !== undefined)
          hits.delete(oldest)
      }

      list.push(now)
      if (existing !== undefined)
        hits.delete(key)
      hits.set(key, list)
      return true
    },
  }
}
