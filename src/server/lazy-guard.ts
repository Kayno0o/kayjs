import type { Guard } from '../runtime/core'

// A guard built when the first request reaches it, so kay.config.ts imports nothing of the app's auth or database: `{ load: async () => (await import('./src/auth')).auth.guard({ require: 'admin' }) }`.
export interface LazyGuard {
  load: () => Guard | Promise<Guard>
}

// A guard that loads on its first call, and tries again after a load that failed.
export function lazily(guard: Guard | LazyGuard): Guard {
  if (typeof guard === 'function')
    return guard

  const { load: build } = guard
  let loaded: Promise<Guard> | undefined

  async function load(): Promise<Guard> {
    // Forgetting a failure must come after `loaded` is set, even when the loader throws at once.
    await Promise.resolve()

    try {
      return await build()
    }
    catch (error) {
      loaded = undefined

      throw error
    }
  }

  return async (ctx) => {
    loaded ??= load()

    return (await loaded)(ctx)
  }
}
