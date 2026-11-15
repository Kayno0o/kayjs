import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const root = resolve(import.meta.dir, 'fixtures/socket-protocol')
const { default: echo, room } = await import(resolve(root, 'src/api/echo.ts')) as typeof import('./fixtures/socket-protocol/src/api/echo')
const site = await testSite({ root, islands: false })

// The server the site starts with its first socket, whose port a raw socket needs.
const serve = Bun.serve
let port = 0

Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  const server = serve(options)

  port = server.port!

  return server
}) as typeof Bun.serve
site.socket(echo, '/replies')
Bun.serve = serve

afterAll(site.close)

// A raw socket: the frames as the server wrote them, and a way to send what a kay client never would.
async function raw(path: string): Promise<{ socket: WebSocket, frames: string[], closed: Promise<number> }> {
  const socket = new WebSocket(`ws://localhost:${port}/api/echo${path}`)
  const frames: string[] = []
  const closed = new Promise<number>(resolve => (socket.onclose = event => resolve(event.code)))

  socket.onmessage = event => void frames.push(String(event.data))
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('the socket did not open'))
  })

  return { socket, frames, closed }
}

async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done() && waited < 3_000; waited += 10)
    await Bun.sleep(10)
}

describe('the frames of a websocket route', () => {
  it('hand a handler that throws to the route\'s error hook, the socket staying open', async () => {
    const { socket, frames } = await raw('/boom')

    socket.send('1')
    await until(() => frames.length === 1)
    socket.send('2')
    await until(() => frames.length === 2)

    expect(frames.map(frame => JSON.parse(frame) as unknown)).toEqual(['reported', 'reported'])
    socket.close()
  })

  it('are JSON both ways: a string, a number, a boolean, null, an object and an array read back as what they were', async () => {
    const { socket, frames } = await raw('/replies')

    for (const kind of ['string', 'numeric', 'number', 'zero', 'boolean', 'null', 'object', 'array', 'returned'])
      socket.send(JSON.stringify(kind))

    await until(() => frames.length === 9)
    socket.close()
    expect(frames).toEqual(['"hi"', '"42"', '42', '0', 'false', 'null', '{"a":1}', '[1,"two",null]', '7'])
  })

  it('reach a typed client as the values they carry', async () => {
    const client = site.socket(echo, '/replies')

    for (const kind of ['numeric', 'number', 'boolean', 'null'])
      client.send(kind)

    expect([await client.next(), await client.next(), await client.next(), await client.next()]).toEqual(['42', 42, false, null])
    client.close()
  })

  it('answer a frame that is not JSON, or is binary, with the error and keep the socket open', async () => {
    const { socket, frames } = await raw('/replies')

    socket.send('plain text')
    socket.send(new Uint8Array([1, 2]).buffer)
    socket.send('"string"')
    await until(() => frames.length === 3)
    socket.close()

    const [first, second, third] = frames.map(frame => JSON.parse(frame) as { error?: { key: string, fields: Record<string, string> } })

    expect(first).toEqual({ error: { key: 'kay.socket.notJson', fields: { '': 'A message must be JSON' } } })
    expect(second).toEqual(first)
    expect(third).toEqual('hi' as never)
  })

  it('refuse a message of the wrong kind with its fields and nothing of the schema', async () => {
    const { socket, frames } = await raw('/replies')

    socket.send('5')
    await until(() => frames.length === 1)
    socket.close()

    const { error } = JSON.parse(frames[0]!) as { error: { key: string, fields: Record<string, string> } }

    expect(error.key).toBe('kay.socket.invalid')
    expect(Object.values(error.fields)).toHaveLength(1)
    expect(frames[0]).not.toContain('"type"')
  })

  it('close the socket on a frame of 16 MB, whatever it holds, before it is parsed', async () => {
    const { socket, frames, closed } = await raw('/replies')

    socket.send(`"${'x'.repeat(16 * 1024 * 1024)}"`)
    expect(await closed).toBe(1009)
    expect(frames).toEqual([])
  })

  it('fail a route that sends what its response schema refuses, with no frame and the socket left open', async () => {
    const { socket, frames } = await raw('/bad')

    socket.send('1')
    await Bun.sleep(100)
    expect(frames).toEqual([])
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })
})

describe('rooms on a websocket route', () => {
  it('send what they publish as JSON, and check it against their reply schema where it is published', async () => {
    const { socket, frames } = await raw('/room')

    await until(() => room.members('only').length === 1)
    socket.send('{"n":1}')
    await until(() => frames.length === 1)
    expect(frames).toEqual(['{"n":1}'])
    expect(() => room.publish('only', { n: 'x' } as never)).toThrow('reply')
    socket.close()
  })

  it('leave on close, and a message published after reaches no closed socket', async () => {
    const { socket, closed } = await raw('/room')

    await until(() => room.members('only').length === 1)
    socket.close()
    await closed
    await until(() => room.members('only').length === 0)
    expect(() => room.publish('only', { n: 2 })).not.toThrow()
    expect(room.members('only')).toHaveLength(0)
  })
})
