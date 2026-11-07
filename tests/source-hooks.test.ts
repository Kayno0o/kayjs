import type { ConnectionHooks } from '../src/runtime/live'
import { afterAll, beforeAll, describe, expect, it, jest, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { root } from '../src/runtime'
import { actionStub, SETTLED } from '../src/runtime/action'
import { actionStream } from '../src/runtime/action-stream'
import { ApiError } from '../src/runtime/api-error'
import { connectionHooks } from '../src/runtime/connection'
import { API_MOUNT, call, openSocket, readEvents, resource, stream } from '../src/runtime/live'
import { eventually } from './helpers/eventually'

// The transition callbacks every source an island reads takes (#2804 slice 5), as options and as methods: `onOpen`, `onData`, `onError`, `onClose`, and `onSuccess` and `onError` on a tracked call.

const sse = (...blocks: string[]) => new Response(blocks.join(''), { headers: { 'content-type': 'text/event-stream' } })
const value = (data: unknown) => `data: ${stringify(data)}\n\n`
const END = 'event: end\n\n'

class FakeSocket extends EventTarget {
  readyState = 0

  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  message(data: string) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }))
  }

  drop(code: number, reason = '') {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
  }

  send(): void {
    // Nothing is sent anywhere.
  }

  close(code: number) {
    this.drop(code)
  }
}

function sockets(hooks?: ConnectionHooks<string>) {
  const made: FakeSocket[] = []
  const client = openSocket<string, string>(() => {
    const ws = new FakeSocket()

    made.push(ws)

    return ws as unknown as WebSocket
  }, hooks)

  client.start()

  return { client, made }
}

