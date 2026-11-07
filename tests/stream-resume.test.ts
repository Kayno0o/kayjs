import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { flush, root } from '../src/runtime'
import { API_MOUNT, openSocket, readEvents, stream } from '../src/runtime/live'
import { eventStream, lastEventId } from '../src/server/event-stream'

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

  it.each(['a\nb', 'a\rb', 'a\0b', ' a', 'a ', 'é', 'x'.repeat(1025)])('fails the stream rather than send the id %j, which the browser would not send back', async (hostile) => {
    const text = await eventStream([1], { id: () => hostile }).text()

    expect(text).toContain('event: error')
    expect(text).not.toContain('id:')
  })

  it('lets a route continue after the Last-Event-ID the browser sent, however hostile its text', async () => {
    const seen: (string | undefined)[] = []
    const app = new Elysia().get('/api/feed', ({ request }) => {
      seen.push(lastEventId(request))

      return eventStream([1], { id: value => value })
    })
    const huge = 'x'.repeat(8_000)

    for (const sent of ['7', '', ' 7', '7 ', 'é', huge])
      await app.handle(new Request('http://localhost/api/feed', { headers: { 'last-event-id': sent } }))

    await app.handle(new Request('http://localhost/api/feed'))
    // A header value is trimmed on its way, so the spaces around a 7 never reach the route.
    expect(seen).toEqual(['7', undefined, '7', '7', undefined, undefined, undefined])
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

  // The ids sent with each request while the answers are read one after another, the last of which ends the stream.
  async function idsSent(...answers: Response[]): Promise<(string | undefined)[]> {
    const restore = instantRetries()
    const sent: (string | undefined)[] = []
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

    return sent
  }

  it('keeps an id across later events that carry none', async () => {
    expect(await idsSent(body('id: 3\ndata: [1]\n\ndata: [2]\n\n'), body('event: end\ndata:\n\n'))).toEqual([undefined, '3'])
  })

  it('takes the id of a block with no event or data, as the standard does', async () => {
    expect(await idsSent(body('id: 8\n\n'), body('event: end\ndata:\n\n'))).toEqual([undefined, '8'])
  })

  it('forgets the id an empty one resets', async () => {
    expect(await idsSent(body('id: 4\ndata: [1]\n\nid:\ndata: [2]\n\n'), body('event: end\ndata:\n\n'))).toEqual([undefined, undefined])
  })

  it.each(['has space ', ' has', 'é', 'x'.repeat(1025)])('does not send back the id %j', async (hostile) => {
    expect(await idsSent(body(`id: ${hostile}\ndata: [1]\n\n`), body('event: end\ndata:\n\n'))).toEqual([undefined, undefined])
  })

  it('sends back an id of 1 KB', async () => {
    const longest = 'x'.repeat(1024)

    expect(await idsSent(body(`id: ${longest}\ndata: [1]\n\n`), body('event: end\ndata:\n\n'))).toEqual([undefined, longest])
  })

  it('forgets the id when a new run starts', async () => {
    const sent: (string | undefined)[] = []
    const reader = readEvents<number>(async (_signal, lastEventId) => {
      sent.push(lastEventId)

      return body('id: 4\ndata: [1]\n\nevent: end\ndata:\n\n')
    }, false, true)

    reader.start()
    await until(() => reader.status() === 'done')
    reader.start(async (_signal, lastEventId) => {
      sent.push(lastEventId)

      return body('event: end\ndata:\n\n')
    })
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

    reader.onOpen(({ reconnected }) => opened.push(reconnected))

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
  const lazy = () => root(() => stream(feed as never, '/' as never, { start: false }) as unknown as { start: () => void, status: () => string, close: () => void })

  // Every request the fetch sees, answered one after another.
  function served(...answers: Response[]): { headers: (string | null)[], urls: string[], restore: () => void } {
    const seen = { headers: [] as (string | null)[], urls: [] as string[] }
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, init?: RequestInit) => {
      seen.urls.push(String(url))
      seen.headers.push(new Headers(init?.headers).get('last-event-id'))

      return answers.shift()!
    }) as typeof fetch)

    return { ...seen, restore: () => fetched.mockRestore() }
  }

  it('sends Last-Event-ID on its reconnect, and none for an id a header cannot carry', async () => {
    const restore = instantRetries()
    const fetched = served(body('id: 12\ndata: [1]\n\n'), body('id: é\ndata: [2]\n\n'), body('event: end\ndata:\n\n'))

    try {
      const reader = lazy()

      reader.start()
      await until(() => reader.status() === 'done')
    }
    finally {
      restore()
      fetched.restore()
    }

    expect(fetched.headers).toEqual([null, '12', null])
  })

  it.each([502, 503, 504])('waits out a %i while the server restarts and resumes after the id it kept', async (status) => {
    const restore = instantRetries()
    const fetched = served(body('id: 5\ndata: [1]\n\n'), new Response(null, { status }), body('id: 6\ndata: [2]\n\nevent: end\ndata:\n\n'))

    try {
      const reader = lazy()

      reader.start()
      await until(() => reader.status() === 'done')
    }
    finally {
      restore()
      fetched.restore()
    }

    expect(fetched.headers).toEqual([null, '5', '5'])
  })

  it.each([400, 401, 403, 404, 500])('fails for good on a %i', async (status) => {
    const restore = instantRetries()
    const fetched = served(body('id: 5\ndata: [1]\n\n'), new Response(null, { status }), body('event: end\ndata:\n\n'))
    let reader: ReturnType<typeof lazy>

    try {
      reader = lazy()
      reader.start()
      await until(() => reader.status() === 'failed')
      await Bun.sleep(20)
    }
    finally {
      restore()
      fetched.restore()
    }

    expect(fetched.headers).toEqual([null, '5'])
  })

  it('forgets the id when start() opens a new run', async () => {
    const fetched = served(body('id: 5\ndata: [1]\n\nevent: end\ndata:\n\n'), body('event: end\ndata:\n\n'))

    try {
      const reader = lazy()

      reader.start()
      await until(() => reader.status() === 'done')
      reader.start()
      await until(() => fetched.headers.length === 2)
    }
    finally {
      fetched.restore()
    }

    expect(fetched.headers).toEqual([null, null])
  })

  it('does not reconnect once closed or unmounted with an id held', async () => {
    const fetched = served(body('id: 5\ndata: [1]\n\n'), body('event: end\ndata:\n\n'))

    try {
      const [reader, dispose] = root(dispose => [stream(feed as never, '/' as never, { start: false }) as unknown as { start: () => void, status: () => string }, dispose] as const)

      reader.start()
      await until(() => fetched.headers.length === 1)
      await until(() => reader.status() === 'connecting')
      dispose()
      // Longer than the first backoff, which is at most half a second.
      await Bun.sleep(700)
      expect(reader.status()).toBe('closed')
    }
    finally {
      fetched.restore()
    }

    expect(fetched.headers).toEqual([null])
  })

  it('reaches the route under the base of the site, the header with it', async () => {
    const fetched = served(body('id: 5\ndata: [1]\n\n'), body('event: end\ndata:\n\n'))
    const restore = instantRetries()

    ;(globalThis as { document?: unknown }).document = { querySelector: () => ({ content: '/docs' }) }

    try {
      const reader = lazy()

      reader.start()
      await until(() => reader.status() === 'done')
    }
    finally {
      delete (globalThis as { document?: unknown }).document
      restore()
      fetched.restore()
    }

    expect(fetched.urls).toEqual(['/docs/api/feed', '/docs/api/feed'])
    expect(fetched.headers).toEqual([null, '5'])
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

    room.onOpen(({ reconnected }) => opened.push(reconnected))

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
  it('tells the first open from the one after a failure and a retry', async () => {
    ;(globalThis as { document?: unknown }).document = { querySelector: () => null }

    try {
      let calls = 0
      const reader = root(() => stream(async function* () {
        if (calls++ === 0)
          throw new Error('dropped')

        yield 1
      }))
      const opened: boolean[] = []

      reader.onOpen(({ reconnected }) => opened.push(reconnected))
      flush()
      await until(() => reader.status() === 'failed')
      reader.retry()
      await until(() => opened.length === 2)
      expect(opened).toEqual([false, true])
    }
    finally {
      delete (globalThis as { document?: unknown }).document
    }
  })
})
