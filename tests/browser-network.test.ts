import type { TestPage } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'
import { createNetwork } from '../src/test/network'

const path = browserPath()

const PAGE = `<!doctype html><title>t</title><style>.box{width:80px;height:40px;background:#ccc}.box:hover{background:#c00}.far{margin-top:2000px}</style>
<h1>Network</h1><div class="box"></div><div class="far">far</div>
<script>window.seenAtParse = window.marker ?? 'none'; document.querySelector('.box').addEventListener('mouseenter', () => { window.entered = (window.entered ?? 0) + 1 })</script>`

// How many times the server was asked for the cacheable script.
let cachedHits = 0

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/api/hello')
      return Response.json({ hello: 'server', sent: request.headers.get('x-test') }, { headers: { 'x-answer': 'yes' } })

    if (url.pathname === '/api/missing')
      return new Response('nope', { status: 404, headers: { 'x-answer': 'no' } })

    if (url.pathname === '/stream')
      return new Response(new ReadableStream({ start: (controller) => { controller.enqueue('data: 1\n\n') } }), { headers: { 'content-type': 'text/event-stream' } })

    if (url.pathname === '/cookies') {
      const headers = new Headers()

      headers.append('x-multi', 'a=1')
      headers.append('x-multi', 'b=2')

      return new Response('x', { headers })
    }

    if (url.pathname === '/cached.js') {
      cachedHits++

      return new Response('window.cached = "server"', { headers: { 'cache-control': 'max-age=3600', 'content-type': 'text/javascript' } })
    }

    if (url.pathname === '/stalled')
      return new Response('<!doctype html><title>t</title><h1>Stalled</h1><a class="link" href="#linked">link</a><img src="/hang.png" alt="">', { headers: { 'content-type': 'text/html' } })

    if (url.pathname === '/old')
      return new Response(null, { status: 302, headers: { location: '/api/hello' } })

    return new Response(PAGE, { headers: { 'content-type': 'text/html' } })
  },
})
const origin = server.url.origin