describe('socket hooks', () => {
  it('runs onOpen with reconnected, onData with the value, and onClose with closed, as options', () => {
    jest.useFakeTimers()

    try {
      const seen: unknown[] = []
      const { client, made } = sockets({
        onOpen: event => seen.push(['open', event]),
        onData: event => seen.push(['data', event]),
        onError: event => seen.push(['error', event]),
        onClose: event => seen.push(['close', event]),
      })

      made[0]!.open()
      made[0]!.message('"hi"')
      // A drop it reconnects from is no error and no close.
      made[0]!.drop(1006)
      jest.advanceTimersByTime(500)
      made[1]!.open()
      client.close()
      client.close()
      expect(seen).toEqual([['open', { reconnected: false }], ['data', { value: 'hi' }], ['open', { reconnected: true }], ['close', { status: 'closed' }]])
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('runs onError then onClose once when the server refuses, and again for a retry that fails', () => {
    const seen: string[] = []
    const { client, made } = sockets()

    client.onError(({ error }) => seen.push(`error ${error.status} ${error.message}`))
    client.onClose(({ status }) => seen.push(`close ${status}`))
    made[0]!.drop(4403, 'Not yours')
    expect(seen).toEqual(['error 403 Not yours', 'close failed'])
    client.retry()
    made[1]!.open()
    made[1]!.drop(4401, 'Sign in')
    expect(seen).toEqual(['error 403 Not yours', 'close failed', 'error 401 Sign in', 'close failed'])
  })

  it('returns what removes a method, runs an option beside a method, and logs a throwing hook', () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const seen: string[] = []
      const { client, made } = sockets({ onOpen: () => void seen.push('option') })
      const stop = client.onOpen(() => void seen.push('removed'))

      client.onOpen(() => {
        throw new Error('boom')
      })
      client.onOpen(() => void seen.push('method'))
      stop()
      made[0]!.open()
      expect(seen).toEqual(['option', 'method'])
      expect(client.status()).toBe('open')
      expect(logged).toHaveBeenCalledTimes(1)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('hands onData as a method too', () => {
    const { client, made } = sockets()
    const values: string[] = []

    client.onData(({ value: text }) => values.push(text))
    made[0]!.open()
    made[0]!.message('"a"')
    expect(values).toEqual(['a'])
  })
})

describe('stream hooks', () => {
  // What `stream()` builds on `readEvents()`, without the route.
  function reading<T>(request: Parameters<typeof readEvents<T>>[0], reconnect: boolean, idle = false, hooks?: ConnectionHooks<T>) {
    const { link, ...reader } = readEvents<T>(request, reconnect, idle)

    return { ...reader, ...connectionHooks(link, reader.onOpen, hooks as ConnectionHooks<never>), link }
  }

  it('runs onOpen, onData and onClose done, in order, as options', async () => {
    const seen: unknown[] = []
    const reader = reading<number>(async () => sse(value(1), value(2), END), false, false, {
      onOpen: event => seen.push(['open', event]),
      onData: event => seen.push(['data', event]),
      onError: event => seen.push(['error', event]),
      onClose: event => seen.push(['close', event]),
    })

    reader.start()
    await eventually(() => expect(reader.status()).toBe('done'))
    expect(seen).toEqual([['open', { reconnected: false }], ['data', { value: 1 }], ['data', { value: 2 }], ['close', { status: 'done' }]])
    // A close after the end is not another end.
    reader.close()
    expect(seen).toHaveLength(4)
  })

  it('runs onError with the refusal and onClose failed once, and again after a retry', async () => {
    const seen: string[] = []
    const reader = reading<number>(async () => new Response('no', { status: 403 }), true, false, {
      onError: ({ error }) => seen.push(`error ${error.status}`),
      onClose: ({ status }) => seen.push(`close ${status}`),
    })

    reader.start()
    await eventually(() => expect(reader.status()).toBe('failed'))
    expect(seen).toEqual(['error 403', 'close failed'])
    reader.retry()
    await eventually(() => expect(seen).toHaveLength(4))
    expect(seen.slice(2)).toEqual(['error 403', 'close failed'])
  })

  it('does not fire onError for a drop it reconnects from, and onOpen tells the reconnect', async () => {
    const seen: unknown[] = []
    let attempt = 0
    const reader = reading<number>(async () => {
      attempt++

      return attempt === 1 ? sse(value(1)) : sse(value(2), END)
    }, true, false, {
      onOpen: ({ reconnected }) => seen.push(`open ${reconnected}`),
      onError: () => seen.push('error'),
      onClose: ({ status }) => seen.push(`close ${status}`),
    })

    reader.start()
    await eventually(() => expect(reader.status()).toBe('done'))
    expect(seen).toEqual(['open false', 'open true', 'close done'])
  })

  it('runs a restarted run through the hooks again', async () => {
    const closes: string[] = []
    const reader = reading<number>(async () => sse(value(1), END), false, true, { onClose: ({ status }) => closes.push(status) })

    reader.start()
    await eventually(() => expect(closes).toEqual(['done']))
    reader.start(async () => sse(value(2), END))
    await eventually(() => expect(closes).toEqual(['done', 'done']))
  })

  it('closed before the end is a close of status closed', () => {
    const closes: string[] = []
    const reader = reading<number>(async () => sse(), false, false, { onClose: ({ status }) => closes.push(status) })

    reader.close()
    expect(closes).toEqual(['closed'])
  })
})

describe('stream() of an iterable', () => {
  beforeAll(() => {
    globalThis.document = { querySelector: () => null } as unknown as Document
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'document')
  })

  it('takes the hooks as options and as methods, onError for a throw', async () => {
    const seen: string[] = []
    const feed = root(() => {
      const made = stream(async function* () {
        yield 1

        throw new TypeError('broke')
      }, {
        onOpen: ({ reconnected }) => seen.push(`open ${reconnected}`),
        onData: ({ value: next }) => seen.push(`data ${next}`),
        onClose: ({ status }) => seen.push(`close ${status}`),
      })

      made.onError(({ error }) => seen.push(`error ${error.message}`))
      made.start()

      return made
    })

    await eventually(() => expect(feed.status()).toBe('failed'))
    expect(seen).toEqual(['open false', 'data 1', 'error broke', 'close failed'])
  })
})

describe('resource hooks', () => {
  beforeAll(() => {
    globalThis.document = { querySelector: () => null } as unknown as Document
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'document')
  })

  it('runs onData for each answer, a quiet reload and mutate(), not for initial, and onError once per failure', async () => {
    const seen: string[] = []
    let next = 0
    const read = root(() => resource<number>(async () => {
      next++

      if (next === 2)
        throw new ApiError(503, 'Down', undefined, { '': 'Down' })

      return next
    }, {
      onData: ({ value: answer }) => seen.push(`data ${answer}`),
      onError: ({ error }) => seen.push(`error ${error.status}`),
    }))

    await eventually(() => expect(read.status()).toBe('ready'))
    read.refresh()
    await eventually(() => expect(read.status()).toBe('failed'))
    read.retry()
    await eventually(() => expect(read.status()).toBe('ready'))
    read.onData(({ value: answer }) => seen.push(`method ${answer}`))
    read.mutate(10, { refresh: false })
    expect(seen).toEqual(['data 1', 'error 503', 'data 3', 'data 10', 'method 10'])
  })

  it('does not run onData for an initial value, and logs a throwing hook', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const seen: string[] = []
      const read = root(() => resource<string>(async () => 'fresh', {
        initial: 'start',
        onData: ({ value: answer }) => {
          seen.push(answer)

          throw new Error('boom')
        },
      }))

      expect(read.value()).toBe('start')
      expect(seen).toEqual([])
      await eventually(() => expect(seen).toEqual(['fresh']))
      expect(read.status()).toBe('ready')
      expect(logged).toHaveBeenCalled()
    }
    finally {
      logged.mockRestore()
    }
  })

  it('does not run onError for a failure of a run that was superseded', async () => {
    const seen: string[] = []
    const read = root(() => resource<number>(async (signal) => {
      await Bun.sleep(5)

      if (signal.aborted)
        throw new ApiError(500, 'late')

      return 1
    }, { onError: () => void seen.push('error') }))

    await eventually(() => expect(read.status()).toBe('ready'))
    expect(seen).toEqual([])
  })
})

