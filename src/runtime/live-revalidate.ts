import type { Duration } from './duration'
import type { Revalidation } from './live'
import { durationSeconds } from './duration'
import { onCleanup } from './reactive'
import { watchTags } from './resource-tags'

const MAX_TIMER = 2_147_483_647

// What a resource asks its route again for by itself: the browser's events and an interval (`revalidate`), and the keys a call of the page invalidated (`tags`); `run` is told the stale window that applies, and whether to leave a request in flight (a tag) or not.
export function askingAgain(options: { revalidate?: Revalidation | readonly Revalidation[] | undefined, stale?: Duration | undefined, tags?: readonly string[] | undefined } | undefined, run: (staleMs: number, inFlight?: boolean) => void): void {
  if (options?.tags !== undefined && options.tags.length > 0)
    onCleanup(watchTags(options.tags, () => run(0, true)))

  if (options?.revalidate !== undefined)
    revalidating(options.revalidate, options.stale, run)
}

// Asks again each time the browser says so, until the owner is gone: the tab getting the focus back, the network returning, or an interval while the tab shows.
// `run` is told the stale window in ms that applies: the browser's events honour `stale`, an interval does not.
export function revalidating(when: Revalidation | readonly Revalidation[], stale: Duration | undefined, run: (staleMs: number) => void): void {
  const staleMs = stale === undefined ? 0 : durationSeconds(stale, 'the stale of resource()') * 1000

  for (const trigger of typeof when === 'string' ? [when] : when) {
    if (trigger === 'focus') {
      const focused = () => run(staleMs)
      const shown = () => {
        if (!document.hidden)
          run(staleMs)
      }

      window.addEventListener('focus', focused)
      document.addEventListener('visibilitychange', shown)
      onCleanup(() => {
        window.removeEventListener('focus', focused)
        document.removeEventListener('visibilitychange', shown)
      })
    }
    else if (trigger === 'reconnect') {
      const back = () => run(staleMs)

      window.addEventListener('online', back)
      onCleanup(() => window.removeEventListener('online', back))
    }
    else {
      const timer = setInterval(() => {
        if (!document.hidden)
          run(0)
      }, Math.min(durationSeconds(trigger, 'the revalidate of resource()') * 1000, MAX_TIMER))

      onCleanup(() => clearInterval(timer))
    }
  }
}
