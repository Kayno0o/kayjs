import type { CallResult, TrackHooks } from './call-result'
import type { Duration } from './duration'
import type { Seed } from './live-resource.server'
import { ApiError, apiErrorOf, failed, refused, textOf, unreachable } from './api-error'
import { withBase } from './base'
import { callBody, fieldText } from './call-body'
import { trackCalls } from './call-result'
import { connection, connectionHooks, ended } from './connection'
import { durationSeconds } from './duration'
import { withKeepalive } from './keepalive'
import { listenerSet } from './listener-set'
import { serverResource } from './live-resource.server'
import { pageData } from './page-data'
import { effect, isHydrating, onCleanup, onMount, ownSignal, untrack } from './reactive'
import { parseEvents, SENDABLE_ID } from './sse'
import { decodeServerValue } from './wire'

// Defined by the browser build, which never runs the server's half: tested where it is read, so the bundler drops it.
declare const KAY_BROWSER: true | undefined

// A timer waits 2^31 - 1 ms at most.
const MAX_TIMER = 2_147_483_647

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

// The callbacks a socket or a stream takes in its options, and as methods of the same names: `onX` after a transition, one object argument. One that throws is logged and leaves the source alone.
export interface ConnectionHooks<T> {
  // The connection opened, a reconnect included (`reconnected` is true after the first open), before what was queued goes.
  onOpen?: ((event: { reconnected: boolean }) => void) | undefined
  // A value arrived.
  onData?: ((event: { value: T }) => void) | undefined
  // It failed (`status` is `failed` then): a refusal, an error event, a close with a code from 4000 to 4999, a source that threw. Not for a drop it reconnects from. Runs before `onClose`.
  onError?: ((event: { error: ApiError }) => void) | undefined
  // A run ended, once: it ran to its `done`, `failed`, or `close()` was called (`closed`). A new run (`start(options)`, `retry()`) ends again.
  onClose?: ((event: { status: 'done' | 'failed' | 'closed' }) => void) | undefined
}

export interface Socket<Send, Receive> extends Source<SocketStatus> {
  // Sent at once while open, otherwise once the connection opens.
  send: (message: Send) => void
  // The last message received, read reactively; undefined before the first.
  last: () => Receive | undefined
  // `failed` when the server closed it with a code from 4000 to 4999, its `error().status` the code minus 4000; any other drop reconnects.
  status: () => SocketStatus

  // Called with `{ value }` for every message received, the shape every source hands its data in; returns what stops it.
  onData: (listener: (event: { value: Receive }) => void) => () => void
  // Called each time the connection opens, a reconnect included, before what was queued goes: where a client joins its rooms again, or refetches what it missed (`reconnected` is true after the first open). Returns what stops it.
  onOpen: (listener: (event: { reconnected: boolean }) => void) => () => void
  // Called with `{ error }` when it fails; returns what stops it.
  onError: (listener: (event: { error: ApiError }) => void) => () => void
  // Called with `{ status }` when it ends, `failed` or `closed`, once; returns what stops it.
  onClose: (listener: (event: { status: 'done' | 'failed' | 'closed' }) => void) => () => void
  // Closes for good: no reconnecting after.
  close: () => void
}

// What every stream of values an island reads shares: a `stream()`, and the stream a streaming action answers with.
export interface Connection<T> extends Source<ConnectionStatus> {
  // The last value received, read reactively; undefined before the first.
  last: () => T | undefined
  // `idle` until a stream opened with `start: false` starts, `done` once it ran to its end, `failed` when it was refused or its source threw, `closed` once `close()` was called.
  status: () => ConnectionStatus

