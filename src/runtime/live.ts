import { withBase } from './base'
import { createSignal, effect, onCleanup, onMount } from './reactive'
import { decodeValue } from './wire'

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
// The close code of a connection either side ended on purpose, which is not reconnected.
const NORMAL_CLOSURE = 1000
// What Elysia's websocket parser reads as JSON, by first character: `"`, `[`, `{`.
const JSON_START = /^["[{]/
const NUMERIC = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i
// A `\r` ending a chunk may be half of a `\r\n`, so it waits for the next one.
const LINE_BREAK = /\r\n|\r(?!$)|\n/
const PARAM_SEGMENT = /^:(.+)$/
// The one space a field's value may start with, which is not part of it.
const LEADING_SPACE = /^ /

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'connect' | 'trace' | 'all' | 'subscribe'

type RoutesOf<Module> = Module extends { '~Routes': infer Routes } ? Routes : never

// One less, to stop walking a route tree past any depth an app reaches, and never instantiate it without end while `Module` is still generic.
type Shallower = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

// Every node of an Elysia route tree with the path reaching it: keys are path segments down to the methods.
type Nodes<Tree, Path extends string = '', Depth extends number = 10> = [Depth] extends [never] ? never : { path: Path extends '' ? '/' : Path, node: Tree } | {
  [Key in Exclude<keyof Tree & string, Method>]: Nodes<Tree[Key], `${Path}/${Key}`, Shallower[Depth]>
}[Exclude<keyof Tree & string, Method>]

export type NodeAt<Module, Path> = Extract<Nodes<RoutesOf<Module>>, { path: Path }>['node']

// The websocket routes of a module, as it declares them: `'/:room'`.
export type SocketPath<Module> = Extract<Nodes<RoutesOf<Module>>, { node: { subscribe: unknown } }>['path']
type SocketRoute<Module, Path> = NodeAt<Module, Path> extends { subscribe: infer Route } ? Route : never

export type StreamMethod<Node> = { [M in keyof Node & Method]: Node[M] extends { response: { 200: EventStream<unknown> } } ? M : never }[keyof Node & Method]

// The routes of a module answering with `eventStream()`.
export type StreamPath<Module> = Nodes<RoutesOf<Module>> extends infer Found ? Found extends { path: infer Path, node: infer Node } ? [StreamMethod<Node>] extends [never] ? never : Path : never : never
type StreamRoute<Module, Path, M> = NodeAt<Module, Path> extends infer Node ? M extends keyof Node ? Node[M] : never : never
type StreamValue<Route> = Route extends { response: { 200: EventStream<infer Value> } } ? Value : never

// What the route's schema asks of the URL: params a path names are required, a query only when its schema requires one.
type UrlOptions<Route> = (Route extends { params: infer Params } ? Record<never, never> extends Params ? { params?: Params } : { params: Params } : { params?: Record<string, unknown> })
  & (Route extends { query: infer Query } ? unknown extends Query ? { query?: Record<string, unknown> } : Record<never, never> extends Query ? { query?: Query } : { query: Query } : { query?: Record<string, unknown> })

type Received<Route> = Route extends { response: { 200: infer Message } } ? Message : unknown
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
  // Closes for good: no reconnecting after.
  close: () => void
}

export type StreamStatus = 'connecting' | 'open' | 'done' | 'failed' | 'closed'

export interface EventReader<T> {
  // The last value received, read reactively; undefined before the first.
  last: () => T | undefined
  // `done` once the stream ran to its end, `failed` when it was refused or its source threw, `closed` once `close()` was called.
  status: () => StreamStatus
  on: (listener: (value: T) => void) => () => void
  close: () => void
}

interface Listeners<T> {
  last: () => T | undefined
  receive: (value: T) => void
  on: (listener: (value: T) => void) => () => void
}

function listeners<T>(): Listeners<T> {
  const [last, setLast] = createSignal<T | undefined>(undefined, { equals: false }, false)
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

  return data === 'true' ? true : data === 'false' ? false : data === 'null' ? null : data
}

function backoff(attempt: number): number {
  return Math.min(RECONNECT_MS * 2 ** attempt, MAX_RECONNECT_MS)
}

