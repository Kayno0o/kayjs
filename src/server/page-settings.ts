import type { Collection } from '../content'
import type { PageSettings } from '../runtime'
import { isRouteOf } from '../content/claims'
import { registeredCollections } from '../content/edit-registry'

// A setting of a page module: its key of `export const page`.
export function pageSetting(module: object, name: keyof PageSettings): unknown {
  return (module as { page?: PageSettings }).page?.[name]
}

// A setting along a route's modules, layouts outermost first and the page last: the innermost that sets it wins, so a page may undo what its layouts say.
export function chainSetting(modules: object[], name: keyof PageSettings): unknown {
  for (let index = modules.length - 1; index >= 0; index--) {
    const value = pageSetting(modules[index]!, name)

    if (value !== undefined)
      return value
  }

  return undefined
}

interface PageRoute {
  pattern: string
  params: readonly string[]
}

// The collections whose `route` is this page's pattern, in the content config's order: the page of one param is where their entries are shown.
export function routedCollections(route: PageRoute): Collection<unknown>[] {
  if (route.params.length !== 1 || route.pattern.includes('?'))
    return []

  return registeredCollections().flatMap(([, collection]) => collection.options.route !== undefined && collection.options.single !== true && isRouteOf(collection.options.route, route.pattern) ? [collection] : [])
}

// A page's `prerender`: what it sets, else the collection whose `route` is the page's pattern, so a page needs no export to list its entries.
export function pagePrerender(module: object, route: PageRoute): unknown {
  return pageSetting(module, 'prerender') ?? routedCollections(route)[0]
}
