// @kayjs/live — Zero-dependency typed real-time rooms, coalesced presence, and SSE streaming for Kay v2.
// Built strictly on Web Streams (text/event-stream) + KayPlugin (`api.route`) — zero core WebSocket coupling.

import type { KayPlugin } from '@kayjs/kay/config'
import type { RequestContext } from '@kayjs/kay/server'
import { definePlugin } from '@kayjs/kay/config'

export interface Subscriber<TMember> {
  readonly id: string
  readonly member: TMember
  send(chunk: Uint8Array): void
  close(): void
}

export type LiveAuthorizeHook = (
  ctx: RequestContext,
  room: string,
) => boolean | Response | Promise<boolean | Response>

export interface ConnectionLimits {
  /** Maximum concurrent subscribers per room (default: 1000). */
  maxConnectionsPerRoom?: number | undefined
  /** Maximum concurrent subscribers per client key / IP (default: 10). */
  maxConnectionsPerClient?: number | undefined
  /** Maximum concurrent subscribers across all rooms (default: 10000). */
  maxTotalConnections?: number | undefined
  /** Derive a client key for per-client caps (defaults to ctx.ip; skipped when unavailable). */
  clientKey?: ((ctx: RequestContext) => string | undefined) | undefined
  /** ReadableStream queue high-water mark in bytes before dropping stalled subscribers (default: 65536). */
  highWaterMark?: number | undefined
}

interface RoomsBaseOptions extends ConnectionLimits {
  /** Optional authorization hook checked before opening an SSE stream. */
  authorize?: LiveAuthorizeHook | undefined
}

/** The SSE endpoint the rooms plugin mounts at `path`, the member it streams as read from each request. */
export interface RoomsEndpointOptions<TMember> extends RoomsBaseOptions {
  path: string
  room?: string | ((ctx: RequestContext) => string) | undefined
  member: (ctx: RequestContext) => TMember | Promise<TMember>
  pingMs?: number | undefined
  onJoin?: ((room: string, member: TMember) => void) | undefined
  onLeave?: ((room: string, member: TMember) => void) | undefined
}

/** Without `path`, no endpoint is mounted and routes open streams with `rooms.stream()`. */
export type RoomsOptions<TMember = undefined> = RoomsEndpointOptions<TMember> | (RoomsBaseOptions & { path?: undefined })

export interface StreamOptions<TMember> extends ConnectionLimits {
  room: string
  member: TMember
  pingMs?: number | undefined
  onJoin?: ((room: string, member: TMember) => void) | undefined
  onLeave?: ((room: string, member: TMember) => void) | undefined
}

/** The plugin `kay.config.ts` registers (mounting the endpoint when `path` is set), and the handle routes publish with. */
export interface Rooms<TMessage, TMember = undefined> extends KayPlugin {
  join(room: string, sub: Subscriber<TMember>): void
  leave(room: string, sub: Subscriber<TMember>): void
  members(room: string): TMember[]
  size(room: string): number
  publish(room: string, message: TMessage, event?: string, id?: string): void
  /** Coalesce burst presence updates into a single microtask broadcast per room. */
  coalesce(build: (room: string) => TMessage, event?: string): (room: string) => void
  /** Create a streaming SSE Response for a room with automatic keepalive, caps, backpressure drop, and disconnect cleanup. */
  stream(ctx: RequestContext, options: StreamOptions<TMember>): Response
}

const DEFAULT_MAX_PER_ROOM = 1_000
const DEFAULT_MAX_PER_CLIENT = 10
const DEFAULT_MAX_TOTAL = 10_000
const DEFAULT_HIGH_WATER_MARK = 64 * 1024

const encoder = new TextEncoder()
const CR_LF_RE = /[\r\n]/

function assertSafeSseField(value: string | undefined, label: string): void {
  if (value !== undefined && CR_LF_RE.test(value))
    throw new RangeError(`@kayjs/live: SSE ${label} must not contain CR or LF characters`)
}

