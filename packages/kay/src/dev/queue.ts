// kay dev's serialized rebuild queue: saves within 40 ms coalesce, and a save during a build runs one more build after it.

import type { ChangeKind } from './watchers'

export interface PendingBuild {
  /** Every change was a stylesheet: the browser swaps its `<link>`s. */
  cssOnly: boolean
  /** Every change was an existing `public/` file: the app is re-created from the current build. */
  publicOnly: boolean
  /** `kay.config.ts` changed: the build cache and the config start over. */
  resetCache: boolean
  /** A file no bundle holds changed: every server module is imported again. */
  reloadAll: boolean
}

const nothingYet = (): PendingBuild => ({ cssOnly: true, publicOnly: true, resetCache: false, reloadAll: false })

export function createRebuildQueue(run: (build: PendingBuild) => Promise<void>) {
  let next = nothingYet()
  let building = false
  let pending = false
  let stopped = false
  let inFlight: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function drain(): Promise<void> {
    clearTimeout(timer)
    if (building) {
      pending = true
      return inFlight ?? Promise.resolve()
    }
    building = true
    inFlight = (async () => {
      try {
        do {
          clearTimeout(timer)
          const build = next
          next = nothingYet()
          pending = false
          await run(build)
        } while (pending && !stopped)
      }
      finally {
        building = false
        inFlight = undefined
      }
    })()
    return inFlight
  }

  return {
    schedule(kind: ChangeKind): void {
      if (stopped)
        return
      if (kind === 'config')
        next.resetCache = true
      if (kind === 'config' || kind === 'full')
        next.reloadAll = true
      if (kind !== 'css')
        next.cssOnly = false
      if (kind !== 'public')
        next.publicOnly = false
      clearTimeout(timer)
      timer = setTimeout(() => void drain(), 40)
    },
    /** A full build now, or right after the one running. */
    now(): Promise<void> {
      next.cssOnly = false
      next.publicOnly = false
      return drain()
    },
    /** Drops what is scheduled and resolves once the running build is done. */
    stop(): Promise<void> {
      stopped = true
      clearTimeout(timer)
      return inFlight ?? Promise.resolve()
    },
  }
}
