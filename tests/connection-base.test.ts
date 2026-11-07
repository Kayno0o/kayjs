import { describe, expect, it, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { flush, root } from '../src/runtime'
import { SETTLED } from '../src/runtime/action'
import { actionStream } from '../src/runtime/action-stream'
import { ApiError } from '../src/runtime/api-error'
import { ending, onData } from '../src/runtime/connection'
import { openSocket, readEvents, stream } from '../src/runtime/live'
import { eventually, turn } from './helpers/eventually'

// The base every connection shares (#2804 slice 4): `ended()` and `onData()` on a stream, a socket and an action's stream, one `start()` on every stream, and `retry()` on an action's stream.

const sse = (...blocks: string[]) => new Response(blocks.join(''), { headers: { 'content-type': 'text/event-stream' } })
const value = (data: unknown) => `data: ${stringify(data)}\n\n`
const END = 'event: end\n\n'

// An action's answer as kay streams it: one `data: ` line per value, devalue-encoded, then the end event.
function answer(...values: unknown[]): Response {
  return new Response(`${values.map(one => `data: ${stringify(one)}\n`).join('')}event: end\n`, { headers: { 'content-type': 'text/event-stream' } })
}

// An answer that sends its values and then stays open until `release()`.
function held(...values: unknown[]): { response: Response, release: (end?: boolean) => void } {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start: (one) => {
      controller = one
      one.enqueue(encoder.encode(values.map(each => `data: ${stringify(each)}\n`).join('')))
    },
  })

  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    release: (end = true) => {
      if (end)
        controller.enqueue(encoder.encode('event: end\n'))

      controller.close()
    },
  }
}

const failure = () => new ApiError(500, 'The stream failed')

// What `stream()` builds on `readEvents()`, without the route: `ended()` and `onData()` come from the connection.
function reading<T>(...args: Parameters<typeof readEvents<T>>) {
  const { link, ...reader } = readEvents<T>(...args)

  return { ...reader, onData: onData(link.on), ended: ending(link).ended }
}

