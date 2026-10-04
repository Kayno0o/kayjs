import type { Server } from 'bun'
import type { Action } from '../src/runtime'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { brotliDecompressSync } from 'node:zlib'
import { describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { parse, stringify } from 'devalue'
import { Elysia } from 'elysia'
import { check } from '../src/check'
import { inlineScriptHashes, pages } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { prerenderPages } from '../src/server/prerender'
import { clientOf } from '../src/server/protection'
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

  it('takes the address a proxy appended last, never one the client wrote before it', () => {
    const behind = new Request('http://localhost/', { headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' } })
    const proxy = { requestIP: () => ({ address: '127.0.0.1' }) } as unknown as Server<unknown>
    const direct = { requestIP: () => ({ address: '198.51.100.9' }) } as unknown as Server<unknown>

    expect(clientOf(behind, proxy)).toBe('203.0.113.7')
    expect(clientOf(behind, direct)).toBe('198.51.100.9')
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

  it('leaves responses alone unless compress is on', async () => {
    const app = await pages({ routes, prebuilt: false })

    expect((await app.handle(new Request('http://localhost/contact', { headers: { 'accept-encoding': 'br' } }))).headers.get('content-encoding')).toBeNull()
  })
})
