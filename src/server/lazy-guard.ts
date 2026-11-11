import type { Guard } from '../runtime/core'

// A guard built when the first request reaches it, so kay.config.ts imports nothing of the app's auth or database: `{ load: async () => (await import('./src/auth')).auth.guard({ require: 'admin' }) }`.
export interface LazyGuard {
  load: () => Guard | Promise<Guard>
}

// What a `guard` option takes: one guard, a list run in order, or a lazy one.
export type GuardOption = Guard | Guard[] | LazyGuard

// Whether a value is a `GuardOption`: a guard, a `{ load }`, or a list holding at least one of them.
export function isGuardOption(value: unknown): value is GuardOption {
  const one = (guard: unknown): boolean => typeof guard === 'function' || (typeof guard === 'object' && guard !== null && typeof (guard as { load?: unknown }).load === 'function')

  return Array.isArray(value) ? value.length > 0 && value.every(one) : one(value)
}

// The guards a `GuardOption` names, each loading on its first call.
export function guardList(option: GuardOption): Guard[] {
  return (Array.isArray(option) ? option : [option]).map(lazily)
}

// One guard for an option that holds one: a list runs in order, the first to throw stops the request, and an object a guard returns is laid over those before it.
export function joinGuards(option: GuardOption): Guard {
  const guards = guardList(option)

  if (!Array.isArray(option))
    return guards[0]!

  return async (ctx) => {
    let value: object | undefined

    for (const guard of guards) {
      const given = await guard(ctx)

      if (typeof given === 'object' && given !== null && !Array.isArray(given) && Object.getPrototypeOf(given) === Object.prototype)
        value = { ...value, ...given }
    }

    return value
  }
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