function encodeEvent(message: unknown, event?: string, id?: string): Uint8Array {
  assertSafeSseField(event, 'event name')
  assertSafeSseField(id, 'event id')
  let frame = ''
  if (id)
    frame += `id: ${id}\n`
  if (event)
    frame += `event: ${event}\n`
  const serialized = JSON.stringify(message) ?? 'null'
  frame += `data: ${serialized}\n\n`
  return encoder.encode(frame)
}

// ctx.ip already honours `trustProxy`; a forwarded header read here would let any client pick its own key.
// Missing IPs return undefined rather than pooling unrelated users into one shared 'anonymous' bucket.
function defaultClientKey(ctx: RequestContext): string | undefined {
  return ctx.ip || undefined
}

const PING_CHUNK = encoder.encode(': ping\n\n')
const RETRY_CHUNK = encoder.encode('retry: 2000\n\n')

interface RoomState<TMember> {
  readonly defaultOpts: RoomsOptions<TMember>
  readonly clientCounts: Map<string, number>
  join(room: string, sub: Subscriber<TMember>): void
  leave(room: string, sub: Subscriber<TMember>): void
  size(room: string): number
  getActiveConnections(): number
}

function openRoomStream<TMember>(
  state: RoomState<TMember>,
  ctx: RequestContext,
  opts: StreamOptions<TMember>,
): Response {
  const { room, member, pingMs = 20_000, onJoin, onLeave } = opts
  const { defaultOpts, clientCounts } = state
  const maxPerRoom = opts.maxConnectionsPerRoom ?? defaultOpts.maxConnectionsPerRoom ?? DEFAULT_MAX_PER_ROOM
  const maxPerClient = opts.maxConnectionsPerClient ?? defaultOpts.maxConnectionsPerClient ?? DEFAULT_MAX_PER_CLIENT
  const maxTotal = opts.maxTotalConnections ?? defaultOpts.maxTotalConnections ?? DEFAULT_MAX_TOTAL
  const highWaterMark = opts.highWaterMark ?? defaultOpts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK
  const resolveClientKey = opts.clientKey ?? defaultOpts.clientKey ?? defaultClientKey
  const rawClientId = resolveClientKey(ctx)
  const clientId = rawClientId !== undefined && rawClientId.length > 0 ? rawClientId : undefined

  if (clientId !== undefined && maxPerClient > 0 && (clientCounts.get(clientId) ?? 0) >= maxPerClient) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'retry-after': '5' },
    })
  }

  if ((maxPerRoom > 0 && state.size(room) >= maxPerRoom) || (maxTotal > 0 && state.getActiveConnections() >= maxTotal)) {
    return new Response('Service Unavailable', {
      status: 503,
      headers: { 'retry-after': '5' },
    })
  }

  let cleaned = false
  let joined = false
  let timer: ReturnType<typeof setInterval> | undefined
  let sub: Subscriber<TMember> | undefined
  let countedClient = false
  let abortHandler: (() => void) | undefined

  const cleanup = () => {
    if (cleaned)
      return
    cleaned = true
    if (abortHandler !== undefined) {
      ctx.request.signal.removeEventListener('abort', abortHandler)
      abortHandler = undefined
    }
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (countedClient && clientId !== undefined) {
      countedClient = false
      const remaining = (clientCounts.get(clientId) ?? 1) - 1
      if (remaining <= 0)
        clientCounts.delete(clientId)
      else
        clientCounts.set(clientId, remaining)
    }
    if (sub !== undefined) {
      state.leave(room, sub)
      if (joined)
        onLeave?.(room, member)
    }
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const drop = () => {
        cleanup()
        try {
          controller.close()
        }
        catch {
          // Stream may already be closed or errored by the consumer.
        }
      }

      sub = {
        id: crypto.randomUUID(),
        member,
        send(chunk) {
          if (cleaned)
            return
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            drop()
            return
          }
          try {
            controller.enqueue(chunk)
          }
          catch {
            drop()
          }
        },
        close: drop,
      }

      if (clientId !== undefined) {
        clientCounts.set(clientId, (clientCounts.get(clientId) ?? 0) + 1)
        countedClient = true
      }

      try {
        controller.enqueue(RETRY_CHUNK)
        state.join(room, sub)
        onJoin?.(room, member)
        joined = true
      }
      catch (err) {
        cleanup()
        throw err
      }

      if (pingMs > 0) {
        timer = setInterval(() => {
          sub?.send(PING_CHUNK)
        }, pingMs)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }

      if (ctx.request.signal.aborted) {
        drop()
      }
      else {
        abortHandler = drop
        ctx.request.signal.addEventListener('abort', drop, { once: true })
      }
    },
    cancel() {
      cleanup()
    },
  }, { highWaterMark, size: chunk => chunk?.byteLength ?? 0 })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

