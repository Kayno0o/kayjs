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

describe('fetching a page that streams', () => {
  const part = (id: string, content: string) => `<template data-kay-await="${id}">${content}</template><script>$kayAwait()</script>`

  function streamed(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(encoder.encode(chunk))

        controller.close()
      },
    })
    const response = new Response(body, { headers: { 'content-type': 'text/html', 'x-kay-streamed': '1' } })

    Object.defineProperty(response, 'url', { value: 'http://localhost/shop' })

    return response
  }

  it('ends at the shell mark, however the network cut the text, and hands each part over whole', async () => {
    const { SHELL_END } = await import('../src/runtime/markers')

    answer(() => streamed(['<body><p>shell</p><!--kay-', 'shell-->', '<!---->', part('0', '<b>a</b>').slice(0, 20), part('0', '<b>a</b>').slice(20), part('1', '<b>é</b>')]))

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, undefined, true)

    expect(fetched.html).toBe('<body><p>shell</p>')
    const { SWAP_CALL } = await import('../src/server/swap')
    const { LATE_PART_END } = await import('../src/runtime/markers')

    expect(SHELL_END).toBe('<!--kay-shell-->')
    // What the server ends each part with, which the browser cuts the stream at.
    expect(LATE_PART_END).toBe(`<script>${SWAP_CALL}</script>`)
    expect(await fetched.late!.read()).toBe(`<!---->${part('0', '<b>a</b>')}`)
    expect(await fetched.late!.read()).toBe(part('1', '<b>é</b>'))
    expect(await fetched.late!.read()).toBeUndefined()
  })

  it('folds the parts that came with the shell into it, leaving the rest to stream', async () => {
    answer(() => streamed([`<body><p>shell</p><!--kay-shell-->${part('0', 'x')}${part('1', 'y').slice(0, 30)}`, part('1', 'y').slice(30)]))

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, undefined, true)

    expect(fetched.html).toBe(`<body><p>shell</p>${part('0', 'x')}`)
    expect(await fetched.late!.read()).toBe(part('1', 'y'))
  })

  it('leaves a page that does not say it streams whole, a mark in its markup included', async () => {
    answer(() => {
      const response = streamed(['<body><p>raw <!--kay-shell--> html</p>', '<p>after</p>'])

      response.headers.delete('x-kay-streamed')

      return response
    })

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, undefined, true)

    expect(fetched.html).toBe('<body><p>raw <!--kay-shell--> html</p><p>after</p>')
    expect(fetched.late).toBeUndefined()
  })

  it('reads a page with no mark whole, with nothing left to stream', async () => {
    answer(() => streamed(['<body>', '<p>plain</p>']))

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, undefined, true)

    expect(fetched.html).toBe('<body><p>plain</p>')
    expect(fetched.late).toBeUndefined()
  })

  it('reads the whole text when asked for loads or not asked to stream', async () => {
    answer(() => streamed(['<body>a<!--kay-shell-->', part('0', 'x')]))

    const fetched = await fetchPage(new URL('http://localhost/shop'))

    expect(fetched.late).toBeUndefined()
    expect(fetched.html).toContain('<template data-kay-await="0">')
  })

  it('gives up on a stream that sends nothing for the page limit, without a second request', async () => {
    const encoder = new TextEncoder()

    answer(() => {
      const response = new Response(new ReadableStream<Uint8Array>({ start: controller => controller.enqueue(encoder.encode('<body>a<!--kay-shell-->')) }), { headers: { 'content-type': 'text/html', 'x-kay-streamed': '1' } })

      Object.defineProperty(response, 'url', { value: 'http://localhost/shop' })

      return response
    })
    document.head.innerHTML = '<meta name="kay-page-timeout" content="50">'

    const fetched = await fetchPage(new URL('http://localhost/shop'), undefined, undefined, true)

    await expect(fetched.late!.read()).rejects.toThrow('stopped streaming')
    expect(asked).toHaveLength(1)
    document.head.innerHTML = ''
  })
})

describe('placing the parts of a streamed page', () => {
  const swapper = async () => {
    const { runnable, scriptMarkup } = await import('../src/runtime/swap-head')

    return { inFlight: {}, entry: 'script[type="module"][src]', runnable, scriptMarkup, keepTyped: () => undefined }
  }

  it('drops a part answering a block the page does not hold, and replaces the one it does', async () => {
    const { followLate } = await import('../src/runtime/swap-streamed')
    const { navigation } = await import('../src/runtime/navigation')

    navigation.hooks = { hydrate: () => undefined, dispose: () => undefined }
    document.body.innerHTML = '<p>top</p><!--kay-await:0--><i>waiting</i><!--/kay-await:0--><p>end</p>'

    const parts = [
      '<template data-kay-await="9"><b>forged</b></template><script>$kayAwait()</script>',
      '<template data-kay-await="0/../x"><b>forged</b></template><script>$kayAwait()</script>',
      '<template data-kay-await="0"><b>done</b></template><script>$kayAwait()</script>',
    ]
    const late = { stopped: false, followed: false, read: async () => parts.shift(), stop() {
      late.stopped = true
    } }

    await followLate(late, await swapper())

    expect(document.body.innerHTML).toBe('<p>top</p><b>done</b><p>end</p>')
  })

  it('lands nothing once stopped', async () => {
    const { followLate } = await import('../src/runtime/swap-streamed')

    document.body.innerHTML = '<!--kay-await:0--><i>waiting</i><!--/kay-await:0-->'

    const late = { stopped: false, followed: false, read: async () => {
      late.stopped = true

      return '<template data-kay-await="0"><b>late</b></template><script>$kayAwait()</script>'
    }, stop() { late.stopped = true } }

    await followLate(late, await swapper())

    expect(document.body.innerHTML).toBe('<!--kay-await:0--><i>waiting</i><!--/kay-await:0-->')
  })
})
