// What a `kay/test` page does with the network: the responses it received, requests a test answers or refuses, and going offline. Built on DevTools' Network and Fetch domains, through the view's `cdp()`.

// A response the page received, its headers lowercased as the wire carried them.
export interface PageResponse {
  url: string
  method: string
  status: number
  // What asked for it, lowercased as DevTools names it: `document`, `fetch`, `xhr`, `script`, `stylesheet`, `image`, `eventsource`...
  type: string
  // As sent, those the browser adds itself included (`accept-encoding`, `available-dictionary`, `cookie`).
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  // Whether the whole body arrived, or the request ended without it; false while a body is still coming, and for good for one that never ends, such as an event stream.
  complete: boolean
}

// What a request is answered with in place of the server's.
export interface FulfillOptions {
  // 200 unless given.
  status?: number | undefined
  headers?: Record<string, string> | undefined
  // Text, or bytes. Its `content-length` is the browser's to compute, and the one in `headers` is left out.
  body?: string | Uint8Array | undefined
  // A value sent as JSON, with a JSON `content-type` unless `headers` gives one.
  json?: unknown
}

// The server's answer to a routed request, decoded.
export interface FetchedResponse {
  status: number
  // Without `content-encoding` and `content-length`, which describe the encoded body rather than this one.
  headers: Record<string, string>
  body: Uint8Array
  text: () => string
}

// A request the page made that a route matched, answered by one call of `fulfill`, `abort` or `continue`, else continued when the handler returns.
export interface PageRequest {
  url: string
  method: string
  type: string
  // As the page set them, before the browser adds its own.
  headers: Record<string, string>
  body: string | undefined
  // Lets the request reach the server and resolves with its answer, which stays held until this request is fulfilled or continued, so a handler can pass it on changed.
  fetch: () => Promise<FetchedResponse>
  fulfill: (options?: FulfillOptions) => Promise<void>
  // Fails the request as a network error does, with a reason of DevTools' `Network.ErrorReason` in lowerCamelCase or kebab-case: `failed` unless given, `connectionrefused`, `timedout`, `accessdenied`, `internetdisconnected`...
  abort: (reason?: string) => Promise<void>
  // Sends the request on, with headers replaced when given.
  continue: (options?: { headers?: Record<string, string> | undefined }) => Promise<void>
}

export type RouteMatch = string | RegExp | ((url: URL) => boolean)
export type RouteHandler = (request: PageRequest) => void | Promise<void>

interface Rule {
  match: RouteMatch
  test: (url: URL) => boolean
  handler: RouteHandler
}

interface Inflight {
  url: string
  method: string
  type: string
  headers: Record<string, string>
  entry?: PageResponse | undefined
  finished?: boolean | undefined
  wire?: Record<string, string> | undefined
  answer?: { status: number, headers: Record<string, string> } | undefined
}

interface Paused {
  requestId: string
  request: { url: string, method: string, headers: Record<string, string>, postData?: string }
  resourceType: string
  networkId?: string
  responseStatusCode?: number
  responseHeaders?: { name: string, value: string }[]
  responseErrorReason?: string
}

type Listener = (event: Event) => void

export interface NetworkView {
  addEventListener: (name: string, listener: Listener) => void
}

export interface NetworkOptions {
  view: NetworkView
  // The page's DevTools commands, one at a time, failing at once once the renderer crashed.
  cdp: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  // The origin a path pattern matches.
  origin: () => string
  // Where a failing handler is reported, as the page's other problems are.
  errors: string[]
  timeout: number
}

export interface Network {
  responses: PageResponse[]
  route: (match: RouteMatch, handler: RouteHandler) => Promise<void>
  unroute: (match?: RouteMatch) => Promise<void>
  offline: (offline: boolean) => Promise<void>
  waitForResponse: (match: RouteMatch, options?: { timeout?: number | undefined, complete?: boolean | undefined }) => Promise<PageResponse>
  // Releases what is paused and stops answering, once the page closed.
  close: () => void
}

