import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const root = resolve(import.meta.dir, 'fixtures/ws-body')
const api = resolve(root, 'src/api')
const { default: rooms } = await import(resolve(api, 'rooms.ts')) as typeof import('./fixtures/ws-body/src/api/rooms')
const site = await testSite({ root })

// The server the site starts with its first socket, whose port a raw socket needs.
const serve = Bun.serve
let port = 0

Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  const server = serve(options)

  port = server.port!

  return server
}) as typeof Bun.serve
site.socket(rooms, '/')
Bun.serve = serve

afterAll(site.close)

// What the server sent to a raw socket, which `send` of a typed one would not let a test write.
async function frames(path: string, ...messages: (string | ArrayBuffer)[]): Promise<string[]> {
  const socket = new WebSocket(`ws://localhost:${port}${path}`)
  const received: string[] = []

  socket.onmessage = event => received.push(String(event.data))
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('the socket did not open'))
  })

  for (const message of messages)
    socket.send(message)

  // A sentinel the route echoes ends the wait: frames come back in order.
  socket.send('{"type":"say","text":"end"}')

  for (let waited = 0; !received.some(frame => frame.includes('"end"')) && waited < 3_000; waited += 10)
    await Bun.sleep(10)

  socket.close()

  return received.filter(frame => !frame.includes('"end"'))
}

describe('a websocket route with a body schema', () => {
  it('drops a message the schema refuses, with no frame to the sender', async () => {
    const socket = site.socket(rooms, '/')

    socket.send({ type: 'say' } as never)
    socket.send({ type: 'say', text: 'hi' })
    expect(await socket.next()).toEqual({ type: 'echo', body: { type: 'say', text: 'hi' }, kinds: ['type:string', 'text:string'] })
    expect(socket.received).toHaveLength(1)
  })

  it('coerces a valid message as an HTTP body is', async () => {
    const socket = site.socket(rooms, '/')

    socket.send({ type: 'move', at: '1' } as never)
    expect(await socket.next()).toEqual({ type: 'echo', body: { type: 'move', at: 1 }, kinds: ['type:string', 'at:number'] })

    const http = await site.fetch('/api/rooms/h', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"at":"1"}' })

    expect(await http.json()).toEqual({ at: 1 })
  })

  it('drops a number past what the schema holds, a wrong kind and a missing field', async () => {
    expect(await frames('/api/rooms', '{"type":"move","at":"x"}', '{"type":"move","at":1.5}', '{"type":"move"}', '{"type":"nope"}', '[]', 'null', '7')).toEqual([])
  })

  it('drops frames that are not JSON, a binary one and an oversized one without closing the connection', async () => {
    const big = JSON.stringify({ type: 'say', text: 'x'.repeat(2_000_000) })

    expect(await frames('/api/rooms', '{"type":', 'plain text', new Uint8Array([0, 1, 2]).buffer, '"say"')).toEqual([])
    expect((await frames('/api/rooms', big)).map(frame => frame.length > big.length)).toEqual([true])
  })

  it('reads a prototype key as plain data, left out as any key the schema does not name', async () => {
    const echo = JSON.stringify({ type: 'echo', body: { type: 'say', text: 'hi' }, kinds: ['type:string', 'text:string'] })

    expect(await frames('/api/rooms', '{"__proto__":{"at":1},"type":"say","text":"hi"}', '{"type":"say","text":"hi","constructor":{"prototype":{}}}')).toEqual([echo, echo])
    expect(({} as { at?: number }).at).toBeUndefined()
  })

  it('drops a structurally invalid message for a nested schema without reaching an error hook', async () => {
    const good = '{"type":"a","nested":{"n":1},"list":[1]}'
    const received = await frames('/api/rooms/nested', '{"type":"b"}', '{"type":"a","nested":null,"list":[1]}', '{"type":"a","nested":{"n":1},"list":[null,1]}', '{"type":"a","nested":[],"list":{}}', good)

    expect(received).toEqual([JSON.stringify({ type: 'echo', body: JSON.parse(good) })])
    expect(await (await site.fetch('/api/rooms/errors')).json()).toBe(0)
  })

  it('never hands the route a message with a key the schema does not name', async () => {
    const received = await frames('/api/rooms/optional', '{"type":"a","nested":null,"extra":1}', '{"type":"a","nested":"x","__proto__":{"x":1}}', '{"type":"a","nested":{"n":1},"extra":1}', '{"type":"a","extra":1}')

    for (const frame of received)
      expect(Object.keys((JSON.parse(frame) as { body: object }).body).every(key => key === 'type' || key === 'nested')).toBe(true)
  })

  it('logs a drop under kay dev only, naming the route and what the body refused', async () => {
    const warn = console.warn
    const logged: string[] = []

    console.warn = (...args: unknown[]) => void logged.push(args.join(' '))
    process.env.KAY_DEV_CODE = '0'

    try {
      await frames('/api/rooms', '{"type":"move","at":"x"}')
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('"/api/rooms"')
      await frames('/api/rooms', '{"type":"move","at":"x"}', '{"type":"move","at":"y"}')
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('dropped a message')
      delete process.env.KAY_DEV_CODE
      logged.length = 0
      await frames('/api/rooms', '{"type":"move","at":"x"}')
      expect(logged).toEqual([])
    }
    finally {
      console.warn = warn
      delete process.env.KAY_DEV_CODE
    }
  })

  it('leaves a route with no body alone', async () => {
    expect(await frames('/api/rooms/plain', '{"anything":"1"}')).toEqual([JSON.stringify({ type: 'echo', body: { anything: '1' } })])
  })

  it('sends and publishes through a route whose response is a room\'s, nothing checked against it, and types the client\'s messages', async () => {
    const socket = site.socket(rooms, '/typed')

    socket.send({ text: 'hi' })

    const first: { type: 'said', text: string } = await socket.next()
    const second: { type: 'said', text: string } = await socket.next()

    expect([first, second]).toEqual([{ type: 'said', text: 'HI' }, { type: 'said', text: 'hi' }])
  })
})
