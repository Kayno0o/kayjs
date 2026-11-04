import type { CallOptions } from '../src/runtime/action'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { turn } from './helpers/eventually'

let reactive: typeof import('../src/runtime/reactive')
let actionStub: typeof import('../src/runtime/action').actionStub

type Call = (input: object, options?: CallOptions) => Promise<unknown>
type Stub = Call & { pending: () => boolean, track: (options?: { queue?: string }) => Call & { status: () => string, error: () => unknown } }

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })

  reactive = await import('../src/runtime/reactive')
  ;({ actionStub } = await import('../src/runtime/action'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const mocks: { mockRestore: () => void }[] = []

afterEach(() => {
  for (const mock of mocks.splice(0))
    mock.mockRestore()
})

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++)
    await turn()
}

// A server answering each post with what `reply` gives, after `ms`, and honouring the abort signal as fetch does.
function serve(reply: (post: number, body: unknown) => Response | Promise<Response>, ms = 0): { posts: () => number, started: number[] } {
  const started: number[] = []
  let posts = 0

  mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
    const post = ++posts

    started.push(post)

    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      setTimeout(() => {
        void (async () => {
          try {
            resolve(await reply(post, init?.body))
          }
          catch (error) {
            reject(error)
          }
        })()
      }, ms)
    })
  }) as unknown as typeof fetch))

  return { posts: () => posts, started }
}

const ok = (value: unknown) => new Response(stringify(value))
const stub = () => actionStub('/_kay/action/test/options') as unknown as Stub

describe('what a call does once it succeeded', () => {
  it('refreshes the resources it names in place of the page, and nothing for refresh: false', async () => {
    serve(() => ok(1))

    const cart = { refresh: () => ++cart.count, count: 0 }
    const wishlist = { refresh: () => ++wishlist.count, count: 0 }
    const save = stub()

    await save({}, { refresh: cart })
    await save({}, { refresh: [cart, wishlist] })
    await save({}, { refresh: false })
    await settle()
    expect([cart.count, wishlist.count]).toEqual([2, 1])
  })

  it('refreshes them for a call aborted once it was sent too, and not for one that never reached the server', async () => {
    serve(() => ok(1), 20)

    const cart = { refresh: () => ++cart.count, count: 0 }
    const controller = new AbortController()
    const running = stub()({}, { refresh: cart, signal: controller.signal })

    await turn()
    controller.abort()
    await expect(running).rejects.toThrow()
    await settle()
    expect(cart.count).toBe(1)
  })
})

describe('the timeout of a call', () => {
  it('rejects a call the server leaves unanswered with a TimeoutError, putting the optimistic change back', async () => {
    serve(() => ok(1), 200)

    const [value, setValue] = reactive.createSignal(1)
    const save = stub()
    const running = save({}, { timeout: '20ms', optimistic: () => setValue(2) })

    expect([value(), save.pending()]).toEqual([2, true])
    await expect(running).rejects.toMatchObject({ name: 'TimeoutError' })
    expect([value(), save.pending()]).toEqual([1, false])
  })

  it('is counted from the post, not from the wait behind an earlier serial call', async () => {
    serve(() => ok(1), 30)

    const save = stub()
    const first = save({}, { queue: 'serial' })
    const second = save({}, { queue: 'serial', timeout: '50ms' })

    expect(await Promise.all([first, second])).toEqual([1, 1])
  })
})

describe('the retries of a call', () => {
  it('posts again after a busy answer or no answer, with a pause that doubles', async () => {
    const server = serve(post => post < 3 ? new Response('busy', { status: 503 }) : ok('done'))
    const began = performance.now()

    expect(await stub()({}, { retry: { times: 2, delay: '20ms' } })).toBe('done')
    expect(server.posts()).toBe(3)
    expect(performance.now() - began).toBeGreaterThanOrEqual(55)
  })

  it('throws the last failure once the tries are spent, and never retries a refusal or an abort', async () => {
    const busy = serve(() => new Response('busy', { status: 503 }))

    await expect(stub()({}, { retry: { times: 1, delay: '1ms' } })).rejects.toMatchObject({ status: 503 })
    expect(busy.posts()).toBe(2)
    mocks.pop()!.mockRestore()

    const refused = serve(() => new Response('no', { status: 422 }))

    await expect(stub()({}, { retry: { times: 3, delay: '1ms' } })).rejects.toMatchObject({ status: 422 })
    expect(refused.posts()).toBe(1)
    mocks.pop()!.mockRestore()

    const slow = serve(() => ok(1), 50)
    const controller = new AbortController()
    const running = stub()({}, { retry: 3, signal: controller.signal })

    await turn()
    controller.abort()
    await expect(running).rejects.toThrow()
    expect(slow.posts()).toBe(1)
  })

  it('retries a timeout, and takes a custom when', async () => {
    const hung = serve(async post => post < 2 ? new Promise<Response>(() => undefined) : ok('late'))

    expect(await stub()({}, { timeout: '20ms', retry: { times: 1, delay: '1ms' } })).toBe('late')
    expect(hung.posts()).toBe(2)
    mocks.pop()!.mockRestore()

    const refused = serve(post => post < 2 ? new Response('no', { status: 409 }) : ok('again'))

    expect(await stub()({}, { retry: { times: 1, delay: '1ms', when: error => error.status === 409 } })).toBe('again')
    expect(refused.posts()).toBe(2)
  })
})

