import type { Guard, GuardContext } from '../runtime'
import type { GuardFile, LayoutAccess, Route, SpecialPages } from './routes'
import { KayError } from '../compiler/errors'
import { importModule } from './bundle'

export interface LoadedGuard extends GuardFile {
  check: Guard
}

// A route with its guards imported once at boot, so a request only calls them.
export interface ServedRoute extends Omit<Route, 'guards' | 'layoutAccess'> {
  guards: LoadedGuard[]
  // Each layout's `layoutAccess`, its guards loaded.
  layoutGuards?: LayoutAccess<LoadedGuard>[] | undefined
}

export interface Refusal {
  guard: LoadedGuard
  // The redirect or denial the guard threw, or the error it failed with.
  error: unknown
}

export async function loadGuards(route: Route, required = false): Promise<ServedRoute> {
  const layoutGuards = await Promise.all((route.layoutAccess ?? []).map(async access => ({ ...access, guards: await Promise.all(access.guards.map(loadGuard)) })))

  return { ...route, layoutGuards, guards: requiredGuards(await Promise.all(route.guards.map(loadGuard)), route, route.special, required) }
}

// What a site with `requireGuards` answers on a route of its own that no guard covers and that did not set `guards: false`.
export const unguarded: Guard = ({ deny }) => deny(403, 'No guard covers this route')

export function requiredGuards(guards: LoadedGuard[], route: { file: string, open?: true | undefined }, special: SpecialPages, required: boolean | undefined): LoadedGuard[] {
  return required === true && guards.length === 0 && route.open !== true ? [{ file: route.file, special, check: unguarded }] : guards
}

export async function loadGuard(guard: GuardFile): Promise<LoadedGuard> {
  const check = (await importModule<{ default?: unknown }>(guard.file)).default

  if (typeof check !== 'function')
    throw new KayError('route-invalid', `kay: ${guard.file} must export a guard by default: export default guard(ctx => ...)`)

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