  // Called with `{ value }` for every value received, the shape every source hands its data in; returns what stops it.
  onData: (listener: (event: { value: T }) => void) => () => void
  // Called each time the stream opens, a reconnect included (`reconnected` is true after the first open): where an island refetches what a drop may have lost, when the route sends no ids to resume from. A streaming action's answer is open before a listener can attach, so for it this runs after `retry()` only. Returns what stops it.
  onOpen: (listener: (event: { reconnected: boolean }) => void) => () => void
  // Called with `{ error }` when it fails; returns what stops it.
  onError: (listener: (event: { error: ApiError }) => void) => () => void
  // Called with `{ status }` once a run ends, `done`, `failed` or `closed`; returns what stops it.
  onClose: (listener: (event: { status: 'done' | 'failed' | 'closed' }) => void) => () => void
  close: () => void
  // Resolves with the last value once the stream ran to its end, undefined when it sent none; rejects with an `ApiError` when it failed, and an `AbortError` when it was closed first.
  ended: () => Promise<T | undefined>
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
export function openSocket<Send, Receive>(connect: () => WebSocket | undefined, hooks?: ConnectionHooks<Receive>): Socket<Send, Receive> & { start: () => void } {
  const link = connection<Receive>(start, true)
  const opened = listenerSet<{ reconnected: boolean }>()
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
      opened.emit({ reconnected: opens++ > 0 })

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
    ...connectionHooks(link, opened.on, hooks),
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
export async function refusalOf(response: Response): Promise<ApiError> {
  let data: unknown

  try {
    data = await response.text()
    data = JSON.parse(data as string)
  }
  catch {}

  const message = textOf(data, response.statusText || `HTTP ${response.status}`)

  return new ApiError(response.status, message, data, { '': message })
}

// The header a reconnecting stream sends so its route can continue after the last event it took, which `readEvents` keeps only when `SENDABLE_ID` accepts it.
export function resumeHeaders(lastEventId: string | undefined): Record<string, string> {
  return lastEventId === undefined ? {} : { 'last-event-id': lastEventId }
}

// An event stream read as it arrives, through `request`, given the id of the last event taken to send as `resumeHeaders` does; a GET stream that drops reconnects, a stream that ran to its end or failed stays as it is; a GET stream also waits out a 502, 503 or 504, as a server or proxy restarting answers, and with `retryRefused` any response that is not ok is tried again after the backoff too.
// `start()` opens it once; given a request, it opens a new run of it, closing the one going and forgetting its last value and its last id.
// It gives the connection to build `ended()` and the hooks on (`connectionHooks()`), which a caller needing neither, a live value, does not carry.
export function readEvents<T>(request: (signal: AbortSignal, lastEventId?: string) => Promise<Response>, reconnect: boolean, idle = false, retryRefused = false): Omit<Connection<T>, 'ended' | 'onData' | 'onError' | 'onClose'> & { link: ReturnType<typeof connection<T>>, on: (listener: (value: T) => void) => () => void, start: (next?: (signal: AbortSignal, lastEventId?: string) => Promise<Response>) => void } {
  let run: AbortController | undefined
  let started = false
  let lastId: string | undefined
  let opens = 0

  const opened = listenerSet<{ reconnected: boolean }>()
  const link = connection<T>(() => void read(run!), reconnect, idle)

  // An empty id resets it, as the standard says, and so does one the next request could not send.
  const remember = (id: string) => {
    lastId = SENDABLE_ID.test(id) ? id : undefined
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

        if (!retryRefused && !(reconnect && response.status > 501 && response.status < 505)) {
          link.fail(refusal)

          return
        }

        // Refused, as a server is while it restarts or a proof is stale: tried again after the backoff.
        failure = refusal
      }
      else {
        link.set('open')
        opened.emit({ reconnected: opens++ > 0 })
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
    link,
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

export type SocketOptions<Module, Path> = UrlOptions<SocketRoute<Module, Path>> & ConnectionHooks<Received<SocketRoute<Module, Path>>>
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
  }, options)

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

export type StreamOf<Module, Path, M> = Stream<StreamValue<MethodRoute<Module, Path, Chosen<M>>>, StreamStartOptions<Module, Path, M>>
export type StreamOptions<Module, Path, M> = MethodOption<NodeAt<Module, Path>, M> & UrlOptions<MethodRoute<Module, Path, Chosen<M>>> & Body<MethodRoute<Module, Path, Chosen<M>>> & ConnectionHooks<StreamValue<MethodRoute<Module, Path, Chosen<M>>>>
// What each run of a stream opened with `start: false` takes: the URL's params and query, and a body, which may be a `FormData`.
export type StreamStartOptions<Module, Path, M> = UrlOptions<MethodRoute<Module, Path, Chosen<M>>> & CallBody<MethodRoute<Module, Path, Chosen<M>>>

// What `stream()` gives: a `Connection` that can be started. One opened with `start: false` is `idle` until then and opens a run each time, closing the one going and forgetting its last value, from a handler as a click starts a streamed answer; one that starts by itself is open already, so `start()` does nothing, and `start(options)` opens a new run as the lazy one does.
export interface Stream<T, Options = Record<never, never>> extends Connection<T> {
  start: (...[options]: Optional<Options>) => void
}

// An async iterable read as it arrives, from the moment the island is in the page.
function iterate(source: (signal: AbortSignal) => AsyncIterable<unknown>, hooks?: ConnectionHooks<unknown>): Stream<unknown> {
  const link = connection<unknown>(() => void read(), false)
  const opened = listenerSet<{ reconnected: boolean }>()
  const controller = new AbortController()
  let opens = 0
  let started = false

  async function read() {
    if (controller.signal.aborted)
      return

    link.set('open')
    opened.emit({ reconnected: opens++ > 0 })

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

  // The source runs once, from the moment the island is in the page; `retry()` runs it again after a failure.
  const start = () => {
    if (!started && typeof document !== 'undefined') {
      started = true
      void read()
    }
  }

  onMount(start)
  onCleanup(close)

  return { last: link.last, status: link.status, pending: link.pending, error: link.error, retry: () => link.retry(() => void read()), ...connectionHooks(link, opened.on, hooks), ended: ended(link), close, start }
}

// Reads a route of a module under `src/api` answering with `eventStream()` from an island, once it is in the page, or with `start: false` each time `start()` is called: each value typed as the route sends it, Dates, Maps and Sets included.
// A GET stream that drops reconnects; `close()` aborts the request, and a stream closes with the component that opened it.
// kept: request
export function stream<Module, const Path extends StreamPath<Module>, const M extends StreamMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<StreamOptions<Module, Path, M> | (MethodOption<NodeAt<Module, Path>, M> & ConnectionHooks<StreamValue<MethodRoute<Module, Path, Chosen<M>>>> & { start: false })>): StreamOf<Module, Path, M>
// Reads any async iterable the same way, once the island is in the page: `source` gets a signal that aborts when `close()` is called or the component is gone, and it has to stop on it, as a source ignoring the signal is not released while it waits for its next value. The stream is `done` once the iterable ends and `failed` when it throws.
export function stream<T>(source: (signal: AbortSignal) => AsyncIterable<T>, hooks?: ConnectionHooks<T>): Stream<T>
export function stream(module: unknown, path?: string | ConnectionHooks<unknown>, options?: UrlInput & ConnectionHooks<never> & { method?: string, start?: boolean }): Stream<unknown, never> {
  if (typeof module === 'function')
    return iterate(module as (signal: AbortSignal) => AsyncIterable<unknown>, path as ConnectionHooks<unknown> | undefined)

  if (typeof path !== 'string')
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
  const { link, ...reader } = readEvents(opened(options), reconnect, lazy)

  onMount(() => {
    if (!lazy && typeof document !== 'undefined')
      reader.start()
  })
  onCleanup(reader.close)

  const start = (given?: UrlInput) => {
    if (!lazy && !given) {
      reader.start()

      return
    }

    const next = { ...given, method: options?.method }

    routeUrl(module, path, next)
    reader.start(opened(next))
  }

  return { ...reader, ...connectionHooks(link, reader.onOpen, options), ended: ended(link), start }
}

// What a resource's status can be: it starts loading, so never idle.
type ResourceState = Exclude<LoadStatus, 'idle'>

// When a resource asks its route again by itself: when the tab gets the focus back, when the network returns, or every so often while the tab shows.
export type Revalidation = 'focus' | 'reconnect' | Duration

// What `resource()` takes besides the route's params and query.
export interface ResourceExtras<T> {
  // A value the app already has: the resource is `ready` with it at once, on the server too, and asks the route for nothing until `refresh()` or a `revalidate`.
  initial?: T | undefined
  // Names the value: every resource with this key shares one request and one value, `mutate()` and `refresh()` reaching them all. A route's key is its URL, so two islands reading the same route and arguments already share; a `load` function shares only when given one.
  key?: string | undefined
  // `false` keeps the server from asking the route: the resource renders `loading` and the browser asks it, for a route whose answer or side effects belong to the browser's own request, such as an editor reading the entry it edits.
  seed?: boolean | undefined
  // Asks the route again quietly, the value kept and the status still `ready`, and stops with the component.
  revalidate?: Revalidation | readonly Revalidation[] | undefined
  // Called with `{ value }` each time the route answers, a quiet reload and `mutate()` included, not for `initial` or the value the server rendered.
  onData?: ((event: { value: T }) => void) | undefined
  // Called with `{ error }` each time a request fails, not for a quiet reload that keeps the value it has.
  onError?: ((event: { error: ApiError }) => void) | undefined
}

export interface Resource<T> extends Source<ResourceState> {
  // What the route last answered, kept while it is asked again; undefined before the first answer.
  value: () => T | undefined
  // `loading` until the route answers, and again each time it is asked anew; `pending()` also reads a quiet reload that keeps `ready`.
  status: () => ResourceState
  // Why the last request failed as an `ApiError`, kept while the route is asked again until it answers. `retry()` asks again after a failure only.
  error: () => ApiError | undefined
  // Called with `{ value }` each time the route answers, as the `onData` option; returns what stops it.
  onData: (listener: (event: { value: T }) => void) => () => void
  // Called with `{ error }` each time a request fails, as the `onError` option; returns what stops it.
  onError: (listener: (event: { error: ApiError }) => void) => () => void
  // Asks the route again with the same options, until the component that read it is gone, even when it is ready.
  refresh: () => void
  // Sets the value at once, for every resource sharing its key, and asks the route again to settle it: a request still in flight is dropped, so an older answer never overwrites it. `{ refresh: false }` keeps the value as set. Given a function, it gets the current value.
  mutate: (next: T | ((current: T | undefined) => T), options?: { refresh?: boolean }) => void
}

// What a value is once it crossed as JSON: a Date arrives as its ISO text.
export type Jsonified<T> = T extends Date | bigint ? string : T extends readonly (infer Item)[] ? Jsonified<Item>[] : T extends object ? { [Key in keyof T]: Jsonified<T[Key]> } : T

type GetRoute<Module, Path> = NodeAt<Module, Path> extends { get: infer Route } ? Route : never

// Whether a route's answer reads back as it is typed: Elysia sends an object as JSON and a string as text, but a number, a boolean or null as bare text with no type to tell it from a string.
type Readable<Value> = unknown extends Value ? true : [Value] extends [EventStream<unknown>] ? false : [Value] extends [object | string] ? true : false

// The GET routes of a module that answer an object, an array or a string.
export type ResourcePath<Module> = Nodes<RoutesOf<Module>> extends infer Found ? Found extends { path: infer Path, node: { get: infer Route } } ? Route extends { response: { 200: infer Value } } ? Readable<Value> extends true ? Path : never : Path : never : never
type ResourceValue<Module, Path> = GetRoute<Module, Path> extends { response: { 200: infer Value } } ? Jsonified<Value> : unknown
export type ResourceOptions<Module, Path> = UrlOptions<GetRoute<Module, Path>> & ResourceExtras<ResourceValue<Module, Path>>
export type ResourceOf<Module, Path> = Resource<ResourceValue<Module, Path>>

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

// How an Entry asks its route: the first time or on `refresh()` it shows `loading`; a quiet reload keeps the status and drops a failure; the one after `mutate()` keeps the status and shows a failure.
type Ask = 'first' | 'quiet' | 'kept'
type Read = (signal: AbortSignal, fresh?: boolean, proof?: (header: string | null) => void) => unknown

// One resource's view of an Entry: it copies the Entry's state into its own signals.
interface Sink {
  apply: (entry: Entry) => void
}

// The entries by key, while a resource holds them.
const entries = new Map<string, Entry>()

// The value, status and request behind the resources sharing a key; a resource with none is the only one on its Entry.
class Entry {
  readonly sinks = new Set<Sink>()
  value: unknown
  // Counts the values written, 0 before the first, so a Sink copies a value only once.
  rev: number
  status: ResourceState
  error: ApiError | undefined = undefined
  busy: boolean
  asked: Read | undefined = undefined
  gone = false
  private current: AbortController | undefined
  private followed = false

  constructor(readonly key: string | undefined, known?: { value: unknown }) {
    this.value = known?.value
    this.rev = known === undefined ? 0 : 1
    this.status = known === undefined ? 'loading' : 'ready'
    this.busy = known === undefined
  }

  private publish(): void {
    for (const sink of this.sinks)
      sink.apply(this)
  }

  // A reload made for a change keeps the status, and the value on failure, so it is swapped without a loading state in between; it skips the browser's cache.
  readonly load = async (read: Read, ask: Ask = 'first'): Promise<void> => {
    const controller = new AbortController()

    this.current?.abort()
    this.current = controller
    this.asked = read
    this.busy = true

    if (ask === 'first')
      this.status = 'loading'

    this.publish()

    try {
      const answer = await read(controller.signal, ask !== 'first', (header) => {
        if ((header !== null || this.followed) && !controller.signal.aborted && !this.gone)
          void this.follow(header)
      })

      if (controller.signal.aborted)
        return

      this.value = answer
      this.rev++
      this.error = undefined
      this.status = 'ready'
      this.busy = false
    }
    catch (failure) {
      if (controller.signal.aborted)
        return

      this.busy = false

      if (ask !== 'quiet') {
        this.error = apiErrorOf(failure)
        this.status = 'failed'
      }
    }

    this.publish()
  }

  set(value: unknown): void {
    this.current?.abort()
    this.current = undefined
    this.value = value
    this.rev++
    this.error = undefined
    this.status = 'ready'
    this.busy = false
    this.publish()
  }

  revalidate(): void {
    if (!this.busy && this.asked !== undefined && !this.gone)
      void this.load(this.asked, 'quiet')
  }

  // Follows the cached values the route's handler read, from the proof its answer carried, or lets go of them when it carried none.
  async follow(proof: string | null): Promise<void> {
    this.followed = proof !== null

    try {
      (await import('./live-cache')).followRoute(this.load, proof, async () => this.gone || this.load(this.asked!, 'quiet'))
    }
    catch {}
  }

  leave(sink: Sink): void {
    this.sinks.delete(sink)

    if (this.sinks.size > 0)
      return

    this.gone = true
    this.busy = false
    this.current?.abort()

    if (this.followed)
      void this.follow(null)

    if (this.key !== undefined && entries.get(this.key) === this)
      entries.delete(this.key)
  }
}

// The page where `resource()` finds what the server's render read: a JSON script of the seeds by key.
export const RESOURCES_SCRIPT = 'data-kay-resources'

function seedOf(key: string): Seed | undefined {
  for (const seeds of pageData<Record<string, Seed>>(`script[${RESOURCES_SCRIPT}]`, JSON.parse, true)) {
    if (Object.hasOwn(seeds, key))
      return seeds[key]
  }

  return undefined
}

// Asks again each time the browser says so, until the owner is gone: the tab getting the focus back, the network returning, or an interval while the tab shows.
function revalidating(when: Revalidation | readonly Revalidation[], run: () => void): void {
  for (const trigger of typeof when === 'string' ? [when] : when) {
    if (trigger === 'focus') {
      const shown = () => {
        if (!document.hidden)
          run()
      }

      window.addEventListener('focus', run)
      document.addEventListener('visibilitychange', shown)
      onCleanup(() => {
        window.removeEventListener('focus', run)
        document.removeEventListener('visibilitychange', shown)
      })
    }
    else if (trigger === 'reconnect') {
      window.addEventListener('online', run)
      onCleanup(() => window.removeEventListener('online', run))
    }
    else {
      const timer = setInterval(() => {
        if (!document.hidden)
          run()
      }, Math.min(durationSeconds(trigger, 'the revalidate of resource()') * 1000, MAX_TIMER))

      onCleanup(() => clearInterval(timer))
    }
  }
}

// Reads a GET route of a module under `src/api` from an island, typed from the route. Options given as a function are read reactively: the route is asked again when a signal they read changes, and an answer a newer request overtook is dropped.
// The server renders the island with the route's answer, asked in process with the visitor's cookies so its guards run, and the island hydrates `ready` with it; a route that refuses or fails there leaves the island `loading` for the browser to ask. A prerendered page asks nothing.
// Resources reading one route and arguments share a request and a value, `key` naming another; `initial` is a value the app has, `revalidate` asks again on focus, on reconnect or every so often, and `mutate(value)` sets the value for all of them and asks the route again.
// kept: request
export function resource<Module, const Path extends ResourcePath<Module>>(module: Module, path: Path, ...[options]: Optional<ResourceOptions<Module, Path> | (() => ResourceOptions<Module, Path>)>): ResourceOf<Module, Path>
// Reads anything else the same way: `load` gets a signal that aborts when it is superseded or the component is gone, and the signals it reads before its first await are tracked, so it runs again when one changes. A throw is the `error()`, its `status` 0 unless it is an `ApiError`. It runs in the browser only; `initial` shows until it first answers.
export function resource<T>(load: (signal: AbortSignal) => T | PromiseLike<T>, options?: ResourceExtras<Awaited<T>>): Resource<Awaited<T>>
export function resource(module: unknown, path?: string | ResourceExtras<unknown>, options?: UrlInput & ResourceExtras<unknown> | (() => UrlInput & ResourceExtras<unknown>)): Resource<unknown> {
  const route = typeof module !== 'function'
  const urlOf = (given: UrlInput | undefined) => {
    try {
      return routeUrl(module, path as string, given)
    }
    catch {
      return undefined
    }
  }
  const keyOf = (given: UrlInput | ResourceExtras<unknown> | undefined) => (given as ResourceExtras<unknown> | undefined)?.key ?? (route ? urlOf(given as UrlInput | undefined) : undefined)
  const optionsNow = () => typeof options === 'function' ? options() : options
  const first = untrack(() => route ? optionsNow() : path) as (UrlInput & ResourceExtras<unknown>) | undefined

  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined')
    return serverResource(keyOf(first), route && first?.seed !== false ? urlOf(first) : undefined, first?.initial === undefined ? undefined : { value: first.initial })

  const [value, setValue] = ownSignal<unknown>(undefined, { equals: false })
  const [status, setStatus] = ownSignal<ResourceState>('loading')
  const [error, setError] = ownSignal<ApiError | undefined>(undefined)
  const [busy, setBusy] = ownSignal(true)
  let entry: Entry | undefined
  let gone = false
  let shown: { from: Entry, rev: number } | undefined
  const answers = listenerSet<{ value: unknown }>()
  const failures = listenerSet<{ error: ApiError }>()
  // The failure last told to `onError`, and whether the sink is joining an entry, which tells nothing of what the entry already holds.
  let told: ApiError | undefined
  let joining = false

  if (first?.onData)
    answers.on(first.onData)

  if (first?.onError)
    failures.on(first.onError)

  const sink: Sink = {
    apply: (from) => {
      if (from.rev > 0 && (shown?.from !== from || shown.rev !== from.rev)) {
        shown = { from, rev: from.rev }
        setValue(from.value)

        if (!joining)
          answers.emit({ value: from.value })
      }

      setStatus(from.status)
      setError(from.error)
      setBusy(from.busy)

      if (from.error !== told) {
        told = from.error

        if (told !== undefined && !joining)
          failures.emit({ error: told })
      }
    },
  }

  const readOf = (given: UrlInput | undefined): Read => route
    ? async (signal, fresh, proof) => {
      const url = withBase(routeUrl(module, path as string, given))
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

      proof?.(response.headers.get('x-kay-live'))

      return answer
    }
    : module as Read

  const join = (next: Entry) => {
    entry = next
    next.sinks.add(sink)
    joining = true
    sink.apply(next)
    joining = false
  }

  // The entry the key names, made if no resource holds it; true when it was made here.
  const take = (key: string | undefined, known?: { value: unknown }): [Entry, boolean] => {
    const held = key === undefined ? undefined : entries.get(key)
    const next = held ?? new Entry(key, known)

    if (held === undefined && key !== undefined)
      entries.set(key, next)

    return [next, held === undefined]
  }

  // A value the app has, or the one the server rendered this island with, is shown at once.
  let known = false
  const firstKey = keyOf(first)
  let seed: Seed | undefined = first?.initial === undefined ? undefined : { value: first.initial, proof: null }

  if (seed === undefined && isHydrating() && route && firstKey !== undefined)
    seed = seedOf(firstKey)

  if (seed !== undefined) {
    const [next, made] = take(firstKey, seed)

    join(next)
    known = true

    if (made && seed.proof !== null)
      void next.follow(seed.proof)
  }

  effect(() => {
    const given = (route ? optionsNow() : undefined) as UrlInput | undefined
    const read = readOf(given)
    const key = keyOf(route ? given : first)
    // A route the app has the value of is not asked; a function runs once, to follow its signals and replace the value.
    const placeholder = known && !route
    const held = entry !== undefined && entry.key === key ? entry : undefined

    known = false

    // A function rerunning for a signal it read asks again under the same key.
    if (held !== undefined && (key === undefined || placeholder || !route)) {
      void held.load(read, placeholder ? 'kept' : 'first')

      return
    }

    if (held !== undefined) {
      held.asked ??= read

      return
    }

    entry?.leave(sink)

    const [next, made] = take(key)

    join(next)

    if (made)
      void next.load(read, 'first')
  })

  if (first?.revalidate !== undefined)
    revalidating(first.revalidate, () => entry?.revalidate())

  onCleanup(() => {
    gone = true
    entry?.leave(sink)
    setBusy(false)
  })

  return {
    value,
    status,
    pending: busy,
    error,
    onData: answers.on,
    onError: failures.on,
    refresh: () => entry?.asked === undefined || gone ? undefined : void entry.load(entry.asked),
    retry: () => {
      if (entry?.asked !== undefined && !gone && untrack(status) === 'failed')
        void entry.load(entry.asked)
    },
    mutate: (next, settings) => {
      if (entry === undefined || gone)
        return

      entry.set(typeof next === 'function' ? (next as (current: unknown) => unknown)(entry.rev > 0 ? entry.value : undefined) : next)

      if (settings?.refresh !== false && entry.asked !== undefined)
        void entry.load(entry.asked, 'kept')
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
  // Lets the call outlive the page, for one made from `pagehide` or `beforeunload`: passed to `fetch` as `keepalive`, unless the body is past the browser's 64 KB cap or holds files, which go as a plain call.
  keepalive?: boolean | undefined
}

// What an answer reads back as: an object as JSON, a Date in it as its ISO text, while a number or a boolean arrives as the text Elysia sends, `null` as `null` and nothing (`undefined`, a 204) as ''.
// A file arrives as a Blob, or as text when its type is text; a Response the route built is read by its type, which the route's type does not say.
export type Answered<Value> = unknown extends Value ? unknown : Value extends EventStream<unknown> ? never : Value extends Response ? unknown : Value extends Blob ? Blob | string : Value extends string ? Value : Value extends number | boolean | bigint ? string : Value extends null ? null : Value extends undefined | void ? '' : Jsonified<Value>
export type ApiAnswer<Module, Path, M> = Answered<Received<MethodRoute<Module, Path, Chosen<M>>>>

// Calls a route of a module under `src/api`, from an event handler or any code running in the browser, typed from the route: resolves with what it answered, and throws an `ApiError` when it refused.
async function callApi<Module, const Path extends CallPath<Module>, const M extends CallMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<ApiCallOptions<Module, Path, M>>): Promise<ApiAnswer<Module, Path, M>> {
  const { method = 'get', body, signal, progress, keepalive } = (options ?? {}) as { method?: string, body?: unknown, signal?: AbortSignal, progress?: (sent: number) => void, keepalive?: boolean }
  const url = withBase(routeUrl(module, path, options as UrlInput | undefined))
  const sent = callBody(body)
  const headers = { accept: 'application/json', ...sent.headers }
  let response: Response

  try {
    response = sent.body instanceof FormData && progress && typeof XMLHttpRequest !== 'undefined'
      ? await (await import('./upload')).uploaded(method.toUpperCase(), url, headers, sent.body, progress, signal)
      : await withKeepalive(keepalive === true, sent.body, async extra => fetch(url, { method: method.toUpperCase(), headers, body: sent.body ?? null, ...signal && { signal }, ...extra }))
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

// A route handle over `call` with a pending count of its own: `const save = call.track(api, '/notes', { onError: ({ error }) => toast.error(error.message) })`, then `await save({ method: 'post', body })` resolves `{ ok, data }` or the route's refusal as `{ ok: false, status, errors, data }`, as an action's `track()` does, and `save.pending()` reads only its own calls. A call that got no answer (status 0) or was aborted still throws.
export interface TrackedApi<Module, Path> extends Source<LoadStatus> {
  <const M extends CallMethod<NodeAt<Module, Path>> = never>(...[options]: Optional<ApiCallOptions<Module, Path, M>>): Promise<CallResult<ApiAnswer<Module, Path, M>, unknown>>
  readonly pending: () => boolean
  readonly settled: () => Promise<void>
  // Called with `{ data, input }` when a call succeeds, `input` the options it was given; returns what stops it. Hooks given to `call.track()` run first.
  readonly onSuccess: (listener: (event: { data: unknown, input: unknown }) => void) => () => void
  // Called with `{ error, input }` when a call fails, a refusal or no answer (which still throws), not for an abort; returns what stops it.
  readonly onError: (listener: (event: { error: ApiError, input: unknown }) => void) => () => void
}

function track<Module, const Path extends CallPath<Module>>(module: Module, path: Path, hooks?: TrackHooks<unknown>): TrackedApi<Module, Path> {
  return trackCalls(
    async (options: unknown) => (callApi as unknown as (module: unknown, path: string, options: unknown) => Promise<unknown>)(module, path, options),
    error => error instanceof ApiError && error.status >= 400 ? { ok: false, status: error.status, message: error.message, errors: error.errors, data: error.data } : undefined,
    undefined,
    undefined,
    hooks as TrackHooks<never> | undefined,
  ) as unknown as TrackedApi<Module, Path>
}

// `call` with `track` on it, built in its declaration and marked pure so a bundle dropping `call` drops `track` and the tracker too.
// kept: request
export const call = /* @__PURE__ */ Object.assign(callApi, { track })
