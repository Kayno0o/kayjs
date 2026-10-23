import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { socketLimits } from '../src/server/ws-limits'
import { testSite } from '../src/test'

const root = resolve(import.meta.dir, 'fixtures/ws-limits')
const { default: chat } = await import(resolve(root, 'src/api/chat.ts')) as typeof import('./fixtures/ws-limits/src/api/chat')
const site = await testSite({ root, islands: false })

// The server the site starts with its first socket, whose port a raw socket needs.
const serve = Bun.serve
let port = 0

Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  const server = serve(options)

  port = server.port!

  return server
}) as typeof Bun.serve
site.socket(chat, '/')
Bun.serve = serve

afterAll(site.close)

interface Outcome {
  received: string[]
  code: number | undefined
  reason: string | undefined
}

// Opens a raw socket, sends the messages, and waits for the server to close it or for the last echo.
async function talk(path: string, ...messages: (string | ArrayBuffer)[]): Promise<Outcome> {
  const socket = new WebSocket(`ws://localhost:${port}/api/chat${path}`)
  const outcome: Outcome = { received: [], code: undefined, reason: undefined }

  socket.onmessage = (event) => {
    outcome.received.push(String(event.data))
  }
  socket.onclose = (event) => {
    outcome.code = event.code
    outcome.reason = event.reason
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('the socket did not open'))
  })

  for (const message of messages)
    socket.send(message)

  for (let waited = 0; outcome.code === undefined && outcome.received.length < messages.length && waited < 3_000; waited += 10)
    await Bun.sleep(10)

  // A close frame sent just after the last echo.
  await Bun.sleep(50)
  socket.close()

  return outcome
}

describe('the payload of a websocket message', () => {
  it('is 1 MB at most by default: a bigger text or binary one closes the socket with 1009', async () => {
    for (const message of ['x'.repeat(1_100_000), new Uint8Array(1_100_000).buffer]) {
      const outcome = await talk('/', message)

      expect(outcome.code).toBe(1009)
      expect(outcome.received).toEqual([])
    }
  })

  it('counts bytes, not characters, and takes one at the limit', async () => {
    expect((await talk('/', 'é'.repeat(600_000))).code).toBe(1009)
    expect((await talk('/', 'x'.repeat(1_048_576))).received).toEqual(['echo:1048576'])
  })

  it('closes the socket on the message, the ones before it answered', async () => {
    const outcome = await talk('/', 'a', 'b', 'x'.repeat(1_100_000), 'c')

    expect(outcome.received).toEqual(['echo:1', 'echo:1'])
    expect(outcome.code).toBe(1009)
  })

  it('is raised or lowered by the route\'s messages.maxSize', async () => {
    expect((await talk('/big', 'x'.repeat(3_000_000))).received).toEqual(['echo:3000000'])
    expect((await talk('/big', 'x'.repeat(5_000_000))).code).toBe(1009)
    expect((await talk('/tiny', 'x'.repeat(100))).received).toEqual(['echo:100'])
    expect((await talk('/tiny', 'x'.repeat(101))).code).toBe(1009)
  })
})

describe('the rate of a websocket\'s messages', () => {
  it('is 100 a second by default: a socket over it is closed with 1008', async () => {
    const outcome = await talk('/', ...new Array<string>(300).fill('x'))

    expect(outcome.code).toBe(1008)
    expect(outcome.received.length).toBeLessThanOrEqual(100)
    expect(outcome.received.length).toBeGreaterThan(0)
  })

  it('lets a socket under it talk on', async () => {
    const outcome = await talk('/', ...new Array<string>(50).fill('x'))

    expect(outcome.code).toBeUndefined()
    expect(outcome.received).toHaveLength(50)
  })

  it('is the route\'s rateLimit when it sets one', async () => {
    const slow = await talk('/slow', 'a', 'b', 'c', 'd')

    expect(slow.received).toEqual(['echo:1', 'echo:1', 'echo:1'])
    expect(slow.code).toBe(1008)
    expect((await talk('/fast', ...new Array<string>(300).fill('x'))).received).toHaveLength(300)
  })

  it('counts each socket apart', async () => {
    const [first, second] = await Promise.all([talk('/slow', 'a', 'b', 'c', 'd'), talk('/slow', 'a', 'b', 'c')])

    expect(first.code).toBe(1008)
    expect(second.received).toHaveLength(3)
  })

  it('counts the window again once it has gone by', async () => {
    const socket = new WebSocket(`ws://localhost:${port}/api/chat/fast`)
    const received: string[] = []

    socket.onmessage = (event) => {
      received.push(String(event.data))
    }
    await new Promise<void>(resolve => (socket.onopen = () => resolve()))

    for (let round = 0; round < 3; round++) {
      for (let count = 0; count < 800; count++)
        socket.send('x')

      await Bun.sleep(1100)
    }

    expect(received).toHaveLength(2400)
    socket.close()
  })
})

describe('every websocket route', () => {
  it('is held to the limits however the module chains it, or builds its instance', async () => {
    for (const path of ['/grouped', '/guarded', '/used'])
      expect((await talk(path, 'x'.repeat(1_100_000))).code).toBe(1009)

    const plain = new WebSocket(`ws://localhost:${port}/api/plain`)
    const outcome: Outcome = { received: [], code: undefined, reason: undefined }

    plain.onclose = (event) => {
      outcome.code = event.code
    }
    await new Promise<void>(resolve => (plain.onopen = () => resolve()))
    plain.send('x'.repeat(1_100_000))
    await Bun.sleep(200)
    expect(outcome.code).toBe(1009)
  })

  it('runs the route\x27s own beforeHandle hooks once', async () => {
    expect((await talk('/hooked', 'a')).received).toEqual(['echo:1'])
    expect(await (await site.fetch('/api/chat/hooked-count')).json()).toBe(1)
  })
})

describe('the options of a websocket route', () => {
  it('throw when they are no size or rate', () => {
    expect(() => socketLimits('/', { maxSize: 0 })).toThrow('maxSize')
    expect(() => socketLimits('/', { maxSize: 'big' as never })).toThrow('maxSize')
    expect(() => socketLimits('/', { rateLimit: { max: 0, window: '1s' } })).toThrow('rateLimit')
    expect(() => socketLimits('/', { rateLimit: { max: 5, window: 3 as never } })).toThrow('rateLimit')
  })
})
