import type { Server } from 'bun'
import type { Action } from '../src/runtime'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { brotliDecompressSync, constants } from 'node:zlib'
import { describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { parse, stringify } from 'devalue'
import { Elysia } from 'elysia'
import { check } from '../src/check'
import { inlineScriptHashes, pages, shutdown } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { prerenderPages } from '../src/server/prerender'
import { clientAddress, protectionRefusal, rateKey } from '../src/server/protection'
import { testSite } from '../src/test'

const ROUTES = 'tests/fixtures/seo/src/routes'

function directives(policy: string | null): Map<string, string[]> {
  return new Map(policy!.split('; ').map((directive) => {
    const [name, ...sources] = directive.split(' ')

    return [name!, sources]
  }))
}

describe('security headers', () => {
  it('sends a strict policy allowing kay\'s inline scripts, and the other headers, on pages and app routes alike', async () => {
    const app = new Elysia().get('/api/ping', () => 'pong').use(await pages({ routes: ROUTES, prebuilt: false }))

    for (const path of ['/about', '/api/ping', '/sitemap-missing']) {
      const response = await app.handle(new Request(`http://localhost${path}`))
      const policy = directives(response.headers.get('content-security-policy'))

      expect(policy.get('default-src')).toEqual(['\'self\''])
      expect(policy.get('script-src')).toEqual(['\'self\'', ...inlineScriptHashes()])
      expect(policy.get('object-src')).toEqual(['\'none\''])
      expect(policy.get('frame-ancestors')).toEqual(['\'self\''])
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    }
  })

  it('allows the live-reload script in development', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, dev: true })
    const policy = directives((await app.handle(new Request('http://localhost/about'))).headers.get('content-security-policy'))

    expect(policy.get('script-src')).toEqual(['\'self\'', ...inlineScriptHashes({ dev: true })])
  })

  it('merges the app\'s directives and headers over kay\'s, false leaving one out', async () => {
    const app = await pages({
      routes: ROUTES,
      prebuilt: false,
      security: {
        csp: { 'img-src': ['\'self\''], 'frame-ancestors': false, 'script-src': ['\'self\'', 'https://cdn.example.com'] },
        headers: { 'Strict-Transport-Security': 'max-age=63072000', 'x-frame-options': false },
      },
    })
    const response = await app.handle(new Request('http://localhost/about'))
    const policy = directives(response.headers.get('content-security-policy'))

    expect(policy.get('img-src')).toEqual(['\'self\''])
    expect(policy.has('frame-ancestors')).toBe(false)
    expect(policy.get('script-src')).toEqual(['\'self\'', 'https://cdn.example.com', ...inlineScriptHashes()])
    expect(response.headers.get('strict-transport-security')).toBe('max-age=63072000')
    expect(response.headers.has('x-frame-options')).toBe(false)
  })

  it('keeps a header a route sets, on its Response or through set.headers', async () => {
    const app = new Elysia()
      .use(await pages({ routes: ROUTES, prebuilt: false }))
      .get('/api/own', () => new Response('own', { headers: { 'x-frame-options': 'DENY' } }))
      .get('/api/set', ({ set }) => {
        set.headers['content-security-policy'] = 'default-src \'none\''

        return 'set'
      })

    expect((await app.handle(new Request('http://localhost/api/own'))).headers.get('x-frame-options')).toBe('DENY')
    expect((await app.handle(new Request('http://localhost/api/set'))).headers.get('content-security-policy')).toBe('default-src \'none\'')
  })

  it('keeps a header the app set itself, and sends none with security off', async () => {
    const own = new Elysia()
      .onRequest(({ set }) => {
        set.headers['content-security-policy'] = 'default-src *'
      })
      .use(await pages({ routes: ROUTES, prebuilt: false }))
    const off = await pages({ routes: ROUTES, prebuilt: false, security: false })
    const offResponse = await off.handle(new Request('http://localhost/about'))

    expect((await own.handle(new Request('http://localhost/about'))).headers.get('content-security-policy')).toBe('default-src *')
    expect(offResponse.headers.has('content-security-policy')).toBe(false)
    expect(offResponse.headers.has('x-content-type-options')).toBe(false)
  })
})

