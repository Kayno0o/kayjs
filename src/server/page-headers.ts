import type { Context } from 'elysia'
import type { PageSecurity } from '../runtime'
import type { ServedRoute } from './guards'
import type { PageResponder } from './page-routes'
import type { SecurityOptions } from './security'
import { RELOAD_HEADER } from '../runtime/swap'
import { importModule } from './bundle'
import { pageSetting } from './page-settings'
import { routeChain } from './routes'
import { securityHeaders } from './security'

interface RouteHeaders {
  headers: Record<string, string>
  // The site's headers the route's settings change or leave out, which the request's context then drops.
  replaced: string[]
}

// The page responder, with what the `security` and `reload` settings of a route's page and layouts add to its responses; a header the response sets itself wins.
export function withPageHeaders(respond: PageResponder, options: SecurityOptions, site: Record<string, string> | undefined): PageResponder {
  const byRoute = new Map<string, Promise<RouteHeaders | undefined>>()

  return async (route, params, context, url) => {
    const { key } = routeChain(route)
    let own = byRoute.get(key)

    if (!own)
      byRoute.set(key, own = loadHeaders(byRoute, key, route, options, site))

    // Once loaded the headers are read at once, without a promise to wait for; the first request loads them while the page renders.
    const [response, headers] = Bun.peek.status(own) === 'fulfilled'
      ? [await respond(route, params, context, url), Bun.peek(own) as RouteHeaders | undefined] as const
      : await Promise.all([respond(route, params, context, url), own])

    if (!headers)
      return response

    const { set } = context as { set?: Context['set'] }

    for (const name of headers.replaced) {
      if (set && set.headers[name] === site?.[name])
        delete set.headers[name]
    }

    for (const [name, value] of Object.entries(headers.headers)) {
      if (!response.headers.has(name))
        response.headers.set(name, value)
    }

    return response
  }
}

// A failed load is forgotten, so the next request tries again instead of meeting the same rejection for good.
async function loadHeaders(known: Map<string, Promise<RouteHeaders | undefined>>, key: string, route: ServedRoute, options: SecurityOptions, site: Record<string, string> | undefined): Promise<RouteHeaders | undefined> {
  try {
    return await routeHeaders(route, options, site)
  }
  catch (error) {
    known.delete(key)

    throw error
  }
}

// The patterns of the routes whose page or layouts set `security`, which only a server answering each page can apply.
export async function routesWithSecurity(routes: ServedRoute[]): Promise<string[]> {
  const found = await Promise.all(routes.map(async (route) => {
    const modules = await Promise.all(routeChain(route).files.map(async file => importModule<object>(file)))

    return modules.some(module => pageSetting(module, 'security') !== undefined) ? [route.pattern] : []
  }))

  return found.flat()
}

async function routeHeaders(route: ServedRoute, options: SecurityOptions, site: Record<string, string> | undefined): Promise<RouteHeaders | undefined> {
  const modules = await Promise.all(routeChain(route).files.map(async file => importModule<object>(file)))
  const security = modules.flatMap(module => (pageSetting(module, 'security') as PageSecurity | undefined) ?? [])
  const reload = modules.some(module => pageSetting(module, 'reload') === true)

  if (security.length === 0 && !reload)
    return undefined

  const headers = security.length > 0 ? securityHeaders(options, security) ?? {} : { ...site }

  if (reload)
    headers[RELOAD_HEADER] = '1'

  return { headers, replaced: Object.keys(site ?? {}).filter(name => headers[name] !== site![name]) }
}
