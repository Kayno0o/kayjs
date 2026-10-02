import type { JSX } from '@solidjs/web'
import type { PageContext } from '../runtime'
import type { ClientBuild } from './client'
import type { Route } from './routes'
import { createComponent, generateHydrationScript, NoHydration, renderToString } from '@solidjs/web'
import { NotFound, Redirect } from './signals'

interface PageModule {
  default: (props: Record<string, unknown>) => JSX.Element
  load?: (ctx: PageContext) => Promise<Record<string, unknown>>
}

export interface RenderOptions {
  lang?: string
}

export async function renderPage(route: Route, request: Request, rawParams: Record<string, string>, client: ClientBuild | undefined, options: RenderOptions = {}): Promise<Response> {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  let status = 200
  const ctx: PageContext = {
    request,
    url: new URL(request.url),
    params: routeParams(route, rawParams),
    status: (code) => {
      status = code
    },
    headers,
    redirect: (location, code = 302) => {
      throw new Redirect(location, code)
    },
    notFound: () => {
      throw new NotFound()
    },
  }

  try {
    const [page, ...layouts] = await Promise.all([route.file, ...route.layouts].map(async file => await import(file) as PageModule))
    const data = await Promise.all([page!, ...layouts].map(async module => await module.load?.(ctx) ?? {}))
    let view = () => createComponent(page!.default, data[0]!)

    for (const [index, layout] of [...layouts.entries()].reverse()) {
      const inner = view

      view = () => createComponent(layout.default, { ...data[index + 1], get children() {
        return inner()
      } })
    }
    let head = ''
    // Pages and layouts are static: only islands, rendered as their own roots, carry hydration keys.
    const body = renderToString(() => createComponent(NoHydration, { get children() {
      return view()
    } }), { onHead: (html) => {
      head = html
    } })
    const scripts = client && body.includes('<kay-island') ? `${generateHydrationScript()}<script type="module" src="${client.entry}"></script>` : ''
    const html = `<!doctype html><html lang="${options.lang ?? 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}${scripts}</head><body>${body}</body></html>`

    return new Response(html, { status, headers })
  }
  catch (error) {
    if (error instanceof Redirect)
      return new Response(null, { status: error.status, headers: { location: error.location } })

    if (error instanceof NotFound)
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })

    throw error
  }
}

function routeParams(route: Route, raw: Record<string, string>): Record<string, string> {
  const params: Record<string, string> = {}

  for (const name of route.params)
    params[name] = decodeURIComponent((name === route.catchAll ? raw['*'] : raw[name]) ?? '')

  return params
}
