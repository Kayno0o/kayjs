import type { CallResult } from './call-result'
import { ApiError, apiErrorOf, failed, refused, textOf, unreachable } from './api-error'
import { withBase } from './base'
import { trackCalls } from './call-result'
import { connection, listenerSet } from './connection'
import { effect, onCleanup, onMount, ownSignal, untrack } from './reactive'
import { parseEvents, sendableId } from './sse'
import { decodeServerValue } from './wire'

// Set by the server on every module it mounts under `/api`, and by the browser build on the stub standing in for one: where the module's routes are served.
export const API_MOUNT = Symbol.for('kay.api')

// Type only: what each value an event stream sends is.
declare const EVENTS: unique symbol

// What `eventStream()` from `kay/server` answers with: a stream of values `stream()` reads in an island, typed.
export type EventStream<T> = Response & { readonly [EVENTS]: T }

// The event closing a stream that ran to its end, and the one closing a stream whose source threw.
export const END_EVENT = 'end'
export const ERROR_EVENT = 'error'

// The close code of a connection either side ended on purpose, which is not reconnected.
const NORMAL_CLOSURE = 1000
// Where the close codes an application chooses for a refusal start: 4000 plus an HTTP status.
const REFUSED_CODES = 4000
// What a socket keeps to send while it connects, the oldest dropped past it: half the 100 messages a second a route takes by default, so the flush after a reconnect stays under it.
const MAX_QUEUED = 50
// What Elysia's websocket parser reads as JSON, by first character: `"`, `[`, `{`.
const JSON_START = /^["[{]/
const NUMERIC = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i
const PARAM_SEGMENT = /^:(.+)$/
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i
// An answer without a type, an empty one say, reads as text too.
const TEXT_TYPE = /^(?:text\/|$)/i

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'connect' | 'trace' | 'all' | 'subscribe'

// The route tree of a module's default export, or of what the function an extension's module exports builds, as `ApiRoutesOf` reads it for `kay check`.
type RoutesOf<Module> = (Module extends (...args: never[]) => infer Built ? Awaited<Built> : Module) extends { '~Routes': infer Routes } ? Routes : never

// One less, to stop walking a route tree past any depth an app reaches, and never instantiate it without end while `Module` is still generic.
type Shallower = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

// The keys of a node that are its methods' routes, a path segment named like a method, `/post`, being none.
type RouteKey<Node> = { [Key in keyof Node & Method]: Node[Key] extends { response: unknown } ? Key : never }[keyof Node & Method]
type RouteField = 'body' | 'params' | 'query' | 'headers' | 'response'
// What a key leads down to: a segment's node, or what a method's route holds besides itself, the segments of a path named like the method, `/post/:id` beside a POST to `/`.
type Below<Tree, Key extends keyof Tree> = Key extends RouteKey<Tree> ? Omit<Tree[Key], RouteField> : Tree[Key]

// Every node of an Elysia route tree with the path reaching it: keys are path segments down to the methods.
type Nodes<Tree, Path extends string = '', Depth extends number = 10> = [Depth] extends [never] ? never : { path: Path extends '' ? '/' : Path, node: Tree } | {
  [Key in keyof Tree & string]: [keyof Below<Tree, Key>] extends [never] ? never : Nodes<Below<Tree, Key>, `${Path}/${Key}`, Shallower[Depth]>
}[keyof Tree & string]

export type NodeAt<Module, Path> = Extract<Nodes<RoutesOf<Module>>, { path: Path }>['node']

// The websocket routes of a module, as it declares them: `'/:room'`.
export type SocketPath<Module> = Extract<Nodes<RoutesOf<Module>>, { node: { subscribe: unknown } }>['path']
type SocketRoute<Module, Path> = NodeAt<Module, Path> extends { subscribe: infer Route } ? Route : never

export type StreamMethod<Node> = { [M in RouteKey<Node>]: Node[M] extends { response: { 200: EventStream<unknown> } } ? M : never }[RouteKey<Node>]

// The routes of a module answering with `eventStream()`.
export type StreamPath<Module> = Nodes<RoutesOf<Module>> extends infer Found ? Found extends { path: infer Path, node: infer Node } ? [StreamMethod<Node>] extends [never] ? never : Path : never : never
// The route a method of a path answers with.
type MethodRoute<Module, Path, M> = NodeAt<Module, Path> extends infer Node ? M extends RouteKey<Node> ? Node[M] : never : never
type StreamValue<Route> = Route extends { response: { 200: EventStream<infer Value> } } ? Value : never

// What the route's schema asks of the URL: params a path names are required, a query only when its schema requires one.
type UrlOptions<Route> = (Route extends { params: infer Params } ? Record<never, never> extends Params ? { params?: Params } : { params: Params } : { params?: Record<string, unknown> })
  & (Route extends { query: infer Query } ? unknown extends Query ? { query?: Record<string, unknown> } : Record<never, never> extends Query ? { query?: Query } : { query: Query } : { query?: Record<string, unknown> })

// A route answering nothing, `() => {}`, declares no response at all.
type Received<Route> = Route extends { response: infer Responses } ? Responses extends { 200: infer Message } ? Message : keyof Responses extends never ? undefined : unknown : unknown
type Sent<Route> = Route extends { body: infer Body } ? Body : unknown
type Body<Route> = Route extends { body: infer Input } ? unknown extends Input ? { body?: unknown } : { body: Input } : { body?: unknown }

// Options a caller may leave out altogether when none of them is required.
export type Optional<Options> = Record<never, never> extends Options ? [options?: Options] : [options: Options]

// What a value read once is: `idle` before it was asked for, `loading` while it is, `ready` once it answered and `failed` when it could not.
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed'

// What a connection is: `idle` until a lazy one starts, `connecting` while it is made or waits to be made again, `open`, `done` once it ran to its end, `failed` when it was refused or its source threw and `closed` once `close()` was called.
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'done' | 'failed' | 'closed'

// What every source an island reads shares, so one block shows any of them: `button(onClick={notes.retry} disabled={notes.pending()}) Retry`.
export interface Source<S extends LoadStatus | ConnectionStatus = LoadStatus | ConnectionStatus> {
  status: () => S
  // Whether it is loading or connecting, a quiet reload included.
  pending: () => boolean
  // The last failure, kept until the next success.
  error: () => ApiError | undefined
  // Tries again now, skipping any backoff; does nothing unless it failed or waits to try again.
  retry: () => void
}

export type SocketStatus = 'connecting' | 'open' | 'failed' | 'closed'

export interface Socket<Send, Receive> extends Source<SocketStatus> {
  // Sent at once while open, otherwise once the connection opens.
  send: (message: Send) => void
  // The last message received, read reactively; undefined before the first.
  last: () => Receive | undefined
  // `failed` when the server closed it with a code from 4000 to 4999, its `error().status` the code minus 4000; any other drop reconnects.
  status: () => SocketStatus
  // Called with every message received; returns what stops it.
  on: (listener: (message: Receive) => void) => () => void
  // Called each time the connection opens, a reconnect included, before what was queued goes: where a client joins its rooms again, or refetches what it missed (`reconnected` is true after the first open). Returns what stops it.
  onOpen: (listener: (reconnected: boolean) => void) => () => void
  // Closes for good: no reconnecting after.
  close: () => void
}

export interface EventReader<T> extends Source<ConnectionStatus> {
  // The last value received, read reactively; undefined before the first.
  last: () => T | undefined
  // `idle` until a stream opened with `start: false` starts, `done` once it ran to its end, `failed` when it was refused or its source threw, `closed` once `close()` was called.
  status: () => ConnectionStatus
  on: (listener: (value: T) => void) => () => void
  // Called each time the stream opens, a reconnect included (`reconnected` is true after the first open): where an island refetches what a drop may have lost, when the route sends no ids to resume from. Returns what stops it.
  onOpen: (listener: (reconnected: boolean) => void) => () => void
  close: () => void
}

// A message as Elysia sends it: an object as JSON, anything else as its text, which its own parser reads back the same way.
function readMessage(data: unknown): unknown {
  if (typeof data !== 'string')
    return data

  if (JSON_START.test(data)) {
    try {
      return JSON.parse(data)
    }
    catch {
      return data
    }
  }

  if (NUMERIC.test(data))
    return Number(data)

  if (data === 'true')
    return true

  if (data === 'false')
    return false

  return data === 'null' ? null : data
}

// The handler a message's `type` names, given the message: one function per type in place of a `switch`, every type handled, as the compiler checks.
// A type no handler names, such as one a newer server sends, throws, saying which.
// kept: request
export function dispatch<Message extends { type: string }, Handlers extends { [Type in Message['type']]: (message: Extract<Message, { type: Type }>) => unknown }>(message: Message, handlers: Handlers): ReturnType<Handlers[Message['type']]> {
  if (!Object.hasOwn(handlers, message.type))
    throw new TypeError(`kay: dispatch() has no handler for a message of type ${message.type}`)

  return (handlers[message.type as Message['type']] as unknown as (message: Message) => ReturnType<Handlers[Message['type']]>)(message)
}

// A websocket that reconnects after a drop, waiting longer each time, until `close()`; `connect` gives none where there is nothing to connect from.
export function openSocket<Send, Receive>(connect: () => WebSocket | undefined): Socket<Send, Receive> & { start: () => void } {
  const link = connection<Receive>(start, true)
  const opened = listenerSet<boolean>()
  const queued: string[] = []
  let current: WebSocket | undefined
  let closed = false
  let opens = 0

  function start() {
    if (closed || current)
      return

    const ws = connect()

    if (!ws)
      return

    current = ws
    ws.addEventListener('open', () => {
      link.reset()
      link.set('open')
      opened.emit(opens++ > 0)

      for (const message of queued.splice(0))
        ws.send(message)
    })
    ws.addEventListener('message', event => link.receive(readMessage(event.data) as Receive))
    ws.addEventListener('close', (event) => {
      current = undefined

      if (closed || event.code === NORMAL_CLOSURE) {
        closed = true
        link.set('closed')

        return
      }

      // The server refused on purpose: a code of its own, 4000 plus the status, is not worth reconnecting for.
      if (event.code >= REFUSED_CODES && event.code < REFUSED_CODES + 1000) {
        const reason = event.reason

        link.fail(failed(event.code - REFUSED_CODES, reason === '' ? `The server closed the connection with ${event.code}` : reason))

        return
      }

      link.lost()
    })
  }

  return {
    start,
    send: (message) => {
      const text = JSON.stringify(message)

      if (current?.readyState === WebSocket.OPEN)
        current.send(text)
      else if (!closed && queued.push(text) > MAX_QUEUED)
        queued.shift()
    },
    last: link.last,
    status: link.status as () => SocketStatus,
    pending: link.pending,
    error: link.error,
    retry: () => {
      if (!closed && !current)
        link.retry()
    },
    on: link.on,
    onOpen: listener => opened.on(listener),
    close: () => {
      closed = true
      queued.length = 0
      link.stop()
      link.set('closed')
      current?.close(NORMAL_CLOSURE)
    },
  }
}

// A refused stream response as an `ApiError`: its JSON or text as the data, read without the route-call machinery a stream page does not otherwise load.
async function refusalOf(response: Response): Promise<ApiError> {
  let data: unknown

  try {
    data = await response.text()
    data = JSON.parse(data as string)
  }
  catch {}

  const message = textOf(data, response.statusText || `HTTP ${response.status}`)

  return new ApiError(response.status, message, data, { '': message })
}

// The header a reconnecting stream sends so its route can continue after the last event it took, which `readEvents` keeps only when `sendableId` accepts it.
export function resumeHeaders(lastEventId: string | undefined): Record<string, string> {
  return lastEventId === undefined ? {} : { 'last-event-id': lastEventId }
}

// The statuses of a server or a proxy that is restarting (502, 503, 504), which a GET stream waits out where any other refusal ends it.
export const whileRestarting = (status: number) => status > 501 && status < 505

// An event stream read as it arrives, through `request`, given the id of the last event taken to send as `resumeHeaders` does; a GET stream that drops reconnects, a stream that ran to its end or failed stays as it is; with `retryRefused`, a response that is not ok (or, given a function, one whose status it accepts) is tried again after the backoff too, as a stream across a restart needs.
// `start()` opens it once; given a request, it opens a new run of it, closing the one going and forgetting its last value and its last id.
export function readEvents<T>(request: (signal: AbortSignal, lastEventId?: string) => Promise<Response>, reconnect: boolean, idle = false, retryRefused: boolean | ((status: number) => boolean) = false): EventReader<T> & { start: (next?: (signal: AbortSignal, lastEventId?: string) => Promise<Response>) => void } {
  let run: AbortController | undefined
  let started = false
  let lastId: string | undefined
  let opens = 0

  const opened = listenerSet<boolean>()
  const link = connection<T>(() => void read(run!), reconnect, idle)

  // An empty id resets it, as the standard says, and so does one the next request could not send.
  const remember = (id: string) => {
    lastId = sendableId(id) ? id : undefined
  }

  const onEvent = (event: string, data: string, id?: string): ConnectionStatus | undefined => {
    if (event === END_EVENT)
      return 'done'

    if (event === ERROR_EVENT) {
      link.fail(failed(0, 'The stream failed on the server'))

      return 'failed'
    }

    let value: T

    try {
      value = decodeServerValue(data) as T
    }
    catch (error) {
      console.error('kay: an event stream sent a value that does not decode', error)
      link.fail(failed(0, 'The stream sent a value that does not decode', error))

      return 'failed'
    }

    // Only a stream that delivered something counts as back, so one dropping as soon as it opens keeps backing off.
    link.reset()

    if (id !== undefined)
      remember(id)

    link.receive(value)

    return undefined
  }

  async function read(controller: AbortController) {
    let ended: ConnectionStatus | undefined
    let failure: ApiError | undefined

    try {
      const response = await request(controller.signal, lastId)

      if (controller.signal.aborted) {
        void response.body?.cancel()

        return
      }

      if (!response.ok || !response.body) {
        const refusal = await refusalOf(response)

        // Superseded or closed while the body was read: the run that took over owns the state.
        if (controller.signal.aborted)
          return

        if (retryRefused === false || (retryRefused !== true && !retryRefused(response.status))) {
          link.fail(refusal)

          return
        }

        // Refused, as a server is while it restarts or a proof is stale: tried again after the backoff.
        failure = refusal
      }
      else {
        link.set('open')
        opened.emit(opens++ > 0)
        ended = await parseEvents(response.body, controller.signal, onEvent, remember)
      }
    }
    catch (thrown) {
      failure = thrown instanceof ApiError ? thrown : unreachable(thrown)
    }

    if (controller.signal.aborted || ended === 'failed')
      return

    if (ended)
      link.set(ended)
    else
      link.lost(failure ?? (reconnect ? undefined : failed(0, 'The connection was lost')))
  }

  return {
    start: (next) => {
      if (next)
        request = next
      else if (started)
        return

      if (next && started) {
        link.forget()
        lastId = undefined
        opens = 0
      }

      started = true
      link.stop()
      run?.abort()
      run = new AbortController()
      link.restart()
      void read(run)
    },
    last: link.last,
    status: link.status,
    pending: link.pending,
    error: link.error,
    retry: () => link.retry(() => {
      link.stop()
      run?.abort()
      run = new AbortController()
      void read(run)
    }),
    on: link.on,
    onOpen: opened.on,
    close: () => {
      link.stop()
      link.set('closed')
      run?.abort()
    },
  }
}

interface UrlInput {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
}

// Where a module's route is served: its params filled in, its query appended.
export function routeUrl(module: unknown, path: string, options: UrlInput = {}): string {
  const mount = (module as { [API_MOUNT]?: string } | undefined)?.[API_MOUNT]

  if (mount === undefined)
    throw new TypeError('kay: socket(), stream(), resource(), call() and apiUrl() take the default export of a module under src/api')

  const segments = path.split('/').map((segment) => {
    if (segment === '*')
      return String(options.params?.['*'] ?? '').split('/').map(part => encodeSegment(part, path)).join('/')

    const param = PARAM_SEGMENT.exec(segment)?.[1]

    if (param === undefined)
      return segment

    const value = options.params?.[param]

    if (value === undefined)
      throw new TypeError(`kay: ${path} takes the param ${param}`)

    if (value === '')
      throw new TypeError(`kay: ${path} cannot take an empty ${param}, it would reach the collection route`)

    return encodeSegment(String(value), path)
  })
  const query = new URLSearchParams()

  for (const [name, value] of Object.entries(options.query ?? {})) {
    for (const item of Array.isArray(value) ? value as unknown[] : [value]) {
      if (item !== undefined && item !== null)
        query.append(name, fieldText(item))
    }
  }

  const search = query.size > 0 ? `?${query}` : ''
  const joined = segments.join('/')

  return `${mount}${joined === '/' ? '' : joined}${search}`
}

// Where a route of a module under `src/api` is served, its params filled in and its query appended, under the site's `base` in the browser: the path follows `apiPath`, so code naming a route never writes `/api/...`. On the server the module must be mounted, which a prerender never does.
// A handler passes its `request` for the module it runs in, which it cannot name inside its own chain.
// kept: request, it names a route of a module the running server mounted, which a prerender never loads.
export function apiUrl(module: unknown, path = '/', options: UrlInput = {}): string {
  return withBase(routeUrl(module, path, options))
}

// A dot segment would be resolved by the URL parser and reach the parent route.
function encodeSegment(value: string, path: string): string {
  if (value === '.' || value === '..')
    throw new TypeError(`kay: ${path} cannot take "${value}" as a param, it would reach the parent route`)

  return encodeURIComponent(value)
}

// A value as a form field or a query param carries it: a Date as its ISO text, an object as JSON.
function fieldText(value: unknown): string {
  if (value instanceof Date)
    return value.toISOString()

  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

export type SocketOptions<Module, Path> = UrlOptions<SocketRoute<Module, Path>>
export type SocketOf<Module, Path> = Socket<Sent<SocketRoute<Module, Path>>, Received<SocketRoute<Module, Path>>>

// Opens a websocket route of a module under `src/api` from an island, once it is in the page: messages typed both ways from the route's `body` and `response` schemas, sent as Elysia reads them.
// Reconnects after a drop, and closes with the component that opened it.
// kept: request
export function socket<Module, const Path extends SocketPath<Module>>(module: Module, path: Path, ...[options]: Optional<SocketOptions<Module, Path>>): SocketOf<Module, Path> {
  // The URL is made in the browser only, as a page prerendering the island imports the module unmounted; a refused param throws here, at the call, rather than from the mount.
  const route = typeof document === 'undefined' ? undefined : routeUrl(module, path, options as UrlInput | undefined)
  const client = openSocket<Sent<SocketRoute<Module, Path>>, Received<SocketRoute<Module, Path>>>(() => {
    if (route === undefined)
      return undefined

    const target = new URL(withBase(route), location.href)

    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'

    return new WebSocket(target)
  })

  onMount(client.start)
  onCleanup(client.close)

  return client
}

// The method a stream is read with: GET unless the options name another.
export type Chosen<M> = [M] extends [never] ? 'get' : M

// The request reading a stream: its method, GET unless named, and its body as `call()` sends one.
export function streamRequest(options: unknown): RequestInit & { method: string, headers: Record<string, string> } {
  const { method = 'get', body } = (options ?? {}) as { method?: string, body?: unknown }
  const sent = callBody(body)

  return { method: method.toUpperCase(), headers: { accept: 'text/event-stream', ...sent.headers }, body: sent.body ?? null }
}

export type StreamOf<Module, Path, M> = EventReader<StreamValue<MethodRoute<Module, Path, Chosen<M>>>>
export type StreamOptions<Module, Path, M> = MethodOption<NodeAt<Module, Path>, M> & UrlOptions<MethodRoute<Module, Path, Chosen<M>>> & Body<MethodRoute<Module, Path, Chosen<M>>>
// What each run of a stream opened with `start: false` takes: the URL's params and query, and a body, which may be a `FormData`.
export type StreamStartOptions<Module, Path, M> = UrlOptions<MethodRoute<Module, Path, Chosen<M>>> & CallBody<MethodRoute<Module, Path, Chosen<M>>>

export interface StreamRun<T, Options> extends EventReader<T> {
  // Opens a run, closing the one going and forgetting its last value: from a handler, as a click starts a streamed answer.
  start: (...[options]: Optional<Options>) => void
}

// An async iterable read as it arrives, from the moment the island is in the page.
function iterate(source: (signal: AbortSignal) => AsyncIterable<unknown>): EventReader<unknown> {
  const link = connection<unknown>(() => void read(), false)
  const opened = listenerSet<boolean>()
  const controller = new AbortController()
  let opens = 0

  async function read() {
    if (controller.signal.aborted)
      return

    link.set('open')
    opened.emit(opens++ > 0)

    try {
      for await (const value of source(controller.signal)) {
        if (controller.signal.aborted)
          return

        link.receive(value)
      }

      if (!controller.signal.aborted)
        link.set('done')
    }
    catch (thrown) {
      if (!controller.signal.aborted)
        link.fail(apiErrorOf(thrown))
    }
  }

  const close = () => {
    link.set('closed')
    controller.abort()
  }

  onMount(() => {
    if (typeof document !== 'undefined')
      void read()
  })
  onCleanup(close)

  return { last: link.last, status: link.status, pending: link.pending, error: link.error, retry: () => link.retry(() => void read()), on: link.on, onOpen: opened.on, close }
}

// Reads a route of a module under `src/api` answering with `eventStream()` from an island, once it is in the page, or with `start: false` each time `start()` is called: each value typed as the route sends it, Dates, Maps and Sets included.
// A GET stream that drops reconnects; `close()` aborts the request, and a stream closes with the component that opened it.
// kept: request
export function stream<Module, const Path extends StreamPath<Module>, const M extends StreamMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, options: MethodOption<NodeAt<Module, Path>, M> & { start: false }): StreamRun<StreamValue<MethodRoute<Module, Path, Chosen<M>>>, StreamStartOptions<Module, Path, M>>
export function stream<Module, const Path extends StreamPath<Module>, const M extends StreamMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<StreamOptions<Module, Path, M>>): StreamOf<Module, Path, M>
// Reads any async iterable the same way, once the island is in the page: `source` gets a signal that aborts when `close()` is called or the component is gone, and it has to stop on it, as a source ignoring the signal is not released while it waits for its next value. The stream is `done` once the iterable ends and `failed` when it throws.
export function stream<T>(source: (signal: AbortSignal) => AsyncIterable<T>): EventReader<T>
export function stream(module: unknown, path?: string, options?: UrlInput & { method?: string, start?: boolean }): EventReader<unknown> {
  if (typeof module === 'function')
    return iterate(module as (signal: AbortSignal) => AsyncIterable<unknown>)

  if (path === undefined)
    throw new TypeError('kay: stream() takes the default export of a module under src/api and a path, or a function returning an async iterable')

  const lazy = options?.start === false
  const opened = (given: UrlInput | undefined) => {
    const init = streamRequest(given)

    return async (signal: AbortSignal, lastEventId?: string) => fetch(withBase(routeUrl(module, path, given)), { ...init, headers: { ...init.headers, ...resumeHeaders(lastEventId) }, signal })
  }

  // A refused param throws at the call and not inside the request, where a GET stream would retry it.
  if (!lazy && typeof document !== 'undefined')
    routeUrl(module, path, options)

  const reconnect = (options?.method ?? 'get') === 'get'
  const reader = readEvents(opened(options), reconnect, lazy, reconnect && whileRestarting)

  onMount(() => {
    if (!lazy && typeof document !== 'undefined')
      reader.start()
  })
  onCleanup(reader.close)

  if (!lazy)
    return reader

  const run: StreamRun<unknown, UrlInput> = {
    ...reader,
    start: (given) => {
      const next = { ...given, method: options.method }

      routeUrl(module, path, next)
      reader.start(opened(next))
    },
  }

  return run
}

