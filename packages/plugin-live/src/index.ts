// @kayjs/live — Zero-dependency typed real-time rooms, coalesced presence, and SSE streaming for Kay v2.
// Built strictly on Web Streams (text/event-stream) + KayPlugin (`api.route`) — zero core WebSocket coupling.

import type { KayPlugin, RequestContext } from 'kay/server'

export interface Subscriber<TMember> {
  readonly id: string
  readonly member: TMember
  send(chunk: Uint8Array): void
  close(): void
}

export interface Rooms<TMessage, TMember = undefined> {
  join(room: string, sub: Subscriber<TMember>): void
  leave(room: string, sub: Subscriber<TMember>): void
  members(room: string): TMember[]
  size(room: string): number
  publish(room: string, message: TMessage, event?: string): void
  /** Coalesce burst presence updates into a single microtask broadcast per room. */
  coalesce(build: (room: string) => TMessage, event?: string): (room: string) => void
  /** Create a streaming SSE Response for a room with automatic keepalive and disconnect cleanup. */
  stream(ctx: RequestContext, options: {
    room: string
    member: TMember
    pingMs?: number | undefined
    onJoin?: ((room: string, member: TMember) => void) | undefined
    onLeave?: ((room: string, member: TMember) => void) | undefined
  }): Response
  /** Optional KayPlugin helper to mount an SSE endpoint directly via `kay.config.ts`. */
  plugin(options: {
    path: string
    room?: string | ((ctx: RequestContext) => string) | undefined
    member: (ctx: RequestContext) => TMember | Promise<TMember>
    pingMs?: number | undefined
    onJoin?: ((room: string, member: TMember) => void) | undefined
    onLeave?: ((room: string, member: TMember) => void) | undefined
  }): KayPlugin
}

const encoder = new TextEncoder()

function encodeEvent(message: unknown, event?: string): Uint8Array {
  const prefix = event ? `event: ${event}\n` : ''
  return encoder.encode(`${prefix}data: ${JSON.stringify(message)}\n\n`)
}

const PING_CHUNK = encoder.encode(': ping\n\n')
const RETRY_CHUNK = encoder.encode('retry: 2000\n\n')

export function createRooms<TMessage, TMember = undefined>(id?: string): Rooms<TMessage, TMember> {
  // Share room map across bundled server chunks when `id` is provided
  const map: Map<string, Set<Subscriber<TMember>>> = id !== undefined
    ? (((globalThis as Record<symbol, Map<string, Set<Subscriber<TMember>>> | undefined>)[Symbol.for(`kay.live.rooms.${id}`)] ??= new Map()))
    : new Map()

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

  function publish(room: string, message: TMessage, event?: string): void {
    const set = map.get(room)
    if (set === undefined || set.size === 0)
      return
    const chunk = encodeEvent(message, event)
    for (const sub of [...set]) {
      try {
        sub.send(chunk)
      }
      catch {
        leave(room, sub)
      }
    }
  }

  function coalesce(build: (room: string) => TMessage, event?: string): (room: string) => void {
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

  function stream(
    ctx: RequestContext,
    opts: {
      room: string
      member: TMember
      pingMs?: number | undefined
      onJoin?: ((room: string, member: TMember) => void) | undefined
      onLeave?: ((room: string, member: TMember) => void) | undefined
    },
  ): Response {
    const { room, member, pingMs = 20_000, onJoin, onLeave } = opts
    let cleaned = false
    let timer: ReturnType<typeof setInterval> | undefined
    let sub: Subscriber<TMember> | undefined

    const cleanup = () => {
      if (cleaned)
        return
      cleaned = true
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      if (sub !== undefined) {
        leave(room, sub)
        onLeave?.(room, member)
      }
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sub = {
          id: crypto.randomUUID(),
          member,
          send(chunk) {
            if (!cleaned)
              controller.enqueue(chunk)
          },
          close() {
            cleanup()
            try {
              controller.close()
            }
            catch {}
          },
        }

        controller.enqueue(RETRY_CHUNK)
        join(room, sub)
        onJoin?.(room, member)

        if (pingMs > 0) {
          timer = setInterval(() => {
            if (!cleaned) {
              try {
                controller.enqueue(PING_CHUNK)
              }
              catch {
                cleanup()
              }
            }
          }, pingMs)
        }

        ctx.request.signal.addEventListener('abort', () => {
          cleanup()
          try {
            controller.close()
          }
          catch {}
        }, { once: true })
      },
      cancel() {
        cleanup()
      },
    })

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    })
  }

  function plugin(opts: {
    path: string
    room?: string | ((ctx: RequestContext) => string) | undefined
    member: (ctx: RequestContext) => TMember | Promise<TMember>
    pingMs?: number | undefined
    onJoin?: ((room: string, member: TMember) => void) | undefined
    onLeave?: ((room: string, member: TMember) => void) | undefined
  }): KayPlugin {
    return {
      name: `@kayjs/live(${opts.path})`,
      server(api) {
        api.route('GET', opts.path, async (ctx) => {
          const room = typeof opts.room === 'function' ? opts.room(ctx) : (opts.room ?? 'default')
          const member = await opts.member(ctx)
          return stream(ctx, {
            room,
            member,
            pingMs: opts.pingMs,
            onJoin: opts.onJoin,
            onLeave: opts.onLeave,
          })
        })
      },
    }
  }

  return { join, leave, members, size, publish, coalesce, stream, plugin }
}
