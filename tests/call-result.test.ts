import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { stringify } from 'devalue'

let actionStub: typeof import('../src/runtime/action').actionStub
let ActionError: typeof import('../src/runtime/action').ActionError
let ActionRedirectError: typeof import('../src/runtime/action').ActionRedirectError
let FAILURE_HEADER: string
let call: typeof import('../src/runtime/live').call

interface Result { ok: boolean, data?: unknown, status?: number, message?: string, errors?: Record<string, string>, error?: { status: number, message: string, errors: Record<string, string>, data: unknown } }
type Call = ((input: object, options?: object) => Promise<Result> & { orThrow: () => Promise<unknown> }) & { track: () => (input: object) => Promise<Result> & { orThrow: () => Promise<unknown> }, pending: () => boolean }

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })
  ;({ actionStub, ActionError, ActionRedirectError } = await import('../src/runtime/action'))
  ;({ FAILURE_HEADER } = await import('../src/runtime/swap'))
  ;({ call } = await import('../src/runtime/live'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const mocks: { mockRestore: () => void }[] = []

afterEach(() => {
  for (const mock of mocks.splice(0))
    mock.mockRestore()
})

function answer(reply: () => Response | Promise<Response>): void {
  mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted === true)
      throw init.signal.reason

    return reply()
  }) as unknown as typeof fetch))
}

const stub = () => actionStub('/_kay/action/test/result') as unknown as Call
const refusal = (status: number, errors: Record<string, string>, data: unknown) => new Response(stringify({ errors, data }), { status, headers: { [FAILURE_HEADER]: '1' } })

describe('what an island call of an action answers', () => {
  it('resolves { ok: true, data } for what the handler returned', async () => {
    answer(() => new Response(stringify({ id: 3 })))

    expect(await stub()({})).toEqual({ ok: true, data: { id: 3 } })
  })

  it('resolves a refusal of the server, its message, fields and data, in the shape track() gives, with the error repeating them', async () => {
    answer(() => refusal(409, { title: 'Taken' }, { reason: 'dup' }))

    const result = await stub()({})

    expect(result).toMatchObject({ ok: false, status: 409, message: 'Taken', errors: { title: 'Taken' }, data: { reason: 'dup' } })
    expect(result.error).toBeInstanceOf(ActionError)
    expect(result.error).toMatchObject({ status: 409, message: 'Taken', errors: { title: 'Taken' }, data: { reason: 'dup' } })
  })

  it('resolves a handler that threw, a 5xx, as a failure with its status', async () => {
    answer(() => new Response('boom', { status: 500 }))

    const result = await stub()({})

    expect([result.ok, result.status, result.error?.status]).toEqual([false, 500, 500])
  })

  it('resolves a call that got no answer as a failure with status 0, and clears pending()', async () => {
    answer(async () => {
      throw new TypeError('Failed to fetch')
    })

    const save = stub()
    const result = await save({})

    expect([result.ok, result.status, result.message]).toEqual([false, 0, 'The server could not be reached'])
    expect(save.pending()).toBe(false)
  })

  it('resolves a call that timed out as a failure with status 0', async () => {
    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })) as unknown as typeof fetch))

    const result = await stub()({}, { timeout: '20ms' })

    expect([result.ok, result.status]).toEqual([false, 0])
    expect(result.message).toContain('timeout')
  })

  it('still rejects for an abort and a redirect, which are no failure of the call', async () => {
    const controller = new AbortController()

    answer(async () => new Promise<Response>(() => undefined))

    const running = stub()({}, { signal: controller.signal })

    controller.abort()
    await expect(running).rejects.toHaveProperty('name', 'AbortError')
    for (const mock of mocks.splice(0)) {
      mock.mockRestore()
    }
    answer(() => new Response(null, { status: 303, headers: { 'x-kay-redirect': '/away' } }))

    const navigate = await import('../src/runtime/navigate-api')
    const { navigation } = await import('../src/runtime/navigation')
    const hooks = navigation.hooks

    mocks.push(spyOn(navigate, 'navigateTo').mockImplementation(async () => true))
    navigation.hooks = { hydrate: () => undefined, dispose: () => undefined }

    try {
      await expect(stub()({})).rejects.toBeInstanceOf(ActionRedirectError)
    }
    finally {
      Object.assign(navigation, { hooks })
    }
  })

  it('throws the failure for .orThrow(), and answers the data when it went through', async () => {
    answer(() => refusal(422, { name: 'Required' }, undefined))

    const refused = stub()({}).orThrow()

    await expect(refused).rejects.toBeInstanceOf(ActionError)
    await expect(refused).rejects.toMatchObject({ status: 422, errors: { name: 'Required' } })
    for (const mock of mocks.splice(0)) {
      mock.mockRestore()
    }
    answer(() => new Response(stringify('fine')))
    expect(await stub()({}).orThrow()).toBe('fine')
  })

  it('leaves no unhandled rejection when only .orThrow() is awaited for an abort', async () => {
    const controller = new AbortController()

    answer(async () => new Promise<Response>(() => undefined))

    const running = stub()({}, { signal: controller.signal }).orThrow()

    controller.abort()
    await expect(running).rejects.toHaveProperty('name', 'AbortError')
  })

  it('gives a track() handle the same results, a failure with no answer included, and its own .orThrow()', async () => {
    answer(async () => {
      throw new TypeError('Failed to fetch')
    })

    const save = stub().track()
    const result = await save({})

    expect([result.ok, result.status]).toEqual([false, 0])
    await expect(save({}).orThrow()).rejects.toBeInstanceOf(TypeError)
  })
})

describe('what an island call of an API route answers', () => {
  const api = { [Symbol.for('kay.api')]: '/api/notes' }
  // eslint-disable-next-line ts/promise-function-async -- an async function would wrap the call's promise, which lacks `orThrow()`
  const route = (options?: object) => (call as unknown as (module: unknown, path: string, options?: object) => Promise<Result> & { orThrow: () => Promise<unknown> })(api, '/notes', options)

  it('resolves { ok, data }, a refusal, a 5xx and a network failure as results, never throwing', async () => {
    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json([1, 2])) as unknown as typeof fetch))
    expect(await route()).toEqual({ ok: true, data: [1, 2] })
    for (const mock of mocks.splice(0)) {
      mock.mockRestore()
    }

    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ errors: { title: 'Short' } }, { status: 422 })) as unknown as typeof fetch))

    const refused = await route()

    expect([refused.ok, refused.status, refused.errors, refused.message]).toEqual([false, 422, { title: 'Short' }, 'Short'])
    for (const mock of mocks.splice(0)) {
      mock.mockRestore()
    }

    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('boom', { status: 500 })) as unknown as typeof fetch))
    expect((await route()).status).toBe(500)
    for (const mock of mocks.splice(0)) {
      mock.mockRestore()
    }

    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch))
    expect([(await route()).ok, (await route()).status]).toEqual([false, 0])
  })

  it('throws an ApiError for .orThrow(), and rejects for an abort', async () => {
    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({}, { status: 404 })) as unknown as typeof fetch))
    await expect(route().orThrow()).rejects.toMatchObject({ name: 'ApiError', status: 404 })

    const controller = new AbortController()

    mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })) as unknown as typeof fetch))

    const running = route({ signal: controller.signal })

    controller.abort()
    await expect(running).rejects.toHaveProperty('name', 'AbortError')
  })
})