// What a resource's status can be: it starts loading, so never idle.
type ResourceState = Exclude<LoadStatus, 'idle'>

export interface Resource<T> extends Source<ResourceState> {
  // What the route last answered, kept while it is asked again; undefined before the first answer.
  value: () => T | undefined
  // `loading` until the route answers, and again each time it is asked anew; `pending()` also reads a quiet reload that keeps `ready`.
  status: () => ResourceState
  // Why the last request failed as an `ApiError`, kept while the route is asked again until it answers. `retry()` asks again after a failure only.
  error: () => ApiError | undefined
  // Asks the route again with the same options, until the component that read it is gone, even when it is ready.
  refresh: () => void
}

// What a value is once it crossed as JSON: a Date arrives as its ISO text.
export type Jsonified<T> = T extends Date | bigint ? string : T extends readonly (infer Item)[] ? Jsonified<Item>[] : T extends object ? { [Key in keyof T]: Jsonified<T[Key]> } : T

type GetRoute<Module, Path> = NodeAt<Module, Path> extends { get: infer Route } ? Route : never

// Whether a route's answer reads back as it is typed: Elysia sends an object as JSON and a string as text, but a number, a boolean or null as bare text with no type to tell it from a string.
type Readable<Value> = unknown extends Value ? true : [Value] extends [EventStream<unknown>] ? false : [Value] extends [object | string] ? true : false

