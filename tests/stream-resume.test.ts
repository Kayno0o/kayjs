import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { root } from '../src/runtime'
import { API_MOUNT, openSocket, readEvents, stream } from '../src/runtime/live'
import { eventStream } from '../src/server/event-stream'

async function until(ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 5) {
    if (waited > 2_000)
      throw new Error('timed out')

    await Bun.sleep(5)
  }
}

// The backoff timers of a reconnect run at once.
function instantRetries(): () => void {
  const real = setTimeout
  const timeouts = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay?: number) => real(run, delay === 60_000 ? 3_600_000 : 0)) as unknown as typeof setTimeout)

  return () => timeouts.mockRestore()
}

const body = (...blocks: string[]) => new Response(blocks.join(''))

describe('eventStream ids', () => {
  it('writes the id of each value before its data', async () => {
    const text = await eventStream([{ n: 1 }, { n: 2 }], { id: value => value.n * 10 }).text()

    expect(text).toMatch(/^id: 10\ndata: .+\n\nid: 20\ndata: .+\n\nevent: end/)
  })

  it('writes no id line unless asked', async () => {
    expect(await eventStream([1]).text()).not.toContain('id:')
  })

  it.each(['a\nb', 'a\rb', 'a\0b'])('fails the stream rather than let the id %j end its field', async (hostile) => {
    const text = await eventStream([1], { id: () => hostile }).text()

    expect(text).toContain('event: error')
    expect(text).not.toContain('id:')
  })

  it('lets a route continue after the Last-Event-ID the browser sent, however hostile its text', async () => {
    const seen: (string | null)[] = []
    const app = new Elysia().get('/api/feed', ({ request }) => {
      seen.push(request.headers.get('last-event-id'))

      return eventStream([1], { id: value => value })
    })
    const huge = 'x'.repeat(8_000)

    for (const sent of ['7', '', '../../etc', '<script>', huge])
      await app.handle(new Request('http://localhost/api/feed', { headers: { 'last-event-id': sent } }))

    await app.handle(new Request('http://localhost/api/feed'))
    expect(seen).toEqual(['7', '', '../../etc', '<script>', huge, null])
  })
})

describe('a stream reconnecting', () => {
  it('sends the id of the last event it took, only the newest when far behind', async () => {
    const restore = instantRetries()
    const sent: (string | undefined)[] = []
    const answers = [body('id: 1\ndata: [1]\n\nid: 2\ndata: [2]\n\nid: 3\ndata: [3]\n\n'), body('data: [4]\n\n'), body('id: 9\ndata: [5]\n\nevent: end\ndata:\n\n')]
    const reader = readEvents<number>(async (_signal, lastEventId) => {
      sent.push(lastEventId)

      return answers.shift()!
    }, true)

    try {
      reader.start()
      await until(() => reader.status() === 'done')
    }
    finally {
      restore()
    }

    expect(sent).toEqual([undefined, '3', '3'])
  })

  it('keeps the id across a refused attempt, as a server restarting refuses', async () => {
    const restore = instantRetries()
    const sent: (string | undefined)[] = []
    const answers = [body('id: 5\ndata: [1]\n\n'), new Response(null, { status: 503 }), body('id: 6\ndata: [2]\n\nevent: end\ndata:\n\n')]
    const reader = readEvents<number>(async (_signal, lastEventId) => {
      sent.push(lastEventId)

      return answers.shift()!
    }, true, false, true)

    try {
      reader.start()
      await until(() => reader.status() === 'done')
    }
    finally {
      restore()
    }

    expect(sent).toEqual([undefined, '5', '5'])
  })

  it('forgets the id when a new run starts, and when the server resets it with an empty one', async () => {
    const sent: (string | undefined)[] = []
    const reader = readEvents<number>(async (_signal, lastEventId) => {
      sent.push(lastEventId)

      return body('id: 4\ndata: [1]\n\nevent: end\ndata:\n\n')
    }, false, true)
    const again = async (_signal: AbortSignal, lastEventId?: string) => {
      sent.push(lastEventId)

      return body('event: end\ndata:\n\n')
    }

    reader.start()
    await until(() => reader.status() === 'done')
    reader.start(again)
    await until(() => sent.length === 2 && reader.status() === 'done')
    expect(sent).toEqual([undefined, undefined])
  })

  it('ignores an id holding a NUL', async () => {
    const restore = instantRetries()
    const sent: (string | undefined)[] = []
    const answers = [body('id: a\0b\ndata: [1]\n\n'), body('event: end\ndata:\n\n')]
    const reader = readEvents<number>(async (_signal, lastEventId) => {
      sent.push(lastEventId)

      return answers.shift()!
    }, true)

    try {
      reader.start()
      await until(() => reader.status() === 'done')
    }
    finally {
      restore()
    }

    expect(sent).toEqual([undefined, undefined])
  })

  it('tells onOpen whether the stream opened before', async () => {
    const restore = instantRetries()
    const answers = [body('data: [1]\n\n'), body('data: [2]\n\n'), body('event: end\ndata:\n\n')]
    const reader = readEvents<number>(async () => answers.shift()!, true)
    const opened: boolean[] = []

    reader.onOpen(reconnected => opened.push(reconnected))

    try {
      reader.start()
      await until(() => reader.status() === 'done')
    }
    finally {
      restore()
    }

    expect(opened).toEqual([false, true, true])
  })
})

describe('stream() of a route', () => {
  const feed = { [API_MOUNT]: '/api/feed' }

  it('sends Last-Event-ID on its reconnect, a plain header-safe id only', async () => {
    const restore = instantRetries()
    const headers: (string | null)[] = []
    const answers = [body('id: 12\ndata: [1]\n\n'), body('id: é\ndata: [2]\n\n'), body('event: end\ndata:\n\n')]
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('last-event-id'))

      return answers.shift()!
    }) as typeof fetch)

    try {
      const reader = root(() => stream(feed as never, '/' as never, { start: false }) as unknown as { start: () => void, status: () => string })

      reader.start()
      await until(() => reader.status() === 'done')
    }
    finally {
      restore()
      fetched.mockRestore()
    }

    // An id a header cannot carry is not sent, rather than throw from fetch and never reconnect.
    expect(headers).toEqual([null, '12', null])
  })
})

describe('socket() onOpen', () => {
  it('tells whether the socket opened before', async () => {
    const restore = instantRetries()
    const sockets: EventTarget[] = []
    const room = openSocket<number, never>(() => {
      const ws = Object.assign(new EventTarget(), { readyState: 1, send: () => undefined, close: () => undefined })

      sockets.push(ws)

      return ws as unknown as WebSocket
    })
    const opened: boolean[] = []

    room.onOpen(reconnected => opened.push(reconnected))

    try {
      room.start()
      sockets[0]!.dispatchEvent(new Event('open'))
      sockets[0]!.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }))
      await until(() => sockets.length === 2)
      sockets[1]!.dispatchEvent(new Event('open'))
    }
    finally {
      restore()
      room.close()
    }

    expect(opened).toEqual([false, true])
  })
})

describe('stream(source) onOpen', () => {
  it('has the method, called as the source starts', () => {
    const reader = root(() => stream(async function* () {
      yield 1
    }))

    expect(typeof reader.onOpen).toBe('function')
  })
})
