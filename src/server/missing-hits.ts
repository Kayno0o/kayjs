import type { Suggestion } from './not-found'

// Past this many distinct paths, the least hit and oldest is forgotten for a new one, so a flood of made-up paths never grows the log nor pushes out a path real visitors keep coming to.
export const MAX_PATHS = 1000
export const MAX_REFERRERS = 8
export const HOUR_MS = 3_600_000
// Hits wait this long in memory, then reach the log in one transaction, so a flood of missing paths costs the event loop one write, not four per request.
export const FLUSH_MS = 1000
// The most distinct paths held back, past which the next one writes them all at once.
export const MAX_PENDING = 256
// A path nobody asked for in this long is dropped with its referrers, as a made-up path can hold a name or an address.
export const MAX_AGE_MS = 90 * 24 * HOUR_MS

// What a store holds back of a path: its hits since the last write, when they came, and the hosts they came from.
export interface Pending {
  hits: number
  firstAt: number
  lastAt: number
  referrers: Map<string, number>
  suggest: (path: string) => Suggestion | undefined
}

// Counts one hit of a path in what a store holds back.
export function holdHit(pending: Map<string, Pending>, path: string, referrer: string | undefined, suggest: Pending['suggest']): void {
  const now = Date.now()
  const held = pending.get(path)

  if (held) {
    held.hits += 1
    held.lastAt = now
    held.suggest = suggest
  }
  else {
    pending.set(path, { hits: 1, firstAt: now, lastAt: now, referrers: new Map(), suggest })
  }

  const hosts = pending.get(path)!.referrers

  if (referrer !== undefined && (hosts.has(referrer) || hosts.size < MAX_REFERRERS))
    hosts.set(referrer, (hosts.get(referrer) ?? 0) + 1)
}
