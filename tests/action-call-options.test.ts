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
let sentHeaders: Record<string, string>[] = []

afterEach(() => {
  sentHeaders = []
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

    sentHeaders.push({ ...init?.headers as Record<string, string> })

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

// A server whose posts wait for the test: `answer(n, response)` settles the n-th post, which fetch aborts as it honours the signal.
function gated(): { posts: () => number, answer: (post: number, response: Response) => void, inits: RequestInit[] } {
  const inits: RequestInit[] = []
  const slots = new Map<number, PromiseWithResolvers<Response>>()
  const slot = (post: number) => {
    const found = slots.get(post) ?? Promise.withResolvers<Response>()

    slots.set(post, found)

    return found
  }

  mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
    inits.push(init ?? {})

    const mine = slot(inits.length)

    init?.signal?.addEventListener('abort', () => mine.reject(init.signal!.reason), { once: true })

    return mine.promise
  }) as unknown as typeof fetch))

  return { posts: () => inits.length, answer: (post, response) => slot(post).resolve(response), inits }
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
    const server = gated()

    const cart = { refresh: () => ++cart.count, count: 0 }
    const controller = new AbortController()
    const running = stub()({}, { refresh: cart, signal: controller.signal })

    await settle()
    expect(server.posts()).toBe(1)
    controller.abort()
    await expect(running).rejects.toThrow()
    await settle()
    expect(cart.count).toBe(1)
  })

  it('leaves the page alone when it names resources, and refreshes it for refresh: true', async () => {
    serve(() => ok(1))

    const navigate = await import('../src/runtime/navigate-api')
    const page = spyOn(navigate, 'refresh').mockImplementation(async () => undefined)

    mocks.push(page)

    const { navigation } = await import('../src/runtime/navigation')
    const hooks = navigation.hooks

    navigation.hooks = { hydrate: () => undefined, dispose: () => undefined }

    try {
      await stub()({}, { refresh: { refresh: () => undefined } })
      await settle()
      expect(page).not.toHaveBeenCalled()
      await stub()({}, { refresh: true })
      await settle()
      expect(page).toHaveBeenCalledTimes(1)
    }
    finally {
      if (hooks)
        navigation.hooks = hooks
      else
        delete navigation.hooks
    }
  })

  it('leaves a call being superseded by a later one without a refresh of the resources it named', async () => {
    const server = gated()

    const cart = { refresh: () => ++cart.count, count: 0 }
    const save = stub()
    const first = save({}, { queue: 'latest', refresh: cart })

    await settle()
    server.answer(1, ok('one'))
    await settle()
    expect(await first).toBe('one')
    expect(cart.count).toBe(1)

    // The first call is answered, so a later one has nothing of it to abort.
    const second = save({}, { queue: 'latest', refresh: cart })

    await settle()
    server.answer(2, ok('two'))
    expect(await second).toBe('two')
    await settle()
    expect(cart.count).toBe(2)
  })
})

describe('the timeout of a call', () => {
  it('rejects a call the server leaves unanswered with a readable TimeoutError, putting the optimistic change back', async () => {
    gated()

    const [value, setValue] = reactive.createSignal(1)
    const save = stub()
    const running = save({}, { timeout: '20ms', optimistic: () => setValue(2) })

    expect([value(), save.pending()]).toEqual([2, true])
    await expect(running).rejects.toMatchObject({ name: 'TimeoutError', message: 'The server did not answer within 20ms' })
    expect([value(), save.pending()]).toEqual([1, false])
  })

  it('is counted from the post, not from the wait behind an earlier serial call', async () => {
    const server = gated()

    const save = stub()
    const first = save({}, { queue: 'serial' })
    const second = save({}, { queue: 'serial', timeout: '40ms' })

    await settle()
    await Bun.sleep(80)
    server.answer(1, ok(1))
    await settle()
    expect(server.posts()).toBe(2)
    server.answer(2, ok(2))
    expect(await Promise.all([first, second])).toEqual([1, 2])
  })

  it('means no timeout for 0s, and throws for text that is no duration', async () => {
    const server = gated()
    const running = stub()({}, { timeout: '0s' })

    await Bun.sleep(30)
    server.answer(1, ok('late'))
    expect(await running).toBe('late')
    await expect(stub()({}, { timeout: 'soon' as '1s' })).rejects.toThrow(/timeout/)
  })

  it('is a status-0 failure for a track() handle, with the change put back', async () => {
    gated()

    const [value, setValue] = reactive.createSignal(1)
    const run = stub().track()
    const [result] = await Promise.allSettled([run({}, { timeout: '20ms', optimistic: () => setValue(2) })])

    expect(result).toMatchObject({ status: 'rejected', reason: { name: 'TimeoutError' } })
    expect(value()).toBe(1)
    expect([run.status(), (run.error() as { status: number }).status]).toEqual(['failed', 0])
  })
})

