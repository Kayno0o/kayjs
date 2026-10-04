import type { Guard, GuardContext } from '../runtime'
import type { GuardFile, Route } from './routes'
import { importModule } from './bundle'

export interface LoadedGuard extends GuardFile {
  check: Guard
}

// A route with its guards imported once at boot, so a request only calls them.
export interface ServedRoute extends Omit<Route, 'guards'> {
  guards: LoadedGuard[]
}

export interface Refusal {
  guard: LoadedGuard
  // The redirect or denial the guard threw, or the error it failed with.
  error: unknown
}

export async function loadGuards(route: Route): Promise<ServedRoute> {
  return { ...route, guards: await Promise.all(route.guards.map(loadGuard)) }
}

export async function loadGuard(guard: GuardFile): Promise<LoadedGuard> {
  const check = (await importModule<{ default?: unknown }>(guard.file)).default

  if (typeof check !== 'function')
    throw new TypeError(`kay: ${guard.file} must export a guard by default: export default guard(ctx => ...)`)

  return { ...guard, check: check as Guard }
}

// Outermost first, each one awaited before the next; the first that stops the request is the answer.
export async function runGuards(guards: LoadedGuard[], ctx: GuardContext): Promise<Refusal | undefined> {
  for (const guard of guards) {
    try {
      await guard.check(ctx)
    }
    catch (error) {
      return { guard, error }
    }
  }

  return undefined
}