describe('action protection', () => {
  const FIXTURE = 'tests/fixtures/production'
  // Held in a variable so tsc leaves the .kay import to Bun.
  const CONTACT = './fixtures/production/src/routes/contact.kay'

  it('refuses a form whose honeypot is filled in, with a message on the field, the handler never running', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false })
    const { send } = await import(CONTACT) as { send: Action<{ message: string }, number, 'website'> }
    const trapped = await site.submit(send, { message: 'hello', website: 'https://spam.example' }, { from: '/contact' })
    const human = await site.submit(send, { message: 'hello', website: '' }, { from: '/contact' })

    expect(trapped.html).toContain('<p class="error">422 Leave this field empty</p>')
    expect(human.html).toContain('<p class="sent">Sent 5</p>')

    // Repeated, or a file, it is filled in all the same.
    for (const website of [['', 'https://spam.example'], new File(['x'], 'x.txt')])
      expect(protectionRefusal(send as never, new Request('http://localhost/'), { website }, true, null)?.status).toBe(422)

    expect(protectionRefusal(send as never, new Request('http://localhost/'), { website: [''] }, true, null)).toBeUndefined()
  })

  it('lets a client post as often as the limit allows in a window, then answers 429 with when to retry', async () => {
    const app = await pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false })
    const { send } = await import(CONTACT) as { send: Action<{ message: string }, number> }
    const call = async (from: string) => app.handle(new Request(`http://localhost${send.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-forwarded-for': from }, body: stringify({ message: 'hi' }) }))

    expect((await call('203.0.113.7')).status).toBe(200)
    expect((await call('203.0.113.7')).status).toBe(200)

    const limited = await call('203.0.113.7')

    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(parse(await limited.text())).toEqual({ errors: { '': expect.stringMatching(/^Too many attempts; try again in \d+ s$/) }, data: undefined })
    expect((await call('198.51.100.2')).status).toBe(200)
  })

  it('counts an IPv6 client by its /64, so rotating addresses inside it buys nothing', () => {
    expect(rateKey('2001:db8:0:1:aaaa::1')).toBe('2001:db8:0:1::/64')
    expect(rateKey('2001:0db8:0000:0001:ffff:ffff:ffff:ffff')).toBe('2001:db8:0:1::/64')
    expect(rateKey('203.0.113.7')).toBe('203.0.113.7')
    expect(rateKey('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7')
  })

  it('takes the address a proxy appended last, never one the client wrote before it', () => {
    const behind = new Request('http://localhost/', { headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' } })
    const proxy = { requestIP: () => ({ address: '127.0.0.1' }) } as unknown as Server<unknown>
    const direct = { requestIP: () => ({ address: '198.51.100.9' }) } as unknown as Server<unknown>

    expect(clientAddress(behind, proxy)).toBe('203.0.113.7')
    expect(clientAddress(behind, direct)).toBe('198.51.100.9')
  })

  it('types the honeypot as one of the form\'s fields for kay check, a misspelt one still refused', async () => {
    const typo = join(FIXTURE, 'src/routes/typo.kay')

    expect(await check(FIXTURE)).toEqual([])

    try {
      await Bun.write(typo, '---\nimport { send } from \'./contact.kay\'\n---\nform(action={send})\n  input(name="websit")\n')

      expect((await check(FIXTURE)).map(diagnostic => diagnostic.line)).toEqual([5])
    }
    finally {
      await rm(typo, { force: true })
    }
  })
})

describe('revalidation', () => {
  const routes = 'tests/fixtures/production/src/routes'

  it('serves a stale prerendered page while rendering it again in the background, then the new one with its own tag', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const { news } = await import('./fixtures/production/src/news')

    try {
      await prerenderPages(root, { routes }, (await readClient(root))!)
      const app = await pages({ routes, prebuilt: true, security: false })
      const visit = async (headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/news', { headers }))
      const built = await visit()
      const etag = built.headers.get('etag')!

      news.edition = 2
      expect(await built.text()).toContain('<h1>Edition 1</h1>')
      expect(await (await visit()).text()).toContain('<h1>Edition 1</h1>')

      setSystemTime(Date.now() + 61_000)
      // The first request past the period still gets the page as it was built.
      expect(await (await visit()).text()).toContain('<h1>Edition 1</h1>')
      await Bun.sleep(50)

      const fresh = await visit({ 'if-none-match': etag, 'accept-encoding': 'br' })

      expect(fresh.status).toBe(200)
      expect(fresh.headers.get('etag')).not.toBe(etag)
      expect(new TextDecoder().decode(brotliDecompressSync(await fresh.bytes()))).toContain('<h1>Edition 2</h1>')
    }
    finally {
      setSystemTime()
      news.edition = 1
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('keeps the page it has when a render fails, trying again a minute later at most', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const { news } = await import('./fixtures/production/src/news')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await prerenderPages(root, { routes }, (await readClient(root))!)
      const app = await pages({ routes, prebuilt: true, security: false })
      const visit = async () => (await app.handle(new Request('http://localhost/news'))).text()

      news.failing = true
      setSystemTime(Date.now() + 61_000)
      await visit()
      await Bun.sleep(50)
      expect(await visit()).toContain('<h1>Edition 1</h1>')
      expect(logged).toHaveBeenCalled()

      news.failing = false
      news.edition = 3
      await visit()
      await Bun.sleep(50)
      expect(await visit()).toContain('<h1>Edition 1</h1>')

      setSystemTime(Date.now() + 122_000)
      await visit()
      await Bun.sleep(50)
      expect(await visit()).toContain('<h1>Edition 3</h1>')
    }
    finally {
      setSystemTime()
      logged.mockRestore()
      news.edition = 1
      news.failing = false
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('refuses a revalidate that is not a positive number of seconds', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const page = join(routes, 'broken.kay')

    try {
      await Bun.write(page, '--- server\nexport const prerender = true\nexport const revalidate = \'1h\'\n---\np Broken\n')

      await expect(prerenderPages(root, { routes }, (await readClient(root))!)).rejects.toThrow('exports a revalidate that is not a positive number of seconds')
    }
    finally {
      await rm(page, { force: true })
      await writeManifest(root, manifest)
    }
  })
})

describe('a prerendered page posted to', () => {
  const routes = 'tests/fixtures/production/src/routes'
  // Held in a variable so tsc leaves the .kay import to Bun.
  const NEWSLETTER = './fixtures/production/src/routes/newsletter.kay'

  it('renders for the request carrying how a form post went, once and kept by no cache, the built file served before and after', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      await prerenderPages(root, { routes }, (await readClient(root))!)
      const app = await pages({ routes, prebuilt: true, security: false })
      const { join: subscribe } = await import(NEWSLETTER) as { join: Action<{ email: string }, string> }
      const visit = async (headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/newsletter', { headers }))
      const post = async (email: string) => {
        const response = await app.handle(new Request(`http://localhost${subscribe.url}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/newsletter' }, body: new URLSearchParams({ email }) }))

        expect(response.headers.get('location')).toBe('http://localhost/newsletter')

        const cookie = response.headers.get('set-cookie')!

        return cookie.slice(0, cookie.indexOf(';'))
      }

      const built = await visit()
      const etag = built.headers.get('etag')!

      expect(etag).toBeTruthy()
      expect(await built.text()).not.toContain('<p class="joined">')

      const refused = await visit({ 'cookie': await post('nope'), 'if-none-match': etag })

      expect(refused.status).toBe(200)
      expect(refused.headers.get('cache-control')).toBe('private, no-store')
      expect(refused.headers.has('etag')).toBe(false)
      expect(refused.headers.get('set-cookie')).toContain('kay_flash=;')

      const html = await refused.text()

      expect(html).toContain('<p class="error">Not an email</p>')
      expect(html).toContain('value="nope"')

      const joined = await visit({ cookie: await post('ada@example.com') })

      expect(await joined.text()).toContain('<p class="joined">Welcome ada</p>')

      const after = await visit({ 'if-none-match': etag })

      expect(after.status).toBe(304)
      expect(after.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    }
    finally {
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })
})

