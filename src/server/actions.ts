import type { Elysia, TSchema } from 'elysia'
import type { ActionContext, ServerAction } from '../runtime/action'
import type { Route } from './routes'
import { isAction } from '../runtime/action'
import { Redirect } from './signals'

// Registers every action the pages export as a POST route whose body Elysia validates against the action's schema.
export async function registerActionRoutes(app: Elysia, routes: Route[]): Promise<void> {
  for (const route of routes) {
    const module = await import(route.file) as Record<string, unknown>

    for (const value of Object.values(module)) {
      if (isAction(value))
        app.post(value.url, ({ body, request }) => runAction(value, body, request), { body: value.schema })
    }
  }
}

async function runAction(action: ServerAction<TSchema, unknown>, input: unknown, request: Request): Promise<Response> {
  const headers = new Headers()
  let status = 200
  const ctx: ActionContext = {
    request,
    headers,
    status: (code) => {
      status = code
    },
    redirect: (location, code = 303) => {
      throw new Redirect(location, code)
    },
  }

  try {
    const result = await action.handler(input, ctx)

    // A fetch from an island wants the result; a plain form post goes back to the page it came from.
    if (request.headers.get('x-kay-action') === '1')
      return Response.json(result ?? null, { status, headers })

    headers.set('location', request.headers.get('referer') ?? '/')

    return new Response(null, { status: 303, headers })
  }
  catch (error) {
    if (!(error instanceof Redirect))
      throw error

    headers.set('location', error.location)

    return new Response(null, { status: error.status, headers })
  }
}
