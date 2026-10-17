import type { SessionSettings } from 'kay/server'
import type { Core } from './core'
import { erase } from './erase'
import { log } from './log'

// What expired is deleted at most this often.
export const PRUNE_EVERY_MS = 60 * 60 * 1000
const BEARER_EXPIRED_KEPT_MS = 30 * 24 * 60 * 60 * 1000
// Guests deleted by one run; a larger backlog goes on with the next.
const GUESTS_PER_RUN = 500

// Starts the store's pruning when it is due, without making the request wait for it; `core.pruned.running` is the run while it lasts. A failure is logged, and the next try is an hour away.
export function pruneWhenDue(core: Core, settings: SessionSettings): void {
  const now = Date.now()

  if ((!core.store.prune && !guestsPruned(core)) || now - core.pruned.at < PRUNE_EVERY_MS)
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

  await pruneGuests(core, now)
}

function guestsPruned(core: Core): boolean {
  return core.guestMaxAge !== undefined && core.store.users.staleGuests !== undefined
}

// Guests older than `guests.maxAge` whose sessions ended go as any deleted user does, `onDelete` first. One whose `onDelete` fails stays, to be tried again the next run.
async function pruneGuests(core: Core, now: number): Promise<void> {
  if (core.guestMaxAge === undefined || !core.store.users.staleGuests)
    return

  try {
    for (const guest of await core.store.users.staleGuests(new Date(now - core.guestMaxAge * 1000), GUESTS_PER_RUN)) {
      try {
        // A guest registered since the list was read is a real account.
        if ((await core.store.users.get(guest.id))?.guest === true)
          await erase({ core }, guest)
      }
      catch (error) {
        log.error('deleting a stale guest failed', error)
      }
    }
  }
  catch (error) {
    log.error('listing the stale guests failed', error)
  }
}
