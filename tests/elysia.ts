import { sucrose } from 'elysia/sucrose'

interface Route {
  method: string
  path: string
  handler: unknown
  hooks: object
}

// The routes of an app whose handler or hooks make Elysia parse the cookies, query or headers of every request, or the body of a GET; a websocket runs its hooks on a context of its own.
export function parsingRoutes(app: unknown): string[] {
  return (app as { routes: Route[] }).routes.filter(route => route.method !== 'WS').filter((route) => {
    const inferred = sucrose({ handler: route.handler, ...route.hooks } as never)

    return inferred.cookie || inferred.query || inferred.headers || (route.method === 'GET' && inferred.body)
  }).map(route => `${route.method} ${route.path}`)
}

export function routePaths(app: unknown): string[] {
  return (app as { routes: Route[] }).routes.map(route => route.path)
}
