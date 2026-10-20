import type { TestPage } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'

const path = browserPath()

const PAGE = `<!doctype html><title>t</title><style>.box{width:80px;height:40px;background:#ccc}.box:hover{background:#c00}.far{margin-top:2000px}</style>
<h1>Network</h1><div class="box"></div><div class="far">far</div>
<script>window.seenAtParse = window.marker ?? 'none'; document.querySelector('.box').addEventListener('mouseenter', () => { window.entered = (window.entered ?? 0) + 1 })</script>`

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
