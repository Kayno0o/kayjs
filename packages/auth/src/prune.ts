import type { SessionSettings } from 'kay/server'
import type { Core } from './core'
import { eraseUser } from './erase'
import { log } from './log'

// What expired is deleted at most this often.
export const PRUNE_EVERY_MS = 60 * 60 * 1000
const BEARER_EXPIRED_KEPT_MS = 30 * 24 * 60 * 60 * 1000
// Accounts listed at once, and the most batches one run goes through; a larger backlog goes on with the next run.
const STALE_PER_BATCH = 500
const STALE_BATCHES_PER_RUN = 20

// Starts the store's pruning when it is due, without making the request wait for it; `core.pruned.running` is the run while it lasts. A failure is logged, and the next try is an hour away.
export function pruneWhenDue(core: Core, settings: SessionSettings): void {
  const now = Date.now()

  if ((!core.store.prune && !staleKept(core)) || now - core.pruned.at < PRUNE_EVERY_MS)
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

  await pruneStale(core, now, 'guest')
  await pruneStale(core, now, 'unverified')
}

function staleKept(core: Core): boolean {
  return core.store.users.staleGuests !== undefined || (core.unverifiedMaxAge !== undefined && core.store.users.staleUnverified !== undefined)
}

// Guests older than `guests.maxAge` whose sessions ended, and with `requireVerified` the accounts registered and never verified for `email.unverifiedMaxAge`, go as any deleted user does, `onDelete` first. One whose `onDelete` fails stays, to be tried again the next run, and the run goes on past it and past any that is kept.
async function pruneStale(core: Core, now: number, kind: 'guest' | 'unverified'): Promise<void> {
  const maxAge = kind === 'guest' ? core.guestMaxAge : core.unverifiedMaxAge
  const list = kind === 'guest' ? core.store.users.staleGuests : core.store.users.staleUnverified

  if (maxAge === undefined || !list)
    return

  // The listing is oldest first and cannot skip, so what a run keeps (a role beyond the default ones, a failed `onDelete`) is listed again each batch: the batch grows by that many and the kept ones are left out, to reach the accounts behind them.
  const kept = new Set<string>()

  try {
    for (let batch = 0; batch < STALE_BATCHES_PER_RUN; batch++) {
      const size = STALE_PER_BATCH + kept.size
      const listed = await list(new Date(now - maxAge * 1000), size)

      let deleted = 0
      let failed = 0

      for (const account of listed) {
        if (kept.has(account.id))
          continue

        try {
          if (await stillStale(core, account.id, kind)) {
            await eraseUser(core, account)
            deleted++

            continue
          }
        }
        catch (error) {
          log.error(`deleting a stale ${kind} failed`, error)
          failed++
        }

        kept.add(account.id)
      }

      // A short list is the end of them, and a batch whose erases all failed means a hook or store is down: the next run tries again.
      if (listed.length < size || (deleted === 0 && failed > 0))
        return
    }
  }
  catch (error) {
    log.error(`listing the stale ${kind}s failed`, error)
  }
}

// Read again just before the erase: a guest registered since the list was read is a real account, and an unverified one given a role beyond the default ones was set up on purpose, as registering again does not replace it.
async function stillStale(core: Core, id: string, kind: 'guest' | 'unverified'): Promise<boolean> {
  const current = await core.store.users.get(id)

  if (!current)
    return false

  if (kind === 'guest')
    return current.guest

  return !current.guest && current.emailVerifiedAt === null && current.roles.every(role => core.defaultRoles.includes(role))
}
