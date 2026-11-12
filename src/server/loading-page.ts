import type { ServedRoute } from './guards'
import type { RenderOptions } from './render'
import type { Route, SpecialPage } from './routes'
import { LOADING_HEADER } from '../runtime/swap'

// The delay a page tells the swap in `client.loadingDelay` once the app has a `_loading.kay` and a server to render it: past a quick answer, short enough to feel prompt. An app without one, or a static export, carries none.
export function withLoadingDelay(options: RenderOptions, routes: Route[], exporting: boolean): RenderOptions {
  const client = { ...options.client, loadingDelay: !exporting && routes.some(route => route.special.loading) ? options.client?.loadingDelay ?? '200ms' : undefined }

  return { ...options, client }
}

const served = new WeakMap<ServedRoute, ServedRoute>()

// The route as the page its loading file is: the file in place of the page, inside the route's own layouts, with rate limit counters of its own and every key of `ctx` loaded since the file's reads are unknown.
// Made once per route, as the chains and modules are cached by the arrays they are made of.
function loadingRoute(route: ServedRoute, loading: SpecialPage): ServedRoute {
  let made = served.get(route)

  if (!made) {
    served.set(route, made = { ...route, contextKeys: undefined, file: loading.file, pattern: `${route.pattern}#loading`, layouts: [...route.layouts] })
  }

  return made
}

// Answers a request asking for the loading page of the route it names, which the page swap sends once a navigation is slow: the nearest `_loading.kay` rendered through the route's guards, layouts and context, or an empty 204 when there is none.
// The answer is for that request alone, kept by no cache, which could otherwise serve it for the page itself.
export async function answerLoading(route: ServedRoute, render: (loading: ServedRoute) => Promise<Response>): Promise<Response> {
  const { loading } = route.special
  const response = loading === undefined ? new Response(null, { status: 204 }) : await render(loadingRoute(route, loading))

  if (response.status === 200)
    response.headers.set(LOADING_HEADER, '1')

  response.headers.set('cache-control', 'private, no-store')
  response.headers.delete('etag')
  response.headers.append('vary', LOADING_HEADER)

  return response
}