describe('compression', () => {
  const routes = 'tests/fixtures/production/src/routes'

  it('compresses what renders per request for a browser taking brotli or gzip, headers and cookies kept', async () => {
    // Registered after the pages, as hooks only reach the routes that come after them.
    const app = new Elysia()
      .use(await pages({ routes, prebuilt: false, compress: true }))
      .get('/api/report', () => new Response(JSON.stringify({ rows: Array.from({ length: 100 }, (_, i) => i) }), { headers: { 'content-type': 'application/json', 'set-cookie': 'seen=1' } }))
      .get('/api/tiny', () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2' } }))
      .get('/api/raw', () => new Response('x'.repeat(1000), { headers: { 'content-type': 'text/plain', 'cache-control': 'no-transform' } }))
    const fetch = async (path: string, encoding: string) => app.handle(new Request(`http://localhost${path}`, { headers: { 'accept-encoding': encoding } }))
    const page = await fetch('/contact', 'gzip, deflate, br, zstd')
    const plain = await fetch('/contact', 'identity')

    expect(page.headers.get('content-encoding')).toBe('br')
    expect(page.headers.get('vary')).toContain('accept-encoding')
    expect(page.headers.get('content-security-policy')).toStartWith('default-src \'self\'')
    expect(new TextDecoder().decode(brotliDecompressSync(await page.bytes()))).toBe(await plain.text())
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(plain.headers.get('vary')).toContain('accept-encoding')

    const report = await fetch('/api/report', 'gzip')

    expect(report.headers.get('content-encoding')).toBe('gzip')
    expect(report.headers.get('set-cookie')).toBe('seen=1')
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await report.bytes())))).toMatchObject({ rows: expect.any(Array) })
    expect((await fetch('/api/tiny', 'br')).headers.get('content-encoding')).toBeNull()
    expect((await fetch('/api/raw', 'br')).headers.get('content-encoding')).toBeNull()
  })

  it('sends a streamed page\'s early chunks before the stream ends', async () => {
    const { compressResponse } = await import('../src/server/compress')
    let push!: (text: string) => void
    let close!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = text => controller.enqueue(new TextEncoder().encode(text))
        close = () => controller.close()
      },
    })
    const response = compressResponse(new Request('http://localhost/', { headers: { 'accept-encoding': 'br' } }), new Response(body, { headers: { 'content-type': 'text/html' } }))!
    const reader = response.body!.getReader()
    const parts: Uint8Array[] = []

    push(`<p>${'shell '.repeat(100)}</p>`)
    parts.push((await reader.read()).value!)
    // The shell decodes on its own, before the rest exists.
    expect(new TextDecoder().decode(brotliDecompressSync(Buffer.concat(parts), { finishFlush: constants.BROTLI_OPERATION_FLUSH }))).toStartWith('<p>shell')

    push('<p>later</p>')
    close()

    for (let read = await reader.read(); !read.done; read = await reader.read())
      parts.push(read.value)

    expect(new TextDecoder().decode(brotliDecompressSync(Buffer.concat(parts)))).toEndWith('<p>later</p>')
  })

  it('leaves responses alone unless compress is on', async () => {
    const app = await pages({ routes, prebuilt: false })

    expect((await app.handle(new Request('http://localhost/contact', { headers: { 'accept-encoding': 'br' } }))).headers.get('content-encoding')).toBeNull()
  })
})

