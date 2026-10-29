import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'

// A page that is no HTML is left to the browser once fetched, which ends a swap without the DOM work.
describe('the fetch of a page being navigated to', () => {
  let swapModule: typeof import('../src/runtime/page-swap')
  let flight: typeof import('../src/runtime/swap-flight')
  let nav: typeof import('../src/runtime/navigation')
  let fetched: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
  let assigned: ReturnType<typeof spyOn<Location, 'assign'>>
  const gates = new Map<string, () => void>()
  const requests: string[] = []
  const link = () => document.createElement('a')
  const visit = async (path: string, intent: 'visit' | 'query' | 'refresh' = 'visit') => swapModule.go(new URL(path, 'http://localhost/'), { intent })
  const release = (path: string) => gates.get(`http://localhost${path}`)?.()
  const pushed = () => history.length

  beforeAll(async () => {
    GlobalRegistrator.register({ url: 'http://localhost/' })
    // happy-dom has neither, and a page without isolation headers reads as one that is not.
    Object.assign(globalThis, { isSecureContext: false, crossOriginIsolated: false })
    swapModule = await import('../src/runtime/page-swap')
    flight = await import('../src/runtime/swap-flight')
    nav = await import('../src/runtime/navigation')
    // Each request waits for its path to be released.
    fetched = spyOn(globalThis, 'fetch').mockImplementation((async (input: string, init?: RequestInit) => {
      requests.push(input)

      const { promise, resolve } = Promise.withResolvers<void>()

      gates.set(input, resolve)
      init?.signal?.addEventListener('abort', () => resolve())
      await promise

      if (init?.signal?.aborted)
        throw new DOMException('aborted', 'AbortError')

      return Object.defineProperty(new Response('x', { headers: { 'content-type': 'text/plain' } }), 'url', { value: input })
    }) as unknown as typeof fetch)
    assigned = spyOn(location, 'assign').mockImplementation(() => undefined)
  })

  afterEach(() => {
    for (const release of gates.values())
      release()

    gates.clear()
    requests.length = 0
    nav.prefetched.clear()
    flight.inFlight.fetch = undefined
    flight.inFlight.asked = undefined
    assigned.mockClear()
  })

  afterAll(async () => {
    fetched.mockRestore()
    assigned.mockRestore()
    await GlobalRegistrator.unregister()
  })

  async function settle(): Promise<void> {
    await Bun.sleep(20)
  }

  it('is joined by a click after a hover and a second click, one request for the page', async () => {
    swapModule.prefetch(new URL('http://localhost/a'), link())

    const first = visit('/a')
    const second = visit('/a')
    const third = visit('/a')

    release('/a')
    await Promise.all([first, second, third])

    expect(requests).toEqual(['http://localhost/a'])
    expect(assigned).toHaveBeenCalledTimes(1)
  })

  it('is not fetched again by a hover while a click loads the page', async () => {
    swapModule.prefetch(new URL('http://localhost/a'), link())

    const click = visit('/a')

    await settle()
    swapModule.prefetch(new URL('http://localhost/a'), link())
    swapModule.prefetch(new URL('http://localhost/a'), link())
    release('/a')
    await click

    expect(requests).toEqual(['http://localhost/a'])
  })

  it('is fetched once for two clicks with no prefetch before', async () => {
    const first = visit('/a')
    const second = visit('/a')

    release('/a')
    await Promise.all([first, second])

    expect(requests).toEqual(['http://localhost/a'])
  })

  it('is joined by another click on a query link', async () => {
    const first = visit('/a?tab=hardware', 'query')
    const second = visit('/a?tab=hardware', 'query')

    release('/a?tab=hardware')
    await Promise.all([first, second])

    expect(requests).toEqual(['http://localhost/a?tab=hardware'])
  })

  it('is cancelled by a click to another page, a click back fetching the first afresh', async () => {
    const first = visit('/a')

    await settle()

    const other = visit('/b')

    await settle()

    const back = visit('/a')

    await settle()
    release('/b')
    release('/a')
    await Promise.all([first, other, back])

    expect(requests).toEqual(['http://localhost/a', 'http://localhost/b', 'http://localhost/a'])
  })

  it('is fetched again by a click on the page once it has shown', async () => {
    const first = visit('/a')

    release('/a')
    await first
    expect(flight.inFlight.fetch).toBeUndefined()

    const again = visit('/a')

    release('/a')
    await again

    expect(requests).toEqual(['http://localhost/a', 'http://localhost/a'])
  })

  it('leaves a refresh waiting for the visit to the same page, without a request of its own', async () => {
    const click = visit('/a')

    await settle()

    const refresh = visit('/a', 'refresh')

    await settle()
    expect(requests).toEqual(['http://localhost/a'])
    release('/a')
    await Promise.all([click, refresh])

    expect(requests).toEqual(['http://localhost/a'])
  })

  it('adds no history entry for a repeated click', async () => {
    const before = pushed()
    const first = visit('/a')
    const second = visit('/a')

    release('/a')
    await Promise.all([first, second])

    expect(pushed()).toBe(before)
  })
})