// The GET routes of a module that answer an object, an array or a string.
export type ResourcePath<Module> = Nodes<RoutesOf<Module>> extends infer Found ? Found extends { path: infer Path, node: { get: infer Route } } ? Route extends { response: { 200: infer Value } } ? Readable<Value> extends true ? Path : never : Path : never : never
export type ResourceOptions<Module, Path> = UrlOptions<GetRoute<Module, Path>>
export type ResourceOf<Module, Path> = Resource<GetRoute<Module, Path> extends { response: { 200: infer Value } } ? Jsonified<Value> : unknown>

// An answer as Elysia sends it: JSON for an object, text for anything else.
// What a route answered: JSON, text, or the bytes of anything else, a file say. A refusal whose JSON does not parse reads as its text, and an answer cut off throws an ApiError with status 0, unless the call was aborted.
export async function readAnswer(response: Response, signal?: AbortSignal): Promise<unknown> {
  const type = response.headers.get('content-type') ?? ''
  let text: string

  try {
    if (!JSON_TYPE.test(type) && !TEXT_TYPE.test(type))
      return await response.blob()

    text = await response.text()
  }
  catch (failure) {
    if (signal?.aborted === true)
      throw failure

    throw unreachable(failure)
  }

  if (!JSON_TYPE.test(type) || text === '')
    return text

  try {
    return JSON.parse(text) as unknown
  }
  catch {
    if (!response.ok)
      return text

    throw new ApiError(response.status, `kay: the route answered JSON that does not parse: ${text.slice(0, 80)}`, text)
  }
}

