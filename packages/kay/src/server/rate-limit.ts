// How often a client may call a plugin route or an action: a sliding window per key, in one store per server bounded in keys and hits.

export interface RateLimit<Ctx extends { ip?: string | undefined } = { ip?: string | undefined }> {
  /** Requests a key may make per window. */
  max: number
  /** Window length in ms. */
  windowMs: number
  /** What a client is counted by (default: its address, `ctx.ip` as `trustProxy` reads it); `undefined` falls back to the address. */
  key?: ((ctx: Ctx) => string | undefined) | undefined
}

export interface RateLimiter {
  /** Counts a request from `key` and returns 0; past the limit, counts nothing and returns the whole seconds until the next request would pass. */
  hit(key: string): number
}

export interface RateLimitStore {
  /** A limiter counting in this store, apart from every other limiter's keys. */
  limiter(limit: Pick<RateLimit, 'max' | 'windowMs'>): RateLimiter
  /** Drops the hits older than their window, and the keys left with none; returns how many keys went. */
  sweep(now?: number): number
  readonly size: number
  /** Stops the sweep timer. */
  close(): void
}

export interface RateLimitStoreOptions {
  /** Keys kept before the least recently used go (default: 10 000). */
  maxKeys?: number | undefined
  /** Hits kept across all keys before the least recently used keys go (default: 1 000 000, about 8 MB). */
  maxHits?: number | undefined
}

interface Entry {
  hits: number[]
  windowMs: number
}

const SWEEP_MS = 60_000

/** Throws when a `rateLimit` option cannot count anything, naming where it was set. */
export function assertRateLimit(limit: Pick<RateLimit, 'max' | 'windowMs'>, where: string): void {
  if (!Number.isInteger(limit.max) || limit.max < 1)
    throw new Error(`kay: rateLimit.max of ${where} is ${String(limit.max)}; give a whole number of requests, 1 or more.`)
  if (!Number.isFinite(limit.windowMs) || limit.windowMs <= 0)
    throw new Error(`kay: rateLimit.windowMs of ${where} is ${String(limit.windowMs)}; give the window in milliseconds, above 0.`)
}

export function createRateLimitStore(options: RateLimitStoreOptions = {}): RateLimitStore {
  const maxKeys = Math.max(1, options.maxKeys ?? 10_000)
  const maxHits = Math.max(1, options.maxHits ?? 1_000_000)
  // Least recently used first: a key is moved to the end on each request.
  const entries = new Map<string, Entry>()
  let hitCount = 0
  let nextId = 0
  let timer: ReturnType<typeof setInterval> | undefined

  function trim(entry: Entry, now: number): void {
    const cutoff = now - entry.windowMs
    let stale = 0
    while (stale < entry.hits.length && entry.hits[stale]! <= cutoff)
      stale++
    if (stale > 0) {
      entry.hits.splice(0, stale)
      hitCount -= stale
    }
  }

  function sweep(now = Date.now()): number {
    let removed = 0
    for (const [key, entry] of entries) {
      trim(entry, now)
      if (entry.hits.length === 0) {
        entries.delete(key)
        removed++
      }
    }
    return removed
  }

  function evict(): void {
    while (entries.size > maxKeys || hitCount > maxHits) {
      const [key, entry] = entries.entries().next().value!
      entries.delete(key)
      hitCount -= entry.hits.length
    }
  }

  return {
    limiter(limit) {
      const { max, windowMs } = limit
      const prefix = `${nextId++}\0`
      if (timer === undefined) {
        timer = setInterval(sweep, SWEEP_MS)
        timer.unref()
      }
      return {
        hit(key) {
          const now = Date.now()
          const id = prefix + key
          const entry = entries.get(id) ?? { hits: [], windowMs }
          trim(entry, now)
          entries.delete(id)
          entries.set(id, entry)
          if (entry.hits.length >= max)
            return Math.max(1, Math.ceil((entry.hits[entry.hits.length - max]! + windowMs - now) / 1000))
          entry.hits.push(now)
          hitCount++
          evict()
          return 0
        },
      }
    },
    sweep,
    get size() {
      return entries.size
    },
    close() {
      clearInterval(timer)
      timer = undefined
    },
  }
}

/** The 429 a limited route or action answers a client calling from script. */
export function tooManyRequests(retryAfter: number): Response {
  return Response.json({ ok: false, status: 429, error: 'Too many requests' }, { status: 429, headers: { 'retry-after': String(retryAfter) } })
}

/** Counts `ctx` against `limiter` by the limit's key, else the client address; returns 0 or the seconds to wait. */
export function hitFor<Ctx extends { ip?: string | undefined }>(limiter: RateLimiter, limit: RateLimit<Ctx>, ctx: Ctx): number {
  return limiter.hit(limit.key?.(ctx) ?? ctx.ip ?? '')
}