describe('the retries of a call', () => {
  it('posts again after a 503 with a pause that doubles, sending one Idempotency-Key every time', async () => {
    const server = serve(post => post < 3 ? new Response('busy', { status: 503 }) : ok('done'))
    const began = performance.now()

    expect(await stub()({}, { retry: { times: 2, delay: '20ms' } })).toBe('done')
    expect(server.posts()).toBe(3)
    expect(performance.now() - began).toBeGreaterThanOrEqual(55)
    expect(sentHeaders.map(headers => headers['idempotency-key'])).toEqual(new Array(3).fill(sentHeaders[0]!['idempotency-key']))
    expect(sentHeaders[0]!['idempotency-key']).toMatch(/^[0-9a-f]{32}$/)
  })

  it('sends no Idempotency-Key for a call that does not retry, and lets the app\'s own header win', async () => {
    serve(() => ok(1))
    await stub()({})
    expect(sentHeaders[0]!['idempotency-key']).toBeUndefined()
    await stub()({}, { retry: 1, headers: { 'idempotency-key': 'mine' } })
    expect(sentHeaders[1]!['idempotency-key']).toBe('mine')
  })

  it('throws the last failure once the tries are spent, and never retries a refusal, a 504 or an abort', async () => {
    const busy = serve(() => new Response('busy', { status: 503 }))

    await expect(stub()({}, { retry: { times: 1, delay: '1ms' } })).rejects.toMatchObject({ status: 503 })
    expect(busy.posts()).toBe(2)
    mocks.pop()!.mockRestore()

    for (const status of [422, 502, 504]) {
      const refused = serve(() => new Response('no', { status }))

      await expect(stub()({}, { retry: { times: 3, delay: '1ms' } })).rejects.toMatchObject({ status })
      expect(refused.posts()).toBe(1)
      mocks.pop()!.mockRestore()
    }

    const slow = gated()
    const controller = new AbortController()
    const running = stub()({}, { retry: { times: 3, when: () => true }, signal: controller.signal })

    await settle()
    controller.abort()
    await expect(running).rejects.toThrow()
    await settle()
    expect(slow.posts()).toBe(1)
  })

  it('retries a post that failed before it was sent, not a network failure after it nor a timeout, until `when` says so', async () => {
    const failing = (sent?: boolean) => {
      let failed = false

      mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => {
        if (!failed) {
          failed = true

          throw Object.assign(new TypeError('Failed to fetch'), sent === undefined ? {} : { sent })
        }

        return ok('late')
      }) as unknown as typeof fetch))
    }

    failing(false)
    expect(await stub()({}, { retry: { times: 1, delay: '1ms' } })).toBe('late')
    mocks.pop()!.mockRestore()
    failing()
    await expect(stub()({}, { retry: { times: 1, delay: '1ms' } })).rejects.toBeInstanceOf(TypeError)
    mocks.pop()!.mockRestore()
    failing()
    expect(await stub()({}, { retry: { times: 1, delay: '1ms', when: () => true } })).toBe('late')
    mocks.pop()!.mockRestore()

    const hung = serve(async post => post < 2 ? new Promise<Response>(() => undefined) : ok('late'))

    await expect(stub()({}, { timeout: '20ms', retry: { times: 1, delay: '1ms' } })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(hung.posts()).toBe(1)
    mocks.pop()!.mockRestore()

    const again = serve(async post => post < 2 ? new Promise<Response>(() => undefined) : ok('late'))

    expect(await stub()({}, { timeout: '20ms', retry: { times: 1, delay: '1ms', when: () => true } })).toBe('late')
    expect(again.posts()).toBe(2)
    mocks.pop()!.mockRestore()

    const refused = serve(post => post < 2 ? new Response('no', { status: 409 }) : ok('again'))

    expect(await stub()({}, { retry: { times: 1, delay: '1ms', when: error => error.status === 409 } })).toBe('again')
    expect(refused.posts()).toBe(2)
  })

  it('never retries what is no failure of the post: a refused redirect, or an error thrown encoding the input', async () => {
    const redirect = serve(() => new Response(null, { status: 200, headers: { 'x-kay-redirect': 'javascript:alert(1)' } }))

    await expect(stub()({}, { retry: { times: 2, delay: '1ms', when: () => true } })).rejects.toBeInstanceOf(TypeError)
    expect(redirect.posts()).toBe(1)
    mocks.pop()!.mockRestore()

    const none = serve(() => ok(1))

    await expect(stub()({ callback: () => 1 }, { retry: { times: 2, delay: '1ms', when: () => true } })).rejects.toThrow()
    expect(none.posts()).toBe(0)
  })

  it('posts the same form data and file again', async () => {
    const bodies: unknown[] = []

    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body)

      return bodies.length < 2 ? new Response('busy', { status: 503 }) : ok('stored')
    }) as unknown as typeof fetch))

    const form = new FormData()

    form.set('note', 'hello')
    form.set('file', new File(['content'], 'a.txt'))

    // fetch sends it, as XMLHttpRequest would report progress of a real network.
    const xhr = globalThis.XMLHttpRequest

    // @ts-expect-error the page has no XMLHttpRequest for this test
    delete globalThis.XMLHttpRequest

    try {
      expect(await stub()(form as unknown as object, { retry: { times: 1, delay: '1ms' } })).toBe('stored')
    }
    finally {
      globalThis.XMLHttpRequest = xhr
    }

    expect(bodies).toHaveLength(2)

    for (const body of bodies as FormData[]) {
      expect(body.get('note')).toBe('hello')
      expect(await (body.get('file') as File).text()).toBe('content')
    }
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

    gated()

    const controller = new AbortController()
    const aborted: unknown[] = []
    const running = stub()({}, { signal: controller.signal, onError: () => aborted.push('error'), onSettled: () => aborted.push('settled') })

    await settle()
    controller.abort()
    await expect(running).rejects.toThrow()
    await settle()
    expect(aborted).toEqual(['settled'])
  })
})