// Reads a GET route of a module under `src/api` from an island, once it is in the page, typed from the route. Options given as a function are read reactively: the route is asked again when a signal they read changes, and an answer a newer request overtook is dropped.
// kept: request
export function resource<Module, const Path extends ResourcePath<Module>>(module: Module, path: Path, ...[options]: Optional<ResourceOptions<Module, Path> | (() => ResourceOptions<Module, Path>)>): ResourceOf<Module, Path>
// Reads anything else the same way: `load` gets a signal that aborts when it is superseded or the component is gone, and the signals it reads before its first await are tracked, so it runs again when one changes. A throw is the `error()`, its `status` 0 unless it is an `ApiError`.
export function resource<T>(load: (signal: AbortSignal) => T | PromiseLike<T>): Resource<Awaited<T>>
export function resource(module: unknown, path?: string, options?: UrlInput | (() => UrlInput)): Resource<unknown> {
  const [value, setValue] = ownSignal<unknown>(undefined, { equals: false })
  const [status, setStatus] = ownSignal<ResourceState>('loading')
  const [error, setError] = ownSignal<ApiError | undefined>(undefined)
  const [busy, setBusy] = ownSignal(true)
  let current: AbortController | undefined
  let asked: ((signal: AbortSignal, fresh?: boolean) => unknown) | undefined
  let gone = false
  let followed = false

  // A reload made for a change keeps the status, and the value on failure, so it is swapped without a loading state in between; it skips the browser's cache.
  const load = async (read: (signal: AbortSignal, fresh?: boolean) => unknown, quiet = false) => {
    const controller = new AbortController()

    current?.abort()
    current = controller
    asked = read

    setBusy(true)

    if (!quiet)
      setStatus('loading')

    try {
      const answer = await read(controller.signal, quiet)

      if (controller.signal.aborted)
        return

      setValue(answer)
      setError(undefined)
      setStatus('ready')
      setBusy(false)
    }
    catch (failure) {
      if (controller.signal.aborted)
        return

      setBusy(false)

      if (quiet)
        return

      setError(apiErrorOf(failure))
      setStatus('failed')
    }
  }

  // Follows the cached values the route's handler read, from the proof its answer carried, or lets go of them when it carried none.
  const follow = async (proof: string | null) => {
    followed = proof !== null

    try {
      (await import('./live-cache')).followRoute(load, proof, async () => gone || load(asked!, true))
    }
    catch {}
  }

  // The server renders the island loading, as the browser does until the answer comes.
  if (typeof document !== 'undefined') {
    effect(() => {
      if (typeof module === 'function')
        return void load(module as (signal: AbortSignal) => unknown)

      const given = typeof options === 'function' ? options() : options

      return void load(async (signal, fresh) => {
        const url = withBase(routeUrl(module, path ?? '', given))
        let response: Response

        try {
          response = await fetch(url, { headers: { accept: 'application/json' }, signal, ...fresh && { cache: 'reload' } })
        }
        catch (failure) {
          throw signal.aborted ? failure : unreachable(failure)
        }

        const answer = await readAnswer(response, signal)

        if (!response.ok && !signal.aborted)
          throw refused(response, answer)

        const proof = response.headers.get('x-kay-live')

        if ((proof !== null || followed) && !signal.aborted && !gone)
          void follow(proof)

        return answer
      })
    })
  }

  onCleanup(() => {
    gone = true
    current?.abort()
    setBusy(false)

    if (followed)
      void follow(null)
  })

  return {
    value,
    status,
    pending: busy,
    error,
    refresh: () => asked === undefined || gone ? undefined : void load(asked),
    retry: () => {
      if (asked !== undefined && !gone && untrack(status) === 'failed')
        void load(asked)
    },
  }
}

