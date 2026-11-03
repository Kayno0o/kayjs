import type { LoadStatus, Source } from '../src/runtime/live'
import { afterAll, beforeAll, describe, expect, it, jest, mock, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { flush, root } from '../src/runtime'
import { actionStub } from '../src/runtime/action'
import { API_MOUNT, ApiError, call, openSocket, readEvents, resource, stream } from '../src/runtime/live'
import { eventually, turn } from './helpers/eventually'

// The shared reading of loading, failure and retry every source an island reads has (#2804 slice 3): `status()`, `pending()`, `error()` and `retry()`.

// A websocket the test drives by hand.
class FakeSocket extends EventTarget {
  readyState = 0
  sent: string[] = []
  closedWith: number | undefined

  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  drop(code: number, reason = '') {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }))
  }

  send(text: string) {
    this.sent.push(text)
  }

  close(code: number) {
    this.closedWith = code
    this.drop(code)
  }
}

function sockets() {
  const made: FakeSocket[] = []
  const client = openSocket<string, string>(() => {
    const ws = new FakeSocket()

    made.push(ws)

    return ws as unknown as WebSocket
  })

  client.start()

  return { client, made }
}

describe('socket', () => {
  it('fails on a close with a code from 4000 to 4999, its status the code minus 4000 and its reason the message, and never reconnects by itself', () => {
    jest.useFakeTimers()

    try {
      const { client, made } = sockets()

      expect([client.status(), client.pending(), client.error()]).toEqual(['connecting', true, undefined])
      made[0]!.open()
      expect([client.status(), client.pending()]).toEqual(['open', false])
      made[0]!.drop(4403, 'Not yours')
      expect(client.status()).toBe('failed')
      expect(client.pending()).toBe(false)
      expect(client.error()).toBeInstanceOf(ApiError)
      expect(client.error()).toMatchObject({ status: 403, message: 'Not yours' })
      jest.advanceTimersByTime(120_000)
      expect(made).toHaveLength(1)
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('words a refusal that gives no reason, and takes both ends of the range', () => {
    const { client, made } = sockets()

    made[0]!.drop(4000)
    expect(client.error()).toMatchObject({ status: 0, message: expect.stringContaining('4000') })

    const last = sockets()

    last.made[0]!.drop(4999)
    expect(last.client.status()).toBe('failed')
    expect(last.client.error()?.status).toBe(999)
  })

  it('reconnects on any other code, and closes for good on 1000', () => {
    jest.useFakeTimers()

    try {
      for (const code of [1006, 1011, 3999, 5000]) {
        const { client, made } = sockets()

        made[0]!.open()
        made[0]!.drop(code)
        expect([code, client.status(), client.error()]).toEqual([code, 'connecting', undefined])
        jest.advanceTimersByTime(500)
        expect([code, made.length]).toEqual([code, 2])
        client.close()
      }

      const { client, made } = sockets()

      made[0]!.open()
      made[0]!.drop(1000)
      expect(client.status()).toBe('closed')
      jest.advanceTimersByTime(60_000)
      expect(made).toHaveLength(1)
      client.retry()
      expect(made).toHaveLength(1)
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('retries a failed socket at once, flushes what was queued and clears the error once open', () => {
    const { client, made } = sockets()

    made[0]!.drop(4401, 'Sign in')
    client.send('hello')
    client.retry()
    expect(made).toHaveLength(2)
    expect([client.status(), client.pending()]).toEqual(['connecting', true])
    // The failure stays readable until the connection is back.
    expect(client.error()?.status).toBe(401)
    made[1]!.open()
    expect(made[1]!.sent).toEqual(['"hello"'])
    expect([client.status(), client.error()]).toEqual(['open', undefined])
  })

  it('retries a waiting backoff at once, and the cancelled timer does not open a third connection', () => {
    jest.useFakeTimers()

    try {
      const { client, made } = sockets()

      made[0]!.open()
      made[0]!.drop(1011)
      client.retry()
      expect(made).toHaveLength(2)
      jest.advanceTimersByTime(120_000)
      expect(made).toHaveLength(2)
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('does nothing while connecting, open or closed', () => {
    const { client, made } = sockets()

    client.retry()
    expect(made).toHaveLength(1)
    made[0]!.open()
    client.retry()
    expect(made).toHaveLength(1)
    client.close()
    client.retry()
    expect(made).toHaveLength(1)
    expect(client.status()).toBe('closed')
  })

  it('stays closed when close() comes while a failed socket is retried', () => {
    const { client, made } = sockets()

    made[0]!.drop(4403)
    client.close()
    client.retry()
    expect(made).toHaveLength(1)
    expect(client.status()).toBe('closed')
  })
})

// Lets the microtasks a fake-timer test queued run.
async function micro(): Promise<void> {
  for (let tick = 0; tick < 50; tick++)
    await Promise.resolve()
}

const sse = (...blocks: string[]) => new Response(blocks.join(''), { headers: { 'content-type': 'text/event-stream' } })
const value = (data: unknown) => `data: ${stringify(data)}\n\n`

describe('stream', () => {
  it('fails a refused response with its status, text and data', async () => {
    const reader = readEvents<number>(async () => new Response(JSON.stringify({ message: 'Sign in first' }), { status: 401, headers: { 'content-type': 'application/json' } }), true)

    reader.start()
    await eventually(() => expect(reader.status()).toBe('failed'))
    expect(reader.error()).toBeInstanceOf(ApiError)
    expect(reader.error()).toMatchObject({ status: 401, message: 'Sign in first', data: { message: 'Sign in first' } })
    expect(reader.pending()).toBe(false)
  })

  it('fails an error event, an undecodable value and a body that breaks off with an ApiError', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const failing = readEvents<number>(async () => sse(value(1), 'event: error\ndata: \n\n'), false)

      failing.start()
      await eventually(() => expect(failing.status()).toBe('failed'))
      expect(failing.last()).toBe(1)
      expect(failing.error()).toBeInstanceOf(ApiError)

      const garbled = readEvents<number>(async () => sse('data: not devalue {\n\n'), false)

      garbled.start()
      await eventually(() => expect(garbled.status()).toBe('failed'))
      expect(garbled.error()).toBeInstanceOf(ApiError)

      const cut = readEvents<number>(async () => sse(value(1)), false)

      cut.start()
      await eventually(() => expect(cut.status()).toBe('failed'))
      expect(cut.error()?.message).toBeString()
    }
    finally {
      logged.mockRestore()
    }
  })

  it('fails a stream whose iterable throws, with that error as the cause', async () => {
    globalThis.document = { querySelector: () => null } as unknown as Document

    try {
      const boom = new Error('the source broke')
      let runs = 0
      const failing = root(() => stream(async function* () {
        runs++

        yield runs

        throw boom
      }))

      flush()
      await eventually(() => expect(failing.status()).toBe('failed'))
      expect(failing.last()).toBe(1)
      expect(failing.error()).toMatchObject({ status: 0, message: 'the source broke' })
      expect(failing.error()?.cause).toBe(boom)
      failing.retry()
      await eventually(() => expect(runs).toBe(2))
      await eventually(() => expect(failing.last()).toBe(2))
    }
    finally {
      Reflect.deleteProperty(globalThis, 'document')
    }
  })

  it('retries a failed stream from the start, and does nothing once done or closed', async () => {
    let opened = 0
    const reader = readEvents<number>(async () => {
      opened++

      return opened === 1 ? new Response('no', { status: 503 }) : sse(value(opened), 'event: end\n\n')
    }, false)

    reader.start()
    await eventually(() => expect(reader.status()).toBe('failed'))
    reader.retry()
    expect([reader.status(), reader.pending()]).toEqual(['connecting', true])
    expect(reader.error()?.status).toBe(503)
    await eventually(() => expect(reader.status()).toBe('done'))
    expect(reader.error()).toBeUndefined()
    expect(reader.last()).toBe(2)
    reader.retry()
    await turn()
    expect(opened).toBe(2)

    const closed = readEvents<number>(async () => new Response('no', { status: 500 }), false)

    closed.start()
    await eventually(() => expect(closed.status()).toBe('failed'))
    closed.close()
    closed.retry()
    await turn()
    expect(closed.status()).toBe('closed')
  })

  it('retries the backoff of a dropped GET stream at once', async () => {
    jest.useFakeTimers()

    try {
      let opened = 0
      const reader = readEvents<number>(async () => {
        opened++

        return sse(value(opened))
      }, true)

      reader.start()
      jest.advanceTimersByTime(0)
      await micro()
      expect(opened).toBe(1)
      expect(reader.status()).toBe('connecting')
      reader.retry()
      jest.advanceTimersByTime(0)
      await micro()
      expect(opened).toBe(2)
      jest.advanceTimersByTime(0)
      await micro()
      reader.close()
      jest.advanceTimersByTime(120_000)
      await micro()
      expect(opened).toBeLessThanOrEqual(3)
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('is idle and not pending before a lazy stream starts', () => {
    const reader = readEvents<number>(async () => sse(), false, true)

    expect([reader.status(), reader.pending(), reader.error()]).toEqual(['idle', false, undefined])
    reader.retry()
    expect(reader.status()).toBe('idle')
  })
})

describe('resource', () => {
  beforeAll(() => {
    globalThis.document = { querySelector: () => null } as unknown as Document
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'document')
  })

  it('is pending while it loads, and reads the ApiError of a failure until the next answer', async () => {
    let attempt = 0
    const read = root(() => resource(async () => {
      attempt++

      if (attempt === 1)
        throw new ApiError(503, 'Down for now', { why: 'deploy' }, { '': 'Down for now' })

      if (attempt === 2)
        throw new TypeError('offline')

      return 'ok'
    }))

    expect([read.status(), read.pending(), read.error()]).toEqual(['loading', true, undefined])
    await eventually(() => expect(read.status()).toBe('failed'))
    expect(read.pending()).toBe(false)
    expect(read.error()).toBeInstanceOf(ApiError)
    expect(read.error()).toMatchObject({ status: 503, message: 'Down for now', data: { why: 'deploy' } })

    read.retry()
    expect([read.status(), read.pending()]).toEqual(['loading', true])
    // Kept while it is asked again.
    expect(read.error()?.status).toBe(503)
    await eventually(() => expect(read.status()).toBe('failed'))
    expect(read.error()).toMatchObject({ status: 0, message: 'offline' })
    expect(read.error()?.cause).toBeInstanceOf(TypeError)

    read.retry()
    await eventually(() => expect(read.status()).toBe('ready'))
    expect([read.pending(), read.error(), read.value()]).toEqual([false, undefined, 'ok'])
  })

  it('retries only a failure, never when ready, loading or gone', async () => {
    let runs = 0
    const [read, dispose] = root(done => [resource(async () => {
      runs++

      if (runs === 1)
        return 'fine'

      throw new Error('later')
    }), done] as const)

    await eventually(() => expect(read.status()).toBe('ready'))
    read.retry()
    await turn()
    expect(runs).toBe(1)
    read.refresh()
    await eventually(() => expect(read.status()).toBe('failed'))
    expect(runs).toBe(2)
    dispose()
    read.retry()
    await turn()
    expect(runs).toBe(2)
  })

  it('records no error for a run that was superseded or aborted', async () => {
    const mounted = root(() => resource(async (signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve)
        setTimeout(resolve, 20)
      })

      if (signal.aborted)
        throw new Error('aborted')

      return 'done'
    }))

    mounted.refresh()
    await eventually(() => expect(mounted.status()).toBe('ready'))
    expect(mounted.error()).toBeUndefined()
  })
})

const mounted = { [API_MOUNT]: '/api/notes' }

// A handle on a route the test mounts by hand, its options untyped.
function tracked() {
  return call.track(mounted as never, '/' as never) as unknown as ((options?: unknown) => Promise<unknown>) & Source<LoadStatus> & { settled: () => Promise<void> }
}

describe('call.track', () => {
  const answering = (...answers: (Response | Error)[]) => spyOn(globalThis, 'fetch').mockImplementation((async () => {
    const answer = answers.shift()!

    if (answer instanceof Error)
      throw answer

    return answer
  }) as unknown as typeof fetch)
  const refusal = (status: number, text: string) => new Response(text, { status, headers: { 'content-type': 'text/plain' } })

  it('is idle until the first call, loading while one runs, then ready or failed by the last to settle', async () => {
    const releases: ((response: Response) => void)[] = []
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => new Promise<Response>(resolve => releases.push(resolve))) as unknown as typeof fetch)

    try {
      const save = tracked()

      expect([save.status(), save.pending(), save.error()]).toEqual(['idle', false, undefined])

      const first = save({ method: 'post' })
      const second = save({ method: 'post' })

      expect([save.status(), save.pending()]).toEqual(['loading', true])
      releases[0]!(refusal(409, 'Taken'))
      await first
      // One call still runs.
      expect(save.status()).toBe('loading')
      releases[1]!(new Response('"saved"', { headers: { 'content-type': 'application/json' } }))
      await second
      expect([save.status(), save.pending(), save.error()]).toEqual(['ready', false, undefined])
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('reads a refusal and a call that got no answer as an ApiError, kept until a success, the second still throwing', async () => {
    const fetched = answering(refusal(409, 'Taken'), new TypeError('Failed to fetch'), new Response('"yes"', { headers: { 'content-type': 'application/json' } }))

    try {
      const save = tracked()

      expect(await save({ method: 'post' })).toMatchObject({ ok: false, status: 409, message: 'Taken' })
      expect(save.status()).toBe('failed')
      expect(save.error()).toBeInstanceOf(ApiError)
      expect(save.error()).toMatchObject({ status: 409, message: 'Taken' })

      await expect(save({ method: 'post' })).rejects.toMatchObject({ status: 0 })
      expect(save.status()).toBe('failed')
      expect(save.error()).toMatchObject({ status: 0, message: 'The server could not be reached' })

      await save({ method: 'post' })
      expect([save.status(), save.error()]).toEqual(['ready', undefined])
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('does not count an abort as a failure, and rethrows it', async () => {
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch)

    try {
      const save = tracked()
      const controller = new AbortController()
      const running = save({ signal: controller.signal })

      controller.abort(new Error('never mind'))
      await expect(running).rejects.toThrow('never mind')
      expect([save.status(), save.error()]).toEqual(['idle', undefined])
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('retries the failed call with the arguments it had, only when failed, and swallows what the retry throws', async () => {
    const fetched = answering(refusal(500, 'Oops'), new TypeError('Failed to fetch'), new Response('"yes"', { headers: { 'content-type': 'application/json' } }))
    const calls = fetched.mock.calls

    try {
      const save = tracked()

      save.retry()
      expect(calls).toHaveLength(0)
      await save({ method: 'post', body: { title: 'a' } })
      save.retry()
      expect(save.status()).toBe('loading')
      await save.settled()
      expect(calls).toHaveLength(2)
      expect(calls[1]![1]).toMatchObject({ method: 'POST', body: '{"title":"a"}' })
      // The retry got no answer: recorded, not thrown out of retry().
      expect(save.status()).toBe('failed')
      expect(save.error()?.status).toBe(0)
      save.retry()
      await save.settled()
      expect([save.status(), save.error()]).toEqual(['ready', undefined])
      save.retry()
      expect(calls).toHaveLength(3)
    }
    finally {
      fetched.mockRestore()
    }
  })
})

describe('an action\'s track()', () => {
  const rejected = (status: number, body: unknown) => new Response(stringify(body), { status, headers: { 'x-kay-failure': '1' } })
  const saved = actionStub('/_kay/action/test/sources') as unknown as import('../src/runtime').Action<{ id: number }, string>

  it('reads idle, loading, ready and failed, with the ActionError as its error, and retries the call that failed', async () => {
    const answers: (Response | Error)[] = [rejected(409, { errors: { '': 'Locked' } }), new TypeError('Failed to fetch'), new Response(stringify('done'))]
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      const next = answers.shift()!

      if (next instanceof Error)
        throw next

      return next
    }) as unknown as typeof fetch)

    try {
      const save = saved.track()

      expect([save.status(), save.pending(), save.error()]).toEqual(['idle', false, undefined])

      const running = save({ id: 7 })

      expect(save.status()).toBe('loading')
      expect(await running).toMatchObject({ ok: false, status: 409, message: 'Locked' })
      expect(save.status()).toBe('failed')
      expect(save.error()).toBeInstanceOf(ApiError)
      expect(save.error()).toMatchObject({ status: 409, message: 'Locked' })

      save.retry()
      await save.settled()
      expect(save.status()).toBe('failed')
      expect(save.error()?.status).toBe(0)

      save.retry()
      await save.settled()
      expect([save.status(), save.error()]).toEqual(['ready', undefined])
      expect(fetched).toHaveBeenCalledTimes(3)
      expect(String(fetched.mock.calls[2]![1]?.body)).toContain('7')
    }
    finally {
      fetched.mockRestore()
    }
  })
})

describe('the shared shape, further cases', () => {
  it('is importable from kay', async () => {
    const kay = await import('../src/runtime') as Record<string, unknown>
    const types: [LoadStatus, import('../src/runtime').ConnectionStatus, import('../src/runtime').Source] = ['idle', 'done', { status: () => 'idle', pending: () => false, error: () => undefined, retry: () => undefined }]

    expect(types[0]).toBe('idle')
    expect(typeof kay.resource).toBe('function')
  })

  it('reads a quiet reload as pending with the status kept, and a quiet failure leaves status and error alone', async () => {
    let refetch: (() => unknown) | undefined

    await mock.module('../src/runtime/live-cache', () => ({ followRoute: (_owner: object, _proof: string | null, again: () => unknown) => {
      refetch = again
    } }))
    globalThis.document = { querySelector: () => null } as unknown as Document

    const answers: (Response | Error)[] = [new Response('"one"', { headers: { 'content-type': 'application/json', 'x-kay-live': 'proof' } }), new Response('"two"', { headers: { 'content-type': 'application/json', 'x-kay-live': 'proof' } }), new TypeError('offline')]
    const release: (() => void)[] = []
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      const next = answers.shift()!

      if (answers.length === 1)
        await new Promise<void>(resolve => release.push(resolve))

      if (next instanceof Error)
        throw next

      return next
    }) as unknown as typeof fetch)

    try {
      const read = root(() => resource(mounted as never, '/' as never)) as ReturnType<typeof resource<string>>

      await eventually(() => expect(read.status()).toBe('ready'))
      await eventually(() => expect(refetch).toBeDefined())
      expect(read.pending()).toBe(false)

      const again = refetch!()

      expect([read.status(), read.pending()]).toEqual(['ready', true])
      release[0]?.()
      await again
      expect([read.value(), read.pending()]).toEqual(['two', false])

      const failing = refetch!()

      await failing
      expect([read.status(), read.pending(), read.error(), read.value()]).toEqual(['ready', false, undefined, 'two'])
    }
    finally {
      fetched.mockRestore()
      Reflect.deleteProperty(globalThis, 'document')
    }
  })

  it('fails a refused stream with the status text, or HTTP and the status when it is empty', async () => {
    const empty = readEvents<number>(async () => Object.defineProperty(new Response('', { status: 502 }), 'statusText', { value: '' }), false)

    empty.start()
    await eventually(() => expect(empty.status()).toBe('failed'))
    expect(empty.error()).toMatchObject({ status: 502, message: 'HTTP 502', errors: { '': 'HTTP 502' } })
  })

  it('wraps a rejected fetch in kay\'s own wording with the browser\'s as the cause', async () => {
    const cause = new TypeError('Failed to fetch')
    const reader = readEvents<number>(async () => Promise.reject(cause), false)

    reader.start()
    await eventually(() => expect(reader.status()).toBe('failed'))
    expect(reader.error()).toMatchObject({ status: 0, message: 'The server could not be reached' })
    expect(reader.error()?.cause).toBe(cause)
  })

  it('lets a superseded run neither fail nor retry the one that took over', async () => {
    const bodies: ((response: Response) => void)[] = []
    let calls = 0
    const reader = readEvents<number>(async () => {
      calls++

      return calls === 1 ? new Promise<Response>(resolve => bodies.push(resolve)) : sse(value(2))
    }, false, true)

    reader.start()
    reader.start(async () => sse(value(2), 'event: end\n\n'))
    await eventually(() => expect(reader.last()).toBe(2))
    bodies[0]?.(new Response('no', { status: 500 }))
    await turn()
    await turn()
    expect([reader.error(), reader.status()]).toEqual([undefined, 'done'])
  })

  it('leaves a redirected track call out of status, error and retry', async () => {
    const { ActionRedirectError } = await import('../src/runtime/action')
    const move = actionStub('/_kay/action/test/redirects') as unknown as import('../src/runtime').Action<{ id: number }, string>
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(stringify({}), { status: 303, headers: { 'location': '/done', 'x-kay-redirect': '1' } })) as unknown as typeof fetch)

    try {
      const save = move.track()

      await expect(save({ id: 1 })).rejects.toBeInstanceOf(ActionRedirectError)
      expect([save.status(), save.error()]).toEqual(['idle', undefined])
      save.retry()
      expect(fetched.mock.calls.length).toBeLessThanOrEqual(1)
    }
    finally {
      fetched.mockRestore()
    }
  })
})
