import type { Server } from 'bun'
import type { Elysia } from 'elysia'

// What a `receive` step is given: the server the request came through, none under `app.handle()`.
export type ReceiveServer = Server<unknown> | null | undefined

// A step of the `receive` phase, which runs before routing: it answers with a Response, hands on a Request to go on with (a rewrite), or returns nothing to let the request through.
export type ReceiveStep = (request: Request, server: ReceiveServer) => Request | Response | undefined | void

// What `receive` ends with: the answer, or the request every later phase and the router see.
export type Received = Request | Response

// The steps run in turn; the first to answer ends it, and one that hands on another request leaves the later steps to read that one.
export function runReceive(steps: readonly ReceiveStep[], request: Request, server: ReceiveServer): Received {
  let current = request

  for (const step of steps) {
    const result = step(current, server)

    if (result instanceof Response)
      return result

    if (result instanceof Request)
      current = result
  }

  return current
}

export function receiving(steps: readonly (ReceiveStep | undefined)[]): (request: Request, server: ReceiveServer) => Received {
  const given = steps.filter(step => step !== undefined)

  return (request, server) => runReceive(given, request, server)
}

// `receive` as the Elysia hook the app still routes through while its routes are not on kay's table: the hook runs before Elysia routes, and a Response it returns is the answer.
export function bridgeReceive(app: Elysia, receive: (request: Request, server: ReceiveServer) => Received): void {
  app.onRequest(({ request, server }) => {
    const received = receive(request, server)

    return received instanceof Response ? received : undefined
  })
}