const NO_THROTTLE = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
const GLOB_SPECIAL = /[.+^${}()|[\]\\?]/g
const STAR = /\*+/g
// What a body no longer has once decoded.
const ENCODING = new Set(['content-encoding', 'content-length'])
// How long a paused request waits to be announced by the Network domain before it is typed as the Fetch domain names it.
const ANNOUNCE_WAIT_MS = 500
// How long a finished response waits for the extra info that carries its wire headers.
const EXTRA_GRACE_MS = 200
const KEBAB = /-([a-z])/g

export function createNetwork({ view, cdp, origin, errors, timeout }: NetworkOptions): Network {
  const responses: PageResponse[] = []
  const inflight = new Map<string, Inflight>()
  const rules: Rule[] = []
  // Requests a handler asked the answer of, resolved when their response pauses.
  const awaited = new Map<string, PromiseWithResolvers<Paused>>()
  const watchers = new Set<() => void>()
  const timers = new Set<Timer>()
  // Waiting on the Network domain to announce a request the Fetch domain paused first.
  const sightings = new Map<string, () => void>()
  let closed = false
  let fetching = false

  const event = <T>(name: string, listener: (data: T) => void) => view.addEventListener(name, (message) => {
    if (!closed)
      listener((message as MessageEvent<T>).data)
  })

  const publish = (state: Inflight, status: number, headers: Record<string, string>, requestHeaders: Record<string, string>, complete = false) => {
    const entry: PageResponse = { url: state.url, method: state.method, status, type: state.type, requestHeaders, responseHeaders: headers, complete }

    responses.push(entry)

    for (const watcher of watchers)
      watcher()

    return entry
  }

  // Chrome sends a request's extra info before or after the event it completes, so what arrives first waits in a state of its own.
  const stateOf = (requestId: string): Inflight => {
    const known = inflight.get(requestId)

    if (known !== undefined)
      return known

    const fresh: Inflight = { url: '', method: 'GET', type: '', headers: {} }

    inflight.set(requestId, fresh)

    return fresh
  }

  const complete = (state: Inflight) => {
    if (state.entry === undefined || state.entry.complete)
      return

    state.entry.complete = true

    for (const watcher of watchers)
      watcher()
  }

  // Complete once the body arrived and the wire's headers are known.
  const settled = (state: Inflight) => {
    if (state.finished === true && state.wire !== undefined && state.answer !== undefined)
      complete(state)
  }

  event<{ requestId: string, type?: string, request: { url: string, method: string, headers: Record<string, string> }, redirectResponse?: { status: number, headers: Record<string, string>, requestHeaders?: Record<string, string> } }>('Network.requestWillBeSent', ({ requestId, type, request, redirectResponse }) => {
    const previous = inflight.get(requestId)

    // A redirect is a response of its own, answered before the next request is sent, and the next hop starts afresh.
    if (redirectResponse !== undefined && previous !== undefined) {
      publish(previous, redirectResponse.status, lowercase(redirectResponse.headers), lowercase(redirectResponse.requestHeaders ?? previous.headers), true)
      inflight.delete(requestId)
    }

    Object.assign(stateOf(requestId), { url: request.url, method: request.method, type: (type ?? 'other').toLowerCase(), headers: lowercase(request.headers) })
    sightings.get(requestId)?.()
  })
  event<{ requestId: string, headers: Record<string, string> }>('Network.requestWillBeSentExtraInfo', ({ requestId, headers }) => {
    const state = stateOf(requestId)

    state.wire = lowercase(headers)

    if (state.entry !== undefined)
      state.entry.requestHeaders = state.wire

    settled(state)
  })
  event<{ requestId: string, statusCode: number, headers: Record<string, string> }>('Network.responseReceivedExtraInfo', ({ requestId, statusCode, headers }) => {
    const state = stateOf(requestId)

    state.answer = { status: statusCode, headers: lowercase(headers) }

    if (state.entry?.status === statusCode)
      state.entry.responseHeaders = state.answer.headers

    settled(state)
  })
  event<{ requestId: string, type?: string, response: { url: string, status: number, headers: Record<string, string>, requestHeaders?: Record<string, string> } }>('Network.responseReceived', ({ requestId, type, response }) => {
    const state = stateOf(requestId)

    if (type !== undefined)
      state.type = type.toLowerCase()

    // The wire's, when DevTools already sent them; else what the network stack reports, which holds the browser's headers too.
    const wire = state.wire ?? lowercase(response.requestHeaders ?? state.headers)
    const answer = state.answer?.status === response.status ? state.answer.headers : lowercase(response.headers)

    state.entry = publish({ ...state, url: response.url }, response.status, answer, wire)
  })

  const ended = ({ requestId }: { requestId: string }) => {
    const state = inflight.get(requestId)

    if (state === undefined)
      return

    state.finished = true

    // A response that had no extra info, from the cache or a route, is complete after a moment instead.
    if (state.wire === undefined || state.answer === undefined)
      timers.add(setTimeout(complete, EXTRA_GRACE_MS, state))
    else
      complete(state)
  }

  event<{ requestId: string }>('Network.loadingFinished', ended)
  event<{ requestId: string }>('Network.loadingFailed', ended)

  // A call of the view while the page is open: the page closing on a paused request is not the test's failure.
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (closed)
      return

    try {
      await cdp(method, params)
    }
    catch (error) {
      if (!closed)
        throw error
    }
  }

  // What a request is, as the Network domain names it: it announces the request after or before the Fetch domain pauses it, and the Fetch domain calls a fetch() call `XHR`.
  const typeOf = async (paused: Paused): Promise<string> => {
    const id = paused.networkId
    const fallback = paused.resourceType.toLowerCase()

    if (id === undefined)
      return fallback

    if (!inflight.has(id)) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const timer = setTimeout(resolve, ANNOUNCE_WAIT_MS)

      sightings.set(id, resolve)
      await promise
      clearTimeout(timer)
      sightings.delete(id)
    }

    return inflight.get(id)?.type ?? fallback
  }

  const request = (paused: Paused, type: string): { routed: PageRequest, answered: () => boolean } => {
    let settled = false
    const once = async (run: () => Promise<void>) => {
      if (settled)
        throw new Error('kay: the request was already answered')

      settled = true
      await run()
    }
    const requestId = paused.requestId

    const routed: PageRequest = {
      url: paused.request.url,
      method: paused.request.method,
      type,
      headers: lowercase(paused.request.headers),
      body: paused.request.postData,
      fetch: async () => {
        if (settled)
          throw new Error('kay: the request was already answered')

        const response = Promise.withResolvers<Paused>()

        awaited.set(requestId, response)
        await send('Fetch.continueRequest', { requestId })

        const answer = await response.promise

        if (answer.responseErrorReason !== undefined)
          throw new Error(`kay: the request to ${paused.request.url} failed: ${answer.responseErrorReason}`)

        const { body, base64Encoded } = await cdp<{ body: string, base64Encoded: boolean }>('Fetch.getResponseBody', { requestId })
        const bytes = base64Encoded ? Uint8Array.fromBase64(body) : new TextEncoder().encode(body)

        return {
          status: answer.responseStatusCode ?? 0,
          headers: Object.fromEntries((answer.responseHeaders ?? []).map(({ name, value }) => [name.toLowerCase(), value]).filter(([name]) => !ENCODING.has(name!))),
          body: bytes,
          text: () => new TextDecoder().decode(bytes),
        }
      },
      fulfill: async (options = {}) => once(async () => {
        const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'content-length'))
        const body = options.json === undefined ? options.body : JSON.stringify(options.json)

        if (options.json !== undefined && !Object.keys(headers).some(name => name.toLowerCase() === 'content-type'))
          headers['content-type'] = 'application/json'

        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body

        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: options.status ?? 200,
          responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
          ...bytes === undefined ? {} : { body: bytes.toBase64() },
        })
      }),
      abort: async reason => once(async () => send('Fetch.failRequest', { requestId, errorReason: errorReason(reason) })),
      continue: async (options = {}) => once(async () => send('Fetch.continueRequest', {
        requestId,
        ...options.headers === undefined ? {} : { headers: Object.entries(options.headers).map(([name, value]) => ({ name, value })) },
      })),
    }

    return { routed, answered: () => settled }
  }

  const answer = async (paused: Paused): Promise<void> => {
    const waiting = awaited.get(paused.requestId)

    // The response of a request a handler fetched; any other response pauses only because both stages are watched.
    if (paused.responseStatusCode !== undefined || paused.responseErrorReason !== undefined) {
      if (waiting === undefined)
        return send('Fetch.continueRequest', { requestId: paused.requestId })

      awaited.delete(paused.requestId)
      waiting.resolve(paused)

      return
    }

    const url = new URL(paused.request.url)
    const rule = rules.findLast(({ test }) => test(url))

    if (rule === undefined)
      return send('Fetch.continueRequest', { requestId: paused.requestId })

    const { routed, answered } = request(paused, await typeOf(paused))

    try {
      await rule.handler(routed)

      // A handler that answered nothing lets the request through.
      if (!answered())
        await routed.continue()
    }
    catch (error) {
      if (closed)
        return

      errors.push(`kay: a route handler for ${paused.request.url} failed: ${error instanceof Error ? error.message : String(error)}`)

      if (!answered()) {
        try {
          await send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'Failed' })
        }
        catch {}
      }
    }
  }

  event<Paused>('Fetch.requestPaused', (paused) => {
    void answer(paused)
  })

  const enable = async () => {
    if (fetching)
      return

    fetching = true
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*', requestStage: 'Response' }] })
  }

  const matches = (match: RouteMatch): ((url: URL) => boolean) => {
    if (typeof match === 'function')
      return match

    if (match instanceof RegExp)
      return url => match.test(url.href)

    const pattern = new RegExp(`^${match.replace(GLOB_SPECIAL, '\\$&').replace(STAR, '.*')}$`)

    // A path, or a path and query, on the page's own site; else a whole URL.
    if (match.startsWith('/'))
      return url => url.origin === origin() && pattern.test(match.includes('?') ? url.pathname + url.search : url.pathname)

    return url => pattern.test(url.href)
  }

  return {
    responses,
    route: async (match, handler) => {
      rules.push({ match, test: matches(match), handler })
      await enable()
    },
    unroute: async (match) => {
      for (let at = rules.length - 1; at >= 0; at--) {
        if (match === undefined || rules[at]!.match === match)
          rules.splice(at, 1)
      }

      if (rules.length === 0 && fetching) {
        fetching = false
        await send('Fetch.disable')
      }
    },
    offline: async offline => send('Network.emulateNetworkConditions', { offline, ...NO_THROTTLE }),
    waitForResponse: async (match, options = {}) => {
      const test = matches(match)
      const found = () => responses.find(({ url, complete }) => test(new URL(url)) && (complete || options.complete === false))
      const { promise, resolve } = Promise.withResolvers<void>()
      const watcher = () => found() === undefined || resolve()
      const wait = options.timeout ?? timeout

      watchers.add(watcher)

      try {
        if (found() === undefined) {
          const timer = setTimeout(resolve, wait)

          await promise
          clearTimeout(timer)
        }

        const response = found()

        if (response === undefined)
          throw new Error(`kay: timed out after ${wait}ms waiting for a response matching ${String(match)}`)

        return response
      }
      finally {
        watchers.delete(watcher)
      }
    },
    close: () => {
      closed = true
      rules.length = 0

      for (const timer of timers)
        clearTimeout(timer)

      for (const waiting of awaited.values())
        waiting.reject(new Error('kay: the page closed'))

      awaited.clear()
    },
  }
}

function lowercase(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
}

// DevTools' `Network.ErrorReason`, such as `ConnectionRefused`, from `connectionrefused`, `connection-refused` or the exact name.
function errorReason(reason = 'failed'): string {
  const known = ['Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed', 'ConnectionReset', 'ConnectionRefused', 'ConnectionAborted', 'ConnectionFailed', 'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable', 'BlockedByClient', 'BlockedByResponse']
  const plain = reason.replace(KEBAB, '$1').toLowerCase()

  return known.find(name => name.toLowerCase() === plain) ?? 'Failed'
}