export { ApiError }

// The methods a node answers over HTTP, a websocket's left out.
export type CallMethod<Node> = Exclude<RouteKey<Node>, 'subscribe'>

// The routes of a module answering over HTTP.
export type CallPath<Module> = Nodes<RoutesOf<Module>> extends infer Found ? Found extends { path: infer Path, node: infer Node } ? [CallMethod<Node>] extends [never] ? never : Path : never : never

// GET unless the options name another method, which a path answering no GET requires.
type MethodOption<Node, M> = 'get' extends RouteKey<Node> ? { method?: M } : { method: M }
type CallBody<Route> = Route extends { body: infer Input } ? unknown extends Input ? { body?: unknown } : { body: Input | FormData } : { body?: unknown }

export type ApiRequest<Module, Path, M> = MethodOption<NodeAt<Module, Path>, M> & UrlOptions<MethodRoute<Module, Path, Chosen<M>>> & CallBody<MethodRoute<Module, Path, Chosen<M>>>

export type ApiCallOptions<Module, Path, M> = ApiRequest<Module, Path, M> & {
  // Aborts the call, which rejects with the signal's reason.
  signal?: AbortSignal | undefined
  // Called as a body carrying files uploads, with how much of it went, from 0 to 1.
  progress?: ((sent: number) => void) | undefined
}

