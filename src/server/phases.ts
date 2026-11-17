import type { LocaleState } from '../runtime/locale-state'
import type { RouteRecord } from './kay-routes'
import type { Received, ReceiveServer, ReceiveStep } from './receive'
import { runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { answer } from './answer'
import { answeringRequest } from './log'
import { runReceive } from './receive'
import { inContext, RequestContext } from './request-context'
import { Denied, NotFound, Redirect } from './signals'
import { SERVER_SPAN, traced } from './trace'

type Outcome = Response | undefined | void

// A step of `limit`, `admit` or `input`: it answers with a Response to end the request there, or returns nothing.
export type Step = (context: RequestContext) => Outcome | Promise<Outcome>

// A step of `respond`, which takes the Response and gives the one that goes on; the order is the order of the list.
export type RespondStep = (context: RequestContext, response: Response) => Response | Promise<Response>

// A step of `after`, run once the answer is made.
export type AfterStep = (context: RequestContext, response: Response) => void | Promise<void>

// A step of `error`, which answers a failure with a Response or leaves it to the next, kay's own last.
export type ErrorStep = (context: RequestContext, error: unknown) => Outcome | Promise<Outcome>

// What runs in each phase, in this order for every kind of route: `receive`, `limit`, `admit`, `input`, `handle`, `answer`, `respond`, `after`, with `error` taking over a failure of any of them. Each list holds what extensions and kay add, in the order they are added.
export interface Phases {
  receive: ReceiveStep[]
  limit: Step[]
  admit: Step[]
  input: Step[]
  respond: RespondStep[]
  after: AfterStep[]
  error: ErrorStep[]
}

export function emptyPhases(): Phases {
  return { receive: [], limit: [], admit: [], input: [], respond: [], after: [], error: [] }
}

export interface PipelineOptions {
  // Whether an unexpected failure's message goes in the 500 answer, as `kay dev` shows it.
  dev?: boolean | undefined
  // The locale a request is answered in, so the handler, the log lines and the stream it opens read it.
  locale?: ((context: RequestContext) => LocaleState | undefined) | undefined
  // Where an unexpected failure is reported, the route's own bug.
  report?: ((error: unknown, request: Request) => void) | undefined
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

// What a handler wrote to `set`, folded into the answer: its headers go on where the answer has none of that name, a cookie added to the others.
function folded(response: Response, context: RequestContext): Response {
  const written = context.written

  if (written === undefined || [...written.headers].length === 0)
    return response

  const headers = new Headers(response.headers)

  for (const [name, value] of written.headers) {
    if (name === 'set-cookie')
      headers.append(name, value)
    else if (!headers.has(name))
      headers.set(name, value)
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

// A body that goes unread under `HEAD`, the headers as the GET would send them.
function headOf(response: Response): Response {
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
}

// The phases around a request, the same for every route kind, so a record kay serves and the Elysia app behind it as a fallback are answered the same way.
export class Pipeline {
  readonly phases: Phases
  readonly #options: PipelineOptions
  // The requests `receive` ran for, so it runs once however many times a request is handed on, as it is to the fallback app which still has its own bridge to it.
  readonly #received = new WeakSet<Request>()

  constructor(phases: Phases = emptyPhases(), options: PipelineOptions = {}) {
    this.phases = phases
    this.#options = options
  }

  // `receive`: the request to go on with, or the answer. A request already received is returned as it is.
  receive(request: Request, server: ReceiveServer): Received {
    if (this.#received.has(request))
      return request

    this.#received.add(request)

    const received = runReceive(this.phases.receive, request, server)

    if (received instanceof Request)
      this.#received.add(received)

    return received
  }

  // Whether a phase has a step: with none, a static Response can go to `Bun.serve` as it is, as nothing is left to apply to it.
  get empty(): boolean {
    const { phases } = this

    return phases.receive.length === 0 && phases.respond.length === 0 && phases.after.length === 0 && phases.limit.length === 0 && phases.admit.length === 0
  }

  // Answers a request for a record, from `limit` to `after`.
  async serve(record: RouteRecord, params: Record<string, string> | undefined, request: Request): Promise<Response> {
    const context = new RequestContext(request, record, params)

    return this.#inScope(context, async () => {
      let response: Response

      try {
        response = await this.#handle(context, record)
      }
      catch (error) {
        response = await this.#fail(context, error)
      }

      return this.#finish(context, response)
    })
  }

  // Runs `respond` and `after` over an answer made before any record was reached: a refusal of `receive`, or the fallback app's.
  async settle(request: Request, response: Response): Promise<Response> {
    // The fallback app's answer, as it is, when no step is left to run over it.
    if (this.phases.respond.length === 0 && this.phases.after.length === 0 && request.method !== 'HEAD')
      return response

    const context = new RequestContext(request, undefined, {})

    return this.#inScope(context, async () => this.#finish(context, response))
  }

  // Answers a failure that came before any record was reached, through the same chain as a handler's.
  async failed(request: Request, error: unknown): Promise<Response> {
    const context = new RequestContext(request, undefined, {})

    return this.#inScope(context, async () => this.#finish(context, await this.#fail(context, error)))
  }

  async #inScope<T>(context: RequestContext, run: () => Promise<T>): Promise<T> {
    const { request } = context

    return inContext(context, async () => answeringRequest(request, async () => {
      const inside = async () => traced(() => `${request.method} ${context.route?.path ?? context.url.pathname}`, () => ({ kind: SERVER_SPAN }), run, request)
      const state = this.#options.locale?.(context)

      return state === undefined ? inside() : runInLocale(state, inside)
    }))
  }

  async #handle(context: RequestContext, record: RouteRecord): Promise<Response> {
    const refused = await this.#run(this.phases.limit, context) ?? await this.#run(this.phases.admit, context) ?? this.#malformed(context) ?? await this.#run(this.phases.input, context)

    return refused !== undefined ? refused : answer(await record.handle!(context), context)
  }

  // A param that does not decode refuses the path as a client's mistake, in `input` after the guards, which read nothing of it.
  #malformed(context: RequestContext): Response | undefined {
    return context.malformed ? text(400, 'Bad Request: the path holds an escape that does not decode\n') : undefined
  }

  async #run(steps: readonly Step[], context: RequestContext): Promise<Response | undefined> {
    for (const step of steps) {
      const result = await step(context)

      if (result instanceof Response)
        return result
    }

    return undefined
  }

  // One chain: the steps of `error`, then kay's own kinds of failure, so what an app or an extension answers wins over the default and a message never leaks unless `dev` says so.
  async #fail(context: RequestContext, error: unknown): Promise<Response> {
    try {
      for (const step of this.phases.error) {
        const result = await step(context, error)

        if (result instanceof Response)
          return result
      }
    }
    catch (thrown) {
      error = thrown
    }

    if (error instanceof Redirect)
      return new Response(null, { status: error.status, headers: { location: error.location } })

    if (error instanceof NotFound)
      return text(404, 'Not Found\n')

    if (error instanceof Denied)
      return text(error.status, `${error.message}\n`)

    this.#report(error, context.request)

    return text(500, this.#options.dev === true && error instanceof Error ? `${error.message}\n` : 'Internal Server Error\n')
  }

  #report(error: unknown, request: Request): void {
    if (this.#options.report === undefined)
      kayLog('error', `${request.method} ${new URL(request.url).pathname} failed`, error)
    else
      this.#options.report(error, request)
  }

  // `respond` in its order, then the `HEAD` body dropped, then `after` on a later turn, once the answer has gone.
  async #finish(context: RequestContext, answered: Response): Promise<Response> {
    let response = folded(answered, context)

    try {
      for (const step of this.phases.respond)
        response = await step(context, response)
    }
    catch (error) {
      response = text(500, 'Internal Server Error\n')
      this.#report(error, context.request)
    }

    if (context.request.method === 'HEAD' && response.body !== null)
      response = headOf(response)

    if (this.phases.after.length > 0)
      setImmediate(() => void this.#after(context, response))

    return response
  }

  async #after(context: RequestContext, response: Response): Promise<void> {
    for (const step of this.phases.after) {
      try {
        await step(context, response)
      }
      catch (error) {
        this.#report(error, context.request)
      }
    }
  }
}
