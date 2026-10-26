import type { LivePage } from '../src/runtime/live-value'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { ownSignal, renderEffect, root } from '../src/runtime/reactive'
import { encodeValue } from '../src/runtime/wire'

type Live = typeof import('../src/runtime/live-value')['live']

const ENCODER = new TextEncoder()

// The script of live values a page carries: what the server rendered each value with.
const script = (...values: [id: string, value: unknown][]) => `<script type="application/json" data-kay-live>${encodeValue({ at: Date.now(), sig: 'sig', values: values.map(([id, value]) => [id, '', value]) } satisfies LivePage)}</script>`

// A connection the test writes to: each call gives the events one chunk, as a server sends what it holds at once.
class Connection {
  private controller!: ReadableStreamDefaultController<Uint8Array>
  readonly body = new ReadableStream<Uint8Array>({ start: (controller) => {
    this.controller = controller
  } })

  send(...events: [id: string, value: unknown][][]): void {
    this.controller.enqueue(ENCODER.encode(events.map(updates => `data: ${encodeValue(updates.map(([id, value]) => [id, '', value]))}\n\n`).join('')))
  }

  end(): void {
    this.controller.close()
  }
}

describe('a live value set just after a connection that followed a refusal', () => {
  let live: Live
  // What the server answers a connection with, in turn: a status, or the connection to stream.
  let answers: (number | Connection)[]
  // The page the server renders for a visitor, fetched to renew the proofs.
  let renewed: string
  const posted: number[] = []
  const shown = new Map<string, unknown>()
  const disposals: (() => void)[] = []

  const follow = (id: string, declared: unknown, also?: () => unknown) => {
    const handle = (live as unknown as (initial: unknown, id: string) => () => unknown)(declared, id)

    root((dispose) => {
      disposals.push(dispose)
      renderEffect(() => void (also?.(), shown.set(id, handle())))
    })
  }
  const until = async (done: () => boolean) => {
    for (let waited = 0; !done() && waited < 5000; waited += 5)
      await Bun.sleep(5)

    expect(done()).toBe(true)
  }
  const page = (...values: [id: string, value: unknown][]) => {
    for (const old of document.querySelectorAll('script[data-kay-live]'))
      old.remove()

    document.head.insertAdjacentHTML('beforeend', script(...values))
  }

  beforeAll(async () => {
    GlobalRegistrator.register({ url: 'http://localhost/' })
    ;(globalThis as { KAY_BROWSER?: true }).KAY_BROWSER = true
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST')
        return new Response(`<html><head>${renewed}</head><body></body></html>`, { headers: { 'content-type': 'text/html' } })

      const answer = answers.shift() ?? 403

      posted.push(typeof answer === 'number' ? answer : 200)

      return typeof answer === 'number' ? new Response(null, { status: answer }) : new Response(answer.body, { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    live = (await import('../src/runtime/live-value')).live
  })

  afterEach(async () => {
    for (const dispose of disposals.splice(0))
      dispose()

    // The connection closes a settling delay after the values are no longer read; a deliberate wait, as nothing else tells it closed.
    await Bun.sleep(80)

    posted.length = 0
    shown.clear()
  })

  afterAll(async () => {
    delete (globalThis as { KAY_BROWSER?: true }).KAY_BROWSER
    await GlobalRegistrator.unregister()
  })

  it('shows the update that came with the snapshot, however soon after it', async () => {
    const connection = new Connection()

    page(['unread', 3])
    renewed = script(['unread', 5])
    answers = [403, connection]
    follow('unread', 0)
    await until(() => shown.get('unread') === 3)
    await until(() => posted.length === 2)
    // The snapshot and the update land together, before the value is read again.
    connection.send([['unread', 5]], [['unread', 7]])
    await until(() => shown.get('unread') === 7)
    await Bun.sleep(100)
    expect(shown.get('unread')).toBe(7)
  })

  it('shows each of several values its newest, beside a value that has no user', async () => {
    const connection = new Connection()

    page(['unread', 3], ['visitors', 10], ['mentions', 1])
    renewed = script(['unread', 5], ['visitors', 10], ['mentions', 2])
    answers = [403, connection]
    follow('unread', 0)
    follow('visitors', 0)
    follow('mentions', 0)
    await until(() => shown.get('mentions') === 1)
    await until(() => posted.length === 2)
    connection.send([['unread', 5], ['visitors', 10], ['mentions', 2]], [['unread', 7], ['mentions', 4]], [['visitors', 11]])
    await until(() => shown.get('visitors') === 11)
    await Bun.sleep(100)
    expect([shown.get('unread'), shown.get('visitors'), shown.get('mentions')]).toEqual([7, 11, 4])
  })

  it('shows a page rendered after the last value the connection delivered', async () => {
    const connection = new Connection()
    const [again, askAgain] = ownSignal(0)

    page(['unread', 3])
    renewed = script(['unread', 5])
    answers = [403, connection]
    follow('unread', 0, again)
    await until(() => shown.get('unread') === 3)
    await until(() => posted.length === 2)
    connection.send([['unread', 5]], [['unread', 7]])
    await until(() => shown.get('unread') === 7)
    // A page rendered later, as an island fetched again holds, is newer than what the connection delivered.
    page(['unread', 9])
    askAgain(1)
    await until(() => shown.get('unread') === 9)
  })

  it('keeps the newest value of a connection that dropped and opened again with no refusal', async () => {
    const first = new Connection()
    const second = new Connection()

    page(['unread', 3])
    answers = [first, second]
    follow('unread', 0)
    await until(() => posted.length === 1)
    first.send([['unread', 5]])
    await until(() => shown.get('unread') === 5)
    first.end()
    await until(() => posted.length === 2)
    second.send([['unread', 5]], [['unread', 7]])
    await until(() => shown.get('unread') === 7)
    await Bun.sleep(100)
    expect(shown.get('unread')).toBe(7)
  })
})
