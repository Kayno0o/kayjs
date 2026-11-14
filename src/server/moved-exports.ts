import type { RateLimit as RateLimitIn, RateLimitRefusal as RateLimitRefusalIn } from '../runtime/action'
import { sqliteCache as sqliteCacheIn } from '../runtime/cache.server'
import { s as sIn } from '../runtime/schema'

// Names `kay/server` exported before each had one home, kept for three minors; `deprecated-import-path` rewrites an import of them.

/** @deprecated Import `RateLimit` from `kay`, its one home. Removed in 1.108.0; `deprecated-import-path` rewrites it. */
export type RateLimit = RateLimitIn

/** @deprecated Import `RateLimitRefusal` from `kay`, its one home. Removed in 1.108.0; `deprecated-import-path` rewrites it. */
export type RateLimitRefusal = RateLimitRefusalIn

/** @deprecated Import `sqliteCache` from `kay/cache`, its one home. Removed in 1.108.0; `deprecated-import-path` rewrites it. */
export const sqliteCache: typeof sqliteCacheIn = sqliteCacheIn

/** @deprecated Import `s` from `kay`, its one home. Removed in 1.108.0; `deprecated-import-path` rewrites it. */
export const s: typeof sIn = sIn