export function createRooms<TMessage, TMember = undefined>(
  options: RoomsOptions<TMember> = {},
): Rooms<TMessage, TMember> {
  const defaultOpts: RoomsOptions<TMember> = options

  const map = new Map<string, Set<Subscriber<TMember>>>()
  const clientCounts = new Map<string, number>()
  let activeConnections = 0

  function join(room: string, sub: Subscriber<TMember>): void {
    let set = map.get(room)
    if (set === undefined) {
      set = new Set()
      map.set(room, set)
    }
    if (!set.has(sub)) {
      set.add(sub)
      activeConnections++
    }
  }

  function leave(room: string, sub: Subscriber<TMember>): void {
    const set = map.get(room)
    if (set === undefined)
      return
    if (set.delete(sub))
      activeConnections--
    if (set.size === 0)
      map.delete(room)
  }

  function members(room: string): TMember[] {
    const set = map.get(room)
    if (set === undefined)
      return []
    const out: TMember[] = []
    for (const sub of set)
      out.push(sub.member)
    return out
  }

  function size(room: string): number {
    return map.get(room)?.size ?? 0
  }

  function publish(room: string, message: TMessage, event?: string, eventId?: string): void {
    // Validate event & id eagerly even if room is empty so injection attempts always fail fast
    assertSafeSseField(event, 'event name')
    assertSafeSseField(eventId, 'event id')
    const set = map.get(room)
    if (set === undefined || set.size === 0)
      return
    const chunk = encodeEvent(message, event, eventId)
    for (const sub of [...set]) {
      try {
        sub.send(chunk)
      }
      catch {
        sub.close()
      }
    }
  }

  function coalesce(build: (room: string) => TMessage, event?: string): (room: string) => void {
    assertSafeSseField(event, 'event name')
    const pending = new Set<string>()
    return (room: string) => {
      if (pending.has(room))
        return
      pending.add(room)
      queueMicrotask(() => {
        pending.delete(room)
        if (size(room) > 0)
          publish(room, build(room), event)
      })
    }
  }

  const roomState: RoomState<TMember> = {
    defaultOpts,
    clientCounts,
    join,
    leave,
    size,
    getActiveConnections: () => activeConnections,
  }

  function stream(ctx: RequestContext, opts: StreamOptions<TMember>): Response {
    return openRoomStream(roomState, ctx, opts)
  }

  // An open stream would hold a graceful stop until its timeout.
  function closeAll(): void {
    for (const set of [...map.values()]) {
      for (const sub of [...set])
        sub.close()
    }
  }

  function endpoint(opts: RoomsEndpointOptions<TMember>): KayPlugin {
    if (typeof opts.member !== 'function')
      throw new TypeError(`@kayjs/live: createRooms({ path: '${opts.path}' }) needs member(ctx), the member each stream joins as`)
    return definePlugin({
      name: `@kayjs/live(${opts.path})`,
      server(api) {
        api.onShutdown(closeAll)
        api.route('GET', opts.path, async (ctx) => {
          const room = typeof opts.room === 'function' ? opts.room(ctx) : (opts.room ?? 'default')
          if (opts.authorize !== undefined) {
            const decision = await opts.authorize(ctx, room)
            if (decision instanceof Response)
              return decision
            if (decision === false)
              return new Response('Forbidden', { status: 403 })
          }
          const member = await opts.member(ctx)
          return stream(ctx, { ...opts, room, member })
        })
      },
    })
  }

  const plugin = options.path === undefined ? definePlugin({ name: '@kayjs/live', server: api => api.onShutdown(closeAll) }) : endpoint(options)
  return { ...plugin, join, leave, members, size, publish, coalesce, stream }
}
