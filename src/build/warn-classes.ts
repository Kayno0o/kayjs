import type { ClientBuild } from '../server/client'
import type { Route } from '../server/routes'
import { routeChain, styleChains } from '../server/routes'
import { warnUnresolved } from './client'

// Tells of the classes a server sets from a value the build cannot read, for the pages rendered per request: a prerendered page was rendered, so its head carries the rules of the classes it shows, and a static export renders nothing per request. A route with params stays told of: kay cannot tell that every value a request may carry was listed.
export function warnServerClasses(root: string, client: ClientBuild, routes: Route[], exported = false): void {
  const found = client.unresolved ?? []

  if (found.length === 0 || exported)
    return

  const prerendered = new Set([...client.pages.values()].map(page => page.pattern))
  const settled = new Set(routes.filter(route => route.params.length === 0 && prerendered.has(route.pattern)).map(route => routeChain(route).files.join('\n')))
  const live = styleChains(routes).filter(files => !settled.has(files.join('\n')))

  warnUnresolved(root, found.filter(unresolved => live.some(files => files.some(file => unresolved.by.includes(file)))), new Set())
}
