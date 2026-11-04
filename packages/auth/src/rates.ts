import type { RateStore, RateWindow } from 'kay'
import type { Limiter } from 'kay/library'
import type { Limit } from './limits'
import type { AuthStore } from './store'
import { limiter } from 'kay/library'

const SWEEP_EVERY = 1000

// Where kayjs-auth counts attempts: kay's `RateStore`. Its `peek` and `reset` are optional, as kay derives them for a store without.
export type AuthRates = RateStore

// Answered at once, as memory needs no promise; `sweep` drops the windows ended by `now`.
export interface MemoryAuthRates {
  hit: (key: string, windowMs: number, weight?: number) => RateWindow
  peek: (key: string) => RateWindow | undefined
  reset: (key: string) => void
  sweep: (now: number) => void
}

// Windows in this process's memory, swept every so many hits so memory follows the clients that keep trying. Unlike kay's `memoryRates` it drops no open window when many are open, so a flood of keys cannot evict an account's lockout.
export function memoryAuthRates(): MemoryAuthRates {
  const windows = new Map<string, RateWindow>()
  let hits = 0

  const sweep = (now: number) => {
    for (const [key, window] of windows) {
      if (window.resetAt <= now)
        windows.delete(key)
    }
  }

  return {
    peek(key) {
      const window = windows.get(key)

      return window && window.resetAt > Date.now() ? { ...window } : undefined
    },
    hit(key, length, weight = 1) {
      const now = Date.now()
      const open = windows.get(key)
      const window = open && open.resetAt > now ? { ...open, count: open.count + weight } : { count: weight, resetAt: now + length }

      if (++hits % SWEEP_EVERY === 0)
        sweep(now)

      windows.set(key, window)

      return { ...window }
    },
    reset(key) {
      windows.delete(key)
    },
    sweep,
  }
}

// The limiter of a limit, counted in the store's own `rates`, else the app's `store.rates` from kay.config.ts, else this process's memory, its keys apart from kay's own limits and other libraries'.
// The app's store is read on each count, as kay sets it up after `createAuth` may have run. A store that fails or hangs counts in memory meanwhile, as kay's own limits do.
export type AuthLimiters = (limit: Limit) => Limiter

export function authLimiters(store: AuthStore): AuthLimiters {
  const made = new Map<string, Limiter>()
  const memory = memoryAuthRates()

  return ({ max, window }) => {
    const id = `${max} ${window}`
    let found = made.get(id)

    if (!found)
      made.set(id, found = limiter({ max, window, store: store.rates, name: 'kayjs-auth', memory }))

    return found
  }
}