describe('lifecycle', () => {
  // A server in a process of its own, with the port it printed and what it prints after.
  async function startServer(env: Record<string, string> = {}) {
    const server = Bun.spawn(['bun', 'tests/fixtures/production/server.ts'], { env: { ...process.env, NODE_ENV: 'production', ...env }, stdout: 'pipe', stderr: 'pipe' })
    const reader = server.stdout.getReader()
    let output = ''

    while (!output.includes('\n')) {
      const { value, done } = await reader.read()

      if (done)
        throw new Error(`the server exited: ${await new Response(server.stderr).text()}`)

      output += new TextDecoder().decode(value)
    }

    const port = (/port (\d+)/).exec(output)![1]
    const rest = (async () => {
      for (;;) {
        const { value, done } = await reader.read()

        if (done)
          return output

        output += new TextDecoder().decode(value)
      }
    })()

    return { server, url: `http://localhost:${port}`, output: async () => rest }
  }

  it('answers the health route while it takes requests', async () => {
    const app = await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false })
    const unhealthy = await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, health: { path: '/up', check: () => false } })
    const health = await app.handle(new Request('http://localhost/_kay/health'))

    expect(health.status).toBe(200)
    expect(await health.text()).toBe('ok')
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect((await unhealthy.handle(new Request('http://localhost/up'))).status).toBe(503)
    expect((await (await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, health: false })).handle(new Request('http://localhost/_kay/health'))).status).toBe(404)
  })

  it('on SIGTERM lets open requests finish, runs the stop hooks, and exits', async () => {
    const { server, url, output } = await startServer()

    expect((await fetch(`${url}/_kay/health`)).status).toBe(200)

    const slow = fetch(`${url}/slow`)

    await Bun.sleep(50)
    server.kill('SIGTERM')

    expect(await (await slow).text()).toBe('slow done')
    expect(await server.exited).toBe(0)
    expect(await output()).toContain('jobs stopped')
  }, 20_000)

  it('closes what is still open past the shutdown timeout and exits with 1', async () => {
    const { server, url } = await startServer({ SHUTDOWN_TIMEOUT: '0.2', SLOW_MS: '5000' })
    const slow = (async () => {
      try {
        return (await fetch(`${url}/slow`)).status
      }
      catch {
        return 'closed'
      }
    })()

    await Bun.sleep(50)
    server.kill('SIGTERM')

    expect(await server.exited).toBe(1)
    expect(await slow).toBe('closed')
  }, 20_000)
})