describe('the hooks of a call', () => {
  it('run onStart, then onSuccess and onSettled with what came back', async () => {
    serve(() => ok('five'))

    const seen: unknown[] = []

    await stub()({ n: 1 }, {
      onStart: event => seen.push(['start', event]),
      onSuccess: event => seen.push(['success', event]),
      onError: event => seen.push(['error', event]),
      onSettled: event => seen.push(['settled', event]),
    })
    await settle()
    expect(seen).toEqual([['start', { input: { n: 1 } }], ['success', { data: 'five' }], ['settled', { data: 'five' }]])
  })

  it('run onError with an ApiError, not for an abort, and never fail the call when one throws', async () => {
    serve(() => new Response('no', { status: 500 }))

    const seen: unknown[] = []
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    mocks.push(logged)
    await expect(stub()({}, {
      onError: ({ error }) => {
        seen.push(error.status)

        throw new Error('the hook broke')
      },
      onSettled: ({ error }) => seen.push(['settled', error?.status]),
    })).rejects.toMatchObject({ status: 500 })
    await settle()
    expect(seen).toEqual([500, ['settled', 500]])
    expect(logged).toHaveBeenCalledTimes(1)
    mocks.pop()!.mockRestore()
    mocks.pop()!.mockRestore()

    serve(() => ok(1), 30)

    const controller = new AbortController()
    const aborted: unknown[] = []
    const running = stub()({}, { signal: controller.signal, onError: () => aborted.push('error'), onSettled: () => aborted.push('settled') })

    await turn()
    controller.abort()
    await expect(running).rejects.toThrow()
    await settle()
    expect(aborted).toEqual(['settled'])
  })
})

describe('the queue of a call', () => {
  it('posts a serial call once the earlier ones settled, pending the whole time', async () => {
    const server = serve(post => ok(post), 20)
    const save = stub()
    const first = save({}, { queue: 'serial' })
    const second = save({}, { queue: 'serial' })
    const third = save({}, { queue: 'serial' })

    await turn()
    expect([server.started, save.pending()]).toEqual([[1], true])
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3])
    expect(save.pending()).toBe(false)
  })

  it('goes on after a serial call failed, and drops one aborted while it waited', async () => {
    const server = serve(post => post === 1 ? new Response('no', { status: 500 }) : ok(post), 10)
    const save = stub()
    const controller = new AbortController()
    const first = save({}, { queue: 'serial' })
    const waiting = save({}, { queue: 'serial', signal: controller.signal })
    const third = save({}, { queue: 'serial' })

    controller.abort()

    const settled = await Promise.allSettled([first, waiting, third])

    expect(settled.map(item => item.status)).toEqual(['rejected', 'rejected', 'fulfilled'])
    expect(settled.map(item => item.status === 'rejected' ? (item.reason as Error).name : item.value)).toEqual(['ActionError', 'AbortError', 2])
    expect(server.posts()).toBe(2)
  })

  it('aborts the earlier calls of a latest one, which reject with an AbortError and put their change back', async () => {
    serve(post => ok(post), 20)

    const [value, setValue] = reactive.createSignal(0)
    const save = stub()
    const first = save({}, { queue: 'latest', optimistic: () => setValue(1) })
    const second = save({}, { queue: 'latest', optimistic: () => setValue(2) })

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(await second).toBe(2)
    expect(value()).toBe(2)
  })

  it('takes the queue of a track handle, which orders its own calls apart from the action\'s, and counts an abort as no failure', async () => {
    serve(post => ok(post), 20)

    const save = stub()
    const row = save.track({ queue: 'latest' })
    const other = save.track({ queue: 'latest' })
    const first = row({})
    const beside = other({})
    const second = row({})

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(await Promise.all([second, beside])).toEqual([{ ok: true, data: 3 }, { ok: true, data: 2 }])
    expect([row.status(), row.error()]).toEqual(['ready', undefined])
  })
})

describe('optimistic changes of calls in flight', () => {
  it('end where they began whichever fails first', async () => {
    const answers = [20, 5]
    let post = 0

    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => {
      await Bun.sleep(answers[post++]!)

      return new Response('no', { status: 500 })
    }) as unknown as typeof fetch))

    const [value, setValue] = reactive.createSignal(0)
    const save = stub()
    const first = save({}, { optimistic: () => setValue(1) })
    const second = save({}, { optimistic: () => setValue(2) })

    await expect(second).rejects.toThrow()
    expect(value()).toBe(1)
    await expect(first).rejects.toThrow()
    expect(value()).toBe(0)
  })

  it('end where they began when the earlier fails first, and keep the later one\'s value when it goes through', async () => {
    const outcomes = [[5, 500], [20, 500], [5, 500], [20, 200]] as const
    let post = 0

    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => {
      const [ms, status] = outcomes[post++]!

      await Bun.sleep(ms)

      return status === 200 ? ok(1) : new Response('no', { status })
    }) as unknown as typeof fetch))

    const [value, setValue] = reactive.createSignal(0)
    const save = stub()
    const first = save({}, { optimistic: () => setValue(1) })
    const second = save({}, { optimistic: () => setValue(2) })

    await expect(first).rejects.toThrow()
    expect(value()).toBe(2)
    await expect(second).rejects.toThrow()
    expect(value()).toBe(0)

    const third = save({}, { optimistic: () => setValue(1) })
    const fourth = save({}, { optimistic: () => setValue(2) })

    await expect(third).rejects.toThrow()
    expect(await fourth).toBe(1)
    expect(value()).toBe(2)
  })
})