async function call(page: TestPage, url: string, init?: RequestInit): Promise<string> {
  return page.evaluate(async (target: string, options?: RequestInit) => {
    try {
      const response = await fetch(target, options)

      return `${response.status} ${await response.text()}`
    }
    catch (error) {
      return `failed ${(error as Error).name}`
    }
  }, url, init)
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the network of a kay/test page', () => {
  let page: TestPage

  beforeAll(async () => {
    page = await browse(`${origin}/`)
  }, 60_000)

  afterAll(async () => {
    page.close()
    await server.stop(true)
  })

  it('lists the responses it received, with their status and the headers the wire carried', async () => {
    page.responses.length = 0

    await call(page, '/api/missing', { headers: { 'x-test': 'sent' } })

    const missing = await page.waitForResponse('/api/missing')

    expect(missing).toMatchObject({ status: 404, method: 'GET', type: 'fetch', responseHeaders: { 'x-answer': 'no' }, requestHeaders: { 'x-test': 'sent' } })
    // What the page never set and the browser added.
    expect(missing.requestHeaders['accept-encoding']).toContain('gzip')
    expect(missing.requestHeaders.host).toBe(new URL(origin).host)
  })

  it('marks a response complete once its body arrived, and waits for that unless asked for the headers only', async () => {
    page.responses.length = 0

    await call(page, '/api/hello')

    expect((await page.waitForResponse('/api/hello')).complete).toBe(true)

    await page.evaluate(() => {
      (window as { events?: EventSource }).events = new EventSource('/stream')
    })

    expect(await page.waitForResponse('/stream', { complete: false })).toMatchObject({ status: 200, complete: false })
    await expect(page.waitForResponse('/stream', { timeout: 100 })).rejects.toThrow('timed out')
    await page.evaluate(() => (window as { events?: EventSource }).events!.close())
  })

  it('lists a redirect as a response of its own', async () => {
    page.responses.length = 0

    expect(await call(page, '/old')).toContain('"hello":"server"')
    expect(page.responses.filter(({ url }) => !url.endsWith('/'))).toMatchObject([{ status: 302, responseHeaders: { location: '/api/hello' } }, { status: 200 }])
  })

  it('waits for a response not received yet, and fails naming it when none comes', async () => {
    page.responses.length = 0

    const waiting = page.waitForResponse(/\/api\/hello$/)

    await page.evaluate(() => {
      setTimeout(() => void fetch('/api/hello'), 50)
    })

    expect((await waiting).status).toBe(200)
    await expect(page.waitForResponse('/never', { timeout: 100 })).rejects.toThrow('timed out after 100ms waiting for a response matching /never')
  })

  it('answers a request with a response of its own, by path, URL pattern, RegExp or function', async () => {
    page.responses.length = 0

    await page.route('/api/*', async request => request.fulfill({ status: 201, json: { hello: 'route' }, headers: { 'x-routed': request.method } }))

    expect(await call(page, '/api/hello')).toBe('201 {"hello":"route"}')
    expect(await call(page, '/api/hello?x=1')).toBe('201 {"hello":"route"}')
    expect(await page.waitForResponse('/api/hello')).toMatchObject({ status: 201, responseHeaders: { 'x-routed': 'GET', 'content-type': 'application/json' } })
    await page.unroute()

    expect(await call(page, '/api/hello')).toContain('server')

    await page.route(`${origin}/api/m*`, async request => request.fulfill({ body: 'by url' }))

    expect(await call(page, '/api/missing')).toBe('200 by url')
    expect(await call(page, '/api/hello')).toContain('server')
    await page.unroute()
    await page.route(/missing$/, async request => request.fulfill({ body: 'by regexp' }))

    expect(await call(page, '/api/missing')).toBe('200 by regexp')
    await page.unroute()
    await page.route(url => url.searchParams.has('only'), async request => request.fulfill({ body: Uint8Array.from([104, 105]) }))

    expect(await call(page, '/api/hello?only')).toBe('200 hi')
    expect(await call(page, '/api/hello')).toContain('server')
    await page.unroute()
  })

  it('answers with the latest route matching', async () => {
    await page.route('/api/hello', async request => request.fulfill({ body: 'first' }))
    await page.route('/api/hello', async request => request.fulfill({ body: 'second' }))

    expect(await call(page, '/api/hello')).toBe('200 second')
    await page.unroute()
  })

  it('answers a script the browser kept in its cache, which no route would see otherwise', async () => {
    const load = async () => page.evaluate(async () => {
      const script = document.createElement('script')

      script.src = '/cached.js'
      document.head.append(script)
      await new Promise(resolve => script.addEventListener('load', resolve))
      script.remove()

      return (window as { cached?: string }).cached
    })

    expect(await load()).toBe('server')

    await page.route('/cached.js', async request => request.fulfill({ body: 'window.cached = "routed"', headers: { 'content-type': 'text/javascript' } }))

    expect(await load()).toBe('routed')

    await page.unroute()

    // The cache is back once the last route went: of two loads the server sees one at most.
    const before = cachedHits

    expect(await load()).toBe('server')
    expect(await load()).toBe('server')
    expect(cachedHits - before).toBeLessThanOrEqual(1)
  })

  it('stops answering what a route matched once unrouted, the others kept', async () => {
    const first = async (request: Parameters<Parameters<TestPage['route']>[1]>[0]) => request.fulfill({ body: 'one' })
    const second = async (request: Parameters<Parameters<TestPage['route']>[1]>[0]) => request.fulfill({ body: 'two' })

    await page.route('/api/hello', first)
    await page.route('/api/missing', second)
    await page.unroute('/api/hello')

    expect(await call(page, '/api/hello')).toContain('server')
    expect(await call(page, '/api/missing')).toBe('200 two')
    await page.unroute()
  })

  it('refuses a request as a network error does', async () => {
    await page.route('/api/*', async request => request.abort('connectionrefused'))

    expect(await call(page, '/api/hello')).toBe('failed TypeError')
    await page.unroute()
  })

  it('lets a request through, changed or not, and passes the server\'s answer on changed', async () => {
    await page.route('/api/hello', async request => request.continue({ headers: { ...request.headers, 'x-test': 'changed' } }))

    expect(await call(page, '/api/hello', { headers: { 'x-test': 'original' } })).toContain('"sent":"changed"')
    await page.unroute()
    await page.route('/api/hello', () => undefined)

    expect(await call(page, '/api/hello')).toContain('"hello":"server"')
    await page.unroute()
    page.responses.length = 0

    await page.route('/api/hello', async (request) => {
      const answer = await request.fetch()

      expect(answer).toMatchObject({ status: 200, headers: { 'x-answer': 'yes' } })
      await request.fulfill({ ...answer, body: answer.text().replace('server', 'edited') })
    })

    expect(await call(page, '/api/hello')).toContain('"hello":"edited"')
    expect(await page.waitForResponse('/api/hello')).toMatchObject({ status: 200, responseHeaders: { 'x-answer': 'yes' } })
    await page.unroute()
  })

  it('rewrites a document before the page parses it, and a request taking a while does not block the page\'s other calls', async () => {
    await page.route('/slow', async (request) => {
      await Bun.sleep(150)
      await request.fulfill({ body: 'slow' })
    })

    const pending = call(page, '/slow')

    expect(await page.count('h1')).toBe(1)
    expect(await pending).toBe('200 slow')
    await page.route('/', async (request) => {
      const answer = await request.fetch()

      await request.fulfill({ ...answer, body: answer.text().replace('<h1>Network</h1>', '<h1>Rewritten</h1>') })
    })
    await page.goto('/')

    expect(await page.text('h1')).toBe('Rewritten')
    await page.unroute()
    await page.goto('/')

    expect(await page.text('h1')).toBe('Network')
  })

  it('reports a handler that throws among the page\'s errors and fails its request', async () => {
    await page.route('/api/hello', () => {
      throw new Error('handler broke')
    })

    expect(await call(page, '/api/hello')).toBe('failed TypeError')
    expect(page.errors.at(-1)).toContain('a route handler for')
    expect(page.errors.at(-1)).toContain('handler broke')
    page.errors.length = 0
    await page.unroute()
  })

  it('goes offline and back online', async () => {
    await page.offline()

    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    expect(await call(page, '/api/hello')).toBe('failed TypeError')

    await page.online()

    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    expect(await call(page, '/api/hello')).toContain('server')
  })

  it('runs a script before the scripts of every document it loads from then on', async () => {
    expect(await page.evaluate(() => (window as { seenAtParse?: string }).seenAtParse)).toBe('none')

    await page.initScript((marker: string) => {
      (window as { marker?: string }).marker = marker
    }, 'early')
    await page.goto('/?again')

    expect(await page.evaluate(() => (window as { seenAtParse?: string }).seenAtParse)).toBe('early')
    await page.goto('/?third')

    expect(await page.evaluate(() => (window as { seenAtParse?: string }).seenAtParse)).toBe('early')
  })

  it('hovers an element scrolled out of view, and leaves the pointer on it', async () => {
    await page.goto('/')
    await page.hover('.far')

    expect(await page.evaluate(() => document.querySelector('.far')!.matches(':hover'))).toBe(true)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

    await page.hover('.box')

    expect(await page.evaluate(() => document.querySelector('.box')!.matches(':hover'))).toBe(true)
    expect(await page.evaluate(() => (window as { entered?: number }).entered)).toBe(1)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.box')!).backgroundColor)).toBe('rgb(204, 0, 0)')
    await expect(page.hover('.nothing', { timeout: 100 })).rejects.toThrow('timed out after 100ms waiting for .nothing')
  })

  it('lets a request go that the page cancels while it is paused, and reports nothing', async () => {
    await page.route('/api/hello', async (request) => {
      await Bun.sleep(200)
      await request.fulfill({ body: 'late' })
    })
    await page.route('/api/missing', async () => {
      await Bun.sleep(200)
    })

    const cancelled = page.evaluate(() => {
      const swallow = async (promise: Promise<unknown>) => {
        try {
          await promise
        }
        catch {}
      }

      void swallow(fetch('/api/hello'))
      void swallow(fetch('/api/missing'))
    })

    await cancelled
    await page.goto('/?away')
    await Bun.sleep(400)

    expect(page.errors).toEqual([])
    await page.unroute()
  })

  it('refuses to read an event stream', async () => {
    await page.route('/stream', async (request) => {
      await request.fetch()
    })
    await page.evaluate(() => {
      const swallow = async (promise: Promise<unknown>) => {
        try {
          await promise
        }
        catch {}
      }

      void swallow(fetch('/stream'))
    })
    await Bun.sleep(300)

    expect(page.errors.at(-1)).toContain('cannot read the event stream')
    page.errors.length = 0
    await page.unroute()
  })

  it('refuses an unknown error name', async () => {
    await page.route('/api/hello', async (request) => {
      await request.abort('typo')
    })
    await call(page, '/api/hello')

    expect(page.errors.at(-1)).toContain('no network error named typo')
    page.errors.length = 0
    await page.unroute()
  })

  it('joins repeated headers', async () => {
    await page.route('/cookies', async (request) => {
      const answer = await request.fetch()

      await request.fulfill({ body: answer.headers['x-multi'] ?? 'none' })
    })

    expect(await call(page, '/cookies')).toMatch(/^200 a=1(, |\n)b=2$/)
    await page.unroute()
  })

  it('does not hold its request when the page closes with it paused', async () => {
    const closing = await browse(`${origin}/`)

    await closing.route('/hold', async (request) => {
      await Bun.sleep(200)
      await request.fulfill({ body: 'late' })
    })
    // Fails with the page, which is what this test is about.
    void (async () => {
      try {
        await closing.evaluate(async () => (await fetch('/hold')).text())
      }
      catch {}
    })()
    await Bun.sleep(50)
    closing.close()
    await Bun.sleep(300)

    expect(closing.errors).toEqual([])

    const next = await browse(`${origin}/`)

    expect(await next.text('h1')).toBe('Network')
    next.close()
  })

  it('lets a handler waiting on the server go quietly when its route is removed before the request reaches it', async () => {
    const removing = await browse(`${origin}/`)
    const { promise: fetching, resolve: fetched } = Promise.withResolvers<void>()
    const { promise: handled, resolve } = Promise.withResolvers<unknown>()

    await removing.route('/removed', async (request) => {
      fetched()

      try {
        await request.fetch()
      }
      catch (error) {
        resolve(error)

        throw error
      }
    })
    void (async () => {
      try {
        await removing.evaluate(async () => (await fetch('/removed')).status)
      }
      catch {}
    })()
    // The fetch is still on its way to the server when the route goes.
    await fetching
    await removing.unroute()

    expect(String(await handled)).toContain('the route was removed')
    await Bun.sleep(100)
    expect(removing.errors).toEqual([])
    removing.close()
  })

  it('ends after its bound on a page that never finishes loading, inside the timeout', async () => {
    const stalled = await browse(`${origin}/`, { timeout: 5000 })

    // A request that never answers keeps the next document loading.
    await stalled.route('/hang.png', async () => new Promise<void>(() => undefined))

    try {
      await stalled.evaluate(() => {
        setTimeout(() => location.assign('/stalled'), 0)
      })
      await stalled.waitFor('h1', { text: 'Stalled' })
      expect(await stalled.evaluate(() => document.readyState)).not.toBe('complete')

      for (const act of [async () => stalled.hover('a.link'), async () => stalled.click('a.link')]) {
        const started = Date.now()

        await act()

        expect(Date.now() - started).toBeGreaterThanOrEqual(900)
        expect(Date.now() - started).toBeLessThan(3000)
      }

      expect(await stalled.evaluate(() => location.hash)).toBe('#linked')
    }
    finally {
      await stalled.unroute()
      stalled.close()
    }
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a page under a mount point', () => {
  it('matches a route by its path on the site, whatever it is mounted under', async () => {
    const mounted = Bun.serve({
      port: 0,
      fetch: request => new URL(request.url).pathname === '/docs/' ? new Response(PAGE, { headers: { 'content-type': 'text/html' } }) : new Response('server'),
    })
    const docs = await browse(`${mounted.url.origin}/docs/`)

    try {
      await docs.route('/docs/data', async request => request.fulfill({ body: 'routed' }))

      expect(await call(docs, '/docs/data')).toBe('200 routed')
      expect(await call(docs, '/data')).toBe('200 server')
    }
    finally {
      docs.close()
      await mounted.stop(true)
    }
  })
})

describe('the interception of a kay/test page', () => {
  it('rejects a route with the error of Fetch.enable, even when putting the cache back fails too', async () => {
    const sent: string[] = []
    const network = createNetwork({
      view: { addEventListener: () => undefined },
      cdp: async (method, params) => {
        sent.push(method)

        if (method === 'Fetch.enable')
          throw new Error('Fetch.enable refused')

        if (params?.cacheDisabled === false)
          throw new Error('cache restore refused')

        return undefined as never
      },
      origin: () => 'http://localhost',
      errors: [],
      timeout: 1000,
    })

    await expect(network.route('/api', async request => request.continue())).rejects.toThrow('Fetch.enable refused')
    expect(sent).toEqual(['Network.setCacheDisabled', 'Fetch.enable', 'Network.setCacheDisabled'])
  })

  // A network over a scripted DevTools: `fire` delivers an event, `sent` lists the commands.
  function scripted(fail?: (method: string) => Error | undefined) {
    const listeners = new Map<string, (event: Event) => void>()
    const sent: { method: string, params?: Record<string, unknown> | undefined }[] = []
    const errors: string[] = []
    const network = createNetwork({
      view: { addEventListener: (name, listener) => void listeners.set(name, listener) },
      cdp: async (method, params) => {
        sent.push({ method, params })

        const error = fail?.(method)

        if (error !== undefined)
          throw error

        return undefined as never
      },
      origin: () => 'http://localhost',
      errors,
      timeout: 1000,
    })
    const fire = (name: string, data: unknown) => listeners.get(name)?.({ data } as MessageEvent)

    return { network, sent, errors, fire }
  }

  const PAUSED = { requestId: 'r1', request: { url: 'http://localhost/api', method: 'GET', headers: {} }, resourceType: 'Fetch' }

  it('pauses a request once, at the request stage, when its handler does not fetch it', async () => {
    const { network, sent, fire } = scripted()

    await network.route('/api', async request => request.continue())
    expect(sent.find(({ method }) => method === 'Fetch.enable')?.params).toEqual({ patterns: [{ urlPattern: '*', requestStage: 'Request' }] })

    fire('Fetch.requestPaused', PAUSED)
    await Bun.sleep(20)
    expect(sent.filter(({ method }) => method === 'Fetch.continueRequest').map(({ params }) => params)).toEqual([{ requestId: 'r1' }])
    network.close()
  })

  it('asks for the response of a request a handler fetches', async () => {
    const { network, sent, fire } = scripted()

    await network.route('/api', async (request) => {
      try {
        await request.fetch()
      }
      catch {}
    })
    fire('Fetch.requestPaused', PAUSED)
    await Bun.sleep(20)
    expect(sent.find(({ method }) => method === 'Fetch.continueRequest')?.params).toEqual({ requestId: 'r1', interceptResponse: true })
    network.close()
  })

  it('swallows the error of a request no longer paused and reports any other', async () => {
    const gone = scripted(method => method === 'Fetch.continueRequest' ? new Error('Invalid InterceptionId.') : undefined)

    await gone.network.route('/api', async request => request.continue())
    gone.fire('Fetch.requestPaused', PAUSED)
    await Bun.sleep(20)
    expect(gone.errors).toEqual([])

    const other = scripted(method => method === 'Fetch.continueRequest' ? new Error('Session with given id not found.') : undefined)

    await other.network.route('/api', async request => request.continue())
    other.fire('Fetch.requestPaused', PAUSED)
    await Bun.sleep(20)
    expect(other.errors.join('\n')).toContain('not found')
  })
})
