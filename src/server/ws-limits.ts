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

const ADMISSION = Symbol.for('kay.socketAdmission')
const CLOSE_POLICY = 1008
const CLOSE_TOO_BIG = 1009
const DEFAULT_RATE = { max: 100, window: '1s' } as const
const DEFAULT_CONNECTIONS = 20
// How long the place of an upgrade is held while the socket has not opened, which a refused handshake never does.
const PENDING_MS = 10_000

interface Limits {
  bytes: number
  max: number
  windowMs: number
  // Open sockets by client, undefined when the route sets no limit on them.
  connections: { most: number, open: Map<string, number> } | undefined
}

interface Upgradable {
  requestIP?: unknown
}

interface RouteContext {
  request?: Request
  server?: Upgradable | null
  [ADMISSION]?: Admission
}

// What the upgrade of one socket was admitted with: the route's limits, the place it holds among its client's open sockets, and how its own messages run in the request's locale.
export interface Admission {
  limits: Limits
  // Frees the place, once: the socket closed, or the upgrade never opened.
  release: () => void
  // The socket opened, so its place is held until it closes.
  opened: () => void
  locale: <T>(run: () => T) => T
}

// The admission an upgrade left in the data of its socket.
export function admissionOf(data: unknown): Admission | undefined {
  return (data as { [ADMISSION]?: Admission } | undefined)?.[ADMISSION]
}

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

// What one socket's messages are held to: a message over the route's `bytes` closes it with 1009, more than `max` in a window with 1008.
// Counted per socket in memory, the window opening at its first message.
export function frameGuard({ bytes, max, windowMs }: Limits): (frame: string | ArrayBuffer | Uint8Array) => { code: number, reason: string } | undefined {
  let opened = 0
  let count = 0

  return (frame) => {
    const size = typeof frame === 'string' ? measured(frame, bytes) : frame.byteLength

    if (size > bytes)
      return { code: CLOSE_TOO_BIG, reason: 'Message too big' }

    const now = performance.now()

    if (now - opened >= windowMs) {
      opened = now
      count = 0
    }

    return ++count > max ? { code: CLOSE_POLICY, reason: 'Too many messages' } : undefined
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

function hasRoom({ connections }: Limits, client: string | undefined): boolean {
  return !connections || client === undefined || (connections.open.get(client) ?? 0) < connections.most
}

// A hook run before a websocket route's upgrade, its limits checked when the module mounts: it answers 429 to a client whose places are all taken, and else takes one for the upgrade and leaves the admission on the context, which Elysia copies into the socket's data for `adopt()`.
// The place is freed when the socket closes, or after `PENDING_MS` when the upgrade never opened.
export function socketLimits(path: string, given: SocketLimits | undefined, app?: Elysia, inLocale: <T>(request: Request, run: () => T) => T = (_request, run) => run()): (context: RouteContext) => Response | undefined {
  const limits = limitsOf(path, given)

  if (app)
    capPayload(app, limits.bytes)

  return (context) => {
    const { request, server } = context
    const client = request === undefined ? undefined : clientKey(request, server)

    if (!hasRoom(limits, client))
      return new Response('Too many open connections', { status: 429 })

    const { connections } = limits
    const upgrading = request?.headers.get('upgrade')?.toLowerCase() === 'websocket'
    let held = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const release = () => {
      clearTimeout(timer)

      if (!held || !connections || client === undefined)
        return

      held = false

      const left = (connections.open.get(client) ?? 1) - 1

      if (left > 0)
        connections.open.set(client, left)
      else
        connections.open.delete(client)
    }

    if (upgrading && connections && client !== undefined) {
      held = true
      connections.open.set(client, (connections.open.get(client) ?? 0) + 1)
      timer = setTimeout(release, PENDING_MS)
      timer.unref()
    }

    context[ADMISSION] = { limits, release, opened: () => clearTimeout(timer), locale: run => request === undefined ? run() : inLocale(request, run) }

    return undefined
  }
}
