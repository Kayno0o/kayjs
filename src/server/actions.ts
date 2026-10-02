import type { Elysia, TSchema } from 'elysia'
import type { Locals } from '../runtime'
import type { ActionContext, ServerAction } from '../runtime/action'
import type { Route } from './routes'
import { isAction } from '../runtime/action'
import { cookieJar } from './cookies'
import { Redirect } from './signals'

// Registers every action the pages export as a POST route whose body Elysia validates against the action's schema.
export async function registerActionRoutes(app: Elysia, routes: Route[]): Promise<void> {
  for (const route of routes) {
    const module = await import(route.file) as Record<string, unknown>

    for (const value of Object.values(module)) {
      if (isAction(value))
        app.post(value.url, async context => runAction(value, context), { body: value.schema, beforeHandle: ({ request }) => crossSite(request) })
    }
  }
}

// Browsers send `Origin` on every POST, so a form another site submits on the user's behalf is refused.
function crossSite(request: Request): Response | undefined {
  const origin = request.headers.get('origin')

  return origin === null || sameHost(request, origin) ? undefined : new Response('Cross-site action refused', { status: 403 })
}

// Hosts rather than origins: behind a TLS-terminating proxy the browser says https while the request arrives as http.
function sameHost(request: Request, url: string | null): url is string {
  return url !== null && URL.canParse(url) && new URL(url).host === new URL(request.url).host
}

// The Elysia context, with what the app derives and resolves, is the action's `ctx.locals`.
async function runAction(action: ServerAction<TSchema, unknown>, context: { body: unknown, request: Request }): Promise<Response> {
  const { request } = context
  const headers = new Headers()
  const jar = cookieJar(request)
  let status = 200
  const ctx: ActionContext = {
    request,
    get cookies() {
      return jar.cookies
    },
    // The app's derive and resolve hooks ran before this handler, so the context carries what `Register` declares.
    locals: context as unknown as Locals,
    headers,
    status: (code) => {
      status = code
    },
    redirect: (location, code = 303) => {
      throw new Redirect(location, code)
    },
  }

  try {
    const result = await action.handler(context.body, ctx)

    jar.writeTo(headers)

    // A fetch from an island wants the result; a plain form post goes back to the page it came from.
    if (request.headers.get('x-kay-action') === '1')
      return Response.json(result ?? null, { status, headers })

    const referer = request.headers.get('referer')

    headers.set('location', sameHost(request, referer) ? referer : '/')

    return new Response(null, { status: 303, headers })
  }
  catch (error) {
    if (!(error instanceof Redirect))
      throw error

    headers.set('location', error.location)
    jar.writeTo(headers)

    return new Response(null, { status: error.status, headers })
  }
}