// A websocket that reconnects after a drop, waiting longer each time, until `close()`; `connect` gives none where there is nothing to connect from.
export function openSocket<Send, Receive>(connect: () => WebSocket | undefined): Socket<Send, Receive> & { start: () => void } {
  const [status, setStatus] = createSignal<SocketStatus>('connecting', undefined, false)
  const messages = listeners<Receive>()
  const queued: string[] = []
  let current: WebSocket | undefined
  let closed = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined

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
      retry = setTimeout(start, backoff(attempt++))
    })
  }

  return {
    start,
    send: (message) => {
      const text = JSON.stringify(message)

      if (current?.readyState === WebSocket.OPEN)
        current.send(text)
      else
        queued.push(text)
    },
    last: messages.last,
    status,
    on: messages.on,
    close: () => {
      closed = true
      clearTimeout(retry)
      setStatus('closed')
      current?.close(NORMAL_CLOSURE)
    },
  }
}

// An event stream read as it arrives, through `request`; a GET stream that drops reconnects, a stream that ran to its end or failed stays as it is.
export function readEvents<T>(request: (signal: AbortSignal) => Promise<Response>, reconnect: boolean): EventReader<T> & { start: () => void } {
  const [status, setStatus] = createSignal<StreamStatus>('connecting', undefined, false)
  const values = listeners<T>()
  const aborts = new AbortController()
  let started = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined

  const settle = (final: StreamStatus) => {
    if (status() !== 'closed')
      setStatus(final)
  }

  const read = async () => {
    let ended: StreamStatus | undefined

    try {
      const response = await request(aborts.signal)

      if (!response.ok || !response.body) {
        settle('failed')

        return
      }

      setStatus('open')

      ended = await parseEvents(response.body, (event, data) => {
        if (event === END_EVENT)
          return 'done'

        if (event === ERROR_EVENT)
          return 'failed'

        let value: T

        try {
          value = decodeValue(data) as T
        }
        catch (error) {
          console.error('kay: an event stream sent a value that does not decode', error)

          return 'failed'
        }

        // Only a stream that delivered something counts as back, so one dropping as soon as it opens keeps backing off.
        attempt = 0
        values.receive(value)

        return undefined
      })
    }
    catch {}

    if (aborts.signal.aborted)
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
    retry = setTimeout(() => void read(), backoff(attempt++))
  }

  return {
    start: () => {
      if (started)
        return

      started = true
      void read()
    },
    last: values.last,
    status,
    on: values.on,
    close: () => {
      clearTimeout(retry)
      setStatus('closed')
      aborts.abort()
    },
  }
}

// Reads `text/event-stream` blocks, a `data` field over several lines joined with line breaks, comments skipped; resolves with what an event returned to end the stream, or undefined when the body ran out first.
async function parseEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => StreamStatus | undefined): Promise<StreamStatus | undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []

  for (;;) {
    const { done, value } = await reader.read()

    if (done)
      return undefined

    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split(LINE_BREAK)

    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line === '') {
        const ended = data.length > 0 || event !== '' ? onEvent(event, data.join('\n')) : undefined

        event = ''
        data = []

        if (ended) {
          await reader.cancel()

          return ended
        }

        continue
      }

      if (line.startsWith(':'))
        continue

      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const text = colon === -1 ? '' : line.slice(colon + 1).replace(LEADING_SPACE, '')

      if (field === 'event')
        event = text
      else if (field === 'data')
        data.push(text)
    }
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
    throw new TypeError('kay: socket(), stream() and resource() take the default export of a module under src/api')

  const segments = path.split('/').map((segment) => {
    if (segment === '*')
      return String(options.params?.['*'] ?? '')

    const param = PARAM_SEGMENT.exec(segment)?.[1]

    if (param === undefined)
      return segment

    const value = options.params?.[param]

    if (value === undefined)
      throw new TypeError(`kay: ${path} takes the param ${param}`)

    return encodeURIComponent(String(value))
  })
  const query = new URLSearchParams()

  for (const [name, value] of Object.entries(options.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined)
        query.append(name, String(item))
    }
  }

  const search = query.size > 0 ? `?${query}` : ''
  const joined = segments.join('/')

  return `${mount}${joined === '/' ? '' : joined}${search}`
}

export type SocketOptions<Module, Path> = UrlOptions<SocketRoute<Module, Path>>
export type SocketOf<Module, Path> = Socket<Sent<SocketRoute<Module, Path>>, Received<SocketRoute<Module, Path>>>

// Opens a websocket route of a module under `src/api` from an island, once it is in the page: messages typed both ways from the route's `body` and `response` schemas, sent as Elysia reads them.
// Reconnects after a drop, and closes with the component that opened it.
export function socket<Module, const Path extends SocketPath<Module>>(module: Module, path: Path, ...[options]: Optional<SocketOptions<Module, Path>>): SocketOf<Module, Path> {
  // The URL is made in the browser only: a page prerendering the island imports the module unmounted.
  const client = openSocket<Sent<SocketRoute<Module, Path>>, Received<SocketRoute<Module, Path>>>(() => {
    if (typeof document === 'undefined')
      return undefined

    const target = new URL(withBase(routeUrl(module, path, options as UrlInput | undefined)), location.href)

    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'

    return new WebSocket(target)
  })

  onMount(client.start)
  onCleanup(client.close)

  return client
}

