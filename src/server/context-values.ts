import { isContextDefinition, setContextLoader, setTemplateContext } from '../runtime/template-context'
import { importModule } from './bundle'
import { RequestReadError } from './request-read'
import { readPersonally, scopeRequest } from './scope'

interface Provider {
  modules: readonly string[]
  prerendering: boolean
}

// The extensions' context modules each request renders with, and what they loaded for it.
const providers = new WeakMap<Request, Provider>()
const loaded = new WeakMap<Request, Record<string, unknown>>()
const pending = new WeakMap<Request, Promise<void>>()

// Called where a render starts, so a layout can load the values of the request being rendered.
export function useContexts(request: Request, modules: readonly string[], prerendering: boolean): void {
  providers.set(request, { modules, prerendering })
}

// Templates read the values the request being rendered loaded, none when no layout of its page did.
setTemplateContext(() => {
  const request = scopeRequest()

  return request === undefined ? undefined : loaded.get(request)
})

async function definitionOf(file: string) {
  const { default: definition } = await importModule<{ default?: unknown }>(file)

  if (!isContextDefinition(definition))
    throw new TypeError(`kay: ${file} is an extension's \`context\`, so it default-exports \`defineContext(load)\` from \`kay/library\``)

  return definition
}

// Loads the values of every extension's context once for the request, and marks the page as the visitor's own. A load that fails stops the page and is tried again by the next layout asking, such as an error page's.
export async function loadContextValues(request: Request): Promise<void> {
  const provider = providers.get(request)

  if (provider === undefined || loaded.has(request))
    return

  if (provider.prerendering)
    throw new RequestReadError('ctx values')

  const running = pending.get(request) ?? loadAll(request, provider.modules)

  pending.set(request, running)

  try {
    await running
  }
  finally {
    pending.delete(request)
  }
}

async function loadAll(request: Request, modules: readonly string[]): Promise<void> {
  readPersonally(request)

  const results = await Promise.all(modules.map(async file => (await definitionOf(file)).load(request)))
  const values: Record<string, unknown> = {}

  for (const [index, result] of results.entries()) {
    if (typeof result !== 'object' || result === null)
      throw new TypeError(`kay: the context ${modules[index]!} answered ${typeof result}, an object of the request values is what \`defineContext\` loads`)

    for (const key of Object.keys(result)) {
      if (Object.hasOwn(values, key))
        throw new Error(`kay: two extensions give ctx.${key}, the latter ${modules[index]!}`)
    }

    Object.defineProperties(values, Object.getOwnPropertyDescriptors(result))
  }

  loaded.set(request, values)
}

setContextLoader(loadContextValues)
