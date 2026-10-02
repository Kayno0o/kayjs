import type { JSX } from '@solidjs/web'
import type { Locals, PageContext } from '../runtime'
import type { ClientBuild } from './client'
import type { Route } from './routes'
import { createComponent, generateHydrationScript, NoHydration, renderToString } from '@solidjs/web'
import { cookieJar } from './cookies'
import { decodePath } from './routes'
import { NotFound, Redirect } from './signals'

interface PageModule {
  default: (props: Record<string, unknown>) => JSX.Element
  load?: (ctx: PageContext) => Promise<Record<string, unknown>>
}

export interface RenderOptions {
  lang?: string
}

// What Elysia hands a route handler, derived and resolved values included; pages see it whole as `ctx.locals`.
export interface RequestContext {
  request: Request
  params: Record<string, string>
}

export async function renderPage(route: Route, context: RequestContext, client: ClientBuild | undefined, options: RenderOptions = {}): Promise<Response> {
  const { request } = context
  const params = routeParams(route, context.params)

  if (!params)
    return new Response('Bad request', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })

  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  const jar = cookieJar(request)
  let status = 200
  const ctx: PageContext = {
    request,
    url: new URL(request.url),
    params,
    get cookies() {
      return jar.cookies
    },
    // The app's derive and resolve hooks ran before this handler, so the context carries what `Register` declares.
    locals: context as unknown as Locals,
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
    // Layouts outermost first, then the page: when several loads fail, the outermost one decides the response.
    const modules = await Promise.all([...route.layouts, route.file].map(async file => await import(file) as PageModule))
    const loads = await Promise.allSettled(modules.map(async module => await module.load?.(ctx) ?? {}))
    const data = loads.map((load) => {
      if (load.status === 'rejected')
        throw load.reason

      return load.value
    })
    const page = modules.length - 1
    let view = () => createComponent(modules[page]!.default, data[page]!)

    for (let index = page - 1; index >= 0; index--) {
      const inner = view

      view = () => createComponent(modules[index]!.default, { ...data[index], get children() {
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

    jar.writeTo(headers)

    return new Response(html, { status, headers })
  }
  catch (error) {
    if (error instanceof Redirect) {
      headers.delete('content-type')
      headers.set('location', error.location)
      jar.writeTo(headers)

      return new Response(null, { status: error.status, headers })
    }

    if (error instanceof NotFound)
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })

    throw error
  }
}

// Elysia decodes named params already; only the catch-all arrives encoded. Undefined when it is malformed.
function routeParams(route: Route, raw: Record<string, string>): Record<string, string> | undefined {
  const params: Record<string, string> = {}

  for (const name of route.params) {
    const value = name === route.catchAll ? decodePath(raw['*'] ?? '') : raw[name] ?? ''

    if (value === undefined)
      return undefined

    params[name] = value
  }

  return params
}
