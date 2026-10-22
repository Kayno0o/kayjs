import { isContextDefinition, setContextLoader, setTemplateContext } from '../runtime/template-context'
import { importModule } from './bundle'
import { RequestReadError } from './request-read'
import { readPersonally, scopeRequest } from './scope'

interface Provider {
  modules: readonly string[]
  prerendering: boolean
  // The keys the page reads, every key when none.
  keys: ReadonlySet<string> | undefined
}

// What a request has loaded so far: the values, the keyed loaders that ran and the contexts loading every key at once.
interface Loaded {
  values: Record<string, unknown>
  keys: Set<string>
  wholes: Set<number>
}

// The extensions' context modules each request renders with, and what they loaded for it.
const providers = new WeakMap<Request, Provider>()
const loaded = new WeakMap<Request, Loaded>()
const pending = new WeakMap<Request, Promise<boolean>>()
// The provider a request has everything loaded for, so a second layout asking costs nothing.
const satisfied = new WeakMap<Request, Provider>()

// Called where a render starts, so a layout can load the values of the request being rendered. `keys` are the ones the page reads, every key when not given.
export function useContexts(request: Request, modules: readonly string[], prerendering: boolean, keys?: readonly string[]): void {
  providers.set(request, { modules, prerendering, keys: keys === undefined ? undefined : new Set(keys) })
}

// A page rendered in place of another, an error page, reads keys the first did not, so every key loads, as its layouts reuse what the failed page's loaded.
export async function loadEveryContextKey(request: Request): Promise<void> {
  const provider = providers.get(request)

  if (provider !== undefined) {
    providers.set(request, { ...provider, keys: undefined })
    await loadContextValues(request)
  }
}

// Templates read the values the request being rendered loaded, none when no layout of its page did. They hold no prototype, so `ctx.constructor` is no member of Object.
setTemplateContext(() => {
  const request = scopeRequest()

  return request === undefined ? undefined : loaded.get(request)?.values
})

async function definitionOf(file: string) {
  const { default: definition } = await importModule<{ default?: unknown }>(file)

  if (!isContextDefinition(definition))
    throw new TypeError(`kay: ${file} is an extension's \`context\`, so it default-exports \`defineContext(load)\` from \`kay/library\``)

  return definition
}

// Loads what the page reads of every extension's context once for the request, and marks the page as the visitor's own. A load that fails stops the page and is tried again by the next layout asking, such as an error page's.
export async function loadContextValues(request: Request): Promise<void> {
  const provider = providers.get(request)

  if (provider === undefined || satisfied.get(request) === provider)
    return

  if (provider.prerendering)
    throw new RequestReadError('ctx values')

  readPersonally(request)

  // Another layout may ask for keys the one loading now does not, so it goes round until a pass has nothing left to load.
  for (let ran = true; ran;) {
    const joined = pending.get(request)
    const running = joined ?? loadMissing(request, provider)

    pending.set(request, running)

    try {
      const loadedNow = await running

      // A pass another caller started may have asked for fewer keys, so only a pass of this caller's own finding nothing ends the loop.
      ran = joined === undefined ? loadedNow : true
    }
    finally {
      if (pending.get(request) === running)
        pending.delete(request)
    }
  }

  satisfied.set(request, provider)
}

async function loadMissing(request: Request, provider: Provider): Promise<boolean> {
  const state = loaded.get(request) ?? { values: Object.create(null) as Record<string, unknown>, keys: new Set<string>(), wholes: new Set<number>() }
  const definitions = await Promise.all(provider.modules.map(definitionOf))
  const jobs: { module: string, key?: string, whole?: number, run: () => unknown }[] = []

  for (const [index, definition] of definitions.entries()) {
    const module = provider.modules[index]!

    if (definition.load !== undefined) {
      if (!state.wholes.has(index))
        jobs.push({ module, whole: index, run: async () => definition.load!(request) })

      continue
    }

    for (const key of Object.keys(definition.loaders ?? {})) {
      if (provider.keys?.has(key) !== false && !state.keys.has(key))
        jobs.push({ module, key, run: () => definition.loaders![key]!(request) })
    }
  }

  if (jobs.length === 0) {
    loaded.set(request, state)

    return false
  }

  // Every loader settles, so one failing keeps the others' values: the retry by the next layout runs only what failed.
  const results = await Promise.allSettled(jobs.map(async job => await job.run()))
  let failure: { reason: unknown } | undefined
  const fresh: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const owners = new Map<string, string>()
  const give = (key: string, value: unknown, module: string) => {
    if (key in state.values || owners.has(key))
      throw new Error(`kay: two extensions give ctx.${key}, the latter ${module}`)

    owners.set(key, module)
    Object.defineProperty(fresh, key, { value, enumerable: true, configurable: true, writable: true })
  }

  for (const [index, job] of jobs.entries()) {
    const settled = results[index]!

    if (settled.status === 'rejected') {
      failure ??= { reason: settled.reason }

      continue
    }

    const result: unknown = settled.value

    if (job.key !== undefined) {
      give(job.key, result, job.module)

      continue
    }

    if (typeof result !== 'object' || result === null)
      throw new TypeError(`kay: the context ${job.module} answered ${typeof result}, an object of the request values is what \`defineContext\` loads`)

    for (const key of Object.keys(result))
      give(key, (result as Record<string, unknown>)[key], job.module)
  }

  for (const [index, job] of jobs.entries()) {
    if (results[index]!.status === 'rejected')
      continue

    if (job.key !== undefined)
      state.keys.add(job.key)
    else
      state.wholes.add(job.whole!)
  }

  Object.defineProperties(state.values, Object.getOwnPropertyDescriptors(fresh))

  // A render that loaded nothing reads an error, not an empty object.
  if (state.keys.size + state.wholes.size > 0)
    loaded.set(request, state)

  if (failure !== undefined)
    throw failure.reason

  return true
}

setContextLoader(loadContextValues)