// What an answer reads back as: an object as JSON, a Date in it as its ISO text, while a number or a boolean arrives as the text Elysia sends, `null` as `null` and nothing (`undefined`, a 204) as ''.
// A file arrives as a Blob, or as text when its type is text; a Response the route built is read by its type, which the route's type does not say.
export type Answered<Value> = unknown extends Value ? unknown : Value extends EventStream<unknown> ? never : Value extends Response ? unknown : Value extends Blob ? Blob | string : Value extends string ? Value : Value extends number | boolean | bigint ? string : Value extends null ? null : Value extends undefined | void ? '' : Jsonified<Value>
export type ApiAnswer<Module, Path, M> = Answered<Received<MethodRoute<Module, Path, Chosen<M>>>>

// Calls a route of a module under `src/api`, from an event handler or any code running in the browser, typed from the route: resolves with what it answered, and throws an `ApiError` when it refused.
async function callApi<Module, const Path extends CallPath<Module>, const M extends CallMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<ApiCallOptions<Module, Path, M>>): Promise<ApiAnswer<Module, Path, M>> {
  const { method = 'get', body, signal, progress } = (options ?? {}) as { method?: string, body?: unknown, signal?: AbortSignal, progress?: (sent: number) => void }
  const url = withBase(routeUrl(module, path, options as UrlInput | undefined))
  const sent = callBody(body)
  const headers = { accept: 'application/json', ...sent.headers }
  let response: Response

  try {
    response = sent.body instanceof FormData && progress && typeof XMLHttpRequest !== 'undefined'
      ? await (await import('./upload')).uploaded(method.toUpperCase(), url, headers, sent.body, progress, signal)
      : await fetch(url, { method: method.toUpperCase(), headers, body: sent.body ?? null, ...signal && { signal } })
  }
  catch (failure) {
    if (signal?.aborted === true)
      throw failure

    throw unreachable(failure)
  }

  const answer = await readAnswer(response, signal)

  if (!response.ok)
    throw refused(response, answer)

  return answer as ApiAnswer<Module, Path, M>
}