// The method a stream is read with: GET unless the options name another.
export type Chosen<M> = [M] extends [never] ? 'get' : M

// The request reading a stream: its method, GET unless named, and its body as JSON, which Elysia reads against the route's schema.
export function streamRequest(options: unknown): RequestInit & { method: string, headers: Record<string, string> } {
  const { method = 'get', body } = (options ?? {}) as { method?: string, body?: unknown }

  if (body === undefined)
    return { method: method.toUpperCase(), headers: { accept: 'text/event-stream' } }

  return { method: method.toUpperCase(), headers: { 'accept': 'text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

export type StreamOf<Module, Path, M> = EventReader<StreamValue<StreamRoute<Module, Path, Chosen<M>>>>
export type StreamOptions<Module, Path, M> = { method?: M } & UrlOptions<StreamRoute<Module, Path, Chosen<M>>> & Body<StreamRoute<Module, Path, Chosen<M>>>

// Reads a route of a module under `src/api` answering with `eventStream()` from an island, once it is in the page: each value typed as the route sends it, Dates, Maps and Sets included.
// A GET stream that drops reconnects; a stream closes with the component that opened it.
export function stream<Module, const Path extends StreamPath<Module>, const M extends StreamMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<StreamOptions<Module, Path, M>>): StreamOf<Module, Path, M> {
  const init = streamRequest(options)
  const reader = readEvents<StreamValue<StreamRoute<Module, Path, Chosen<M>>>>(async signal => fetch(withBase(routeUrl(module, path, options as UrlInput | undefined)), { ...init, signal }), init.method === 'GET')

  onMount(() => {
    if (typeof document !== 'undefined')
      reader.start()
  })
  onCleanup(reader.close)

  return reader
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
async function readAnswer(response: Response): Promise<unknown> {
  return response.headers.get('content-type')?.startsWith('application/json') ? response.json() : response.text()
}

// Why a route refused: the text it answered, the message of a JSON error such as a validation failure, else its status text.
function refusal(answer: unknown, response: Response): string {
  if (typeof answer === 'string' && answer !== '')
    return answer

  const message = typeof answer === 'object' && answer !== null && 'message' in answer ? answer.message : undefined

  return typeof message === 'string' ? message : response.statusText
}

// Reads a GET route of a module under `src/api` from an island, once it is in the page, typed from the route. Options given as a function are read reactively: the route is asked again when a signal they read changes, and an answer a newer request overtook is dropped.
export function resource<Module, const Path extends ResourcePath<Module>>(module: Module, path: Path, ...[options]: Optional<ResourceOptions<Module, Path> | (() => ResourceOptions<Module, Path>)>): ResourceOf<Module, Path> {
  const [value, setValue] = createSignal<unknown>(undefined, { equals: false }, false)
  const [status, setStatus] = createSignal<ResourceStatus>('loading', undefined, false)
  const [error, setError] = createSignal<ResourceFailure | undefined>(undefined, undefined, false)
  let current: AbortController | undefined
  let asked = ''
  let gone = false

  const load = async (url: string) => {
    const controller = new AbortController()

    current?.abort()
    current = controller
    asked = url
    setStatus('loading')

    try {
      const response = await fetch(withBase(url), { headers: { accept: 'application/json' }, signal: controller.signal })
      const answer = await readAnswer(response)

      if (controller.signal.aborted)
        return

      if (!response.ok) {
        setError({ status: response.status, message: refusal(answer, response) })
        setStatus('failed')

        return
      }

      setValue(answer)
      setError(undefined)
      setStatus('ready')
    }
    catch (failure) {
      if (controller.signal.aborted)
        return

      setError({ status: 0, message: failure instanceof Error ? failure.message : String(failure) })
      setStatus('failed')
    }
  }

  // The server renders the island loading, as the browser does until the answer comes.
  if (typeof document !== 'undefined') {
    effect(() => void load(routeUrl(module, path, (typeof options === 'function' ? options() : options) as UrlInput | undefined)))
  }

  onCleanup(() => {
    gone = true
    current?.abort()
  })

  return { value, status, error, refresh: () => asked === '' || gone ? undefined : void load(asked) } as ResourceOf<Module, Path>
}
