import { describe, expect, it } from 'bun:test'
import { ServerWebSocket } from '../src/server'

describe('ServerWebSocket', () => {
  it('opens a socket with headers and a protocol, which the DOM constructor types refuse', async () => {
    const seen: (string | null)[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, serving) {
        seen.push(request.headers.get('x-token'), request.headers.get('sec-websocket-protocol'))

        return serving.upgrade(request, { headers: { 'sec-websocket-protocol': 'chat' } }) ? undefined : new Response('no', { status: 400 })
      },
      websocket: { message(socket, data) {
        socket.send(`echo ${String(data)}`)
      } },
    })

    try {
      const socket = new ServerWebSocket(`ws://127.0.0.1:${server.port}/`, { headers: { 'x-token': 'abc' }, protocols: ['chat'] })
      const reply = await new Promise<string>((resolve, reject) => {
        socket.addEventListener('open', () => socket.send('hi'))
        socket.addEventListener('message', event => resolve(String(event.data)))
        socket.addEventListener('error', () => reject(new Error('socket failed')))
      })

      expect(reply).toBe('echo hi')
      expect(seen).toEqual(['abc', 'chat'])
      expect(socket instanceof WebSocket).toBe(true)
      expect(ServerWebSocket.OPEN).toBe(1)
      socket.close()
    }
    finally {
      await server.stop(true)
    }
  })
})
