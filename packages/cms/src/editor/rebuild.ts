import { signal } from 'kay'
import { browserStorage } from './dock'

// A save to a forge shows on the live site only once it has rebuilt, which the editor cannot see end: it remembers when the last such save went through, so the notice outlives leaving edit mode and reloading the page.
const KEY = 'kcms:rebuilding'

// How long after a save the editor keeps telling the site may still show the old content.
export const REBUILD_WINDOW = 5 * 60 * 1000

export function markRebuilding(storage: Pick<Storage, 'setItem'> | undefined, now = Date.now()): void {
  try {
    storage?.setItem(KEY, String(now))
  }
  catch {}
}

// How many milliseconds the notice still holds for, 0 once the window passed or no save waits.
export function rebuildingFor(storage: Pick<Storage, 'getItem'> | undefined, now = Date.now()): number {
  try {
    const at = Number(storage?.getItem(KEY))

    return Number.isFinite(at) && at > 0 ? Math.max(0, at + REBUILD_WINDOW - now) : 0
  }
  catch {
    return 0
  }
}

const waiting = signal(false)
let expiry: ReturnType<typeof setTimeout> | undefined

// Whether a save the site shows only once it has rebuilt went through lately, read again from the browser's storage by `watchRebuild`.
export const rebuilding = () => waiting()

export function watchRebuild(): void {
  const left = rebuildingFor(browserStorage())

  clearTimeout(expiry)
  waiting.set(left > 0)

  if (left > 0)
    expiry = setTimeout(() => waiting.set(false), left)
}

export function rebuildStarted(): void {
  markRebuilding(browserStorage())
  watchRebuild()
}

// The site serves the last save: the notice goes, here and in the other tabs once they read the storage again.
export function rebuildFinished(): void {
  try {
    browserStorage()?.removeItem(KEY)
  }
  catch {}

  watchRebuild()
}