describe('track hooks', () => {
  const mounted = { [API_MOUNT]: '/api/notes' }
  const answering = (...answers: (Response | Error)[]) => spyOn(globalThis, 'fetch').mockImplementation((async () => {
    const answer = answers.shift()!

    if (answer instanceof Error)
      throw answer

    return answer
  }) as unknown as typeof fetch)
  const refusal = (status: number, text: string) => new Response(text, { status, headers: { 'content-type': 'text/plain' } })
  const saved = () => new Response('"saved"', { headers: { 'content-type': 'application/json' } })

  it('call.track runs onSuccess with the data and the input, and onError for a refusal and for no answer, both as options and methods', async () => {
    const fetched = answering(saved(), refusal(409, 'Taken'), new TypeError('offline'))
    const seen: unknown[] = []

    try {
      const save = call.track(mounted as never, '/' as never, {
        onSuccess: ({ data, input }: { data: unknown, input: unknown }) => seen.push(['success', data, input]),
      }) as unknown as ((options?: unknown) => Promise<unknown>) & { onError: (hook: (event: { error: ApiError, input: unknown }) => void) => () => void }
      const input = { method: 'post' }

      save.onError(({ error, input: given }) => seen.push(['error', error.status, error.message, given]))
      await save(input)
      await save(input)
      await expect(save(input)).rejects.toThrow()
      expect(seen).toEqual([['success', 'saved', input], ['error', 409, 'Taken', input], ['error', 0, 'The server could not be reached', input]])
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('never runs onError for an abort, and the hooks run again for a retry', async () => {
    const fetched = answering(refusal(500, 'Down'), saved())
    const seen: string[] = []

    try {
      const save = call.track(mounted as never, '/' as never, {
        onSuccess: () => seen.push('success'),
        onError: () => seen.push('error'),
      }) as unknown as ((options?: unknown) => Promise<unknown>) & { retry: () => void, settled: () => Promise<void> }

      await save({ method: 'post' })
      save.retry()
      await save.settled()
      expect(seen).toEqual(['error', 'success'])

      const controller = new AbortController()

      fetched.mockImplementation((async (_url: unknown, init: RequestInit) => {
        controller.abort()

        throw init.signal?.reason ?? new DOMException('aborted', 'AbortError')
      }) as unknown as typeof fetch)
      await expect(save({ method: 'post', signal: controller.signal })).rejects.toBeDefined()
      expect(seen).toEqual(['error', 'success'])
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('logs a throwing hook and still resolves the call with its result', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const fetched = answering(saved())

    try {
      const save = call.track(mounted as never, '/' as never, {
        onSuccess: () => {
          throw new Error('boom')
        },
      }) as unknown as (options?: unknown) => Promise<{ ok: boolean }>

      expect(await save({ method: 'post' })).toMatchObject({ ok: true })
      expect(logged).toHaveBeenCalledTimes(1)
    }
    finally {
      logged.mockRestore()
      fetched.mockRestore()
    }
  })

  it('an action track() takes the same hooks', async () => {
    const stub = actionStub('/_kay/action/test/hooks') as unknown as import('../src/runtime').Action<{ id: number }, string>
    const fetched = answering(new Response(stringify('done')), new Response(stringify({ errors: { '': 'Locked' } }), { status: 409, headers: { 'x-kay-failure': '1' } }))
    const seen: unknown[] = []

    try {
      const save = stub.track({ onSuccess: ({ data, input }) => void seen.push(['success', data, input]) })

      save.onError(({ error, input }) => seen.push(['error', error.status, error.message, input]))
      await save({ id: 1 })
      await save({ id: 2 })
      expect(seen).toEqual([['success', 'done', { id: 1 }], ['error', 409, 'Locked', { id: 2 }]])
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('a handle without a hook runs as before', async () => {
    const fetched = answering(saved())

    try {
      const save = call.track(mounted as never, '/' as never) as unknown as (options?: unknown) => Promise<{ ok: boolean }>

      expect(await save({ method: 'post' })).toMatchObject({ ok: true })
    }
    finally {
      fetched.mockRestore()
    }
  })
})

describe('an action\'s stream hooks', () => {
  const body = (...lines: string[]) => new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } })
  const failure = () => new ApiError(500, 'The stream failed')

  it('runs onError then onClose failed, and onOpen with reconnected after a retry', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const seen: unknown[] = []
      const acted = actionStream<number>(body(`data: ${stringify(1)}\n`), SETTLED, failure, {
        send: async () => body(`data: ${stringify(2)}\n`, 'event: end\n'),
        read: async () => undefined,
        begun: () => undefined,
      })

      acted.onError(({ error }) => seen.push(`error ${error.status}`))
      acted.onClose(({ status }) => seen.push(`close ${status}`))
      acted.onOpen(event => seen.push(['open', event]))
      await eventually(() => expect(acted.status()).toBe('failed'))
      acted.retry()
      await eventually(() => expect(acted.status()).toBe('done'))
      expect(seen).toEqual(['error 500', 'close failed', ['open', { reconnected: true }], 'close done'])
    }
    finally {
      logged.mockRestore()
    }
  })

  it('runs onClose closed when closed before its end', () => {
    const open = new Response(new ReadableStream<Uint8Array>(), { headers: { 'content-type': 'text/event-stream' } })
    const acted = actionStream<number>(open, SETTLED, failure)
    const closes: string[] = []

    acted.onClose(({ status }) => closes.push(status))
    acted.close()
    acted.close()
    expect(closes).toEqual(['closed'])
  })
})
