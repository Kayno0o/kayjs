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
  // The body as it came, for an upload that is no text.
  bytes: Uint8Array
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
  // What a route function threw since the test began, each of which answered 500.
  errors: unknown[]
  // Answers every request with this status and body until the test ends.
  fail: (status: number, body?: string) => void
  // Holds every request without answering until the test ends, or the client gives up.
  stall: () => void
  // Stops the fake now, and releases what it held; the end of the test file does it anyway.
  stop: () => Promise<void>
  [Symbol.asyncDispose]: () => Promise<void>
}

const METHOD_KEY = /^([a-z]+) (?=\/)/i
const STALL_RELEASED = 'the fake service ended the test with this request unanswered'

function answerOf(value: ServiceAnswer): Response {
  if (value instanceof Response)
    return value.clone()

  if (value === undefined)
    return new Response(null, { status: 204 })

  if (typeof value === 'string')
    return new Response(value, { headers: { 'content-type': 'text/plain; charset=utf-8' } })

  return Response.json(value)
}

function handlerOf(routes: ServiceRoutes): ServiceHandler {
  if (typeof routes === 'function')
    return routes

  // The method of a key is read in upper case, as a request's is.
  const table = new Map(Object.entries(routes).map(([key, route]) => [key.replace(METHOD_KEY, (_, method: string) => `${method.toUpperCase()} `), route]))

  return (request) => {
    const key = `${request.method} ${request.path}`
    const found = table.has(key) ? key : request.path

    if (!table.has(found))
      return new Response('Not found', { status: 404 })

    const route = table.get(found)

    return typeof route === 'function' ? (route as ServiceHandler)(request) : route
  }
}

// A stand-in for an outside HTTP service the app calls, a real server on a free loopback port: its `url` goes where the app reads the service's, `overrideEnv(env, { FORGEJO_URL: forgejo.url })`.
// Its requests clear and its `fail` and `stall` end with each test, and it stops after the file's tests; made inside a test, stop it with `await using` or `stop()`.
export function fakeService(routes: ServiceRoutes): FakeService {
  const handle = handlerOf(routes)
  const held = new Set<() => void>()
  let requests: ServiceRequest[] = []
  let errors: unknown[] = []
  let failing: { status: number, body: string } | undefined
  let stalled = false

  const release = (): void => {
    for (const free of held)
      free()
  }

  const reset = (): void => {
    requests = []
    errors = []
    failing = undefined
    stalled = false
    release()
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(incoming) {
      const bytes = new Uint8Array(await incoming.arrayBuffer())
      const text = new TextDecoder().decode(bytes)
      const url = new NativeURL(incoming.url)
      const request: ServiceRequest = { method: incoming.method, path: url.pathname, query: url.searchParams, headers: incoming.headers, text, bytes, json: () => JSON.parse(text) as unknown }

      requests.push(request)

      if (stalled) {
        await new Promise<void>((resolve) => {
          const free = (): void => {
            held.delete(free)
            incoming.signal.removeEventListener('abort', free)
            resolve()
          }

          held.add(free)
          incoming.signal.addEventListener('abort', free, { once: true })
        })

        return new Response(STALL_RELEASED, { status: 503 })
      }

      return withNatives(async () => (failing ? new Response(failing.body, { status: failing.status }) : answerOf(await handle(request))))
    },
    error(error) {
      errors.push(error)

      return new Response('The fake service\'s route threw', { status: 500 })
    },
  })

  server.unref()

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
    get errors() {
      return errors
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

  // Hooks cannot be registered from inside a test, where the fake is left to `stop()`, and the server does not keep the process alive.
  try {
    afterAll(stop)
  }
  catch {}

  try {
    beforeEach(reset)
  }
  catch {}

  return service
}
