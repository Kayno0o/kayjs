import type { Duration, RateStore, RateWindow } from 'kay'
import type { AuthStore, MaybePromise } from './store'
import { appStore, durationSeconds } from 'kay/library'
import { log } from './log'

const SWEEP_EVERY = 1000
// Keys in the app's shared `store.rates` sit apart from kay's own limits and other libraries'.
const SHARED_PREFIX = 'kayjs-auth\n'

// Where kayjs-auth counts attempts: kay's `RateStore`, reading a count without adding to it (`peek`) and clearing one once the attempt it guards succeeds (`reset`).
export type AuthRates = RateStore & Required<Pick<RateStore, 'peek' | 'reset'>>

// The counter of a store before 1.81, which answered a hit with the count alone.
export interface LegacyAttempts {
  count: (key: string) => MaybePromise<number>
  hit: (key: string, window: Duration) => MaybePromise<number>
  reset: (key: string) => MaybePromise<void>
}

// Answered at once, as memory needs no promise; `sweep` drops the windows ended by `now`.
export interface MemoryAuthRates {
  hit: (key: string, window: Duration, weight?: number) => RateWindow
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
      const window = open && open.resetAt > now ? { ...open, count: open.count + weight } : { count: weight, resetAt: now + durationSeconds(length, 'an attempts window') * 1000 }

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

// A pre-1.81 `attempts` counter read as a `RateStore`; kayjs-auth reads no window's end, so none is given.
function legacyRates(attempts: LegacyAttempts): AuthRates {
  return {
    hit: async (key, window) => ({ count: await attempts.hit(key, window), resetAt: Number.NaN }),
    async peek(key) {
      const count = await attempts.count(key)

      return count > 0 ? { count, resetAt: Number.NaN } : undefined
    },
    reset: async key => attempts.reset(key),
  }
}

function counts(store: RateStore): store is AuthRates {
  return typeof store.peek === 'function' && typeof store.reset === 'function'
}

// The store's pre-1.81 `attempts`, else its own `rates`, else the app's `store.rates` from kay.config.ts when it can peek and reset, else this auth's memory.
// `attempts` comes first: the built-in stores give `rates` and no `attempts`, so a store holding both spread one and gave the counter shared by its processes.
// The app's store is read on each count, as kay sets it up after `createAuth` may have run.
export function authRates(store: AuthStore): AuthRates {
  const own = store.attempts ? legacyRates(store.attempts) : store.rates

  if (own)
    return own

  let memory: AuthRates | undefined
  let warned: RateStore | undefined

  const target = (): { rates: AuthRates, prefix: string } => {
    const shared = appStore()?.rates

    if (shared && counts(shared))
      return { rates: shared, prefix: SHARED_PREFIX }

    if (shared && warned !== shared) {
      warned = shared
      log.warn('the app\'s store.rates has no peek or reset, which kayjs-auth needs to read and clear a count, so it counts attempts in this process\'s memory: give the store both, or the auth store `rates`')
    }

    return { rates: memory ??= memoryAuthRates(), prefix: '' }
  }

  return {
    hit: async (key, window, weight) => {
      const { rates, prefix } = target()

      return rates.hit(prefix + key, window, weight)
    },
    peek: async (key) => {
      const { rates, prefix } = target()

      return rates.peek(prefix + key)
    },
    reset: async (key) => {
      const { rates, prefix } = target()

      await rates.reset(prefix + key)
    },
  }
}
