import type { LivePage } from '../src/runtime/live-value'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { ApiError } from '../src/runtime/api-error'
import { renderEffect, root } from '../src/runtime/reactive'
import { encodeValue } from '../src/runtime/wire'

type Live = typeof import('../src/runtime/live-value')['live']
interface Status { status: () => string, pending: () => boolean, error: () => ApiError | undefined, retry: () => void }

const ENCODER = new TextEncoder()

const script = (...values: [id: string, value: unknown][]) => `<script type="application/json" data-kay-live>${encodeValue({ at: Date.now(), sig: 'sig', values: values.map(([id, value]) => [id, '', value]) } satisfies LivePage)}</script>`

// A connection the test writes to.
class Connection {
  private controller!: ReadableStreamDefaultController<Uint8Array>
  readonly body = new ReadableStream<Uint8Array>({ start: (controller) => {
    this.controller = controller
  } })

  send(id: string, value: unknown): void {
    this.controller.enqueue(ENCODER.encode(`data: ${encodeValue([[id, '', value]])}\n\n`))
  }

  fail(): void {
    this.controller.enqueue(ENCODER.encode('event: error\ndata: gone\n\n'))
  }
}

const declare = (live: Live, id: string, initial: unknown) => (live as unknown as (initial: unknown, id: string) => Status & ((key?: string) => unknown))(initial, id)

const declareOwn = (live: Live, id: string, initial: unknown) => (live as unknown as (initial: unknown, id: string, options: unknown) => Status & (() => unknown))(initial, id, { user: true })

describe('the status of a live value on the server', () => {
  it('is idle for every shape, with nothing to retry', async () => {
    const { live } = await import('../src/runtime/live-value')

    for (const handle of [declare(live, 'plain', 0), declare(live, 'keyed', (key: string) => key), declareOwn(live, 'own', 0)]) {
      expect(handle.status()).toBe('idle')
      expect(handle.pending()).toBe(false)
      expect(handle.error()).toBeUndefined()
      expect(() => handle.retry()).not.toThrow()
    }
  })
})

describe('the status of a live value in a browser', () => {
  let live: Live
  let answers: (number | Connection)[]
  const posted: number[] = []
  const signals: AbortSignal[] = []
  const disposals: (() => void)[] = []

  const follow = (handle: () => unknown) => {
    root((dispose) => {
      disposals.push(dispose)
      renderEffect(() => void handle())
    })
  }
  const until = async (done: () => boolean) => {
    for (let waited = 0; !done() && waited < 5000; waited += 5)
      await Bun.sleep(5)

    expect(done()).toBe(true)
  }

  beforeAll(async () => {
    GlobalRegistrator.register({ url: 'http://localhost/' })
    ;(globalThis as { KAY_BROWSER?: true }).KAY_BROWSER = true
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST')
        return new Response(`<html><head>${script(['count', 1])}</head><body></body></html>`, { headers: { 'content-type': 'text/html' } })

      const answer = answers.shift() ?? 403

      posted.push(typeof answer === 'number' ? answer : 200)
      signals.push(init.signal!)

      return typeof answer === 'number' ? new Response(null, { status: answer }) : new Response(answer.body, { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    document.head.insertAdjacentHTML('beforeend', script(['count', 1], ['room', 2]))
    live = (await import('../src/runtime/live-value')).live
  })

  afterEach(async () => {
    for (const dispose of disposals.splice(0))
      dispose()

    await until(() => signals.every(signal => signal.aborted))
    signals.length = 0
    posted.length = 0
  })

  afterAll(async () => {
    delete (globalThis as { KAY_BROWSER?: true }).KAY_BROWSER
    await GlobalRegistrator.unregister()
  })

  it('is idle while nothing is read, connecting while the connection is made and open once it answers, for every handle', async () => {
    const count = declare(live, 'count', 0)
    const room = declare(live, 'room', (key: string) => key)
    const seen: string[] = []

    expect(count.status()).toBe('idle')
    expect(count.pending()).toBe(false)
    answers = [new Connection()]
    follow(count)
    follow(() => room(''))
    root((dispose) => {
      disposals.push(dispose)
      renderEffect(() => void seen.push(count.status()))
    })
    await until(() => count.status() === 'open')
    expect(seen).toContain('connecting')
    expect(seen.at(-1)).toBe('open')
    expect(count.pending()).toBe(false)
    expect(count.error()).toBeUndefined()
    expect(room.status()).toBe('open')
  })

  it('keeps retrying a refused connection behind its error, retry skips the backoff, and the error clears once it opens', async () => {
    const count = declare(live, 'count', 0)
    const connection = new Connection()

    // The refusal, the retry with the renewed proofs, then the backoff, then the answer.
    answers = [403, 403, connection]
    follow(count)
    await until(() => posted.length === 2)
    await until(() => count.error() !== undefined)
    expect(count.error()).toBeInstanceOf(ApiError)
    expect(count.error()?.status).toBe(403)
    expect(count.status()).toBe('connecting')
    expect(count.pending()).toBe(true)
    count.retry()
    await until(() => posted.length === 3)
    await until(() => count.status() === 'open')
    expect(count.error()).toBeUndefined()
    expect(() => count.retry()).not.toThrow()
    await Bun.sleep(50)
    expect(posted.length).toBe(3)
  })

  it('fails on an error event, and retry opens a new connection', async () => {
    const count = declare(live, 'count', 0)
    const first = new Connection()

    answers = [first, new Connection()]
    follow(count)
    await until(() => count.status() === 'open')
    first.fail()
    await until(() => count.status() === 'failed')
    expect(count.error()).toBeInstanceOf(ApiError)
    expect(count.pending()).toBe(false)
    count.retry()
    await until(() => count.status() === 'open')
    expect(count.error()).toBeUndefined()
    expect(posted.length).toBe(2)
  })

  it('stays open while one of two islands reading the value goes', async () => {
    const count = declare(live, 'count', 0)

    answers = [new Connection()]
    follow(count)
    follow(count)
    await until(() => count.status() === 'open')
    disposals.shift()!()
    await Bun.sleep(100)
    expect(count.status()).toBe('open')
    expect(posted.length).toBe(1)
  })

  it('goes idle in a hidden tab, where retry sends nothing, and opens again once shown', async () => {
    const count = declare(live, 'count', 0)
    const hidden = (value: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
      document.dispatchEvent(new Event('visibilitychange'))
    }

    answers = [new Connection(), new Connection()]
    follow(count)
    await until(() => count.status() === 'open')
    hidden(true)
    await until(() => count.status() === 'idle')
    count.retry()
    await Bun.sleep(100)
    expect(posted.length).toBe(1)
    hidden(false)
    await until(() => count.status() === 'open')
    expect(posted.length).toBe(2)
  })

  it('goes back to idle with no error once nothing reads a value, and retry sends nothing', async () => {
    const count = declare(live, 'count', 0)
    const first = new Connection()

    answers = [first]
    follow(count)
    await until(() => count.status() === 'open')
    first.fail()
    await until(() => count.status() === 'failed')
    for (const dispose of disposals.splice(0))
      dispose()

    await until(() => count.status() === 'idle')
    expect(count.error()).toBeUndefined()
    count.retry()
    await Bun.sleep(100)
    expect(posted.length).toBe(1)
  })
})
