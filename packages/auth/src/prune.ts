import type { SessionSettings } from 'kay/server'
import type { Core } from './core'
import { log } from './log'

// What expired is deleted at most this often.
export const PRUNE_EVERY_MS = 60 * 60 * 1000
const BEARER_EXPIRED_KEPT_MS = 30 * 24 * 60 * 60 * 1000

// Starts the store's pruning when it is due, without making the request wait for it; `core.pruned.running` is the run while it lasts. A failure is logged, and the next try is an hour away.
export function pruneWhenDue(core: Core, settings: SessionSettings): void {
  const now = Date.now()

  if (!core.store.prune || now - core.pruned.at < PRUNE_EVERY_MS)
    return

  core.pruned.at = now
  core.pruned.running = prune(core, settings, now)
}

async function prune(core: Core, settings: SessionSettings, now: number): Promise<void> {
  try {
    await core.store.prune?.({ now: new Date(now), bearerExpiredBefore: new Date(now - BEARER_EXPIRED_KEPT_MS), sessionMaxAge: Math.max(settings.maxAge, core.rememberMaxAge, settings.browserMaxAge), sessionAbsoluteMaxAge: settings.absoluteMaxAge })
  }
  catch (error) {
    log.error('pruning what expired failed', error)
  }
}