// A route handle over `call` with a pending count of its own: `const save = call.track(api, '/notes')`, then `await save({ method: 'post', body })` resolves `{ ok, data }` or the route's refusal as `{ ok: false, status, errors, data }`, as an action's `track()` does, and `save.pending()` reads only its own calls. A call that got no answer (status 0) or was aborted still throws.
export interface TrackedApi<Module, Path> extends Source<LoadStatus> {
  <const M extends CallMethod<NodeAt<Module, Path>> = never>(...[options]: Optional<ApiCallOptions<Module, Path, M>>): Promise<CallResult<ApiAnswer<Module, Path, M>, unknown>>
  readonly pending: () => boolean
  readonly settled: () => Promise<void>
}

function track<Module, const Path extends CallPath<Module>>(module: Module, path: Path): TrackedApi<Module, Path> {
  return trackCalls(
    async (options: unknown) => (callApi as unknown as (module: unknown, path: string, options: unknown) => Promise<unknown>)(module, path, options),
    error => error instanceof ApiError && error.status >= 400 ? { ok: false, status: error.status, message: error.message, errors: error.errors, data: error.data } : undefined,
  ) as unknown as TrackedApi<Module, Path>
}

// `call` with `track` on it, built in its declaration and marked pure so a bundle dropping `call` drops `track` and the tracker too.
// kept: request
export const call = /* @__PURE__ */ Object.assign(callApi, { track })

// A body carrying files goes as a form, its other fields as text, which Elysia reads against the route's schema; anything else goes as JSON.
export function callBody(body: unknown): { body?: BodyInit | undefined, headers?: Record<string, string> } {
  if (body === undefined || body instanceof FormData)
    return { body }

  const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.entries(body) : []

  if (!fields.some(([, value]) => value instanceof Blob || (Array.isArray(value) && value.some(item => item instanceof Blob))))
    return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }

  const form = new FormData()

  for (const [name, value] of fields) {
    for (const item of Array.isArray(value) ? value as unknown[] : [value]) {
      if (item !== undefined && item !== null)
        form.append(name, item instanceof Blob ? item : fieldText(item))
    }
  }

  return { body: form }
}
