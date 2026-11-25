// @kayjs/live — Zero-dependency typed real-time rooms, coalesced presence, and SSE streaming for Kay v2.
// Built strictly on Web Streams (text/event-stream) + KayPlugin (`api.route`) — zero core WebSocket coupling.

import type { KayPlugin, RequestContext } from '@kayjs/kay/server'
import { definePlugin } from '@kayjs/kay/server'

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
  /** Derive a client key for per-client caps (defaults to ctx.ip, else 'anonymous'). */
  clientKey?: ((ctx: RequestContext) => string) | undefined
  /** ReadableStream queue high-water mark before dropping stalled subscribers (default: 64). */
  highWaterMark?: number | undefined
}

export interface RoomsOptions extends ConnectionLimits {
  /** Optional authorization hook checked before opening an SSE stream. */
  authorize?: LiveAuthorizeHook | undefined
}

export interface StreamOptions<TMember> extends ConnectionLimits {
  room: string
  member: TMember
  pingMs?: number | undefined
  onJoin?: ((room: string, member: TMember) => void) | undefined
  onLeave?: ((room: string, member: TMember) => void) | undefined
}

export interface LivePluginOptions<TMember> extends ConnectionLimits {
  path: string
  room?: string | ((ctx: RequestContext) => string) | undefined
  member: (ctx: RequestContext) => TMember | Promise<TMember>
  pingMs?: number | undefined
  onJoin?: ((room: string, member: TMember) => void) | undefined
  onLeave?: ((room: string, member: TMember) => void) | undefined
  authorize?: LiveAuthorizeHook | undefined
}

export interface Rooms<TMessage, TMember = undefined> {
  join(room: string, sub: Subscriber<TMember>): void
  leave(room: string, sub: Subscriber<TMember>): void
  members(room: string): TMember[]
  size(room: string): number
  publish(room: string, message: TMessage, event?: string, id?: string): void
  /** Coalesce burst presence updates into a single microtask broadcast per room. */
  coalesce(build: (room: string) => TMessage, event?: string): (room: string) => void
  /** Create a streaming SSE Response for a room with automatic keepalive, caps, backpressure drop, and disconnect cleanup. */
  stream(ctx: RequestContext, options: StreamOptions<TMember>): Response
  /** Optional KayPlugin helper to mount an SSE endpoint directly via `kay.config.ts`. */
  plugin(options: LivePluginOptions<TMember>): KayPlugin
}

const DEFAULT_MAX_PER_ROOM = 1_000
const DEFAULT_MAX_PER_CLIENT = 10
const DEFAULT_MAX_TOTAL = 10_000
const DEFAULT_HIGH_WATER_MARK = 64

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
  frame += `data: ${JSON.stringify(message)}\n\n`
  return encoder.encode(frame)
}

// ctx.ip already honours `trustProxy`; a forwarded header read here would let any client pick its own key.
function defaultClientKey(ctx: RequestContext): string {
  return ctx.ip || 'anonymous'
}

const PING_CHUNK = encoder.encode(': ping\n\n')
const RETRY_CHUNK = encoder.encode('retry: 2000\n\n')

export function createRooms<TMessage, TMember = undefined>(
  options: RoomsOptions = {},
): Rooms<TMessage, TMember> {
  const defaultOpts: RoomsOptions = options

  const map = new Map<string, Set<Subscriber<TMember>>>()
  const clientCounts = new Map<string, number>()

  function totalConnections(): number {
    let total = 0
    for (const set of map.values())
      total += set.size
    return total
  }

  function join(room: string, sub: Subscriber<TMember>): void {
    let set = map.get(room)
    if (set === undefined) {
      set = new Set()
      map.set(room, set)
    }
    set.add(sub)
  }

  function leave(room: string, sub: Subscriber<TMember>): void {
    const set = map.get(room)
    if (set === undefined)
      return
    set.delete(sub)
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

  function stream(ctx: RequestContext, opts: StreamOptions<TMember>): Response {
    const { room, member, pingMs = 20_000, onJoin, onLeave } = opts
    const maxPerRoom = opts.maxConnectionsPerRoom ?? defaultOpts.maxConnectionsPerRoom ?? DEFAULT_MAX_PER_ROOM
    const maxPerClient = opts.maxConnectionsPerClient ?? defaultOpts.maxConnectionsPerClient ?? DEFAULT_MAX_PER_CLIENT
    const maxTotal = opts.maxTotalConnections ?? defaultOpts.maxTotalConnections ?? DEFAULT_MAX_TOTAL
    const highWaterMark = opts.highWaterMark ?? defaultOpts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK
    const resolveClientKey = opts.clientKey ?? defaultOpts.clientKey ?? defaultClientKey
    const clientId = resolveClientKey(ctx)

    const currentClientCount = clientCounts.get(clientId) ?? 0
    if (maxPerClient > 0 && currentClientCount >= maxPerClient) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'retry-after': '5' },
      })
    }

    if ((maxPerRoom > 0 && size(room) >= maxPerRoom) || (maxTotal > 0 && totalConnections() >= maxTotal)) {
      return new Response('Service Unavailable', {
        status: 503,
        headers: { 'retry-after': '5' },
      })
    }

    let cleaned = false
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
      if (countedClient) {
        countedClient = false
        const remaining = (clientCounts.get(clientId) ?? 1) - 1
        if (remaining <= 0)
          clientCounts.delete(clientId)
        else
          clientCounts.set(clientId, remaining)
      }
      if (sub !== undefined) {
        leave(room, sub)
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
          catch {}
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

        clientCounts.set(clientId, (clientCounts.get(clientId) ?? 0) + 1)
        countedClient = true

        try {
          controller.enqueue(RETRY_CHUNK)
          join(room, sub)
          onJoin?.(room, member)
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
    }, { highWaterMark })

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    })
  }

  function plugin(opts: LivePluginOptions<TMember>): KayPlugin {
    return definePlugin({
      name: `@kayjs/live(${opts.path})`,
      server(api) {
        api.route('GET', opts.path, async (ctx) => {
          const room = typeof opts.room === 'function' ? opts.room(ctx) : (opts.room ?? 'default')
          const authFn = opts.authorize ?? defaultOpts.authorize
          if (authFn !== undefined) {
            const decision = await authFn(ctx, room)
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

  return { join, leave, members, size, publish, coalesce, stream, plugin }
}