describe('request logging', () => {
  const routes = 'tests/fixtures/production/src/routes'

  it('logs one line per request with its status and duration, leaving kay\'s own routes out', async () => {
    const lines = spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      const app = new Elysia().use(await pages({ routes, prebuilt: false, log: true })).get('/api/fail', ({ set }) => {
        set.status = 418

        return 'teapot'
      }).listen(0)

      for (const path of ['/contact?token=secret', '/api/fail', '/_kay/health', '/missing'])
        await (await fetch(`http://localhost:${app.server!.port}${path}`)).text()

      await shutdown(app)
      expect(lines.mock.calls.map(call => String(call[0]).replace(/\d+ms$/, 'Nms'))).toEqual(['GET /contact 200 Nms', 'GET /api/fail 418 Nms', 'GET /missing 404 Nms'])
    }
    finally {
      lines.mockRestore()
    }
  })

  it('writes JSON, or hands each entry to a function', async () => {
    const lines = spyOn(console, 'log').mockImplementation(() => undefined)
    const entries: unknown[] = []

    try {
      const json = await pages({ routes, prebuilt: false, log: 'json' })
      const custom = await pages({ routes, prebuilt: false, log: entry => entries.push(entry) })
      const quiet = await pages({ routes, prebuilt: false })

      for (const app of [json, custom, quiet]) {
        app.listen(0)
        await (await fetch(`http://localhost:${app.server!.port}/contact`)).text()
        await shutdown(app)
      }

      expect(lines.mock.calls).toHaveLength(1)
      expect(JSON.parse(String(lines.mock.calls[0]![0]))).toEqual({ time: expect.any(String), method: 'GET', path: '/contact', status: 200, duration: expect.any(Number) })
      expect(entries).toEqual([{ method: 'GET', path: '/contact', status: 200, duration: expect.any(Number) }])
    }
    finally {
      lines.mockRestore()
    }
  })
})

describe('rewrites', () => {
  const routes = 'tests/fixtures/production/src/routes'
  const rewrite = (url: URL) => url.hostname === 'shop.localhost' ? `/shop${url.pathname}${url.search}` : undefined

  it('serves a host from a section through the whole app, the query kept and derives reached', async () => {
    const app = new Elysia()
      .derive(({ request }) => ({ seenAt: new URL(request.url).pathname }))
      .use(await pages({ routes, prebuilt: false, security: false, rewrite }))
      .get('/shop/api/where', ({ seenAt }) => seenAt)
      .get('/shop/api/marked', ({ request }) => String(request.headers.has('x-kay-rewritten') || request.headers.has('x-kay-client')))
      .post('/shop/api/echo', ({ body }) => body)
      .listen(0)
    const fetchAt = async (host: string, path: string) => fetch(`http://localhost:${app.server!.port}${path}`, { headers: { host } })

    try {
      expect(await (await fetchAt('shop.localhost', '/mug?color=red')).text()).toContain('<p class="item">Shop mug in red at /shop/mug</p>')
      expect(await (await fetchAt('shop.localhost', '/api/where')).text()).toBe('/shop/api/where')
      expect(await (await fetchAt('shop.localhost', '/api/marked')).text()).toBe('false')
      // kay's own routes keep their paths on every host.
      expect((await fetchAt('shop.localhost', '/_kay/health')).status).toBe(200)

      const echoed = await fetch(`http://localhost:${app.server!.port}/api/echo`, { method: 'POST', headers: { 'host': 'shop.localhost', 'content-type': 'application/json' }, body: JSON.stringify({ mug: 'red' }) })

      expect(await echoed.json()).toEqual({ mug: 'red' })
      expect(await (await fetchAt('localhost', '/shop/mug')).text()).toContain('<p class="item">Shop mug in any at /shop/mug</p>')
      expect((await fetchAt('localhost', '/mug')).status).toBe(404)
      // Without a server, kay's own pages serve it.
      expect(await (await (await pages({ routes, prebuilt: false, rewrite })).handle(new Request('http://shop.localhost/mug'))).text()).toContain('<p class="item">Shop mug in any at /shop/mug</p>')
    }
    finally {
      await shutdown(app)
    }
  })

  it('keeps the socket\'s address for a rewritten request, a client never passing for one', async () => {
    const { rewrittenAddress } = await import('../src/server/rewrite')
    const forged = new Request('http://localhost/', { headers: { 'x-kay-rewritten': 'guess', 'x-kay-client': '1.2.3.4' } })

    expect(rewrittenAddress(forged)).toBeUndefined()
  })

  it('refuses a rewrite to anything but a path', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const app = await pages({ routes, prebuilt: false, rewrite: () => 'https://elsewhere.example/' })

    try {
      expect((await app.handle(new Request('http://localhost/contact'))).status).toBe(500)
      expect(String(logged.mock.calls[0]![0])).toContain('it returns a path starting with one /')
    }
    finally {
      logged.mockRestore()
    }
  })
})
