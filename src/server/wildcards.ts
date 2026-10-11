import type { Elysia } from 'elysia'

interface Context { params: Record<string, string | undefined>, path: string }

// The paths of the wildcard routes kay registers on each app.
const ownWildcards = new WeakMap<Elysia, Set<string>>()

// Registers a wildcard route of kay's own, such as `/_kay/*`, for `agreeOnWildcards` to keep ahead of the param routes around it.
export function wildcardRoute(app: Elysia, path: string): void {
  const paths = ownWildcards.get(app) ?? new Set<string>()

  paths.add(path)
  ownWildcards.set(app, paths)
}

// Elysia hands Bun's router every route but those ending in `*`, which Bun's router then sends a path to before Elysia's own router sees it: a page at `/:p1/:p2` takes `/_kay/x.js` from `/_kay/*`, which `app.handle()` would serve. So each of kay's wildcard routes is registered again at the depth of each such param route, with the static segments of both, where Bun's router prefers it as Elysia's does.
export function agreeOnWildcards(app: Elysia): void {
  const wildcards = ownWildcards.get(app)

  if (!wildcards)
    return

  const routes = app.routes.filter(route => typeof route.handler === 'function')
  const taken = new Set(routes.map(route => `${route.method} ${shapeOf(route.path)}`))

  for (const wildcard of routes.filter(route => route.method === 'GET' && wildcards.has(route.path))) {
    const prefix = wildcard.path.slice(0, -'/*'.length).split('/').slice(1)
    const handler = wildcard.handler as (context: Context) => unknown

    for (const route of routes) {
      if (route.method !== 'GET' || route.path.endsWith('*'))
        continue

      for (const path of optionalVariants(route.path)) {
        const mirror = overlap(prefix, path.split('/').slice(1))

        if (!mirror || taken.has(`GET ${shapeOf(mirror.path)}`))
          continue

        taken.add(`GET ${shapeOf(mirror.path)}`)
        app.get(mirror.path, async (context: Context) => {
          const segments = (context.path.endsWith('/') ? context.path.slice(0, -1) : context.path).split('/')
          const params: Record<string, string | undefined> = { '*': segments.slice(segments.length - mirror.rest).join('/') }

          for (const [index, segment] of prefix.entries()) {
            if (segment.startsWith(':'))
              params[segment.slice(1)] = mirror.segments[index]!.startsWith(':') ? context.params[mirror.segments[index]!.slice(1)] : mirror.segments[index]
          }

          context.params = params

          return handler(context)
        })
      }
    }
  }
}

// The paths both a wildcard route's start and a param route serve, where Elysia's router picks the wildcard: the first segment telling them apart is static in the wildcard and a param in the other. Undefined when they share no path or the other route wins.
function overlap(prefix: string[], segments: string[]): { path: string, segments: string[], rest: number } | undefined {
  if (segments.length <= prefix.length)
    return undefined

  let wildcardWins: boolean | undefined
  const shared: string[] = []

  for (const [index, own] of prefix.entries()) {
    const other = segments[index]!
    const ownParam = own.startsWith(':')
    const otherParam = other.startsWith(':')

    if (!ownParam && !otherParam && own !== other)
      return undefined

    if (ownParam !== otherParam)
      wildcardWins ??= !ownParam

    shared.push(ownParam ? other : own)
  }

  if (wildcardWins !== true)
    return undefined

  const all = [...shared, ...segments.slice(prefix.length)]

  return { path: `/${all.join('/')}`, segments: all, rest: segments.length - prefix.length }
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

// A path with its params unnamed, as Bun's router tells two routes apart.
function shapeOf(path: string): string {
  return path.replace(/:[^/]+/g, ':')
}
