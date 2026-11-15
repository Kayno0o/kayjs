import type { RateWindow } from '../runtime/action'

// The most windows a memory store keeps: past it, a new client makes room by dropping the expired windows, then the oldest ones.
const MAX_WINDOWS = 10_000

// Expired windows sit first, so dropping them, then the oldest live ones when still full, costs each new window what it removes.
export function makeRoom(windows: Map<string, RateWindow>, now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt > now && windows.size < MAX_WINDOWS)
      return

    windows.delete(key)
  }
}
