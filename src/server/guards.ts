import type { Guard, GuardContext } from '../runtime'
import type { GuardRequirement } from './guard-requirement'
import type { GuardFile, LayoutAccess, Route, SpecialPages } from './routes'
import { KayError } from '../compiler/errors'
import { importModule } from './bundle'
import { guardList, isGuardOption } from './lazy-guard'
import { guardValues, handOn, startGuardValues } from './request-scope'

export type { GuardOption } from './lazy-guard'

// Where `api({ guards })` keeps the module's own guards on its instance, as it keeps its `cors` and `rateLimit`.
const API_GUARDS = Symbol('kay.api.guards')

export function keepOwnGuards(instance: object, option: unknown): void {
  if (typeof option !== 'boolean' && option !== undefined)
    Object.defineProperty(instance, API_GUARDS, { value: option })
}

export interface LoadedGuard extends GuardFile {
  check: Guard
}

// A route with its guards imported once at boot, so a request only calls them.
export interface ServedRoute extends Omit<Route, 'guards' | 'layoutAccess' | 'actionAccess'> {
  guards: LoadedGuard[]
  // Each layout's `layoutAccess`, its guards loaded.
  layoutGuards?: LayoutAccess<LoadedGuard>[] | undefined
  // Each action module's `actionAccess`, its guards loaded.
  actionGuards?: LayoutAccess<LoadedGuard>[] | undefined
}

export interface Refusal {
  guard: LoadedGuard
  // The redirect or denial the guard threw, or the error it failed with.
  error: unknown
}

export async function loadGuards(route: Route, required: GuardRequirement = false): Promise<ServedRoute> {
  const layoutGuards = await Promise.all((route.layoutAccess ?? []).map(async access => ({ ...access, guards: await Promise.all(access.guards.map(loadGuard)) })))

  const actionGuards = route.actionAccess && await Promise.all(route.actionAccess.map(async access => ({ ...access, guards: await Promise.all(access.guards.map(loadGuard)) })))

  return { ...route, layoutGuards, ...actionGuards && { actionGuards }, guards: requiredGuards(await Promise.all(route.guards.map(loadGuard)), route, route.special, required) }
}

// What a site requiring guards answers on a route of its own that no guard covers and that did not set `guards: false`.
export const unguarded: Guard = ({ deny }) => deny(403, 'No guard covers this route')

export function requiredGuards(guards: LoadedGuard[], route: { file: string, open?: true | undefined }, special: SpecialPages, required: GuardRequirement | undefined): LoadedGuard[] {
  return (required === true || required === 'routes') && guards.length === 0 && route.open !== true ? [{ file: route.file, special, check: unguarded }] : guards
}

export async function loadGuard(guard: GuardFile): Promise<LoadedGuard> {
  if (guard.own === true)
    return ownGuard(guard)

  const check = (await importModule<{ default?: unknown }>(guard.file)).default

  if (typeof check !== 'function')
    throw new KayError('route-invalid', `kay: ${guard.file} must export a guard by default: export default guard(ctx => ...)`)

  return { ...guard, check: check as Guard }
}

// Outermost first, each one awaited before the next; the first that stops the request is the answer.
// An object a guard returns is laid over what the ones before it returned, which `ctx.guard` gives the next guard, the layouts, the page and the actions.
export async function runGuards(guards: LoadedGuard[], ctx: GuardContext): Promise<Refusal | undefined> {
  const values = guards.length > 0 ? startGuardValues(ctx.request) : {}

  for (const guard of guards) {
    try {
      handOn(values, await guard.check(ctx))
    }
    catch (error) {
      return { guard, error }
    }
  }

  return undefined
}

// The `guards` a module lists itself, `export const page = { guards }` or `api({ guards })`, run after the files above it, each reading what the ones before it returned in `ctx.guard`. The module is imported when the first request asks, as its page is, and the list is built once per value it holds.
function ownGuard(guard: GuardFile): LoadedGuard {
  let given: unknown
  let list: Guard[] = []

  return {
    ...guard,
    async check(ctx) {
      const module = await importModule<{ page?: { guards?: unknown }, default?: { [API_GUARDS]?: unknown } }>(guard.file)
      const option = module.page?.guards ?? module.default?.[API_GUARDS]

      if (option !== given) {
        if (!isGuardOption(option))
          throw new KayError('route-invalid', `kay: the guards in ${guard.file} take a guard, a list of guards or { load } returning one; \`false\` skips the guards above and is read from the source as a literal`)

        given = option
        list = guardList(option)
      }

      const values = guardValues(ctx.request)

      for (const check of list)
        handOn(values, await check(ctx))

      return undefined
    },
  }
}