describe('ended() of a stream', () => {
  it('resolves with the last value once the stream ran to its end, and with undefined for none', async () => {
    const full = reading<number>(async () => sse(value(1), value(2), END), false)
    const empty = reading<number>(async () => sse(END), false)

    full.start()
    empty.start()
    expect(await full.ended()).toBe(2)
    expect(await empty.ended()).toBeUndefined()
  })

  it('resolves at once for a stream that is done already, and rejects at once for one failed or closed', async () => {
    const done = reading<number>(async () => sse(value(1), END), false)

    done.start()
    await eventually(() => expect(done.status()).toBe('done'))
    expect(await done.ended()).toBe(1)

    const refused = reading<number>(async () => new Response('no', { status: 403 }), false)

    refused.start()
    await eventually(() => expect(refused.status()).toBe('failed'))
    await expect(refused.ended()).rejects.toMatchObject({ status: 403 })
    await expect(refused.ended()).rejects.toBe(refused.error()!)

    const closed = reading<number>(async () => sse(), false)

    closed.close()
    await expect(closed.ended()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects with the ApiError of an error event, an undecodable value and a body that breaks off', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const erroring = reading<number>(async () => sse(value(1), 'event: error\ndata: \n\n'), false)
      const garbled = reading<number>(async () => sse('data: not devalue {\n\n'), false)
      const cut = reading<number>(async () => sse(value(1)), false)

      erroring.start()
      garbled.start()
      cut.start()
      await expect(erroring.ended()).rejects.toBeInstanceOf(ApiError)
      await expect(garbled.ended()).rejects.toBeInstanceOf(ApiError)
      await expect(cut.ended()).rejects.toBeInstanceOf(ApiError)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('rejects with an AbortError when close() comes first, and waits through a lazy stream\'s idle time', async () => {
    const gate = Promise.withResolvers<void>()
    const reader = reading<number>(async (signal) => {
      await gate.promise
      signal.throwIfAborted()

      return sse(value(1), END)
    }, false, true)
    const waiting = reader.ended()
    let settled = false
    const watch = async () => {
      try {
        await waiting
      }
      finally {
        settled = true
      }
    }

    const watching = watch()

    await turn()
    expect(settled).toBe(false)
    reader.start()
    gate.resolve()
    expect(await waiting).toBe(1)
    await watching

    const blocked = reading<number>(async (signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve)
      })

      return sse()
    }, false)
    const aborted = blocked.ended()

    blocked.start()
    blocked.close()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('waits for the new run when a stream is started again after it ended', async () => {
    let run = 0
    const reader = reading<number>(async () => sse(value(++run), END), false, true)

    reader.start(async () => sse(value(10), END))
    expect(await reader.ended()).toBe(10)
    reader.start(async () => sse(value(20), END))
    expect(await reader.ended()).toBe(20)
  })

  it('belongs to an iterable stream too: the last value at the end, an ApiError for a throw', async () => {
    globalThis.document = { querySelector: () => null } as unknown as Document

    try {
      const counting = root(() => stream(async function* () {
        yield 1
        yield 2
      }))
      const boom = new Error('broke')
      const throwing = root(() => stream(async function* () {
        yield 1

        throw boom
      }))

      flush()
      expect(await counting.ended()).toBe(2)
      await expect(throwing.ended()).rejects.toMatchObject({ status: 0, message: 'broke', cause: boom })
    }
    finally {
      Reflect.deleteProperty(globalThis, 'document')
    }
  })
})

describe('start() of a stream', () => {
  it('is on a stream that starts by itself, which opens once and starts a new run when given a request', async () => {
    globalThis.document = { querySelector: () => null } as unknown as Document

    try {
      let opened = 0
      const reader = reading<number>(async () => sse(value(++opened), END), false)

      reader.start()
      reader.start()
      await eventually(() => expect(reader.status()).toBe('done'))
      expect(opened).toBe(1)

      let sources = 0
      const iterated = root(() => stream(async function* () {
        sources++

        yield sources
      }))

      flush()
      await eventually(() => expect(iterated.status()).toBe('done'))
      iterated.start()
      await turn()
      expect(sources).toBe(1)
      expect(typeof iterated.start).toBe('function')
    }
    finally {
      Reflect.deleteProperty(globalThis, 'document')
    }
  })
})

describe('onData()', () => {
  it('hands the value of a stream, a socket and an action\'s stream as { value }, and returns what stops it', async () => {
    const reader = reading<number>(async () => sse(value(1), value(2), END), false, true)
    const seen: number[] = []
    const off = reader.onData(({ value: one }) => void seen.push(one))
    const stopped: number[] = []

    reader.onData(({ value: one }) => void stopped.push(one))()
    reader.start()
    await eventually(() => expect(reader.status()).toBe('done'))
    expect(seen).toEqual([1, 2])
    expect(stopped).toEqual([])
    off()

    class Fake extends EventTarget {
      readyState = 0
      send = (): void => undefined
      close = (): void => undefined
    }

    const ws = new Fake()
    const client = openSocket<string, string>(() => ws as unknown as WebSocket)
    const heard: string[] = []

    client.onData(({ value: one }) => void heard.push(one))
    client.start()
    ws.dispatchEvent(new Event('open'))
    ws.dispatchEvent(Object.assign(new Event('message'), { data: 'hi' }))
    expect(heard).toEqual(['hi'])

    const acted = actionStream<number>(answer(1, 2), SETTLED, failure)
    const got: number[] = []

    acted.onData(({ value: one }) => void got.push(one))
    expect(await acted.ended()).toBe(2)
    expect(got).toEqual([1, 2])
  })

  it('keeps the values an action\'s stream got before the first listener, for onData as for on', async () => {
    const acted = actionStream<number>(answer(1, 2), SETTLED, failure)
    const got: number[] = []

    acted.onData(({ value: one }) => void got.push(one))
    expect(got).toEqual([])
    await acted.ended()
    expect(got).toEqual([1, 2])
  })
})

describe('an action\'s stream', () => {
  it('has the shared source reading: pending only while it retries, error() once failed', async () => {
    const failing = actionStream<number>(new Response(`data: ${stringify(1)}\n`, { headers: { 'content-type': 'text/event-stream' } }), SETTLED, failure)

    await eventually(() => expect(failing.status()).toBe('failed'))
    expect(failing.pending()).toBe(false)
    expect(failing.error()).toBeInstanceOf(ApiError)
    expect(failing.error()).toMatchObject({ status: 500, message: 'The stream failed' })
    await expect(failing.ended()).rejects.toBe(failing.error()!)
  })

  it('retries a failed stream by calling the action again, reading the new answer into the same stream', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      let sent = 0
      const begun: string[] = []
      const acted = actionStream<number>(new Response(`data: ${stringify(1)}\n`, { headers: { 'content-type': 'text/event-stream' } }), SETTLED, failure, {
        send: async () => {
          sent++

          return answer(10, 20)
        },
        begun: () => void begun.push('begun'),
      })
      const seen: number[] = []
      const opens: boolean[] = []

      acted.on(one => void seen.push(one))
      acted.onOpen(reconnected => void opens.push(reconnected))
      await eventually(() => expect(acted.status()).toBe('failed'))
      await expect(acted.ended()).rejects.toBeInstanceOf(ApiError)
      acted.retry()
      expect([acted.status(), acted.pending(), acted.last()]).toEqual(['connecting', true, undefined])
      expect(acted.error()).toBeInstanceOf(ApiError)
      await eventually(() => expect(acted.status()).toBe('done'))
      expect(sent).toBe(1)
      expect(begun).toEqual(['begun'])
      expect(seen).toEqual([1, 10, 20])
      expect(acted.last()).toBe(20)
      expect(acted.error()).toBeUndefined()
      expect(opens).toEqual([true])
      expect(await acted.ended()).toBe(20)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('does nothing unless failed: open, done, closed, or a stream that cannot be called again', async () => {
    let sent = 0
    const send = async () => {
      sent++

      return answer(1)
    }
    const open = held(1)
    const running = actionStream<number>(open.response, SETTLED, failure, { send, begun: () => undefined })

    await eventually(() => expect(running.last()).toBe(1))
    running.retry()
    open.release()
    await running.ended()
    running.retry()

    const closed = actionStream<number>(held(1).response, SETTLED, failure, { send, begun: () => undefined })

    closed.close()
    closed.retry()
    expect(closed.status()).toBe('closed')
    expect(sent).toBe(0)

    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const alone = actionStream<number>(new Response('', { headers: { 'content-type': 'text/event-stream' } }), SETTLED, failure)

      await eventually(() => expect(alone.status()).toBe('failed'))
      alone.retry()
      expect(alone.status()).toBe('failed')
    }
    finally {
      logged.mockRestore()
    }
  })

  it('fails again with the error of a call that was refused or got no answer, and retries once more', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const answers = [new ApiError(403, 'Not allowed'), new TypeError('Failed to fetch')]
      const acted = actionStream<number>(new Response('', { headers: { 'content-type': 'text/event-stream' } }), SETTLED, failure, {
        send: async () => {
          const next = answers.shift()

          if (next)
            throw next

          return answer(5)
        },
        begun: () => undefined,
      })

      await eventually(() => expect(acted.status()).toBe('failed'))
      acted.retry()
      await eventually(() => expect(acted.error()).toMatchObject({ status: 403, message: 'Not allowed' }))
      expect(acted.status()).toBe('failed')
      acted.retry()
      await eventually(() => expect(acted.error()?.status).toBe(0))
      expect(acted.status()).toBe('failed')
      acted.retry()
      await eventually(() => expect(acted.status()).toBe('done'))
      expect(acted.last()).toBe(5)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('stays closed when close() comes while the retry is being sent, and cancels the answer it gets', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const gate = Promise.withResolvers<Response>()
      const body = held(1)
      const cancelled = spyOn(body.response.body!, 'cancel')
      const acted = actionStream<number>(new Response('', { headers: { 'content-type': 'text/event-stream' } }), SETTLED, failure, { send: async () => gate.promise, begun: () => undefined })

      await eventually(() => expect(acted.status()).toBe('failed'))
      acted.retry()
      acted.close()
      gate.resolve(body.response)
      await eventually(() => expect(cancelled).toHaveBeenCalled())
      expect(acted.status()).toBe('closed')
      expect(acted.last()).toBeUndefined()
    }
    finally {
      logged.mockRestore()
    }
  })

  it('settles its end callbacks once for each run, so a retried stream can be closed with its block again', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const acted = actionStream<number>(new Response('', { headers: { 'content-type': 'text/event-stream' } }), SETTLED, failure, { send: async () => answer(1), begun: () => undefined })
      const ends: string[] = []

      acted[SETTLED](status => void ends.push(status))
      await eventually(() => expect(ends).toEqual(['failed']))
      acted.retry()
      acted[SETTLED](status => void ends.push(status))
      await eventually(() => expect(ends).toEqual(['failed', 'done']))
    }
    finally {
      logged.mockRestore()
    }
  })
})
