import type { Server } from 'bun'
import type { Elysia } from 'elysia'
import type { Compiled, RouteEnv, RouteRecord } from './kay-routes'
import type { PipelineOptions } from './phases'
import type { ReceiveServer } from './receive'
import { compileRecord, extractParams, isDynamic, RouteIndex, slashed } from './kay-routes'
import { emptyPhases, Pipeline } from './phases'
import { requestUrl } from './request-url'

// What answers a request no record of the table serves: the Elysia app kay still routes the rest through.
export type Fallback = (request: Request, server: ReceiveServer) => Response | Promise<Response>

type Handler = (request: Request, server: ReceiveServer) => Promise<Response>
type BunRoutes = Record<string, Record<string, Handler | Response>>

export interface KayServerOptions extends PipelineOptions {
  env: RouteEnv
  fallback?: Fallback | undefined
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']

// The methods Bun is handed a record for: a GET record answers HEAD too, an ALL one every method.
function askedBy(method: string): string[] {
  if (method === 'ALL')
    return METHODS

  return method === 'GET' ? ['GET', 'HEAD'] : [method]
}

// kay's own server: the route table compiled into the `routes` `Bun.serve` matches, and `fetch` for what that router leaves, with the fixed phases around both and the fallback app answering what no record serves.
export class KayServer {
  readonly pipeline: Pipeline
  readonly records: RouteRecord[] = []
  fallback: Fallback | undefined
  readonly #env: RouteEnv
  #built: { routes: BunRoutes, index: RouteIndex } | undefined

  constructor(options: KayServerOptions) {
    this.pipeline = new Pipeline(emptyPhases(), options)
    this.#env = options.env
    this.fallback = options.fallback
  }

  // Adds a record to the table; the routes compile again from the next read.
  add(...records: RouteRecord[]): void {
    this.records.push(...records)
    this.#built = undefined
  }

  // What to hand `Bun.serve({ routes })`.
  get routes(): BunRoutes {
    return this.#build().routes
  }

  // Answers a request the router did not send to a record: a rewritten one, a request with no server, or one whose path is the fallback's.
  async fetch(request: Request, server?: ReceiveServer): Promise<Response> {
    const received = await this.#receive(request, server)

    if (received instanceof Response)
      return received

    const hit = this.#build().index.match(received.method, requestUrl(received).pathname)

    return hit === undefined ? this.#fallback(received, server) : this.#answer(hit.compiled, hit.params, received)
  }

  #build(): { routes: BunRoutes, index: RouteIndex } {
    if (this.#built !== undefined)
      return this.#built

    const compiled = this.records.flatMap(record => compileRecord(record, this.#env))
    const routes: BunRoutes = {}

    for (const entry of compiled) {
      const methods = routes[entry.path] ??= {}
      const asked = askedBy(entry.record.method)
      const staticAnswer = !entry.redirect && this.pipeline.empty ? entry.record.static : undefined

      for (const method of asked) {
        // The first record of a path and method keeps it.
        if (methods[method] === undefined)
          methods[method] = staticAnswer !== undefined && method === 'GET' ? staticAnswer : async (request, server) => this.#serve(entry, request, server)
      }
    }

    return this.#built = { routes, index: new RouteIndex(compiled) }
  }

  // `receive`, its answer or the failure of a step taken through the phases that follow it, as any failure is.
  async #receive(request: Request, server: ReceiveServer): Promise<Request | Response> {
    try {
      const received = this.pipeline.receive(request, server)

      return received instanceof Response ? await this.pipeline.settle(request, received) : received
    }
    catch (error) {
      return this.pipeline.failed(request, error)
    }
  }

  // A request Bun's router sent to a record: received first, and handed on to the table's own match when `receive` rewrote it.
  async #serve(entry: Compiled, request: Request, server: ReceiveServer): Promise<Response> {
    const received = await this.#receive(request, server)

    if (received instanceof Response)
      return received

    if (received !== request)
      return this.fetch(received, server)

    const params = isDynamic(entry.path) ? extractParams(entry.segments, requestUrl(received).pathname) : {}

    // A path the router took for the record, which its own reading of the params refuses, is the fallback's.
    return params === null ? this.#fallback(received, server) : this.#answer(entry, params, received)
  }

