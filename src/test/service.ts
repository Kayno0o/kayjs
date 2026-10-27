import { afterAll, beforeEach } from 'bun:test'
import { NativeURL, withNatives } from './natives'

// What a route answers: a `Response` as it is, a string as text, `undefined` as 204, anything else as JSON.
export type ServiceAnswer = Response | string | object | number | boolean | null | undefined

// A request the fake received, its body read once.
export interface ServiceRequest {
  method: string
  // The path with no query, such as `/api/v1/repos`.
  path: string
  query: URLSearchParams
  headers: Headers
  text: string
  // The body parsed as JSON, throwing when it is not.
  json: () => unknown
}

export type ServiceHandler = (request: ServiceRequest) => ServiceAnswer | Promise<ServiceAnswer>

// Routes keyed by `path` or `METHOD path`, each a value or a function of the request; a bare function answers every request.
export type ServiceRoutes = Record<string, ServiceAnswer | ServiceHandler> | ServiceHandler

export interface FakeService {
  // The origin the fake listens on, such as `http://127.0.0.1:41233`, with no trailing slash.
  url: string
  // Every request received since the test began, in order, the unmatched ones included.
  requests: ServiceRequest[]
  // Answers every request with this status and body until the test ends.
  fail: (status: number, body?: string) => void
  // Holds every request without answering until the test ends, or the client gives up.
  stall: () => void
  // Stops the fake now, and releases what it held; the end of the test file does it anyway.
  stop: () => Promise<void>
  [Symbol.asyncDispose]: () => Promise<void>
}

const STALL_RELEASED = 'the fake service ended the test with this request unanswered'

function answerOf(value: ServiceAnswer): Response {
  if (value instanceof Response)
    return value

  if (value === undefined)
    return new Response(null, { status: 204 })

  if (typeof value === 'string')
    return new Response(value, { headers: { 'content-type': 'text/plain; charset=utf-8' } })

  return Response.json(value)
}

function handlerOf(routes: ServiceRoutes): ServiceHandler {
  if (typeof routes === 'function')
    return routes

  const table = new Map(Object.entries(routes))

  return (request) => {
    const route = table.has(`${request.method} ${request.path}`) ? table.get(`${request.method} ${request.path}`) : table.get(request.path)

    if (route === undefined && !table.has(request.path))
      return new Response('Not found', { status: 404 })

    return typeof route === 'function' ? (route as ServiceHandler)(request) : route
  }
}

// A stand-in for an outside HTTP service the app calls, a real server on a free loopback port: its `url` goes where the app reads the service's, `overrideEnv(env, { FORGEJO_URL: forgejo.url })`.
// Its requests clear and its `fail` and `stall` end with each test, and it stops after the file's tests; made inside a test, stop it with `await using` or `stop()`.
export function fakeService(routes: ServiceRoutes): FakeService {
  const handle = handlerOf(routes)
  const held = new Set<() => void>()
  let requests: ServiceRequest[] = []
  let failing: { status: number, body: string } | undefined
  let stalled = false

  const release = (): void => {
    for (const free of held)
      free()
  }

  const reset = (): void => {
    requests = []
    failing = undefined
    stalled = false
    release()
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(incoming) {
      return withNatives(async () => {
        const url = new NativeURL(incoming.url)
        const text = await incoming.text()
        const request: ServiceRequest = { method: incoming.method, path: url.pathname, query: url.searchParams, headers: incoming.headers, text, json: () => JSON.parse(text) as unknown }

        requests.push(request)

        if (stalled) {
          await new Promise<void>((resolve) => {
            const free = (): void => {
              held.delete(free)
              resolve()
            }

            held.add(free)
            incoming.signal.addEventListener('abort', free, { once: true })
          })

          return new Response(STALL_RELEASED, { status: 503 })
        }

        return failing ? new Response(failing.body, { status: failing.status }) : answerOf(await handle(request))
      })
    },
  })

  const stop = async (): Promise<void> => {
    stalled = false
    release()
    await server.stop(true)
  }

  const service: FakeService = {
    url: `http://127.0.0.1:${server.port}`,
    get requests() {
      return requests
    },
    fail(status, body = '') {
      failing = { status, body }
    },
    stall() {
      stalled = true
    },
    stop,
    [Symbol.asyncDispose]: stop,
  }

  // Hooks cannot be registered from inside a test, where the fake is left to `stop()`.
  try {
    beforeEach(reset)
    afterAll(stop)
  }
  catch {}

  return service
}
