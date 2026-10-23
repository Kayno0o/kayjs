import type { ByteSize } from '../runtime/byte-size'
import type { Duration } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { byteSize } from '../runtime/byte-size'
import { optionMs } from '../runtime/duration'
import { DEFAULT_BODY_LIMIT } from './body'

// What a websocket route lets one socket send, in the route's `detail.messages`: the most one message may weigh, and how many a socket may send in a window.
export interface SocketLimits {
  maxSize?: ByteSize | undefined
  rateLimit?: { max: number, window: Duration } | undefined
}

const LIMITS = Symbol.for('kay.socketLimits')
const CLOSE_POLICY = 1008
const CLOSE_TOO_BIG = 1009
const DEFAULT_RATE = { max: 100, window: '1s' } as const

interface Limits {
  bytes: number
  max: number
  windowMs: number
}

interface Upgradable {
  upgrade: (request: Request, options?: { data?: unknown }) => boolean
}

type Handler = (ws: Closable, message: string | ArrayBuffer | Uint8Array) => unknown

interface Closable {
  close: (code: number, reason: string) => unknown
}

interface RouteContext {
  server?: Upgradable | null
  [LIMITS]?: Limits
}

// Servers whose `upgrade` already carries the limits, so it is wrapped once.
const wrapped = new WeakSet<Upgradable>()

function limitsOf(path: string, given: SocketLimits | undefined): Limits {
  const bytes = byteSize(given?.maxSize ?? DEFAULT_BODY_LIMIT, `the maxSize of the websocket route ${path}`)
  const { max, window } = given?.rateLimit ?? DEFAULT_RATE

  if (!Number.isInteger(max) || max < 1)
    throw new KayError('config-invalid', `kay: the rateLimit of the websocket route ${path} has max ${String(max)}; it takes a whole number of messages from 1`)

  try {
    return { bytes, max, windowMs: optionMs(window, 'window') }
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

// Elysia hands the server's `upgrade` the socket's data, whose `message` Bun calls with the raw frame before Elysia parses it: wrapping it there is the one place a frame is measured before a 16 MB JSON is parsed.
function limitUpgrades(server: Upgradable): void {
  if (wrapped.has(server))
    return

  const upgrade = server.upgrade.bind(server)

  wrapped.add(server)
  server.upgrade = (request, options) => {
    const data = options?.data as { message?: Handler, [LIMITS]?: Limits } | undefined
    const limits = data?.[LIMITS]

    if (data?.message && limits)
      data.message = guarded(data.message, limits)

    return upgrade(request, options)
  }
}

// A hook run before a websocket route's upgrade, its limits checked when the module mounts: it puts them on the context, which Elysia copies into the socket's data.
export function socketLimits(path: string, given: SocketLimits | undefined): (context: RouteContext) => void {
  const limits = limitsOf(path, given)

  return (context) => {
    context[LIMITS] = limits

    if (context.server)
      limitUpgrades(context.server)
  }
}