  async #answer(entry: Compiled, params: Record<string, string> | undefined, request: Request): Promise<Response> {
    if (entry.redirect) {
      const { pathname, search } = requestUrl(request)

      return this.pipeline.settle(request, new Response(null, { status: 308, headers: { location: slashed(pathname, search) } }))
    }

    return this.pipeline.serve(entry.record.static === undefined || entry.record.handle !== undefined ? entry.record : { ...entry.record, handle: () => entry.record.static!.clone() }, params, request)
  }

  async #fallback(request: Request, server: ReceiveServer): Promise<Response> {
    if (this.fallback === undefined)
      return this.pipeline.settle(request, new Response('Not Found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }))

    return this.pipeline.settle(request, await this.fallback(request, server))
  }
}

// The routes Elysia handed Bun with the table's laid over them, each method of a path the table serves taken from it and the others left to Elysia.
function withTable(elysia: Record<string, unknown> | undefined, table: BunRoutes): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...elysia }

  for (const [path, methods] of Object.entries(table)) {
    const held = merged[path]

    merged[path] = typeof held === 'object' && held !== null && Object.getPrototypeOf(held) === Object.prototype ? { ...held, ...methods } : methods
  }

  return merged
}

const INSTALLED = Symbol.for('kay.server.installed')

type Reload = Server<unknown>['reload']

// What a server holds once kay is in front of it: the table it serves now, which a later run of the app (`kay dev` restarts it on the same server) takes over.
interface Front {
  kay: KayServer
}

interface Installable {
  [INSTALLED]?: Front
}

// Puts kay's server in front of the Elysia app once it listens: Bun is handed `kay.fetch`, with the app's own `fetch` as its fallback, and the routes the table compiled to, beside the ones Elysia hands it.
// Elysia hands Bun its `fetch` and routes in a `reload` when it has loaded its modules, a microtask after it starts listening, and recompiles `app.fetch` by then, so the `reload` of the running server is where both are taken over.
// Elysia also hands Bun a handler for each of its routes, which Bun calls without `fetch`, so the answer would skip `respond` and `after`: once a step of either is set, Elysia's own router serves them through `fetch` instead. With none set, which is the case until the slices moving the response work onto the phases land, the app is served exactly as before.
export function serveThrough(app: Elysia, kay: KayServer): void {
  app.onStart((root) => {
    const { server } = root

    if (server === null || server === undefined)
      return

    const { respond, after } = kay.pipeline.phases

    if (respond.length > 0 || after.length > 0)
      root.config.systemRouter = false

    const held = (server as Installable)[INSTALLED]

    if (held !== undefined) {
      held.kay = kay

      return
    }

    const front: Front = { kay }

    ;(server as Installable)[INSTALLED] = front

    // The `reload` of the server is its prototype's, which the patch shadows: it is lifted for the call. A wrapper of the server (`kay dev` hands each run one) calls it on the server itself, so `this` is the server whatever object the app holds.
    function patched(this: Server<unknown>, options: Parameters<Reload>[0]): void {
      const target = this
      const native = (given: Parameters<Reload>[0]): void => {
        delete (target as { reload?: Reload }).reload

        try {
          target.reload(given)
        }
        finally {
          target.reload = patched as Reload
        }
      }

      // Elysia also reloads a server with the server itself, which holds what it already serves.
      if (typeof (options as { stop?: unknown }).stop === 'function')
        return native(options)

      const { kay: current } = front
      const { fetch: elysia } = options as { fetch?: ((request: Request, server: ReceiveServer) => Response | Promise<Response>) | undefined }

      current.fallback = elysia && (async request => elysia(request, target))
      native({ ...options, fetch: async (request: Request, bun: ReceiveServer) => current.fetch(request, bun ?? target), routes: withTable(options.routes, current.routes) as never })
    }

    server.reload = patched as Reload
        }
      }

      // Elysia also reloads a server with the server itself, which holds what it already serves.
      if ((options as unknown) === server)
        return native(options)

      const { kay: current } = front
      const { fetch: elysia } = options as { fetch?: ((request: Request, server: ReceiveServer) => Response | Promise<Response>) | undefined }

      current.fallback = elysia && (async request => elysia(request, server))

      return native({ ...options, fetch: async (request: Request, bun: ReceiveServer) => current.fetch(request, bun ?? server), routes: withTable(options.routes, current.routes) as never })
    }

    server.reload = patched
  })
}