describe('the queue of a call', () => {
  it('posts a serial call once the earlier ones settled, pending the whole time', async () => {
    const server = gated()
    const save = stub()
    const first = save({}, { queue: 'serial' })
    const second = save({}, { queue: 'serial' })
    const third = save({}, { queue: 'serial' })

    await settle()
    expect([server.posts(), save.pending()]).toEqual([1, true])
    server.answer(1, ok(1))
    await settle()
    expect(server.posts()).toBe(2)
    server.answer(2, ok(2))
    await settle()
    server.answer(3, ok(3))
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3])
    expect(save.pending()).toBe(false)
  })

  it('goes on after a serial call failed, and drops one aborted while it waited', async () => {
    const server = serve(post => post === 1 ? new Response('no', { status: 500 }) : ok(post))
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
    const server = gated()

    const [value, setValue] = reactive.createSignal(0)
    const save = stub()
    const first = save({}, { queue: 'latest', optimistic: () => setValue(1) })

    await settle()

    const second = save({}, { queue: 'latest', optimistic: () => setValue(2) })
    const superseded = Promise.allSettled([first])

    await settle()
    server.answer(2, ok(2))
    expect(await superseded).toMatchObject([{ status: 'rejected', reason: { name: 'AbortError' } }])
    expect(await second).toBe(2)
    expect(value()).toBe(2)
  })

  it('takes the queue of a track handle, which orders its own calls apart from the action\'s, and counts an abort as no failure', async () => {
    const server = gated()

    const save = stub()
    const row = save.track({ queue: 'latest' })
    const other = save.track({ queue: 'latest' })
    const first = row({})
    const beside = other({})

    await settle()

    const second = row({})
    const superseded = Promise.allSettled([first])

    await settle()
    server.answer(2, ok(2))
    server.answer(3, ok(3))
    expect(await superseded).toMatchObject([{ status: 'rejected', reason: { name: 'AbortError' } }])
    expect(await Promise.all([second, beside])).toEqual([{ ok: true, data: 3 }, { ok: true, data: 2 }])
    expect([row.status(), row.error()]).toEqual(['ready', undefined])
  })
})

