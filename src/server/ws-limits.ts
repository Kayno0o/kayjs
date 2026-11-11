import type { Elysia } from 'elysia'
import type { ByteSize } from '../runtime/byte-size'
import type { Duration } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { byteSize } from '../runtime/byte-size'
import { optionMs } from '../runtime/duration'
import { DEFAULT_BODY_LIMIT } from './body'
import { knownAddress, rateKey } from './protection'

// What a websocket route lets one socket send, in the route's `detail.messages`: the most one message may weigh, how many a socket may send in a window, and how many sockets one client may hold open on the route.
export interface SocketLimits {
  maxSize?: ByteSize | undefined
  rateLimit?: { max: number, window: Duration } | undefined
  // The sockets one client may have open on the route at once, 20 by default, `false` for no limit; one past it is refused with 429.
  connections?: number | false | undefined
}

const LIMITS = Symbol.for('kay.socketLimits')
const CLOSE_POLICY = 1008
const CLOSE_TOO_BIG = 1009
const DEFAULT_RATE = { max: 100, window: '1s' } as const
const DEFAULT_CONNECTIONS = 20

interface Limits {
  bytes: number
  max: number
  windowMs: number
  // Open sockets by client, undefined when the route sets no limit on them.
  connections: { most: number, open: Map<string, number> } | undefined
}

interface Upgradable {
  upgrade: (request: Request, options?: { data?: unknown }) => boolean
}

type Handler = (ws: Closable, message: string | ArrayBuffer | Uint8Array) => unknown
type CloseHandler = (ws: Closable, code: number, reason: string) => unknown

interface Closable {
  close: (code: number, reason: string) => unknown
}

interface RouteContext {
  request?: Request
  server?: Upgradable | null
  [LIMITS]?: Limits
}

// Servers whose `upgrade` already carries the limits, so it is wrapped once.
const wrapped = new WeakSet<Upgradable>()

function limitsOf(path: string, given: SocketLimits | undefined): Limits {
  const bytes = byteSize(given?.maxSize ?? DEFAULT_BODY_LIMIT, `the maxSize of the websocket route ${path}`)
  const { max, window } = given?.rateLimit ?? DEFAULT_RATE
  const most = given?.connections ?? DEFAULT_CONNECTIONS

  if (!Number.isInteger(max) || max < 1)
    throw new KayError('config-invalid', `kay: the rateLimit of the websocket route ${path} has max ${String(max)}; it takes a whole number of messages from 1`)

  if (most !== false && (!Number.isInteger(most) || most < 1))
    throw new KayError('config-invalid', `kay: the connections of the websocket route ${path} is ${String(most)}; it takes a whole number of sockets from 1, or false for no limit`)

  const connections = most === false ? undefined : { most, open: new Map<string, number>() }

  try {
    return { bytes, max, windowMs: optionMs(window, 'window'), connections }
  }
  catch (error) {
    throw new KayError('config-invalid', `kay: the rateLimit of the websocket route ${path} is wrong: ${(error as Error).message}`)
  }
}

// A string weighs three bytes a character at most, so only a long one is measured.
function measured(text: string, bytes: number): number {
  return text.length * 3 > bytes ? Buffer.byteLength(text) : 0
}

// What one socket's messages are held to: a message over `bytes` closes it with 1009, more than `max` in a window with 1008.
// Counted per socket in memory, the window opening at its first message.
function guarded(message: Handler, { bytes, max, windowMs }: Limits): Handler {
  let opened = 0
  let count = 0

  return (ws, raw) => {
    const size = typeof raw === 'string' ? measured(raw, bytes) : raw.byteLength

    if (size > bytes)
      return ws.close(CLOSE_TOO_BIG, 'Message too big')

    const now = performance.now()

    if (now - opened >= windowMs) {
      opened = now
      count = 0
    }

    return ++count > max ? ws.close(CLOSE_POLICY, 'Too many messages') : message(ws, raw)
  }
}

// The cap kay gave each app, so a later route raises it and one the app set itself is left alone.
const payloadCaps = new WeakMap<Elysia, number>()

// Bun takes one `maxPayloadLength` for the whole server and buffers a frame up to it, 16 MiB by default, before kay's own check can close the socket: it is the largest `maxSize` of the app's routes.
function capPayload(app: Elysia, bytes: number): void {
  const own = app.config.websocket?.maxPayloadLength
  const given = payloadCaps.get(app)

  if (own !== undefined && own !== given)
    return

  const cap = Math.max(given ?? 0, bytes)

  payloadCaps.set(app, cap)
  app.config.websocket = { ...app.config.websocket, maxPayloadLength: cap }
}

// Undefined when no address is known, as on a unix socket or under `app.handle()`: clients that cannot be told apart are not counted as one.
function clientKey(request: Request, server: Upgradable | null | undefined): string | undefined {
  const address = knownAddress(request, server as Parameters<typeof knownAddress>[1])

  return address === undefined ? undefined : rateKey(address)
}

function hasRoom({ connections }: Limits, request: Request | undefined, server: Upgradable | null | undefined): boolean {
  const client = request === undefined ? undefined : clientKey(request, server)

  return !connections || client === undefined || (connections.open.get(client) ?? 0) < connections.most
}

// Elysia hands the server's `upgrade` the socket's data, whose `message` Bun calls with the raw frame before Elysia parses it: wrapping it there is the one place a frame is measured before a 16 MB JSON is parsed.
// Its `close` frees the client's place among the open sockets of the route.
function limitUpgrades(server: Upgradable): void {
  if (wrapped.has(server))
    return

  const upgrade = server.upgrade.bind(server)

  wrapped.add(server)
  server.upgrade = (request, options) => {
    const data = options?.data as { message?: Handler, close?: CloseHandler | undefined, [LIMITS]?: Limits } | undefined
    const limits = data?.[LIMITS]

    if (!data || !limits)
      return upgrade(request, options)

    data.message &&= guarded(data.message, limits)

    const { connections } = limits
    const client = clientKey(request, server)

    if (!connections || client === undefined)
      return upgrade(request, options)

    if (!hasRoom(limits, request, server))
      return false

    const close = data.close

    data.close = (ws, code, reason) => {
      const left = (connections.open.get(client) ?? 1) - 1

      if (left > 0)
        connections.open.set(client, left)
      else
        connections.open.delete(client)

      return close?.(ws, code, reason)
    }

    if (!upgrade(request, options)) {
      data.close = close

      return false
    }

    connections.open.set(client, (connections.open.get(client) ?? 0) + 1)

    return true
  }
}

// A hook run before a websocket route's upgrade, its limits checked when the module mounts: it puts them on the context, which Elysia copies into the socket's data, and answers 429 to a client whose places are all taken.
export function socketLimits(path: string, given: SocketLimits | undefined, app?: Elysia): (context: RouteContext) => Response | undefined {
  const limits = limitsOf(path, given)

  if (app)
    capPayload(app, limits.bytes)

  return (context) => {
    if (!hasRoom(limits, context.request, context.server))
      return new Response('Too many open connections', { status: 429 })

    context[LIMITS] = limits

    if (context.server)
      limitUpgrades(context.server)

    return undefined
  }
}
