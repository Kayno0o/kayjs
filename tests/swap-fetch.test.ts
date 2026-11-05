import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'

GlobalRegistrator.register({ url: 'http://localhost/shop' })
Object.assign(globalThis, { isSecureContext: false, crossOriginIsolated: false })

const { fetchPage } = await import('../src/runtime/swap-fetch')
const { joinedLoads } = await import('../src/runtime/page-swap')

const realFetch = globalThis.fetch
const asked: { url: string, loads: string | null }[] = []

function answer(response: (loads: string | null) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const loads = new Headers(init?.headers).get('x-kay-loads')

    asked.push({ url: String(input), loads })

    return response(loads)
  }) as typeof fetch
}

function page(status: number, url: string, loads: string | null): Response {
  const response = new Response(`<html>${loads ?? 'whole'}</html>`, { status, headers: { 'content-type': 'text/html' } })

  Object.defineProperty(response, 'url', { value: url })

  return response
}

beforeAll(() => {
  asked.length = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
  asked.length = 0
})

afterAll(async () => GlobalRegistrator.unregister())

describe('fetching a page for some of its loads', () => {
  it('asks for the whole page again when the answer is not a 2xx', async () => {
    answer(loads => page(loads === null ? 200 : 500, 'http://localhost/shop', loads))

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, ['cart'])

    expect(asked.map(call => call.loads)).toEqual(['cart', null])
    expect(fetched.html).toBe('<html>whole</html>')
  })

  it('asks for the whole page again when the answer came from another page', async () => {
    answer(loads => page(200, loads === null ? 'http://localhost/shop' : 'http://localhost/login', loads))

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, ['cart'])

    expect(asked.map(call => call.loads)).toEqual(['cart', null])
    expect(fetched.html).toBe('<html>whole</html>')
  })

  it('takes an answer with no url, as a service worker gives, for the page asked', async () => {
    answer(loads => page(200, '', loads))

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, ['cart'])

    expect(asked.map(call => call.loads)).toEqual(['cart'])
    expect(fetched.html).toBe('<html>cart</html>')
  })

  it('keeps a scoped answer of the page asked for', async () => {
    answer(loads => page(200, 'http://localhost/shop', loads))

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, ['cart', 'user'])

    expect(asked.map(call => call.loads)).toEqual(['cart,user'])
    expect(fetched.html).toContain('cart,user')
  })
})

describe('the loads two refreshes ask for together', () => {
  it('joins the names of both without repeating one', () => {
    expect(joinedLoads(['cart'], ['wishlist', 'cart'])).toEqual(['cart', 'wishlist'])
  })

  it('asks for the whole page when either does', () => {
    expect(joinedLoads(undefined, ['cart'])).toBeUndefined()
    expect(joinedLoads(['cart'], undefined)).toBeUndefined()
  })
})

describe('the names a refresh asks for', () => {
  it('keeps only bindings, in development and production alike, and asks for the whole page when none is left', async () => {
    const { checkedLoads } = await import('../src/runtime/navigate-api')
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const mode = process.env.NODE_ENV

    try {
      for (const env of ['development', 'production']) {
        process.env.NODE_ENV = env

        expect(checkedLoads(['cart', 'bad\nname', 'a-b', 'wishlist'])).toEqual(['cart', 'wishlist'])
        expect(checkedLoads(['bad\u0000'])).toBeUndefined()
        expect(checkedLoads([])).toBeUndefined()
      }

      // Only development tells of the mistake.
      expect(warn).toHaveBeenCalled()
      warn.mockClear()
      process.env.NODE_ENV = 'production'
      checkedLoads(['x y'])
      expect(warn).not.toHaveBeenCalled()
    }
    finally {
      process.env.NODE_ENV = mode ?? 'test'
      warn.mockRestore()
    }
  })
})
