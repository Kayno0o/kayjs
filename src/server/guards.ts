import type { Guard, GuardContext } from '../runtime'
import type { GuardRequirement } from './guard-requirement'
import type { GuardFile, LayoutAccess, Route, SpecialPages } from './routes'
import { KayError } from '../compiler/errors'
import { importModule } from './bundle'
import { guardList, isGuardOption } from './lazy-guard'
import { guardValues, handOn, startGuardValues } from './request-scope'

export type { GuardOption, OwnGuardValues } from './lazy-guard'

// Where `api({ guards })` keeps the module's own guards on its instance, as it keeps its `cors` and `rateLimit`.
const API_GUARDS = Symbol('kay.api.guards')

export function keepOwnGuards(instance: object, option: unknown): void {
  if (typeof option !== 'boolean' && option !== undefined)
    Object.defineProperty(instance, API_GUARDS, { value: option })
}

// The files whose scan found `guards` of their own in the source, which is where a route's guards are decided.
const declared = new Set<string>()

// A module holding guards the scan did not find would serve its route with none of them, such as a settings object that is no literal in the file, so it stops the request instead.
export function refuseUndeclared(file: string, option: unknown, found: boolean): void {
  if (option !== undefined && typeof option !== 'boolean' && !found)
    throw new KayError('route-invalid', `kay: the guards in ${file} are not written where kay reads them, so none would run: set \`guards\` in the object literal of \`export const page = { ... }\` or of \`api({ ... })\` in the file itself; a special page (_404, _error, _loading) takes none`)
}

// A page module as the server imports it, refused when it holds guards the scan never saw.
export async function importChecked<Module>(file: string): Promise<Module> {
  const module = await importModule<Module>(file)

  refuseUndeclared(file, (module as { page?: { guards?: unknown } }).page?.guards, declared.has(file))

  return module
}

// The guards an API module runs: those of its directories, then the `api({ guards })` the instance keeps.
export async function loadApiGuards(module: { file: string, guards: { file: string, own?: true | undefined }[] }, instance: object): Promise<LoadedGuard[]> {
  const option = (instance as { [API_GUARDS]?: unknown })[API_GUARDS]

  refuseUndeclared(module.file, option, module.guards.some(guard => guard.own === true))

  return Promise.all(module.guards.map(async ({ file, own }) => own === true ? ownGuard({ file, special: {}, own }, () => option) : loadGuard({ file, special: {} })))
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
  if (guard.own === true) {
    declared.add(guard.file)

    return ownGuard(guard, async () => (await importModule<{ page?: { guards?: unknown } }>(guard.file)).page?.guards)
  }

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

// The `guards` a module lists itself, `export const page = { guards }` or `api({ guards })`, run after the files above it, each reading what the ones before it returned in `ctx.guard`. A page's module is imported when the first request asks, and the list is built once per value it holds.
function ownGuard(guard: GuardFile, read: () => unknown): LoadedGuard {
  let given: unknown
  let list: Guard[] = []

  return {
    ...guard,
    async check(ctx) {
      const option = await read()

      if (option !== given) {
        if (!isGuardOption(option))
          throw new KayError('route-invalid', `kay: the guards in ${guard.file} take a guard, a non-empty list of guards or { load } returning one; \`false\` skips the guards above and is read from the source as a literal`)

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
