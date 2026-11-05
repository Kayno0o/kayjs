import type { ListStore } from './list-store'
import { maintenance } from 'kay/library'
import { log } from './log'

// The first sweep of the stores waits for the app to boot; the next ones follow at this pace.
const FIRST_SWEEP_MS = 10_000
const SWEEP_EVERY_MS = 3_600_000

// Forgets what the lists keep past its time, in the stores `stores` gives: the unclicked confirmations and the old broadcasts. It runs once the app has booted and every hour, off any subscribe post.
export function listSweeper(stores: () => Iterable<ListStore | undefined>, timing: { after?: number | undefined, every?: number | undefined } = {}) {
  const sweep = async (now?: number): Promise<void> => {
    for (const store of new Set(stores())) {
      if (store === undefined || store.closed)
        continue

      try {
        await store.sweep(now)
      }
      catch (error) {
        log.warn(`a mailing list store could not be swept: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Started by the first `mail.list()`, which may run in a request the sweeps must not keep: the maintenance makes its timers outside any request.
  const upkeep = maintenance('mail-lists', timing.every ?? SWEEP_EVERY_MS, async () => sweep(), { first: timing.after ?? FIRST_SWEEP_MS })

  return {
    sweep,
    start: upkeep.start,
    // Ends the timers, which a `kay dev` reload does through the mailer's `onStop` so the app that follows starts its own and they do not stack.
    stop: upkeep.stop,
  }
}
