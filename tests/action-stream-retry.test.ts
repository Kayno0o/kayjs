import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { eventually } from './helpers/eventually'

// What a retried action stream does to the call that made it (#2804 slice 4): a tracked handle counts it in flight again, and the call timeout does not cut the new post.

interface Stream { error: () => unknown, pending: () => boolean, status: () => string, last: () => number | undefined, retry: () => void }
type Tracked = ((input: object) => Promise<{ ok: true, data: Stream }>) & { pending: () => boolean }
type Stub = ((input: object, options?: { timeout?: string }) => Promise<Stream>) & { track: () => Tracked }

let actionStub: typeof import('../src/runtime/action').actionStub
const mocks: { mockRestore: () => void }[] = []

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })
  ;({ actionStub } = await import('../src/runtime/action'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  for (const mock of mocks.splice(0))
    mock.mockRestore()
})

const stub = () => actionStub('/_kay/action/test/retry') as unknown as Stub
const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
const failing = () => sse(`data: ${stringify(1)}\n`)
const done = (value: number) => sse(`data: ${stringify(value)}\nevent: end\n`)

// An answer that stays open until `drop()` breaks it off before its end, which fails the stream.
function open(): { response: () => Response, drop: () => void, finish: (value: number) => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined

  return {
    response: () => new Response(new ReadableStream<Uint8Array>({ start: (one) => { controller = one } }), { headers: { 'content-type': 'text/event-stream' } }),
    drop: () => controller?.close(),
    finish: (value) => {
      controller?.enqueue(new TextEncoder().encode(`data: ${stringify(value)}\nevent: end\n`))
      controller?.close()
    },
  }
}

// A server answering the posts in order, the n-th after `delays[n]` ms, and counting the posts its abort signal cut.
function serve(answers: (() => Response)[], delays: number[] = []): { aborted: () => number } {
  let post = 0
  let aborted = 0

  mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
    const mine = post++

    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted++
        reject(init.signal!.reason)
      }, { once: true })
      setTimeout(() => resolve(answers[mine]!()), delays[mine] ?? 0)
    })
  }) as unknown as typeof fetch))

  return { aborted: () => aborted }
}

describe('a stream retried', () => {
  it('counts a track() handle as in flight again until it ends once more', async () => {
    mocks.push(spyOn(console, 'error').mockImplementation(() => undefined))
    const first = open()
    const second = open()

    const third = open()

    serve([first.response, second.response, third.response])

    const run = stub().track()
    const { data: stream } = await run({})

    expect(run.pending()).toBe(true)
    first.drop()
    await eventually(() => expect(stream.status()).toBe('failed'))
    expect(run.pending()).toBe(false)
    stream.retry()
    expect(stream.pending()).toBe(true)
    await eventually(() => expect(stream.status()).toBe('open'))
    expect(run.pending()).toBe(true)
    second.drop()
    await eventually(() => expect(stream.status()).toBe('failed'))
    expect(run.pending()).toBe(false)
    stream.retry()
    await eventually(() => expect(stream.status()).toBe('open'))
    expect(run.pending()).toBe(true)
    third.finish(3)
    await eventually(() => expect(stream.status()).toBe('done'))
    expect(run.pending()).toBe(false)
    expect(stream.last()).toBe(3)
  })

  it('is not cut by the timeout of the call, which counts for its first answer alone', async () => {
    mocks.push(spyOn(console, 'error').mockImplementation(() => undefined))

    const server = serve([failing, () => done(9)], [0, 120])
    const stream = await stub()({}, { timeout: '40ms' })

    await eventually(() => expect(stream.status()).toBe('failed'))
    stream.retry()
    await eventually(() => expect(stream.status()).toBe('done'), 2000)
    expect(stream.last()).toBe(9)
    expect(server.aborted()).toBe(0)
  })
})

describe('a stream retried whose post fails', () => {
  it('leaves a track() handle released, as the call never ran again', async () => {
    mocks.push(spyOn(console, 'error').mockImplementation(() => undefined))

    const first = open()

    serve([first.response, () => new Response('Not yours', { status: 403 })])

    const run = stub().track()
    const { data: stream } = await run({})

    first.drop()
    await eventually(() => expect(stream.status()).toBe('failed'))
    stream.retry()
    await eventually(() => expect(stream.error()).toMatchObject({ status: 403 }))
    expect(stream.status()).toBe('failed')
    expect(run.pending()).toBe(false)
  })
})
