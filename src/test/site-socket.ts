import type { EventReader } from '../runtime/live'
import type { SiteScope } from './site-scope'
import type { TestSite } from './site-types'
import { joinBase } from '../runtime/base'
import { openSocket, readEvents, routeUrl, streamRequest } from '../runtime/live'
import { effect, root as reactiveRoot } from '../runtime/reactive'
import { withKept } from './cookies'
import { NativeFetch, NativeWebSocket } from './natives'
import { withDefaults } from './site-scope'

// How long a refused upgrade may take to answer.
const REFUSAL_TIMEOUT_MS = 5_000
const UPGRADE = { 'upgrade': 'websocket', 'connection': 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' }
// The DOM typings of WebSocket hide the options Bun takes, the upgrade's headers among them.
const BunWebSocket = NativeWebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket

export function socketsOf({ defaults, keyHeader, base, jar, send, listening, connections }: SiteScope): Pick<TestSite, 'socket' | 'socketRefusal' | 'stream'> {
  // What a socket's upgrade carries: the site's headers, the cookies so far and the call's own.
  const upgradeHeaders = (url: string, given: Record<string, string> | undefined): Record<string, string> => {
    const headers = withDefaults(defaults, given, keyHeader)

    const cookie = withKept(headers.get('cookie'), jar.header(joinBase(base, url)))

    if (cookie !== '')
      headers.set('cookie', cookie)

    return Object.fromEntries(headers)
  }

  return {
    socket: (module, path, ...[options]) => {
      const url = routeUrl(module, path, options as Parameters<typeof routeUrl>[2])
      const client = openSocket(() => new BunWebSocket(`ws://localhost:${listening().port}${url}`, { headers: upgradeHeaders(url, options?.headers) }))
      const tested = Object.assign(client, inbox(client))

      connections.add(client)
      client.start()

      return tested as never
    },
    socketRefusal: async (module, path, ...[options]) => {
      const url = routeUrl(module, path, options as Parameters<typeof routeUrl>[2])
      const attempt = new AbortController()
      const timer = setTimeout(() => attempt.abort(), REFUSAL_TIMEOUT_MS)
      const connection = { close: () => attempt.abort() }

      connections.add(connection)

      try {
        const response = await NativeFetch(`http://localhost:${listening().port}${url}`, { headers: { ...UPGRADE, ...upgradeHeaders(url, options?.headers) }, redirect: 'manual', signal: attempt.signal })

        if (response.status === 101) {
          await response.body?.cancel()

          throw new Error(`kay: the upgrade to ${url} was accepted, where a refusal was expected`)
        }

        jar.keep(response)

        return response
      }
      finally {
        clearTimeout(timer)
        connections.delete(connection)
      }
    },
    stream: (module, path, ...[options]) => {
      const url = routeUrl(module, path, options as Parameters<typeof routeUrl>[2])
      const init = streamRequest(options)
      const reader = readEvents(async signal => send(url, { ...init, headers: { ...init.headers, ...options?.headers }, signal }), init.method === 'GET')
      const tested = Object.assign(reader, inbox(reader))
      const finished = new Promise<unknown[]>((resolve) => {
        reactiveRoot(dispose => effect(() => {
          const status = reader.status()

          if (status !== 'connecting' && status !== 'open') {
            dispose()
            resolve(tested.received)
          }
        }))
      })

      Object.assign(tested, { finished: async () => finished })
      connections.add(reader)
      reader.start()

      return tested as never
    },
  }
}

// Keeps every message a client receives, for a test to read in order.
function inbox<T>(client: Pick<EventReader<T>, 'on'>): { received: T[], next: () => Promise<T> } {
  const received: T[] = []
  const waiting: ((value: T) => void)[] = []
  let read = 0

  client.on((value) => {
    received.push(value)

    const waiter = waiting.shift()

    if (waiter) {
      read++
      waiter(value)
    }
  })

  return {
    received,
    next: async () => read < received.length ? received[read++]! : new Promise<T>(resolve => waiting.push(resolve)),
  }
}