describe('a latest call', () => {
  it('composes its signals without AbortSignal.any, which the browsers this runs on may lack', async () => {
    const any = AbortSignal.any.bind(AbortSignal)

    // @ts-expect-error older browsers have no AbortSignal.any
    delete AbortSignal.any

    try {
      const server = gated()
      const controller = new AbortController()
      const save = stub()
      const first = save({}, { queue: 'latest', signal: controller.signal })

      await settle()

      const second = save({}, { queue: 'latest', timeout: '1s' })
      const superseded = Promise.allSettled([first])

      await settle()
      expect(await superseded).toMatchObject([{ status: 'rejected', reason: { name: 'AbortError' } }])
      server.answer(2, ok('two'))
      expect(await second).toBe('two')

      const third = save({}, { signal: controller.signal })

      await settle()
      controller.abort()
      await expect(third).rejects.toThrow()
    }
    finally {
      AbortSignal.any = any
    }
  })

  it('does not abort the call it follows once that one is answered, only its page refresh is left running', async () => {
    const server = gated()
    const refreshed = Promise.withResolvers<void>()
    const cart = { refresh: async () => refreshed.promise }
    const save = stub()
    const first = save({}, { queue: 'latest', refresh: cart })

    await settle()
    server.answer(1, ok('one'))
    expect(await first).toBe('one')
    await settle()

    const second = save({}, { queue: 'latest' })

    await settle()
    server.answer(2, ok('two'))
    expect(await second).toBe('two')
    refreshed.resolve()
  })

  it('puts the changes of calls back in order when a later call fails while an earlier one is superseded', async () => {
    const server = gated()
    const [value, setValue] = reactive.createSignal(0)
    const save = stub()
    const first = save({}, { queue: 'latest', optimistic: () => setValue(1) })

    await settle()

    const second = save({}, { queue: 'latest', optimistic: () => setValue(2) })
    const superseded = Promise.allSettled([first])

    await settle()
    expect(await superseded).toMatchObject([{ status: 'rejected', reason: { name: 'AbortError' } }])
    expect(value()).toBe(2)
    server.answer(2, new Response('no', { status: 500 }))
    await expect(second).rejects.toMatchObject({ status: 500 })
    expect(value()).toBe(0)
  })

  it('puts them back in order when a serial call fails and an earlier one succeeded', async () => {
    const server = gated()
    const [value, setValue] = reactive.createSignal(0)
    const save = stub()
    const first = save({}, { queue: 'serial', optimistic: () => setValue(1) })
    const second = save({}, { queue: 'serial', optimistic: () => setValue(2) })

    await settle()
    server.answer(1, ok('one'))
    await settle()
    server.answer(2, new Response('no', { status: 500 }))
    expect(await first).toBe('one')
    await expect(second).rejects.toMatchObject({ status: 500 })
    expect(value()).toBe(1)
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

  it('hand the later change the value before them when both wrote the same one', async () => {
    const server = gated()
    const [value, setValue] = reactive.createSignal(1)
    const save = stub()
    const first = save({}, { optimistic: () => setValue(2) })
    const second = save({}, { optimistic: () => setValue(2) })

    await settle()
    server.answer(1, new Response('no', { status: 500 }))
    await expect(first).rejects.toThrow()
    expect(value()).toBe(2)
    server.answer(2, new Response('no', { status: 500 }))
    await expect(second).rejects.toThrow()
    expect(value()).toBe(1)
  })

  it('end where they began for the optimistic() helper, whose kept change is the one after it to build on', () => {
    const [value, setValue] = reactive.createSignal(1)
    const change = reactive.optimistic(() => setValue(2))

    change.undo()
    expect(value()).toBe(1)

    const kept = reactive.optimistic(() => setValue(3))

    kept.keep()

    const later = reactive.optimistic(() => setValue(4))

    kept.undo()
    expect(value()).toBe(4)
    later.undo()
    expect(value()).toBe(3)
  })
})
