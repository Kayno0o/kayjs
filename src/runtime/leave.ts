import type { LeaveGuard } from './navigation'
import { leaveGuards, navigation } from './navigation'
import { effect, onCleanup } from './reactive'

export interface LeaveGuardOptions {
  // Asked before the page is left for `to`, an app's own dialog resolving once answered; `window.confirm` by default.
  confirm?: ((to: URL) => boolean | Promise<boolean>) | undefined
}

// Only while one holds unsaved changes is the page listened for unloading: a `beforeunload` listener can keep it out of the back-forward cache.
const dirtyGuards = new Set<LeaveGuard>()

// Asks before the page is left while `dirty` holds, for as long as the island lives: a link of the app, `navigate()` and going back or forward ask the guard, a reload, closing the tab or another site's link get the browser's own prompt.
export function guardLeave(dirty: () => boolean, options: LeaveGuardOptions = {}): void {
  if (typeof document === 'undefined')
    return

  const guard: LeaveGuard = { dirty, confirm: options.confirm }

  leaveGuards.add(guard)
  effect(() => {
    if (dirty())
      dirtyGuards.add(guard)
    else
      dirtyGuards.delete(guard)

    listenUnload()
  })
  onCleanup(() => {
    leaveGuards.delete(guard)
    dirtyGuards.delete(guard)
    listenUnload()
  })
}

function listenUnload(): void {
  if (dirtyGuards.size > 0) {
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pageshow', onPageShow)
  }
  else {
    window.removeEventListener('beforeunload', onBeforeUnload)
  }
}

// A full load kay starts itself was asked about already, or is no leave: a form the swap hands back to the browser.
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!navigation.released)
    event.preventDefault()
}

// Back from the back-forward cache, the page is guarded again.
function onPageShow(): void {
  navigation.released = false
}
