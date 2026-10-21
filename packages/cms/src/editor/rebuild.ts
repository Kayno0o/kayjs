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
