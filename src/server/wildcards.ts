import type { Elysia } from 'elysia'

type Handle = (request: Request) => Response | Promise<Response>

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const READS = new Set(['GET', 'HEAD'])

// Elysia hands Bun's router every route but those ending in `*`, which Bun's router then sends a path to before Elysia's own router sees it: a page at `/:p1/:p2` takes `/_kay/x.js` from `/_kay/*`, a redirect from `/old/*` or an API module's `/api/files/*`, which `app.handle()` would serve. So once the server listens, each path of Bun's table such a route would win hands its requests to Elysia's router, which runs the route with its own hooks, as `app.handle()` does.
export function agreeOnWildcards(app: Elysia): void {
  app.onStart((root) => {
    const routes = fallingThrough(root)

    if (Object.keys(routes).length === 0)
      return

    // Elysia reads these again as the modules it waits on resolve, a microtask after it starts listening, and lays them over its own table.
    const serve = (root.config.serve ?? {}) as { routes?: Record<string, unknown> }

    root.config.serve = { ...serve, routes: { ...routes, ...serve.routes } } as NonNullable<typeof root.config.serve>
  })
}

// The paths of Bun's table a wildcard route shares with a param route and wins in Elysia's router, each method of them handed to Elysia's `fetch`.
function fallingThrough(root: Elysia): Record<string, Record<string, Handle>> {
  const routes = root.routes.filter(route => typeof route.handler === 'function' && route.method !== 'WS')
  const wildcards = routes.filter(route => route.path.endsWith('*')).map(route => ({ method: route.method, prefix: route.path.slice(0, -'/*'.length).split('/').slice(1) }))
  const paths = new Set<string>()

  for (const route of routes) {
    if (route.path.endsWith('*'))
      continue

    for (const path of optionalVariants(route.path)) {
      const segments = path.split('/').slice(1)

      if (wildcards.some(wildcard => sameMethod(wildcard.method, route.method) && wildcardWins(wildcard.prefix, segments)))
        paths.add(encodeURI(path))
    }
  }

  const handle: Handle = async request => root.fetch(request)
  const methods = Object.fromEntries(METHODS.map(method => [method, handle]))

  return Object.fromEntries([...paths].map(path => [path, methods]))
}

function sameMethod(wildcard: string, route: string): boolean {
  return wildcard === route || wildcard === 'ALL' || route === 'ALL' || (READS.has(wildcard) && READS.has(route))
}

// Whether a path both a wildcard route's start and a param route serve goes to the wildcard in Elysia's router: the first segment telling them apart is static in the wildcard and a param in the other.
function wildcardWins(prefix: string[], segments: string[]): boolean {
  if (segments.length <= prefix.length)
    return false

  for (const [index, own] of prefix.entries()) {
    const other = segments[index]!
    const ownParam = own.startsWith(':')
    const otherParam = other.startsWith(':')

    if (ownParam !== otherParam)
      return !ownParam

    if (!ownParam && own !== other)
      return false
  }

  return false
}

// The paths Elysia registers for one with optional params, `/a/:b?` serving `/a` and `/a/:b`.
function optionalVariants(path: string): string[] {
  let variants = ['']

  for (const segment of path.split('/').slice(1)) {
    variants = segment.endsWith('?')
      ? variants.flatMap(variant => [variant, `${variant}/${segment.slice(0, -1)}`])
      : variants.map(variant => `${variant}/${segment}`)
  }

  return variants.map(variant => variant || '/')
}
