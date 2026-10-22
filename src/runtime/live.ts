import { ApiError } from './api-error'
import { withBase } from './base'
import { effect, onCleanup, onMount, ownSignal } from './reactive'
import { parseEvents } from './sse'
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

const RECONNECT_MS = 500
const MAX_RECONNECT_MS = 30_000
// How often a visible tab the browser says is offline tries anyway, as `navigator.onLine` can be wrong, behind some VPNs for one.
const OFFLINE_RETRY_MS = 60_000
// The close code of a connection either side ended on purpose, which is not reconnected.
const NORMAL_CLOSURE = 1000
// What a socket keeps to send while it connects, the oldest dropped past it.
const MAX_QUEUED = 100
// What Elysia's websocket parser reads as JSON, by first character: `"`, `[`, `{`.
const JSON_START = /^["[{]/
const NUMERIC = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i
const PARAM_SEGMENT = /^:(.+)$/
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i
// An answer without a type, an empty one say, reads as text too.
const TEXT_TYPE = /^(?:text\/|$)/i

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'connect' | 'trace' | 'all' | 'subscribe'

type RoutesOf<Module> = Module extends { '~Routes': infer Routes } ? Routes : never

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

export type SocketStatus = 'connecting' | 'open' | 'closed'

export interface Socket<Send, Receive> {
  // Sent at once while open, otherwise once the connection opens.
  send: (message: Send) => void
  // The last message received, read reactively; undefined before the first.
  last: () => Receive | undefined
  status: () => SocketStatus
  // Called with every message received; returns what stops it.
  on: (listener: (message: Receive) => void) => () => void
  // Called each time the connection opens, a reconnect included, before what was queued goes: where a client joins its rooms again. Returns what stops it.
  onOpen: (listener: () => void) => () => void
  // Closes for good: no reconnecting after.
  close: () => void
}

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'done' | 'failed' | 'closed'

export interface EventReader<T> {
  // The last value received, read reactively; undefined before the first.
  last: () => T | undefined
  // `idle` until a stream opened with `start: false` starts, `done` once it ran to its end, `failed` when it was refused or its source threw, `closed` once `close()` was called.
  status: () => StreamStatus
  on: (listener: (value: T) => void) => () => void
  close: () => void
}

interface Listeners<T> {
  last: () => T | undefined
  receive: (value: T) => void
  on: (listener: (value: T) => void) => () => void
  forget: () => void
}

function listeners<T>(): Listeners<T> {
  const [last, setLast] = ownSignal<T | undefined>(undefined, { equals: false })
  const all = new Set<(value: T) => void>()

  return {
    last,
    receive: (value) => {
      setLast(value)

      // One listener failing leaves the others and the connection alone.
      for (const listener of all) {
        try {
          listener(value)
        }
        catch (error) {
          console.error(error)
        }
      }
    },
    on: (listener) => {
      all.add(listener)

      return () => void all.delete(listener)
    },
    forget: () => setLast(undefined),
  }
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
export function dispatch<Message extends { type: string }, Handlers extends { [Type in Message['type']]: (message: Extract<Message, { type: Type }>) => unknown }>(message: Message, handlers: Handlers): ReturnType<Handlers[Message['type']]> {
  if (!Object.hasOwn(handlers, message.type))
    throw new TypeError(`kay: dispatch() has no handler for a message of type ${message.type}`)

  return (handlers[message.type as Message['type']] as unknown as (message: Message) => ReturnType<Handlers[Message['type']]>)(message)
}

function backoff(attempt: number): number {
  return Math.min(RECONNECT_MS * 2 ** attempt, MAX_RECONNECT_MS)
}

function asleep(): boolean {
  return typeof document !== 'undefined' && (document.hidden || navigator.onLine === false)
}

// Runs `reconnect` after the attempt's backoff, shortened by up to half at random so the clients a restart dropped together come back apart, and not before the tab is visible and online again; gives what cancels it.
function scheduleRetry(attempt: number, reconnect: () => void): () => void {
  const delay = backoff(attempt)
  // Read only once asleep, which a browser alone can be.
  const wakers = () => [[globalThis, 'online'], [document, 'visibilitychange']] as const
  let waiting = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let fallback: ReturnType<typeof setTimeout> | undefined

  function stopWaiting() {
    clearTimeout(fallback)

    if (!waiting)
      return

    waiting = false

    for (const [target, type] of wakers())
      target.removeEventListener(type, wake)
  }

  function rest() {
    clearTimeout(fallback)

    if (!document.hidden) {
      fallback = setTimeout(() => {
        stopWaiting()
        reconnect()
      }, OFFLINE_RETRY_MS)
    }
  }

  function wake() {
    if (asleep()) {
      rest()

      return
    }

    stopWaiting()
    // The clients a network coming back wakes together come back apart too.
    timer = setTimeout(reconnect, Math.random() * RECONNECT_MS)
  }

  timer = setTimeout(() => {
    if (!asleep()) {
      reconnect()

      return
    }

    waiting = true

    for (const [target, type] of wakers())
      target.addEventListener(type, wake)

    rest()
  }, delay - Math.random() * delay / 2)

  return () => {
    clearTimeout(timer)
    stopWaiting()
  }
}

// A websocket that reconnects after a drop, waiting longer each time, until `close()`; `connect` gives none where there is nothing to connect from.
export function openSocket<Send, Receive>(connect: () => WebSocket | undefined): Socket<Send, Receive> & { start: () => void } {
  const [status, setStatus] = ownSignal<SocketStatus>('connecting')
  const messages = listeners<Receive>()
  const opened = listeners<undefined>()
  const queued: string[] = []
  let current: WebSocket | undefined
  let closed = false
  let attempt = 0
  let cancelRetry: (() => void) | undefined

  const start = () => {
    if (closed || current)
      return

    const ws = connect()

    if (!ws)
      return

    current = ws
    ws.addEventListener('open', () => {
      attempt = 0
      setStatus('open')
      opened.receive(undefined)

      for (const message of queued.splice(0))
        ws.send(message)
    })
    ws.addEventListener('message', event => messages.receive(readMessage(event.data) as Receive))
    ws.addEventListener('close', (event) => {
      current = undefined

      if (closed || event.code === NORMAL_CLOSURE) {
        closed = true
        setStatus('closed')

        return
      }

      setStatus('connecting')
      cancelRetry = scheduleRetry(attempt++, start)
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
    last: messages.last,
    status,
    on: messages.on,
    onOpen: listener => opened.on(listener),
    close: () => {
      closed = true
      queued.length = 0
      cancelRetry?.()
      setStatus('closed')
      current?.close(NORMAL_CLOSURE)
    },
  }
}

// An event stream read as it arrives, through `request`; a GET stream that drops reconnects, a stream that ran to its end or failed stays as it is; with `retryRefused`, a response that is not ok is tried again after the backoff too, as a stream across a restart needs.
// `start()` opens it once; given a request, it opens a new run of it, closing the one going and forgetting its last value.
export function readEvents<T>(request: (signal: AbortSignal) => Promise<Response>, reconnect: boolean, idle = false, retryRefused = false): EventReader<T> & { start: (next?: (signal: AbortSignal) => Promise<Response>) => void } {
  const [status, setStatus] = ownSignal<StreamStatus>(idle ? 'idle' : 'connecting')
  const values = listeners<T>()
  let run: AbortController | undefined
  let started = false
  let attempt = 0
  let cancelRetry: (() => void) | undefined

  const settle = (final: StreamStatus) => {
    if (status() !== 'closed')
      setStatus(final)
  }

  const onEvent = (event: string, data: string): StreamStatus | undefined => {
    if (event === END_EVENT)
      return 'done'

    if (event === ERROR_EVENT)
      return 'failed'

    let value: T

    try {
      value = decodeServerValue(data) as T
    }
    catch (error) {
      console.error('kay: an event stream sent a value that does not decode', error)

      return 'failed'
    }

    // Only a stream that delivered something counts as back, so one dropping as soon as it opens keeps backing off.
    attempt = 0
    values.receive(value)

    return undefined
  }

  const read = async (controller: AbortController) => {
    let ended: StreamStatus | undefined

    try {
      const response = await request(controller.signal)

      if (controller.signal.aborted) {
        void response.body?.cancel()

        return
      }

      if (!response.ok || !response.body) {
        if (!retryRefused) {
          settle('failed')

          return
        }

        // Refused, as a server is while it restarts or a proof is stale: tried again after the backoff.
        void response.body?.cancel()
      }
      else {
        setStatus('open')
        ended = await parseEvents(response.body, controller.signal, onEvent)
      }
    }
    catch {}

    if (controller.signal.aborted)
      return

    if (ended) {
      settle(ended)

      return
    }

    if (!reconnect) {
      settle('failed')

      return
    }

    setStatus('connecting')
    cancelRetry = scheduleRetry(attempt++, () => void read(controller))
  }

  return {
    start: (next) => {
      if (next)
        request = next
      else if (started)
        return

      if (next && started)
        values.forget()

      started = true
      cancelRetry?.()
      run?.abort()
      run = new AbortController()
      attempt = 0
      setStatus('connecting')
      void read(run)
    },
    last: values.last,
    status,
    on: values.on,
    close: () => {
      cancelRetry?.()
      setStatus('closed')
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
    throw new TypeError('kay: socket(), stream(), resource() and call() take the default export of a module under src/api')

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
  const [status, setStatus] = ownSignal<StreamStatus>('connecting')
  const values = listeners<unknown>()
  const controller = new AbortController()

  const read = async () => {
    if (controller.signal.aborted)
      return

    setStatus('open')

    try {
      for await (const value of source(controller.signal)) {
        if (controller.signal.aborted)
          return

        values.receive(value)
      }

      if (!controller.signal.aborted)
        setStatus('done')
    }
    catch {
      if (!controller.signal.aborted)
        setStatus('failed')
    }
  }
  const close = () => {
    setStatus('closed')
    controller.abort()
  }

  onMount(() => {
    if (typeof document !== 'undefined')
      void read()
  })
  onCleanup(close)

  return { last: values.last, status, on: values.on, close }
}

// Reads a route of a module under `src/api` answering with `eventStream()` from an island, once it is in the page, or with `start: false` each time `start()` is called: each value typed as the route sends it, Dates, Maps and Sets included.
// A GET stream that drops reconnects; `close()` aborts the request, and a stream closes with the component that opened it.
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

    return async (signal: AbortSignal) => fetch(withBase(routeUrl(module, path, given)), { ...init, signal })
  }

  // A refused param throws at the call and not inside the request, where a GET stream would retry it.
  if (!lazy && typeof document !== 'undefined')
    routeUrl(module, path, options)

  const reader = readEvents(opened(options), (options?.method ?? 'get') === 'get', lazy)

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

export type ResourceStatus = 'loading' | 'ready' | 'failed'

export interface ResourceFailure {
  // The status the route answered with, 0 when no answer came.
  status: number
  message: string
}

export interface Resource<T> {
  // What the route last answered, kept while it is asked again; undefined before the first answer.
  value: () => T | undefined
  // `loading` until the route answers, and again each time it is asked anew.
  status: () => ResourceStatus
  // Why the last request failed, kept while the route is asked again until it answers.
  error: () => ResourceFailure | undefined
  // Asks the route again with the same options, until the component that read it is gone.
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

    throw new ApiError(0, failure instanceof Error ? failure.message : String(failure))
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

// Why a route refused: the text it answered, the message of a JSON error such as a validation failure, else its status text.
function refusal(answer: unknown, response: Response): string {
  if (typeof answer === 'string' && answer !== '')
    return answer

  const message = typeof answer === 'object' && answer !== null && 'message' in answer ? answer.message : undefined

  return typeof message === 'string' ? message : response.statusText || `HTTP ${response.status}`
}

// Reads a GET route of a module under `src/api` from an island, once it is in the page, typed from the route. Options given as a function are read reactively: the route is asked again when a signal they read changes, and an answer a newer request overtook is dropped.
export function resource<Module, const Path extends ResourcePath<Module>>(module: Module, path: Path, ...[options]: Optional<ResourceOptions<Module, Path> | (() => ResourceOptions<Module, Path>)>): ResourceOf<Module, Path>
// Reads anything else the same way: `load` gets a signal that aborts when it is superseded or the component is gone, and the signals it reads before its first await are tracked, so it runs again when one changes. A throw is the `error()`, its `status` 0 unless it is an `ApiError`.
export function resource<T>(load: (signal: AbortSignal) => T | PromiseLike<T>): Resource<Awaited<T>>
export function resource(module: unknown, path?: string, options?: UrlInput | (() => UrlInput)): Resource<unknown> {
  const [value, setValue] = ownSignal<unknown>(undefined, { equals: false })
  const [status, setStatus] = ownSignal<ResourceStatus>('loading')
  const [error, setError] = ownSignal<ResourceFailure | undefined>(undefined)
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

    if (!quiet)
      setStatus('loading')

    try {
      const answer = await read(controller.signal, quiet)

      if (controller.signal.aborted)
        return

      setValue(answer)
      setError(undefined)
      setStatus('ready')
    }
    catch (failure) {
      if (controller.signal.aborted || quiet)
        return

      setError({ status: failure instanceof ApiError ? failure.status : 0, message: failure instanceof Error ? failure.message : String(failure) })
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
        const response = await fetch(withBase(routeUrl(module, path ?? '', given)), { headers: { accept: 'application/json' }, signal, ...fresh && { cache: 'reload' } })
        const answer = await readAnswer(response, signal)

        if (!response.ok && !signal.aborted)
          throw new ApiError(response.status, refusal(answer, response), answer)

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

    if (followed)
      void follow(null)
  })

  return { value, status, error, refresh: () => asked === undefined || gone ? undefined : void load(asked) }
}

export { ApiError }

// The text of a refusal a visitor can read: the message of an `ApiError` the route answered, else `fallback` for an error that came with no answer (status 0, whose message is the browser's) or is no `ApiError`.
export function refusalMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.status !== 0 ? (error as { errors?: Record<string, string> }).errors?.[''] ?? error.message : fallback
}

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

// What an answer reads back as: an object as JSON, a Date in it as its ISO text, while a number or a boolean arrives as the text Elysia sends, and nothing as ''.
// A file arrives as a Blob, or as text when its type is text; a Response the route built is read by its type, which the route's type does not say.
export type Answered<Value> = unknown extends Value ? unknown : Value extends EventStream<unknown> ? never : Value extends Response ? unknown : Value extends Blob ? Blob | string : Value extends string ? Value : Value extends number | boolean | bigint ? string : Value extends null | undefined | void ? '' : Jsonified<Value>
export type ApiAnswer<Module, Path, M> = Answered<Received<MethodRoute<Module, Path, Chosen<M>>>>

// Calls a route of a module under `src/api`, from an event handler or any code running in the browser, typed from the route: resolves with what it answered, and throws an `ApiError` when it refused.
export async function call<Module, const Path extends CallPath<Module>, const M extends CallMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<ApiCallOptions<Module, Path, M>>): Promise<ApiAnswer<Module, Path, M>> {
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

    throw new ApiError(0, failure instanceof Error ? failure.message : String(failure))
  }

  const answer = await readAnswer(response, signal)

  if (!response.ok)
    throw new ApiError(response.status, refusal(answer, response), answer)

  return answer as ApiAnswer<Module, Path, M>
}

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
