import type { ServiceAnswer, ServiceHandler, ServiceRequest } from './service'
import { NativeRequest, NativeURL } from './natives'
import { answerOf, requestOf } from './service'

// What `site.fetchStub` takes: routes keyed by a URL pattern with `*` for any characters, optionally led by a method (`'POST https://api.x/v1/*'`), each a value or a function of the request.
export type FetchStubRoutes = Record<string, ServiceAnswer | ServiceHandler>

// A request the app made to a stubbed address.
export interface StubbedRequest extends ServiceRequest {
  url: string
}

export interface FetchStub {
  // Every request the stub answered since it was made, in order.
  requests: StubbedRequest[]
}

interface Route {
  method: string | undefined
  pattern: RegExp
  // A pattern naming a query is matched against the whole URL, any other against the URL up to its query.
  withQuery: boolean
  answer: ServiceAnswer | ServiceHandler
}

interface Stub {
  routes: Route[]
  requests: StubbedRequest[]
}

const METHOD_KEY = /^([a-z]+) (?=\S)/i
const SPECIAL = /[.+?^${}()|[\]\\]/g
const LOOPBACK = /^(?:localhost|.*\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/

const stubs: Stub[] = []
let open = 0
let strict = 0
let original: typeof fetch | undefined
let installed: typeof fetch | undefined

function routeOf(key: string, answer: ServiceAnswer | ServiceHandler): Route {
  const method = METHOD_KEY.exec(key)?.[1]?.toUpperCase()
  const pattern = method === undefined ? key : key.slice(method.length + 1)

  return { method, withQuery: pattern.includes('?'), answer, pattern: new RegExp(`^${pattern.split('*').map(part => part.replace(SPECIAL, '\\$&')).join('.*')}$`) }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string')
    return new NativeURL(input).href

  return input instanceof URL ? input.href : input.url
}

function found(url: string, method: string): { stub: Stub, route: Route } | undefined {
  const parsed = new NativeURL(url)
  const bare = parsed.origin + parsed.pathname

  for (const stub of stubs.toReversed()) {
    const route = stub.routes.find(candidate => (candidate.method === undefined || candidate.method === method) && candidate.pattern.test(candidate.withQuery ? parsed.href : bare))

    if (route)
      return { stub, route }
  }

  return undefined
}

async function outgoing(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = urlOf(input)
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
  const stubbed = found(url, method)

  if (stubbed) {
    const request = await requestOf(new NativeRequest(input, init))
    const seen: StubbedRequest = { ...request, url }

    stubbed.stub.requests.push(seen)

    const { answer } = stubbed.route

    return answerOf(typeof answer === 'function' ? await (answer as ServiceHandler)(request) : answer)
  }

  const { protocol, hostname } = new NativeURL(url)

  if (strict === 0 || (protocol !== 'http:' && protocol !== 'https:') || LOOPBACK.test(hostname))
    return original!(input, init)

  const origin = new NativeURL(url).origin

  throw new Error(`kay: the test made an outgoing ${method} ${url} that no stub answers: stub it with \`site.fetchStub({ '${origin}/*': { ... } })\`, or let a site's tests reach the network with \`testSite({ outgoing: 'allow' })\``)
}

// Puts the guard on `fetch` for the open sites; returns what takes one site off it, the last one restoring `fetch`.
// A request to loopback, or by a scheme other than http and https, goes through, so a `fakeService` and the site's own servers answer; with `allow`, so does every other, unless a stub answers it.
export function guardOutgoing(allow: boolean): () => void {
  if (open++ === 0) {
    original = globalThis.fetch
    installed = Object.assign(outgoing, { preconnect: original.preconnect })
    globalThis.fetch = installed
  }

  if (!allow)
    strict++

  let released = false

  return () => {
    if (released)
      return

    released = true

    if (!allow)
      strict--

    if (--open === 0) {
      // A fetch a test replaced itself stays as it set it.
      if (globalThis.fetch === installed)
        globalThis.fetch = original!

      stubs.length = 0
    }
  }
}

export function stubFetch(routes: FetchStubRoutes): FetchStub {
  const stub: Stub = { routes: Object.entries(routes).map(([key, answer]) => routeOf(key, answer)), requests: [] }

  stubs.push(stub)

  return { requests: stub.requests }
}

export function clearStubs(): void {
  stubs.length = 0
}
